"""Raccolta SNMP dei contatori di interfaccia.

Il rate sui contatori è la parte delicata: il wraparound va sommato,
un reset del device no, altrimenti un reboot sembra un picco di traffico.
"""

import asyncio

from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData,
    ContextData,
    ObjectIdentity,
    ObjectType,
    SnmpEngine,
    UdpTransportTarget,
    bulk_walk_cmd,
    walk_cmd,
)

from . import config

# ifXTable (64 bit) e, in fallback, ifTable (32 bit).
_HC_IN = "1.3.6.1.2.1.31.1.1.1.6"
_HC_OUT = "1.3.6.1.2.1.31.1.1.1.10"
_IF_NAME = "1.3.6.1.2.1.31.1.1.1.1"
_IN = "1.3.6.1.2.1.2.2.1.10"
_OUT = "1.3.6.1.2.1.2.2.1.16"
_IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
_IF_OPER = "1.3.6.1.2.1.2.2.1.8"

# (device_id, ifindex) -> (octets_in, octets_out, monotonic time)
_prev: dict[tuple[str, int], tuple[int, int, float]] = {}

# Oltre questa soglia il salto è un reset del contatore, non traffico reale.
_MAX_BPS = 100_000_000_000


def counter_rate(prev: int, curr: int, dt: float, bits: int = 64) -> float | None:
    """Byte/s da due letture di un contatore. None se il salto è un reset."""
    if dt <= 0:
        return None
    delta = curr - prev
    if delta < 0:
        delta += 2**bits
    rate = delta / dt
    if rate < 0 or rate * 8 > _MAX_BPS:
        return None
    return rate


def _is_timeout(error: str) -> bool:
    text = error.lower()
    return "timeout" in text or "timed out" in text or "timedout" in text


def _ifindex(oid: str, base: str) -> int | None:
    text = str(oid).strip()
    prefix = base + "."
    if not text.startswith(prefix):
        return None
    rest = text[len(prefix):]
    return int(rest) if rest.isdigit() else None


def _text(value) -> str:
    raw = getattr(value, "asOctets", None)
    if callable(raw):
        text = raw().decode("utf-8", "replace")
    else:
        text = str(value)
    return text.replace("\x00", "").strip()


def _number(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _iface_name(name: str, index: int) -> str:
    clean = "".join(ch if ch.isalnum() or ch in "-_./" else "_" for ch in name).strip("_.")
    return (clean or f"if{index}")[:64]


def _skip_name(name: str) -> bool:
    low = name.lower()
    return low in {"lo", "lo0", "sit0"} or low.startswith("loopback")


async def _walk(host: str, community: str, oid: str, version: int, bulk: bool) -> tuple[dict[int, object], str]:
    engine = SnmpEngine()
    try:
        target = await UdpTransportTarget.create((host, 161), timeout=2, retries=0)
        auth = CommunityData(community, mpModel=version)
        var_bind = ObjectType(ObjectIdentity(oid))
        options = dict(lexicographicMode=False, lookupMib=False, maxRows=128)
        if bulk:
            rows = bulk_walk_cmd(engine, auth, target, ContextData(), 0, 20, var_bind, **options)
        else:
            rows = walk_cmd(engine, auth, target, ContextData(), var_bind, **options)
        found: dict[int, object] = {}
        async for error_indication, error_status, _error_index, var_binds in rows:
            if error_indication:
                return found, str(error_indication)
            if error_status:
                return found, str(error_status)
            for bind in var_binds:
                index = _ifindex(bind[0].prettyPrint(), oid)
                if index is not None:
                    found[index] = bind[1]
        return found, ""
    finally:
        engine.close_dispatcher()


async def _table(host: str, community: str, oid: str) -> tuple[dict[int, object], Exception | None]:
    try:
        return await _column(host, community, oid), None
    except TimeoutError:
        raise
    except Exception as exc:
        return {}, exc


async def _soft(host: str, community: str, oid: str) -> dict[int, object]:
    try:
        found, _error = await _table(host, community, oid)
        return found
    except Exception:
        return {}


async def _column(host: str, community: str, oid: str) -> dict[int, object]:
    found, error = await _walk(host, community, oid, version=1, bulk=True)
    if found:
        return found
    if error and _is_timeout(error):
        raise TimeoutError(error or "snmp timeout")
    found, fallback = await _walk(host, community, oid, version=0, bulk=False)
    if found:
        return found
    if fallback and _is_timeout(fallback):
        raise TimeoutError(fallback)
    if error or fallback:
        raise RuntimeError(fallback or error)
    return {}


def _rates(device_id: str, index: int, octets_in: int, octets_out: int, bits: int, now: float) -> tuple[float, float] | None:
    key = (device_id, index)
    previous = _prev.get(key)
    _prev[key] = (octets_in, octets_out, now)
    if previous is None:
        return None
    prev_in, prev_out, prev_at = previous
    inbound = counter_rate(prev_in, octets_in, now - prev_at, bits)
    outbound = counter_rate(prev_out, octets_out, now - prev_at, bits)
    if inbound is None or outbound is None:
        return None
    return inbound * 8, outbound * 8


async def poll_interfaces(device: dict) -> list[dict]:
    """Byte/s in ingresso e in uscita per ogni interfaccia su. Lista vuota al primo campione."""
    host = (device.get("host") or "").strip()
    device_id = device.get("id") or device.get("name") or host
    if not host or not device_id:
        return []
    community = (device.get("snmp_community") or config.SNMP_COMMUNITY or "public").strip()
    if not community:
        return []

    inbound, inbound_error = await _table(host, community, _HC_IN)
    bits = 64
    outbound_oid, name_oid = _HC_OUT, _IF_NAME
    if not inbound:
        inbound, inbound_error = await _table(host, community, _IN)
        bits = 32
        outbound_oid, name_oid = _OUT, _IF_DESCR
    if not inbound:
        if inbound_error:
            raise inbound_error
        return []

    outbound, outbound_error = await _table(host, community, outbound_oid)
    if not outbound and outbound_error:
        raise outbound_error
    names = await _soft(host, community, name_oid)
    if not names and name_oid == _IF_NAME:
        names = await _soft(host, community, _IF_DESCR)
    oper = await _soft(host, community, _IF_OPER)
    now = asyncio.get_running_loop().time()

    samples = []
    for index, raw_in in inbound.items():
        octets_in = _number(raw_in)
        octets_out = _number(outbound.get(index))
        if octets_in is None or octets_out is None:
            continue
        status = _number(oper.get(index))
        if status is not None and status != 1:
            _prev.pop((device_id, index), None)
            continue
        label = _text(names.get(index, "")) or f"if{index}"
        if _skip_name(label):
            continue
        rate = _rates(device_id, index, octets_in, octets_out, bits, now)
        if rate is None:
            continue
        samples.append({
            "iface": _iface_name(label, index),
            "in_bps": rate[0],
            "out_bps": rate[1],
        })
    return samples


async def poll_system(device: dict) -> dict:
    """TODO: hrProcessorLoad, hrStorage, temperature vendor-specific."""
    return {}
