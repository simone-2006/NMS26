"""Raccolta SNMP.

TODO: implementare snmp_get/snmp_walk (es. con pysnmp o chiamando snmpget).
Qui c'è già la parte delicata: il calcolo del rate sui contatori.
"""


def counter_rate(prev: int, curr: int, dt: float, bits: int = 64) -> float:
    """Byte/s da due letture di un contatore, gestendo il wraparound."""
    if dt <= 0:
        return 0.0
    delta = curr - prev
    if delta < 0:  # wraparound (o reset del device)
        delta += 2**bits
    return delta / dt


async def poll_interfaces(device: dict) -> list[dict]:
    """TODO: leggere ifHCInOctets/ifHCOutOctets (1.3.6.1.2.1.31.1.1.1.6 / .10)."""
    return []


async def poll_system(device: dict) -> dict:
    """TODO: hrProcessorLoad, hrStorage, temperature vendor-specific."""
    return {}
