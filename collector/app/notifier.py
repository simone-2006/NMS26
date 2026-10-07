import httpx
from . import config


async def notify(text: str):
    if not (config.TG_TOKEN and config.TG_CHAT):
        print(f"[ALERT] {text}")
        return
    url = f"https://api.telegram.org/bot{config.TG_TOKEN}/sendMessage"
    async with httpx.AsyncClient(timeout=10) as c:
        await c.post(url, json={"chat_id": config.TG_CHAT, "text": text})
