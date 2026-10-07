import os
import yaml


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            f"Set it in the environment or .env before starting the collector."
        )
    return value


INFLUX_URL = os.getenv("INFLUX_URL", "http://influxdb:8086")
INFLUX_TOKEN = _require_env("INFLUX_TOKEN")
INFLUX_ORG = _require_env("INFLUX_ORG")
INFLUX_BUCKET = _require_env("INFLUX_BUCKET")

TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.getenv("TELEGRAM_CHAT_ID", "")

DHCP_LEASES_PATH = os.getenv("DHCP_LEASES_PATH", "")
ARP_CACHE_PATH = os.getenv("ARP_CACHE_PATH", "/config/arp-cache.txt")
INTERVAL = int(os.getenv("CHECK_INTERVAL", 30))
PING_COUNT = int(os.getenv("PING_COUNT", 5))
DOWN_AFTER = int(os.getenv("DOWN_AFTER_FAILS", 3))
UP_AFTER = int(os.getenv("UP_AFTER_OKS", 2))


def load_devices(path="/config/devices.yml"):
    with open(path) as f:
        return yaml.safe_load(f)["devices"]
