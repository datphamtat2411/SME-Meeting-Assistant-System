"""Public, input-independent audio failure categories."""

from enum import StrEnum


class AudioErrorCategory(StrEnum):
    VALIDATION = "VALIDATION"
    DECODING = "DECODING"
    TIMEOUT = "TIMEOUT"
    RESOURCE = "RESOURCE"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    INFERENCE = "INFERENCE"


class AudioProcessingError(Exception):
    """Never contains source paths, subprocess output, or OS error details."""

    def __init__(self, category: AudioErrorCategory | str, *, origin: str | None = None):
        if origin not in (None, "source", "evidence"):
            raise ValueError("Invalid audio error origin")
        self.category = AudioErrorCategory(category)
        self.origin = origin
        super().__init__(f"Audio processing failed: {self.category.value}")
