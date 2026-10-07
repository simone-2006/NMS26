"""Risolve il MAC nell'IP confermato in questo ciclo.

I lease DHCP, se configurati, sono l'unica fonte: un MAC assente dal lease
non viene cercato in ARP, perché quella voce può essere l'indirizzo vecchio.
Senza file di lease si usa solo la tabella ARP del sistema.
"""

import time

from . import config

_leases_warned = False


def normalize_mac(value: str) -> str:
    hexonly = value.strip().lower().replace("-", "").replace(":", "").replace(".", "")
    if len(hexonly) != 12 or any(c not in "0123456789abcdef" for c in hexonly):
        return ""
    return ":".join(hexonly[i:i + 2] for i in range(0, 12, 2))


def is_ipv4(value: str) -> bool:
    parts = value.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit():
            return False
        number = int(part)
        if number > 255:
            return False
    return True


def _read_leases():
    """None se i lease non sono configurati. Dict (anche vuoto) se lo sono."""
    global _leases_warned
    path = config.DHCP_LEASES_PATH
    if not path:
        return None
    try:
        lines = open(path, encoding="utf-8", errors="replace")
    except OSError as exc:
        if not _leases_warned:
            print(f"[WARN] lease DHCP {path}: {exc!r}")
            _leases_warned = True
        return {}

    now = time.time()
    found = {}
    with lines:
        for line in lines:
            parts = line.split()
            if len(parts) < 3 or parts[0].startswith("#"):
                continue
            expiry, mac, ip = parts[0], normalize_mac(parts[1]), parts[2]
            if not mac or not is_ipv4(ip):
                continue
            if expiry.isdigit() and int(expiry) not in (0,) and int(expiry) < now:
                continue
            found[mac] = ip
    return found


def _pair_mac_ip(parts: list[str]) -> tuple[str, str]:
    mac = ip = ""
    for part in parts:
        if not ip and is_ipv4(part) and not part.startswith(("224.", "239.", "255.")):
            ip = part
            continue
        if not mac:
            parsed = normalize_mac(part)
            if parsed:
                mac = parsed
    return mac, ip


def _read_cache(path: str):
    """None se il file non c'è. Dict (anche vuoto) se c'è."""
    try:
        lines = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return None
    found = {}
    with lines:
        for line in lines:
            mac, ip = _pair_mac_ip(line.split())
            if mac and ip:
                found[mac] = ip
    return found


def _read_arp():
    found = {}
    try:
        lines = open("/proc/net/arp", encoding="utf-8", errors="replace")
    except OSError:
        return found
    with lines:
        next(lines, None)
        for line in lines:
            parts = line.split()
            if len(parts) < 4:
                continue
            ip, _hw, flags, mac = parts[0], parts[1], parts[2], normalize_mac(parts[3])
            if flags == "0x0" or not mac or not is_ipv4(ip):
                continue
            found[mac] = ip
    return found


def confirmed_ips() -> dict[str, str]:
    leases = _read_leases()
    if leases is not None:
        return leases
    if config.ARP_CACHE_PATH:
        cache = _read_cache(config.ARP_CACHE_PATH)
        if cache is not None:
            return cache
    return _read_arp()
