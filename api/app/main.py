import json
import os
import re
import uuid
from datetime import datetime, timezone
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
    with open(DEVICES_PATH) as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        data = {}
    devices = data.get("devices") or []
    data["devices"] = devices
    return data


def _write_config(data):
    tmp = DEVICES_PATH + ".tmp"
    with open(tmp, "w") as f:
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


def _neighbors():
    try:
        handle = open(ARP_CACHE_PATH, encoding="utf-8", errors="replace")
    except OSError:
        return []
    found = []
    with handle:
        for line in handle:
            mac = ip = ""
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
            if mac and ip:
                found.append({"mac": mac, "ip": ip})
    return found


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

    return [
        {
            "id": _device_id(d),
            "name": d["name"],
            "host": d.get("host") or "",
            "mac": d.get("mac") or "",
            "current_ip": current_ip.get(_device_id(d)),
            "status": status.get(_device_id(d), "LOADING"),
            "latency_ms": ping.get(_device_id(d), {}).get("rtt_avg"),
            "loss_pct": ping.get(_device_id(d), {}).get("loss"),
            "last_ping": ping.get(_device_id(d), {}).get("time"),
        }
        for d in cfg
    ]


@app.get("/neighbors")
def neighbors():
    return _neighbors()


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
    checks = body.checks or ["ping"]
    if not set(checks) <= ALLOWED_CHECKS:
        raise HTTPException(400, "checks non validi")

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
    _write_config(data)
    return {"id": device_id, "name": new_name, "host": host, "mac": mac}


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

# TODO: /logs
