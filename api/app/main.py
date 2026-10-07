import os
import yaml
from fastapi import FastAPI, HTTPException
from influxdb_client import InfluxDBClient
from pydantic import BaseModel, Field

app = FastAPI(title="Mini NMS API")

client = InfluxDBClient(
    url=os.getenv("INFLUX_URL", "http://influxdb:8086"),
    token=os.environ["INFLUX_TOKEN"],
    org=os.environ["INFLUX_ORG"],
)
BUCKET = os.environ["INFLUX_BUCKET"]
DEVICES_PATH = "/config/devices.yml"
ALLOWED_CHECKS = {"ping", "snmp"}


@app.get("/health")
def health():
    return {"status": "ok"}


def _rows(flux):
    return [r for t in client.query_api().query(flux) for r in t.records]


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

    # ultima latenza/loss negli ultimi 5 minuti
    ping = {}
    for r in _rows(f'''
        from(bucket: "{BUCKET}") |> range(start: -5m)
          |> filter(fn: (r) => r._measurement == "ping" and (r._field == "rtt_avg" or r._field == "loss"))
          |> last()'''):
        ping.setdefault(r["device"], {})[r.get_field()] = r.get_value()

    return [
        {
            "name": d["name"],
            "host": d["host"],
            "status": status.get(d["name"], "UNKNOWN"),
            "latency_ms": ping.get(d["name"], {}).get("rtt_avg"),
            "loss_pct": ping.get(d["name"], {}).get("loss"),
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
    if not all(c.isalnum() or c in "-_." for c in name):
        raise HTTPException(400, "nome non valido")
    checks = body.checks or ["ping"]
    if not set(checks) <= ALLOWED_CHECKS:
        raise HTTPException(400, "checks non validi")

    data = _read_config()
    if any(d.get("name") == name for d in data["devices"]):
        raise HTTPException(409, "device già presente")

    data["devices"].append({"name": name, "host": host, "checks": checks})
    _write_config(data)
    return {
        "name": name,
        "host": host,
        "status": "UNKNOWN",
        "latency_ms": None,
        "loss_pct": None,
    }


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
    return [{"t": r.get_time().isoformat(), "device": r["device"], "state": r.get_value()} for r in rows]


@app.get("/devices/{name}/latency")
def latency(name: str, hours: int = 24):
    safe = "".join(c for c in name if c.isalnum() or c in "-_.")
    q = f'''
    from(bucket: "{BUCKET}")
      |> range(start: -{int(hours)}h)
      |> filter(fn: (r) => r._measurement == "ping" and r.device == "{safe}" and r._field == "rtt_avg")
      |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
    '''
    tables = client.query_api().query(q)
    return [{"t": r.get_time().isoformat(), "ms": r.get_value()} for t in tables for r in t.records]

# TODO: /logs
