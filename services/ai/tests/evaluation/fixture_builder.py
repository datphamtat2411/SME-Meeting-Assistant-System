"""Explicit local creation of non-sensitive controls, never speech ground truth."""

import hashlib
import math
import random
import struct
import wave
from pathlib import Path

from .support import EvaluationError, file_digest, require


def build_control(path: Path, kind: str, *, sample_count: int):
    """Return a manifest fixture entry; dataset review/approval remains external.

    Invoke manually during dataset provisioning. The model suite never generates
    or replaces assets. One seeded PCM block keeps long controls bounded in memory.
    """
    require(kind in {"silence", "noise", "music", "long-audio"}, "synthetic control kind")
    require(type(sample_count) is int and sample_count > 0, "synthetic control duration")
    require(path.parent.is_dir() and not path.exists(), "synthetic control output")
    rng = random.Random(0)
    values = []
    for index in range(16000):
        if kind == "noise":
            value = rng.randrange(-8000, 8001)
        elif kind == "music":
            # A documented tonal/chord control, not a representative music corpus.
            value = int(2500 * sum(math.sin(2 * math.pi * hz * index / 16000) for hz in (220, 330, 440)))
        else:
            value = 0
        values.append(value)
    block = struct.pack("<16000h", *values)
    try:
        with path.open("xb") as target, wave.open(target, "wb") as output:
            output.setparams((1, 2, 16000, 0, "NONE", ""))
            for start in range(0, sample_count, 16000):
                output.writeframesraw(block[:min(16000, sample_count - start) * 2])
        width = min(512, sample_count)
        anchors = []
        with wave.open(str(path), "rb") as audio:
            for start in (0, sample_count - width):
                audio.setpos(start)
                anchors.append({"start_sample": start, "end_sample": start + width,
                                "pcm_sha256": hashlib.sha256(audio.readframes(width)).hexdigest()})
    except (OSError, wave.Error):
        raise EvaluationError("evaluation synthetic control creation failed") from None
    label = {"silence": "silence", "noise": "noise", "music": "music", "long-audio": "silence"}[kind]
    condition = "background-noise" if kind == "noise" else kind
    return {
        "fixture_id": f"control-{kind}", "path": path.name, "source_sha256": file_digest(path),
        "kind": "synthetic", "language": "none", "conditions": [condition],
        "annotation_version": "synthetic-controls-1", "annotation_origin": "synthetic-control",
        "sample_count": sample_count,
        "labels": [{"start_sample": 0, "end_sample": sample_count, "label": label}],
        "anchors": anchors,
    }
