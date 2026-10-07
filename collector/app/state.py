from dataclasses import dataclass


@dataclass
class DeviceState:
    status: str = "UNKNOWN"   # UNKNOWN | UP | DOWN
    fails: int = 0
    oks: int = 0

    def update(self, alive: bool, down_after: int, up_after: int) -> str | None:
        """Aggiorna lo stato. Ritorna 'DOWN' o 'UP' solo quando c'è una transizione."""
        if alive:
            self.oks += 1
            self.fails = 0
            if self.status != "UP" and self.oks >= up_after:
                prev, self.status = self.status, "UP"
                return "UP" if prev == "DOWN" else None  # niente alert al primo avvio
        else:
            self.fails += 1
            self.oks = 0
            if self.status != "DOWN" and self.fails >= down_after:
                self.status = "DOWN"
                return "DOWN"
        return None
