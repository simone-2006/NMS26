import asyncio
from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS
from . import config

_client = InfluxDBClient(url=config.INFLUX_URL, token=config.INFLUX_TOKEN, org=config.INFLUX_ORG)
_write = _client.write_api(write_options=SYNCHRONOUS)


async def write_ping(device: str, host: str, r: dict):
    p = (
        Point("ping").tag("device", device).tag("host", host)
        .field("alive", int(r["alive"]))
        .field("loss", float(r["loss"]))
    )
    if r["alive"]:
        p.field("rtt_avg", float(r["rtt_avg"]))
    await asyncio.to_thread(_write.write, config.INFLUX_BUCKET, config.INFLUX_ORG, p)


async def write_current_ip(device: str, ip: str):
    p = Point("current_ip").tag("device", device).field("ip", ip or "-")
    await asyncio.to_thread(_write.write, config.INFLUX_BUCKET, config.INFLUX_ORG, p)


async def write_traffic(device: str, iface: str, in_bps: float, out_bps: float):
    p = (
        Point("traffic").tag("device", device).tag("iface", iface)
        .field("in_bps", float(in_bps))
        .field("out_bps", float(out_bps))
    )
    await asyncio.to_thread(_write.write, config.INFLUX_BUCKET, config.INFLUX_ORG, p)


async def write_status(device: str, host: str, state: str):
    p = Point("status").tag("device", device).tag("host", host).field("state", state)
    await asyncio.to_thread(_write.write, config.INFLUX_BUCKET, config.INFLUX_ORG, p)
