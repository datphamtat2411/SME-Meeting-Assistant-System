"""Content-free capability failures; worker ownership always takes precedence."""

import math
import time
from threading import Event


class IntelligenceError(Exception):
    def __init__(self, category: str):
        self.category = category
        super().__init__(f"INTELLIGENCE_{category}")


def require(condition: bool, category: str) -> None:
    if not condition:
        raise IntelligenceError(category)


def check_authority(deadline: float, cancelled: Event) -> None:
    require(type(deadline) in (int, float) and math.isfinite(deadline), "CONFIGURATION")
    require(not cancelled.is_set(), "CANCELLED")
    require(time.monotonic() < deadline, "DEADLINE")
