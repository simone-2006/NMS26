import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from urllib.error import URLError
from urllib.request import Request, urlopen

import yaml
from fastapi import FastAPI, HTTPException
from influxdb_client import InfluxDBClient
from pydantic import BaseModel, Field


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            f"Set it in the environment or .env before starting the API."
        )
    return value


INFLUX_URL = os.getenv("INFLUX_URL", "http://influxdb:8086")
INFLUX_TOKEN = _require_env("INFLUX_TOKEN")
INFLUX_ORG = _require_env("INFLUX_ORG")
BUCKET = _require_env("INFLUX_BUCKET")
DEVICES_PATH = "/config/devices.yml"
ARP_CACHE_PATH = os.getenv("ARP_CACHE_PATH", "/config/arp-cache.txt")
DHCP_LEASES_PATH = os.getenv("DHCP_LEASES_PATH", "").strip()
ARP_FRESH_SECONDS = 90
COLLECTOR_URL = os.getenv("COLLECTOR_URL", "http://collector:8010")
LOSS_SAMPLES = max(1, int(os.getenv("DOWN_AFTER_FAILS", "3")))
ALLOWED_CHECKS = {"ping", "snmp"}
DEVICE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)
LATENCY_START_RE = re.compile(
    r"^(?:-\d+[smhdwy]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$"
)
LATENCY_EVERY = {"30s", "1m", "5m", "15m", "30m", "1h", "6h", "1d"}

client = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    client.close()


app = FastAPI(title="Mini NMS API", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


def _rows(flux, params=None):
    return [
        r
        for t in client.query_api().query(flux, params=params or {})
        for r in t.records
    ]


def _read_config():
    try:
        with open(DEVICES_PATH, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    devices = data.get("devices") or []
    data["devices"] = devices if isinstance(devices, list) else []
    return data


def _write_config(data):
    tmp = DEVICES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
    os.replace(tmp, DEVICES_PATH)


class DeviceIn(BaseModel):
    name: str = Field(min_length=1)
    host: str = ""
    mac: str = ""
    checks: list[str] = ["ping"]


class DeviceDelete(BaseModel):
    ids: list[str] = Field(min_length=1)


class DeviceUpdate(BaseModel):
    name: str = Field(min_length=1)
    host: str = ""
    mac: str = ""
    checks: list[str] | None = None


def _device_id(device: dict) -> str:
    return device.get("id") or device["name"]


def _mac_or_empty(value: str) -> str:
    hexonly = value.strip().lower().replace("-", "").replace(":", "").replace(".", "")
    if len(hexonly) != 12 or any(c not in "0123456789abcdef" for c in hexonly):
        return ""
    return ":".join(hexonly[i:i + 2] for i in range(0, 12, 2))


def _normalize_mac(value: str) -> str:
    hexonly = value.strip().lower().replace("-", "").replace(":", "").replace(".", "")
    if not hexonly:
        return ""
    mac = _mac_or_empty(value)
    if not mac:
        raise HTTPException(400, "mac non valido")
    return mac


def _read_lines(path: str):
    try:
        handle = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    with handle:
        return handle.readlines()


def _parse_arp_hosts(lines: list[str]) -> list[dict]:
    found = []
    for line in lines:
        mac = ip = ""
        name_parts = []
        for part in line.split():
            if not ip and len(part.split(".")) == 4 and all(p.isdigit() and int(p) <= 255 for p in part.split(".")):
                if part.startswith(("224.", "239.", "255.")):
                    continue
                ip = part
                continue
            if not mac:
                parsed = _mac_or_empty(part)
                if parsed and parsed not in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff") and not parsed.startswith("01:00:5e"):
                    mac = parsed
                    continue
            name_parts.append(part)
        if mac and ip:
            found.append({"mac": mac, "ip": ip, "name": " ".join(name_parts)})
    return found


def _parse_lease_hosts(lines: list[str]) -> list[dict]:
    now = datetime.now(timezone.utc).timestamp()
    found = {}
    for line in lines:
        parts = line.split()
        if len(parts) < 3 or parts[0].startswith("#"):
            continue
        expiry, mac, ip = parts[0], _mac_or_empty(parts[1]), parts[2]
        if not mac or not _is_ipv4(ip):
            continue
        if expiry.isdigit() and int(expiry) not in (0,) and int(expiry) < now:
            continue
        name = parts[3] if len(parts) > 3 and parts[3] != "*" else ""
        found[mac] = {"mac": mac, "ip": ip, "name": name}
    return list(found.values())


def _file_clock(path: str):
    try:
        updated = datetime.fromtimestamp(os.stat(path).st_mtime, tz=timezone.utc)
    except OSError:
        return None
    age = (datetime.now(timezone.utc) - updated).total_seconds()
    return updated, age


def _discovery() -> dict:
    """Stato della fonte usata per elencare gli host della LAN.

    I lease, se configurati, sono l'unica fonte, come nel collector.
    Senza lease si legge la cache ARP. Una cache vecchia o vuota non
    dimostra che ogni host sia già in inventario.
    """
    if DHCP_LEASES_PATH:
        clock = _file_clock(DHCP_LEASES_PATH)
        if clock is None:
            return {"kind": "leases", "source": "missing", "updated_at": None, "hosts": []}
        updated, _age = clock
        lines = _read_lines(DHCP_LEASES_PATH) or []
        hosts = _parse_lease_hosts(lines)
        return {
            "kind": "leases",
            "source": "live" if hosts else "empty",
            "updated_at": updated.isoformat(),
            "hosts": hosts,
        }

    clock = _file_clock(ARP_CACHE_PATH)
    if clock is None:
        return {"kind": "arp", "source": "missing", "updated_at": None, "hosts": []}
    updated, age = clock
    hosts = _parse_arp_hosts(_read_lines(ARP_CACHE_PATH) or [])
    if not hosts:
        source = "empty"
    elif age > ARP_FRESH_SECONDS:
        source = "stale"
    else:
        source = "live"
    return {
        "kind": "arp",
        "source": source,
        "updated_at": updated.isoformat(),
        "hosts": hosts,
    }


def _neighbors():
    return _discovery()["hosts"]


def _normalize_host(value: str) -> str:
    host = value.strip()
    if not host:
        return ""
    octets = host.split(".")
    if len(octets) == 4 and all(part.isdigit() for part in octets):
        if any(int(part) > 255 for part in octets):
            raise HTTPException(400, "ip non valido")
        return host
    if not HOSTNAME_RE.fullmatch(host):
        raise HTTPException(400, "host non valido")
    return host


def _assert_mac_free(devices: list, mac: str, except_id: str | None = None) -> None:
    if not mac:
        return
    for device in devices:
        if except_id and _device_id(device) == except_id:
            continue
        if _mac_or_empty(device.get("mac") or "") == mac:
            raise HTTPException(409, f"MAC già usato da {device.get('name') or _device_id(device)}")


def _normalize_checks(raw: list[str] | None) -> list[str]:
    checks = []
    for item in raw or ["ping"]:
        if item not in checks:
            checks.append(item)
    if "ping" not in checks:
        checks.insert(0, "ping")
    if not set(checks) <= ALLOWED_CHECKS:
        raise HTTPException(400, "checks non validi")
    return checks


def _as_utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _is_ipv4(value: str) -> bool:
    parts = value.split(".")
    return len(parts) == 4 and all(part.isdigit() and int(part) <= 255 for part in parts)


def _target(host: str, mac: str) -> tuple[str, str]:
    host, mac = _normalize_host(host), _normalize_mac(mac)
    if not host and not mac:
        raise HTTPException(400, "serve un host oppure un MAC")
    return host, mac


def _devices_state():
    cfg = _read_config()["devices"]

    # ultimo stato noto per device
    status = {
        r["device"]: r.get_value()
        for r in _rows(f'''
            from(bucket: "{BUCKET}") |> range(start: -30d)
              |> filter(fn: (r) => r._measurement == "status")
              |> group(columns: ["device"]) |> last()''')
    }

    # ultimi controlli: la perdita in tabella è la media degli ultimi giri,
    # così un solo ping fallito non compare come 100% mentre lo stato è ancora UP
    samples = {}
    for r in _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -5m)
          |> filter(fn: (r) => r._measurement == "ping" and (r._field == "rtt_avg" or r._field == "loss"))
          |> group(columns: ["device"])'''):
        by_time = samples.setdefault(r["device"], {})
        slot = by_time.setdefault(r.get_time(), {})
        slot[r.get_field()] = r.get_value()

    ping = {}
    for device, by_time in samples.items():
        ordered = [by_time[t] for t in sorted(by_time)]
        recent = ordered[-LOSS_SAMPLES:]
        losses = [s["loss"] for s in recent if isinstance(s.get("loss"), (int, float))]
        latency = None
        for sample in reversed(ordered):
            loss = sample.get("loss")
            rtt = sample.get("rtt_avg")
            if isinstance(rtt, (int, float)) and not (isinstance(loss, (int, float)) and loss >= 100):
                latency = rtt
                break
        loss_pct = round(sum(losses) / len(losses), 1) if losses else None
        if isinstance(loss_pct, float) and loss_pct.is_integer():
            loss_pct = int(loss_pct)
        ping[device] = {
            "rtt_avg": latency,
            "loss": loss_pct,
            "time": max(by_time).isoformat(),
        }

    current_ip = {}
    for r in _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -5m)
          |> filter(fn: (r) => r._measurement == "current_ip" and r._field == "ip")
          |> group(columns: ["device"]) |> last()'''):
        value = r.get_value()
        if value and value != "-":
            current_ip[r["device"]] = value

    by_mac = {}
    by_ip = {}
    for neighbor in _neighbors():
        network_name = neighbor.get("name") or ""
        if not network_name:
            continue
        by_mac[neighbor["mac"]] = network_name
        by_ip.setdefault(neighbor["ip"], network_name)

    def _network_name(device: dict) -> str:
        mac = _mac_or_empty(device.get("mac") or "")
        if mac and mac in by_mac:
            return by_mac[mac]
        ip = current_ip.get(_device_id(device)) or ""
        host = (device.get("host") or "").strip()
        return by_ip.get(ip) or by_ip.get(host) or ""

    return [
        {
            "id": _device_id(d),
            "name": d["name"],
            "network_name": _network_name(d),
            "host": d.get("host") or "",
            "mac": d.get("mac") or "",
            "current_ip": current_ip.get(_device_id(d)),
            "status": status.get(_device_id(d), "LOADING"),
            "latency_ms": ping.get(_device_id(d), {}).get("rtt_avg"),
            "loss_pct": ping.get(_device_id(d), {}).get("loss"),
            "last_ping": ping.get(_device_id(d), {}).get("time"),
            "checks": d.get("checks") or ["ping"],
        }
        for d in cfg
    ]


def _uptime_report(hours: int):
    hours = max(1, min(int(hours), 168))
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=hours)
    baseline = {
        r["device"]: r.get_value()
        for r in _rows(f'''
            from(bucket: "{BUCKET}") |> range(start: -30d, stop: -{hours}h)
              |> filter(fn: (r) => r._measurement == "status" and r._field == "state")
              |> group(columns: ["device"]) |> last()''')
    }
    events: dict[str, list[tuple[datetime, str]]] = {}
    for r in _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -{hours}h)
          |> filter(fn: (r) => r._measurement == "status" and r._field == "state")
          |> group(columns: ["device"])'''):
        events.setdefault(r["device"], []).append((_as_utc(r.get_time()), r.get_value()))

    devices = []
    for device in _read_config()["devices"]:
        device_id = _device_id(device)
        points = sorted(events.get(device_id, []))
        state = baseline.get(device_id)
        if state is None and not points:
            devices.append({"id": device_id, "uptime_pct": None, "segments": []})
            continue
        if state is None:
            state = "UNKNOWN"
        cursor = window_start
        segments = []
        up_seconds = 0.0
        for moment, new_state in points:
            if moment < window_start:
                state = new_state
                continue
            if moment > now:
                break
            if moment > cursor:
                segments.append({
                    "start": cursor.isoformat(),
                    "end": moment.isoformat(),
                    "state": state,
                })
                if state == "UP":
                    up_seconds += (moment - cursor).total_seconds()
            state = new_state
            cursor = max(cursor, moment)
        if cursor < now:
            segments.append({
                "start": cursor.isoformat(),
                "end": now.isoformat(),
                "state": state,
            })
            if state == "UP":
                up_seconds += (now - cursor).total_seconds()
        total = (now - window_start).total_seconds()
        devices.append({
            "id": device_id,
            "uptime_pct": round(100 * up_seconds / total, 1) if total else None,
            "segments": segments,
        })
    return {"hours": hours, "devices": devices}


@app.get("/neighbors")
def neighbors():
    snap = _discovery()
    return {
        "kind": snap["kind"],
        "source": snap["source"],
        "updated_at": snap["updated_at"],
        "hosts": snap["hosts"],
    }


@app.post("/check")
def check_now():
    """Chiede al collector un giro di ping subito, su tutti i dispositivi."""
    req = Request(f"{COLLECTOR_URL}/check", data=b"", method="POST")
    try:
        with urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())
    except (URLError, TimeoutError, json.JSONDecodeError, OSError):
        raise HTTPException(502, "controllo dispositivi non riuscito")


@app.get("/devices")
def devices():
    return _devices_state()


@app.post("/devices", status_code=201)
def add_device(body: DeviceIn):
    name = body.name.strip()
    host, mac = _target(body.host, body.mac)
    if not name:
        raise HTTPException(400, "nome obbligatorio")
    if not DEVICE_NAME_RE.fullmatch(name):
        raise HTTPException(400, "nome non valido")
    checks = _normalize_checks(body.checks)

    data = _read_config()
    if any(d.get("name") == name for d in data["devices"]):
        raise HTTPException(409, "device già presente")
    _assert_mac_free(data["devices"], mac)

    device_id = uuid.uuid4().hex[:12]
    device = {"id": device_id, "name": name, "checks": checks}
    if host:
        device["host"] = host
    if mac:
        device["mac"] = mac
    data["devices"].append(device)
    _write_config(data)
    return {
        "id": device_id,
        "name": name,
        "host": host,
        "mac": mac,
        "current_ip": None,
        "status": "LOADING",
        "latency_ms": None,
        "loss_pct": None,
        "checks": checks,
    }


@app.patch("/devices/{device_id}")
def update_device(device_id: str, body: DeviceUpdate):
    if not DEVICE_NAME_RE.fullmatch(device_id):
        raise HTTPException(400, "id non valido")
    new_name = body.name.strip()
    host, mac = _target(body.host, body.mac)
    if not new_name:
        raise HTTPException(400, "nome obbligatorio")
    if not DEVICE_NAME_RE.fullmatch(new_name):
        raise HTTPException(400, "nome non valido")

    data = _read_config()
    current = next((d for d in data["devices"] if _device_id(d) == device_id), None)
    if current is None:
        raise HTTPException(404, "device non trovato")
    if new_name != current["name"] and any(d.get("name") == new_name for d in data["devices"]):
        raise HTTPException(409, "device già presente")
    _assert_mac_free(data["devices"], mac, device_id)

    current["id"] = device_id
    current["name"] = new_name
    if host:
        current["host"] = host
    else:
        current.pop("host", None)
    if mac:
        current["mac"] = mac
    else:
        current.pop("mac", None)
    if body.checks is not None:
        current["checks"] = _normalize_checks(body.checks)
    elif not current.get("checks"):
        current["checks"] = ["ping"]
    _write_config(data)
    return {
        "id": device_id,
        "name": new_name,
        "host": host,
        "mac": mac,
        "checks": current.get("checks") or ["ping"],
    }


@app.delete("/devices")
def delete_devices(body: DeviceDelete):
    ids = []
    for raw in body.ids:
        device_id = raw.strip()
        if not DEVICE_NAME_RE.fullmatch(device_id):
            raise HTTPException(400, "id non valido")
        ids.append(device_id)

    data = _read_config()
    drop = set(ids)
    kept = [d for d in data["devices"] if _device_id(d) not in drop]
    removed = len(data["devices"]) - len(kept)
    if removed == 0:
        raise HTTPException(404, "nessun device trovato")
    data["devices"] = kept
    _write_config(data)
    return {"removed": removed}


@app.get("/radar")
def radar():
    known_macs = set()
    known_ips = set()
    for device in _read_config()["devices"]:
        mac = _mac_or_empty(device.get("mac") or "")
        if mac:
            known_macs.add(mac)
        host = (device.get("host") or "").strip()
        if host and _is_ipv4(host):
            known_ips.add(host)
    for row in _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -5m)
          |> filter(fn: (r) => r._measurement == "current_ip" and r._field == "ip")
          |> group(columns: ["device"]) |> last()'''):
        value = row.get_value()
        if value and value != "-" and _is_ipv4(str(value)):
            known_ips.add(str(value))
    snap = _discovery()
    seen = {}
    for neighbor in snap["hosts"]:
        seen[neighbor["mac"]] = neighbor
    unknown = [
        {"mac": mac, "ip": item["ip"], "name": item.get("name") or ""}
        for mac, item in seen.items()
        if mac not in known_macs and item["ip"] not in known_ips
    ]
    unknown.sort(key=lambda item: tuple(int(part) for part in item["ip"].split(".")))
    return {
        "kind": snap["kind"],
        "source": snap["source"],
        "updated_at": snap["updated_at"],
        "seen": len(seen),
        "unknown": unknown,
    }


@app.get("/uptime")
def uptime(hours: int = 24):
    return _uptime_report(hours)


@app.get("/summary")
def summary():
    devs = _devices_state()
    online = [d for d in devs if d["status"] == "UP"]
    lat = [d["latency_ms"] for d in online if d["latency_ms"] is not None]
    loss = [d["loss_pct"] for d in devs if d["loss_pct"] is not None]
    return {
        "total": len(devs),
        "online": len(online),
        "offline": sum(d["status"] == "DOWN" for d in devs),
        "unknown": sum(d["status"] in ("UNKNOWN", "LOADING", "UNRESOLVED") for d in devs),
        "avg_latency_ms": round(sum(lat) / len(lat), 1) if lat else None,
        "avg_loss_pct": round(sum(loss) / len(loss), 2) if loss else None,
    }


@app.get("/alerts")
def alerts(limit: int = 50, device: str | None = None):
    limit = max(1, min(int(limit), 200))
    device_filter = ""
    if device is not None:
        if not DEVICE_NAME_RE.fullmatch(device):
            raise HTTPException(400, "id non valido")
        device_filter = f' and r.device == "{device}"'
    rows = _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -30d)
          |> filter(fn: (r) => r._measurement == "status"{device_filter})
          |> group() |> sort(columns: ["_time"], desc: true) |> limit(n: {limit})''')
    names = {_device_id(d): d["name"] for d in _read_config()["devices"]}
    return [
        {"t": r.get_time().isoformat(), "device": names.get(r["device"], r["device"]), "state": r.get_value()}
        for r in rows
    ]


def _latency_range(hours: int | None, start: str | None, every: str) -> tuple[str, str]:
    if start:
        if not LATENCY_START_RE.fullmatch(start) or every not in LATENCY_EVERY:
            raise HTTPException(400, "intervallo non valido")
        if start.startswith("-"):
            return start, every
        moment = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(timezone.utc)
        return moment.strftime("%Y-%m-%dT%H:%M:%SZ"), every
    window = 24 if hours is None else max(1, min(int(hours), 168))
    return f"-{window}h", "5m"


@app.get("/devices/{device_id}/latency")
def latency(device_id: str, hours: int | None = None, start: str | None = None, every: str = "5m"):
    if not DEVICE_NAME_RE.fullmatch(device_id):
        raise HTTPException(400, "id non valido")
    range_start, window = _latency_range(hours, start, every)
    q = f'''
    from(bucket: "{BUCKET}")
      |> range(start: {range_start})
      |> filter(fn: (r) => r._measurement == "ping" and r.device == "{device_id}" and r._field == "rtt_avg")
      |> aggregateWindow(every: {window}, fn: mean, createEmpty: false)
    '''
    tables = client.query_api().query(q)
    return [{"t": r.get_time().isoformat(), "ms": r.get_value()} for t in tables for r in t.records]


@app.get("/devices/{device_id}/traffic")
def traffic(device_id: str, hours: int | None = None, start: str | None = None, every: str = "5m"):
    if not DEVICE_NAME_RE.fullmatch(device_id):
        raise HTTPException(400, "id non valido")
    range_start, window = _latency_range(hours, start, every)
    slots = {}
    for r in _rows(f'''
        from(bucket: "{BUCKET}")
          |> range(start: {range_start})
          |> filter(fn: (r) => r._measurement == "traffic" and r.device == "{device_id}" and (r._field == "in_bps" or r._field == "out_bps"))
          |> aggregateWindow(every: {window}, fn: mean, createEmpty: false)'''):
        iface = r.values.get("iface") or "traffic"
        slots.setdefault((r.get_time(), iface), {})[r.get_field()] = r.get_value()
    return [
        {
            "t": moment.isoformat(),
            "iface": iface,
            "in_bps": fields.get("in_bps"),
            "out_bps": fields.get("out_bps"),
        }
        for (moment, iface), fields in sorted(slots.items(), key=lambda item: (item[0][0], item[0][1]))
    ]

# TODO: /logs
