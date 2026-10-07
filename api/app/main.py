import os
import re
import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager

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
ALLOWED_CHECKS = {"ping", "snmp"}
DEVICE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
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
    host: str = Field(min_length=1)
    checks: list[str] = ["ping"]


class DeviceDelete(BaseModel):
    ids: list[str] = Field(min_length=1)


class DeviceUpdate(BaseModel):
    name: str = Field(min_length=1)
    host: str = Field(min_length=1)


def _device_id(device: dict) -> str:
    return device.get("id") or device["name"]


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

    # ultima latenza/loss negli ultimi 5 minuti (per device e per field)
    ping = {}
    for r in _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -5m)
          |> filter(fn: (r) => r._measurement == "ping" and (r._field == "rtt_avg" or r._field == "loss"))
          |> group(columns: ["device", "_field"]) |> last()'''):
        slot = ping.setdefault(r["device"], {})
        slot[r.get_field()] = r.get_value()
        if r.get_field() == "rtt_avg":
            slot["time"] = r.get_time().isoformat()

    return [
        {
            "id": _device_id(d),
            "name": d["name"],
            "host": d["host"],
            "status": status.get(_device_id(d), "UNKNOWN"),
            "latency_ms": ping.get(_device_id(d), {}).get("rtt_avg"),
            "loss_pct": ping.get(_device_id(d), {}).get("loss"),
            "last_ping": ping.get(_device_id(d), {}).get("time"),
        }
        for d in cfg
    ]


@app.get("/devices")
def devices():
    return _devices_state()


@app.post("/devices", status_code=201)
def add_device(body: DeviceIn):
    name, host = body.name.strip(), body.host.strip()
    if not name or not host:
        raise HTTPException(400, "nome e host obbligatori")
    if not DEVICE_NAME_RE.fullmatch(name):
        raise HTTPException(400, "nome non valido")
    checks = body.checks or ["ping"]
    if not set(checks) <= ALLOWED_CHECKS:
        raise HTTPException(400, "checks non validi")

    data = _read_config()
    if any(d.get("name") == name for d in data["devices"]):
        raise HTTPException(409, "device già presente")

    device_id = uuid.uuid4().hex[:12]
    data["devices"].append({"id": device_id, "name": name, "host": host, "checks": checks})
    _write_config(data)
    return {
        "id": device_id,
        "name": name,
        "host": host,
        "status": "UNKNOWN",
        "latency_ms": None,
        "loss_pct": None,
    }


@app.patch("/devices/{device_id}")
def update_device(device_id: str, body: DeviceUpdate):
    if not DEVICE_NAME_RE.fullmatch(device_id):
        raise HTTPException(400, "id non valido")
    new_name, host = body.name.strip(), body.host.strip()
    if not new_name or not host:
        raise HTTPException(400, "nome e host obbligatori")
    if not DEVICE_NAME_RE.fullmatch(new_name):
        raise HTTPException(400, "nome non valido")

    data = _read_config()
    current = next((d for d in data["devices"] if _device_id(d) == device_id), None)
    if current is None:
        raise HTTPException(404, "device non trovato")
    if new_name != current["name"] and any(d.get("name") == new_name for d in data["devices"]):
        raise HTTPException(409, "device già presente")

    current["id"] = device_id
    current["name"] = new_name
    current["host"] = host
    _write_config(data)
    return {"id": device_id, "name": new_name, "host": host}


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
        "unknown": sum(d["status"] == "UNKNOWN" for d in devs),
        "avg_latency_ms": round(sum(lat) / len(lat), 1) if lat else None,
        "avg_loss_pct": round(sum(loss) / len(loss), 2) if loss else None,
    }


@app.get("/alerts")
def alerts(limit: int = 50):
    rows = _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -30d)
          |> filter(fn: (r) => r._measurement == "status")
          |> group() |> sort(columns: ["_time"], desc: true) |> limit(n: {int(limit)})''')
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
