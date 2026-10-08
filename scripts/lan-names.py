"""Nomi annunciati in LAN, gli stessi che spesso compaiono sul router.

mDNS (stampanti, NAS, TV, Apple) e, per chi non risponde, NetBIOS (PC Windows).
Legge gli IP da config/arp-cache.txt e scrive config/lan-names.txt.
"""

import re
import socket
import struct
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARP_PATH = ROOT / "config" / "arp-cache.txt"
OUT_PATH = ROOT / "config" / "lan-names.txt"

SERVICES = [
    "_workstation._tcp.local",
    "_ipp._tcp.local",
    "_printer._tcp.local",
    "_ipps._tcp.local",
    "_airplay._tcp.local",
    "_raop._tcp.local",
    "_googlecast._tcp.local",
    "_companion-link._tcp.local",
    "_hap._tcp.local",
    "_http._tcp.local",
    "_smb._tcp.local",
    "_device-info._tcp.local",
    "_scanner._tcp.local",
    "_apple-mobdev2._tcp.local",
]

_MAC_SUFFIX = re.compile(r"\s*\[[0-9a-fA-F:.-]{11,}]")
_SKIP_NB = {"WORKGROUP", "MSHOME", "MSBROWSE", "__MSBROWSE__"}


def _encode_name(name: str) -> bytes:
    out = b""
    for label in name.split("."):
        if not label:
            continue
        raw = label.encode()
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def _decode_name(data: bytes, offset: int) -> tuple[str, int]:
    labels = []
    jumped = False
    start = offset
    seen = 0
    while offset < len(data) and seen < 30:
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                break
            pointer = ((length & 0x3F) << 8) | data[offset + 1]
            if not jumped:
                start = offset + 2
            offset = pointer
            jumped = True
            seen += 1
            continue
        offset += 1
        labels.append(data[offset:offset + length].decode("utf-8", "replace"))
        offset += length
        seen += 1
    return ".".join(labels), (start if jumped else offset)


def _query(name: str) -> bytes:
    return struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0) + _encode_name(name) + struct.pack(">HH", 12, 1)


def _parse_dns(data: bytes) -> list[tuple]:
    if len(data) < 12:
        return []
    qd, an, ns, ar = struct.unpack(">HHHHHH", data[:12])[2:6]
    offset = 12
    for _ in range(qd):
        _, offset = _decode_name(data, offset)
        offset += 4
    found = []
    for _ in range(an + ns + ar):
        if offset >= len(data):
            break
        name, offset = _decode_name(data, offset)
        if offset + 10 > len(data):
            break
        typ, _cls, _ttl, rdlen = struct.unpack(">HHIH", data[offset:offset + 10])
        offset += 10
        start = offset
        offset += rdlen
        if typ == 12:
            host, _ = _decode_name(data, start)
            found.append(("PTR", host))
        elif typ == 1 and rdlen == 4:
            ip = ".".join(str(b) for b in data[start:start + 4])
            found.append(("A", name, ip))
    return found


def _pretty(label: str) -> str:
    if "@" in label:
        label = label.split("@", 1)[1]
    label = _MAC_SUFFIX.sub("", label).strip().strip(".")
    if not label or label.startswith("_") or label.lower() in {"localhost", "local"}:
        return ""
    return label.replace("\t", " ").replace("\n", " ").strip()


def _instance(ptr: str) -> str:
    if "._" not in ptr:
        return ""
    return _pretty(ptr.split(".", 1)[0])


def _rank(name: str) -> tuple:
    score = 0
    if " " in name:
        score += 3
    if name != name.upper():
        score += 2
    return (score, len(name))


def _best(names: set[str]) -> str:
    if not names:
        return ""
    chosen = set()
    for name in names:
        base = name.split("(", 1)[0]
        if name != base and base in names:
            continue
        chosen.add(name)
    return max(chosen or names, key=_rank)


def _ips_from_arp() -> list[str]:
    if not ARP_PATH.exists():
        return []
    found = []
    seen = set()
    for line in ARP_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        for part in line.split():
            bits = part.split(".")
            if len(bits) == 4 and all(bit.isdigit() and int(bit) <= 255 for bit in bits):
                if part not in seen and not part.startswith(("224.", "239.", "255.")):
                    seen.add(part)
                    found.append(part)
                break
    return found


def _mdns(ips: list[str]) -> dict[str, set[str]]:
    names: dict[str, set[str]] = {ip: set() for ip in ips}
    wanted = set(ips)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", 0))
        sock.settimeout(0.2)
        sock.setsockopt(
            socket.IPPROTO_IP,
            socket.IP_ADD_MEMBERSHIP,
            socket.inet_aton("224.0.0.251") + socket.inet_aton("0.0.0.0"),
        )
        for service in SERVICES:
            sock.sendto(_query(service), ("224.0.0.251", 5353))
        for ip in ips:
            reverse = ".".join(reversed(ip.split("."))) + ".in-addr.arpa"
            sock.sendto(_query(reverse), ("224.0.0.251", 5353))
        deadline = time.time() + 2.2
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            source = addr[0]
            for item in _parse_dns(data):
                if item[0] == "PTR":
                    label = _instance(item[1])
                    if label and source in wanted:
                        names[source].add(label)
                elif item[0] == "A" and item[2] in wanted:
                    host = item[1]
                    if host.endswith(".local"):
                        host = host[: -len(".local")]
                    host = _pretty(host)
                    if host:
                        names[item[2]].add(host)
    finally:
        sock.close()
    return names


def _netbios_name(payload: bytes) -> str:
    """Il nome workstation sta nella tabella della risposta, non nell'eco della query."""
    if len(payload) < 57 or payload[12:13] != b"\x20":
        return ""
    offset = 12 + 34
    if payload[offset:offset + 2] != b"\x00\x21":
        return ""
    offset += 8
    if offset + 3 > len(payload):
        return ""
    offset += 2
    count = payload[offset]
    offset += 1
    found = []
    for _ in range(count):
        if offset + 18 > len(payload):
            break
        raw = payload[offset:offset + 15]
        suffix = payload[offset + 15]
        flags = struct.unpack(">H", payload[offset + 16:offset + 18])[0]
        offset += 18
        if flags & 0x8000 or suffix not in (0x00, 0x20):
            continue
        try:
            name = raw.decode("ascii").strip()
        except UnicodeDecodeError:
            continue
        if len(name) < 2 or name.upper() in _SKIP_NB or set(name) <= {"A"}:
            continue
        if not all(ch.isalnum() or ch in "-_" for ch in name):
            continue
        if name not in found:
            found.append(name)
    return found[0] if found else ""


def _netbios(ips: list[str]) -> dict[str, str]:
    if not ips:
        return {}
    packet = b"\x82\x28\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00" + b"\x20CK" + b"A" * 30 + b"\x00\x00\x21\x00\x01"
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    found = {}
    try:
        sock.settimeout(0.3)
        for ip in ips:
            try:
                sock.sendto(packet, (ip, 137))
            except OSError:
                continue
        deadline = time.time() + 1.0
        while time.time() < deadline:
            try:
                data, addr = sock.recvfrom(2048)
            except socket.timeout:
                break
            name = _netbios_name(data)
            if name and addr[0] in ips and addr[0] not in found:
                found[addr[0]] = name
    finally:
        sock.close()
    return found


def main():
    ips = _ips_from_arp()
    if not ips:
        return
    named = _mdns(ips)
    missing = [ip for ip in ips if not named[ip]]
    fallback = _netbios(missing)
    lines = []
    for ip in ips:
        name = _best(named[ip]) or fallback.get(ip, "")
        if name:
            lines.append(f"{ip}\t{name}")
    text = ("\n".join(lines) + "\n") if lines else ""
    tmp = OUT_PATH.with_suffix(".txt.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(OUT_PATH)


if __name__ == "__main__":
    main()
