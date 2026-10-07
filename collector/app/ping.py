import itertools

from icmplib import async_ping

# Ogni ping in parallelo deve avere un id ICMP diverso: altrimenti le risposte
# si mescolano e un host vivo risulta con il 100% di perdita.
_icmp_ids = itertools.count(1)


def _icmp_id() -> int:
    return (next(_icmp_ids) % 65535) + 1


async def ping_host(host: str, count: int):
    """Ritorna dict con alive, rtt_avg (ms), loss (%)."""
    r = await async_ping(host, count=count, interval=0.2, timeout=2, id=_icmp_id(), privileged=True)
    return {
        "alive": r.is_alive,
        "rtt_avg": r.avg_rtt,
        "rtt_min": r.min_rtt,
        "rtt_max": r.max_rtt,
        "loss": r.packet_loss * 100,
        "address": r.address,
    }
