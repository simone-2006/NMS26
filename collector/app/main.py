import asyncio
import json
import os

from . import config
from .ping import ping_host
from .resolve import confirmed_ips, is_ipv4, normalize_mac
from .state import DeviceState
from .snmp import poll_interfaces
from .storage import write_current_ip, write_ping, write_status, write_traffic
from .notifier import notify

states: dict[str, DeviceState] = {}
_devices: list = []
_lock = asyncio.Lock()
CHECK_PORT = int(os.getenv("CHECK_PORT", "8010"))


async def _record(device_id: str, name: str, label: str, st: DeviceState, measured: dict | None, current_ip: str):
    prev = st.status
    if measured is None:
        change = st.update(False, config.DOWN_AFTER, config.UP_AFTER)
    else:
        await write_ping(device_id, label, measured)
        change = st.update(measured["alive"], config.DOWN_AFTER, config.UP_AFTER)
    await write_current_ip(device_id, current_ip)
    if st.status != prev:
        await write_status(device_id, label, st.status)
    if change == "DOWN":
        await notify(f"🔴 {name} ({label}) è DOWN")
    elif change == "UP":
        await notify(f"🟢 {name} ({label}) è tornato UP")


async def check_device(dev: dict, by_mac: dict[str, str]):
    name = dev["name"]
    device_id = dev.get("id") or name
    host = (dev.get("host") or "").strip()
    mac = normalize_mac(dev.get("mac") or "")
    st = states.setdefault(device_id, DeviceState())

    if "ping" not in dev.get("checks", ["ping"]):
        return

    if host:
        try:
            measured = await ping_host(host, config.PING_COUNT)
        except Exception as exc:
            print(f"[ERROR] {name}: {exc!r}")
            await _record(device_id, name, host, st, None, "")
            return
        address = measured.get("address") or ""
        current = address if is_ipv4(address) else (host if is_ipv4(host) else "")
        await _record(device_id, name, current or host, st, measured, current)
        await _poll_snmp(dev, current)
        return

    if not mac:
        print(f"[ERROR] {name}: manca host e MAC")
        return

    ip = by_mac.get(mac, "")
    if not ip:
        prev = st.status
        st.mark_unresolved()
        await write_current_ip(device_id, "")
        if st.status != prev:
            await write_status(device_id, mac, st.status)
        return

    try:
        measured = await ping_host(ip, config.PING_COUNT)
    except Exception as exc:
        print(f"[ERROR] {name}: {exc!r}")
        await _record(device_id, name, ip, st, None, ip)
        return
    await _record(device_id, name, ip, st, measured, ip)
    await _poll_snmp(dev, ip)


async def _poll_snmp(dev: dict, ip: str):
    if "snmp" not in dev.get("checks", []) or not ip:
        return
    try:
        samples = await poll_interfaces({**dev, "host": ip})
    except Exception as exc:
        print(f"[ERROR] {dev['name']} snmp: {exc!r}")
        return
    device_id = dev.get("id") or dev["name"]
    for sample in samples:
        await write_traffic(device_id, sample["iface"], sample["in_bps"], sample["out_bps"])


async def run_once() -> int:
    """Un giro di ping su tutti i dispositivi. Un solo giro alla volta."""
    global _devices
    async with _lock:
        try:
            _devices = config.load_devices()
        except Exception as e:
            print(f"[ERROR] config: {e!r}")
        by_mac = confirmed_ips()
        results = await asyncio.gather(*(check_device(d, by_mac) for d in _devices), return_exceptions=True)
        for d, r in zip(_devices, results):
            if isinstance(r, Exception):
                print(f"[ERROR] {d['name']}: {r!r}")
        return len(_devices)


async def _reply(writer, status: int, payload: dict):
    body = json.dumps(payload).encode()
    reason = {200: "OK", 404: "Not Found", 500: "Error"}.get(status, "Error")
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n".encode()
        + body
    )
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def handle_check(reader, writer):
    try:
        data = await asyncio.wait_for(reader.read(4096), timeout=5)
    except Exception:
        writer.close()
        return
    if not data.split(b"\r\n", 1)[0].startswith(b"POST /check"):
        await _reply(writer, 404, {"error": "not found"})
        return
    try:
        checked = await run_once()
    except Exception as exc:
        print(f"[ERROR] check: {exc!r}")
        await _reply(writer, 500, {"error": "check failed"})
        return
    await _reply(writer, 200, {"checked": checked})


async def main():
    server = await asyncio.start_server(handle_check, "0.0.0.0", CHECK_PORT)
    async with server:
        while True:
            try:
                await run_once()
            except Exception as e:
                print(f"[ERROR] ciclo: {e!r}")
            await asyncio.sleep(config.INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
