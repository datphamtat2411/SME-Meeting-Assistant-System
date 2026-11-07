"""Local-only demo transport: admission, bounded multipart upload and polling."""

import asyncio
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Request, Response
from pydantic import ValidationError
from starlette.datastructures import Headers, MutableHeaders, UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse

from sme_meeting_ai.audio import AudioNormalizer, AudioProcessingError, AudioSource
from sme_meeting_ai.demo.jobs import DemoCapacityError
from sme_meeting_ai.demo.models import DemoJobAccepted, DemoJobStatus, SpeakerHints

from .errors import error_response

router = APIRouter(prefix="/demo/v1")
_CHUNK_BYTES = 65536
_MULTIPART_ALLOWANCE = 65536


class _FileTooLarge(MultiPartException):
    pass


class _AudioMultipartParser(MultiPartParser):
    """Enforce the file limit during parsing, before writing each received part."""

    def __init__(self, headers, stream, limit):
        super().__init__(headers, stream, max_files=1, max_fields=3, max_part_size=4096)
        self._limit, self._file_bytes = limit, 0

    def on_part_data(self, data, start, end):
        if self._current_part.file is not None:
            self._file_bytes += end - start
            if self._file_bytes > self._limit:
                raise _FileTooLarge("Upload limit exceeded")
        super().on_part_data(data, start, end)


def _error(status, code, message):
    response = error_response(status, code, message)
    response.headers["Cache-Control"] = "no-store"
    return response


def _capacity_error():
    response = _error(429, "DEMO_CAPACITY", "Demo job capacity is full. Try again later.")
    response.headers["Retry-After"] = "2"
    return response


def _local_request(scope, headers, settings):
    try:
        if not scope.get("client") or not ip_address(scope["client"][0]).is_loopback:
            return False
        host = urlsplit("//" + headers.get("host", ""))
        if (host.hostname not in ("127.0.0.1", "::1", "localhost") or host.username or host.password
                or (host.port or 80) != settings.http_port or host.path or host.query or host.fragment):
            return False
        origin = headers.get("origin")
        allowed = {f"{scope['scheme']}://{name}:{settings.http_port}"
                   for name in ("127.0.0.1", "localhost", "[::1]")}
        if settings.http_port == 80:
            allowed.update(f"http://{name}" for name in ("127.0.0.1", "localhost", "[::1]"))
        if settings.demo_web_origin:
            allowed.add(settings.demo_web_origin)
        return origin is None or origin in allowed
    except ValueError:
        return False


class DemoRequestMiddleware:
    """Bound admission/body bytes before Starlette can spool multipart files.

    No forwarded-header trust, authentication changes, or global CORS policy.
    The byte counter applies even without Content-Length (chunked HTTP uploads).
    """

    def __init__(self, app, settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/demo/"):
            await self.app(scope, receive, send)
            return

        async def no_store(message):
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["Cache-Control"] = "no-store"
            await send(message)

        headers = Headers(scope=scope)
        if not _local_request(scope, headers, self.settings):
            await _error(403, "DEMO_LOCAL_ONLY", "Demo requests require local development access.")(scope, receive, no_store)
            return
        if scope["method"] != "POST" or scope["path"] != "/demo/v1/jobs":
            await self.app(scope, receive, no_store)
            return
        if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
            await _error(415, "MULTIPART_REQUIRED", "Use multipart/form-data with one audio file.")(scope, receive, no_store)
            return
        limit = min(self.settings.demo_max_upload_bytes, self.settings.audio_max_input_bytes) + _MULTIPART_ALLOWANCE
        length = headers.get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal() or len(length) > 20):
            await _error(422, "INVALID_UPLOAD", "Invalid audio upload.")(scope, receive, no_store)
            return
        if length is not None and int(length) > limit:
            await _error(413, "UPLOAD_TOO_LARGE", "Audio upload exceeds the demo limit.")(scope, receive, no_store)
            return
        manager = getattr(scope["app"].state, "demo_jobs", None)
        if manager is None:
            await _error(503, "DEMO_UNAVAILABLE", "Demo processing is unavailable.")(scope, receive, no_store)
            return
        try:
            reservation = manager.reserve()
        except DemoCapacityError:
            await _capacity_error()(scope, receive, no_store)
            return
        scope.setdefault("state", {})["demo_reservation"] = reservation
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    scope["state"]["demo_body_too_large"] = True
                    raise MultiPartException("Upload limit exceeded")
            return message

        try:
            await self.app(scope, bounded_receive, no_store)
        finally:
            manager.release(reservation)


class _UploadError(Exception):
    def __init__(self, status):
        self.status = status


def _prepare_upload(file, directory, settings):
    path = Path(directory) / "input.media"
    limit = min(settings.demo_max_upload_bytes, settings.audio_max_input_bytes)
    size = 0
    with path.open("xb") as output:
        while chunk := file.read(_CHUNK_BYTES):
            size += len(chunk)
            if size > limit:
                raise _UploadError(413)
            output.write(chunk)
    if not size:
        raise _UploadError(422)
    # Content-based preflight uses the same container/codec/duration policy as
    # preprocessing. Full decoding/VAD still run once inside the offline pipeline.
    probe = AudioNormalizer(settings).probe(AudioSource(str(uuid4()), path))
    extension = {"wav": ".wav", "mp3": ".mp3", "mov,mp4,m4a,3gp,3g2,mj2": ".m4a",
                 "matroska,webm": ".webm"}[probe.container]
    published = path.with_name("audio" + extension)
    path.rename(published)
    return published


async def owned_blocking(function, *args):
    """Do not let request cancellation close files a live I/O thread still owns."""
    future = asyncio.get_running_loop().run_in_executor(None, function, *args)
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        try:
            await asyncio.shield(future)
        except Exception:
            pass
        raise


@router.post("/jobs", status_code=202, response_model=DemoJobAccepted)
async def create_job(request: Request, response: Response) -> DemoJobAccepted | JSONResponse:
    manager = request.app.state.demo_jobs
    settings = request.app.state.settings
    parser = _AudioMultipartParser(request.headers, request.stream(),
                                   min(settings.demo_max_upload_bytes, settings.audio_max_input_bytes))
    form = temporary = None
    try:
        form = await parser.parse()
        items = form.multi_items()
        if (len({key for key, _ in items}) != len(items) or "file" not in form
                or not isinstance(form["file"], UploadFile)):
            raise _UploadError(422)
        hints = SpeakerHints.model_validate({key: value for key, value in items if key != "file"})
        temporary = manager.new_upload()
        path = await owned_blocking(_prepare_upload, form["file"].file, temporary.name, settings)
        await form.close()
        form = None  # Drop the multipart copy before a worker can start inference.
        accepted = manager.submit(request.state.demo_reservation, path, temporary, hints)
        temporary = None  # Ownership transferred to the job, including on shutdown.
        response.headers["Location"] = f"/demo/v1/jobs/{accepted.jobId}"
        return accepted
    except _FileTooLarge:
        return _error(413, "UPLOAD_TOO_LARGE", "Audio upload exceeds the demo limit.")
    except _UploadError as error:
        if error.status == 413:
            return _error(413, "UPLOAD_TOO_LARGE", "Audio upload exceeds the demo limit.")
        return _error(422, "INVALID_UPLOAD", "Invalid audio upload.")
    except (MultiPartException, ValidationError, ValueError, AudioProcessingError, ClientDisconnect):
        if getattr(request.state, "demo_body_too_large", False):
            return _error(413, "UPLOAD_TOO_LARGE", "Audio upload exceeds the demo limit.")
        return _error(422, "INVALID_UPLOAD", "Invalid audio upload or speaker hints.")
    except DemoCapacityError:
        return _capacity_error()
    except OSError:
        return _error(503, "DEMO_UNAVAILABLE", "Demo processing is unavailable.")
    finally:
        if form is not None:
            await form.close()
        if temporary is not None:
            await owned_blocking(temporary.cleanup)


@router.get("/jobs/{job_id}", response_model=DemoJobStatus)
async def get_job(job_id: str, request: Request) -> DemoJobStatus | JSONResponse:
    job = request.app.state.demo_jobs.get(job_id)
    if job is None:
        return _error(404, "not_found", "Resource not found")
    return job
