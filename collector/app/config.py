import os
import yaml

INFLUX_URL = os.getenv("INFLUX_URL", "http://influxdb:8086")
INFLUX_TOKEN = os.environ["INFLUX_TOKEN"]
INFLUX_ORG = os.environ["INFLUX_ORG"]
INFLUX_BUCKET = os.environ["INFLUX_BUCKET"]

TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.getenv("TELEGRAM_CHAT_ID", "")

INTERVAL = int(os.getenv("CHECK_INTERVAL", 30))
PING_COUNT = int(os.getenv("PING_COUNT", 5))
DOWN_AFTER = int(os.getenv("DOWN_AFTER_FAILS", 3))
UP_AFTER = int(os.getenv("UP_AFTER_OKS", 2))


def load_devices(path="/config/devices.yml"):
    with open(path) as f:
        return yaml.safe_load(f)["devices"]
