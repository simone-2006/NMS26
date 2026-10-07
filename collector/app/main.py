import asyncio
from . import config
from .ping import ping_host
from .state import DeviceState
from .storage import write_ping, write_status
from .notifier import notify

states: dict[str, DeviceState] = {}


async def check_device(dev: dict):
    name, host = dev["name"], dev["host"]
    st = states.setdefault(name, DeviceState())

    if "ping" in dev.get("checks", ["ping"]):
        r = await ping_host(host, config.PING_COUNT)
        await write_ping(name, host, r)
        prev = st.status
        change = st.update(r["alive"], config.DOWN_AFTER, config.UP_AFTER)
        if st.status != prev:
            await write_status(name, host, st.status)
        if change == "DOWN":
            await notify(f"🔴 {name} ({host}) è DOWN")
        elif change == "UP":
            await notify(f"🟢 {name} ({host}) è tornato UP")

    # TODO: if "snmp" in dev["checks"]: poll_interfaces / poll_system -> storage


async def main():
    devices = []
    while True:
        try:
            devices = config.load_devices()
        except Exception as e:
            print(f"[ERROR] config: {e!r}")
        results = await asyncio.gather(*(check_device(d) for d in devices), return_exceptions=True)
        for d, r in zip(devices, results):
            if isinstance(r, Exception):
                print(f"[ERROR] {d['name']}: {r!r}")
        await asyncio.sleep(config.INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
