"""Replicate files/predictions adapter with bounded asynchronous network I/O."""

import asyncio
import logging
import math
import mimetypes
import os
import re
import stat
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
)
from sme_meeting_ai.diarization.parsing import MAX_OUTPUT_BYTES, parse_output
from sme_meeting_ai.observability.logging import log_event

_API = "https://api.replicate.com"
_MAX_UPLOAD_BYTES = 100_000_000
_MAX_API_BYTES = 1024 * 1024
_POLL_INTERVAL_SECONDS = 15
logger = logging.getLogger(__name__)


def _delivery_url(value: object) -> str:
    if not isinstance(value, str) or len(value) > 8192:
        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
    parts = urlsplit(value)
    host = parts.hostname or ""
    if (parts.scheme != "https" or not (host == "replicate.delivery" or host.endswith(".replicate.delivery"))
            or parts.username or parts.password or parts.port not in (None, 443) or parts.fragment):
        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
    return value


def _upload_url(value: object) -> str:
    if not isinstance(value, str) or not 0 < len(value) <= 8192:
        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)

    try:
        parts = urlsplit(value)
        if (parts.scheme == "https" and parts.netloc == "api.replicate.com"
                and parts.path.startswith("/v1/files/") and len(parts.path) > len("/v1/files/")
                and not parts.query and not parts.fragment
                and not any(segment in (".", "..") for segment in parts.path.split("/"))):
            return value
    except ValueError:
        pass
    return _delivery_url(value)


def _status(response: httpx.Response) -> None:
    if 200 <= response.status_code < 300:
        return
    category = {401: DiarizationErrorCategory.AUTHENTICATION, 403: DiarizationErrorCategory.AUTHENTICATION,
                400: DiarizationErrorCategory.VALIDATION, 422: DiarizationErrorCategory.VALIDATION,
                413: DiarizationErrorCategory.INPUT_TOO_LARGE,
                429: DiarizationErrorCategory.RATE_LIMIT, 408: DiarizationErrorCategory.TIMEOUT,
                504: DiarizationErrorCategory.TIMEOUT}.get(response.status_code, DiarizationErrorCategory.PROVIDER)
    raise DiarizationError(category)


async def _body(response: httpx.Response, limit: int) -> bytes:
    chunks = bytearray()
    async for chunk in response.aiter_bytes():
        chunks.extend(chunk)
        if len(chunks) > limit:
            raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
    return bytes(chunks)


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    if value.isascii() and value.isdigit() and len(value) <= 10:
        return float(int(value))
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            return None
        return max(0, (date - datetime.now(timezone.utc)).total_seconds())
    except (ValueError, TypeError, OverflowError):
        return None


async def _request_body(client, method, url, *, limit, deadline, retry, **kwargs):
    for attempt in range(3):
        category = None
        delay = None
        try:
            async with client.stream(method, url, **kwargs) as response:
                if 200 <= response.status_code < 300:
                    return await _body(response, limit)
                code = response.status_code
                allowed = (retry == "read" and code in (408, 429, 500, 502, 503, 504)
                           or retry == "create" and code == 429)
                if not allowed or attempt == 2:
                    _status(response)
                delay = _retry_after(response.headers.get("Retry-After"))
        except httpx.TimeoutException:
            category = DiarizationErrorCategory.TIMEOUT
        except (httpx.TransportError, OSError):
            category = DiarizationErrorCategory.TRANSPORT
        if category is not None and (retry != "read" or attempt == 2):
            raise DiarizationError(category) from None
        delay = max(2 ** attempt, delay or 0)
        remaining = deadline - asyncio.get_running_loop().time()
        if delay >= remaining:
            raise DiarizationError(DiarizationErrorCategory.TIMEOUT)
        await asyncio.sleep(delay)
    raise DiarizationError(DiarizationErrorCategory.PROVIDER)


async def _json_request(client: httpx.AsyncClient, method: str, url: str, *, deadline, retry=None, **kwargs) -> dict:
    body = await _request_body(client, method, url, limit=_MAX_API_BYTES, deadline=deadline, retry=retry, **kwargs)
    import json

    value = json.loads(body)
    if not isinstance(value, dict):
        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
    return value


class ReplicateDiarizationAdapter:
    """Synchronous local-file operation. The caller owns injected test transports."""

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        self._settings = settings
        self._transport = transport

    def diarize(self, audio_path: str | Path, *, num_speakers: int | None = None,
                min_speakers: int | None = None, max_speakers: int | None = None) -> DiarizationResult:
        try:
            return self._diarize(audio_path, num_speakers, min_speakers, max_speakers)
        except DiarizationError as error:
            category = error.category
        except (TimeoutError, httpx.TimeoutException):
            category = DiarizationErrorCategory.TIMEOUT
        except httpx.HTTPError:
            category = DiarizationErrorCategory.TRANSPORT
        except OSError:
            category = DiarizationErrorCategory.TRANSPORT
        except (ValueError, TypeError):
            category = DiarizationErrorCategory.MALFORMED_OUTPUT
        raise DiarizationError(category)

    def _diarize(self, audio_path, num_speakers, min_speakers, max_speakers):
        if not self._settings.diarization_enabled:
            raise DiarizationError(DiarizationErrorCategory.CONFIGURATION)
        hints = {"num_speakers": num_speakers, "min_speakers": min_speakers, "max_speakers": max_speakers}
        if (any(value is not None and (type(value) is not int or not 1 <= value <= 1000) for value in hints.values())
                or (min_speakers is not None and max_speakers is not None and min_speakers > max_speakers)
                or (num_speakers is not None and min_speakers is not None and num_speakers < min_speakers)
                or (num_speakers is not None and max_speakers is not None and num_speakers > max_speakers)):
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)
        fd = None
        try:
            try:
                path = Path(audio_path)
                # Nonblocking open avoids hanging on a FIFO before fstat.
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
                    raise DiarizationError(DiarizationErrorCategory.VALIDATION)
                if info.st_size > _MAX_UPLOAD_BYTES:
                    raise DiarizationError(DiarizationErrorCategory.INPUT_TOO_LARGE)
                audio = os.fdopen(fd, "rb")
                fd = None  # The file object owns the descriptor now.
            except (OSError, ValueError, TypeError):
                raise DiarizationError(DiarizationErrorCategory.VALIDATION) from None
        finally:
            if fd is not None:
                os.close(fd)
        with audio:
            secret = self._settings.replicate_api_token
            token = secret.get_secret_value() if secret else ""
            if not token or any(ord(char) < 33 or ord(char) > 126 for char in token):
                raise DiarizationError(DiarizationErrorCategory.CONFIGURATION)
            # The synchronous API remains usable from an already-running event loop.
            with ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(asyncio.run, self._request(audio, path.name, token, {
                    key: value for key, value in hints.items() if value is not None
                })).result()

    async def _request(self, audio, filename, token, hints):
        timeout = self._settings.diarization_timeout_seconds
        deadline = asyncio.get_running_loop().time() + timeout
        async with asyncio.timeout_at(deadline):
            async with httpx.AsyncClient(transport=self._transport, trust_env=False, follow_redirects=False,
                                         timeout=httpx.Timeout(min(timeout, 30))) as client:
                auth = {"Authorization": f"Bearer {token}"}
                content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                log_event(logger, logging.INFO, "worker.diarization.provider.upload_attempt",
                          upload_bytes=os.fstat(audio.fileno()).st_size)
                uploaded = await _json_request(client, "POST", f"{_API}/v1/files", deadline=deadline, headers=auth,
                                               files={"content": (filename, audio, content_type)})
                urls = uploaded.get("urls")
                if not isinstance(urls, dict):
                    raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
                audio_url = _upload_url(urls.get("get"))
                prediction = await _json_request(
                    client, "POST", f"{_API}/v1/predictions",
                    deadline=deadline, retry="create",
                    headers={**auth, "Cancel-After": f"{max(5, math.ceil(timeout))}s"},
                    json={"version": self._settings.diarization_model.split(":", 1)[1],
                          "input": {"audio": audio_url, **hints}},
                )
                while prediction.get("status") in ("starting", "processing"):
                    prediction_id = prediction.get("id")
                    if not isinstance(prediction_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", prediction_id):
                        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
                    await asyncio.sleep(_POLL_INTERVAL_SECONDS)
                    prediction = await _json_request(client, "GET", f"{_API}/v1/predictions/{prediction_id}",
                                                     deadline=deadline, retry="read", headers=auth)
                if prediction.get("status") in ("failed", "canceled"):
                    raise DiarizationError(DiarizationErrorCategory.PROVIDER)
                if prediction.get("status") != "succeeded":
                    raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
                output_url = _delivery_url(prediction.get("output"))
                data = await _request_body(client, "GET", output_url, limit=MAX_OUTPUT_BYTES,
                                           deadline=deadline, retry="read")
                return parse_output(data, self._settings.diarization_model)
