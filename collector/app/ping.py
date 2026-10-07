from icmplib import async_ping


async def ping_host(host: str, count: int):
    """Ritorna dict con alive, rtt_avg (ms), loss (%)."""
    r = await async_ping(host, count=count, interval=0.2, timeout=2, privileged=True)
    return {
        "alive": r.is_alive,
        "rtt_avg": r.avg_rtt,
        "rtt_min": r.min_rtt,
        "rtt_max": r.max_rtt,
        "loss": r.packet_loss * 100,
    }
