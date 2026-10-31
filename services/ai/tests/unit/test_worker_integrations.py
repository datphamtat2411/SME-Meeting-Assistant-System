import asyncio
import hashlib
import io
import json
import traceback
from uuid import uuid4

import httpx
import pytest
from botocore.exceptions import ClientError, ReadTimeoutError

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.core_api import (
    CoreApiClient,
    CoreError,
    SourceDescriptor,
)
from sme_meeting_ai.integrations.messaging import MessageError, decode_event
from sme_meeting_ai.integrations.object_storage import ObjectStorage, StorageError


def event_body(retry=False):
    body = {key: str(uuid4()) for key in (
        "eventId", "processingJobId", "meetingId", "sourceMediaId", "requestedByUserId",
    )}
    body.update(requestId="request-1", schemaVersion=2 if retry else 1,
                occurredAt="2026-10-31T12:00:00Z")
    if retry:
        body.update(retryFromStage="CONTEXTUAL_CORRECTION", attemptNumber=1)
    return body


def decode(body, **overrides):
    options = dict(
        headers={"eventId": body["eventId"], "eventType": (
            "PROCESSING_JOB_QUEUED" if body["schemaVersion"] == 1 else "PROCESSING_JOB_RETRY_REQUESTED"
        )}, message_id=body["eventId"], content_type="application/json", delivery_mode=2,
    )
    options.update(overrides)
    return decode_event(json.dumps(body).encode(), **options)


@pytest.mark.parametrize("retry", [False, True])
def test_event_contract(retry):
    event = decode(event_body(retry))
    assert event.generation == int(retry)
    assert event.event_type == ("PROCESSING_JOB_RETRY_REQUESTED" if retry else "PROCESSING_JOB_QUEUED")


@pytest.mark.parametrize("change", [
    {"schemaVersion": True}, {"schemaVersion": 3}, {"meetingId": "private-invalid"},
    {"requestId": "bad\nheader"}, {"requestId": " "}, {"unexpected": "private-value"},
    {"occurredAt": "2026-10-31T12:00:00"}, {"retryFromStage": None},
])
def test_poison_event_rejected_without_sensitive_context(change):
    body = event_body()
    body.update(change)
    with pytest.raises(MessageError) as caught:
        decode(body)
    assert "private" not in "".join(traceback.format_exception(caught.value))


@pytest.mark.parametrize("overrides", [
    {"message_id": str(uuid4())}, {"headers": {}}, {"delivery_mode": 1},
    {"content_type": "text/plain"},
])
def test_event_properties_are_verified(overrides):
    with pytest.raises(MessageError):
        decode(event_body(), **overrides)


def test_duplicate_keys_and_oversized_messages():
    body = event_body()
    options = dict(headers={"eventId": body["eventId"], "eventType": "PROCESSING_JOB_QUEUED"},
                   message_id=body["eventId"], content_type="application/json", delivery_mode=2)
    for raw in (json.dumps(body)[:-1].encode() + b',"schemaVersion":1}', b" " * 16385):
        with pytest.raises(MessageError):
            decode_event(raw, **options)


class S3:
    def __init__(self, data=b"accepted audio"):
        self.data = data
        self.error = None
        self.puts = []
        self.objects = {}
        self.streams = []

    def get_object(self, **kwargs):
        if self.error:
            raise self.error
        key = kwargs["Key"]
        if key.startswith("processing/") and key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        data = self.objects.get(key, self.data)
        stream = io.BytesIO(data)
        self.streams.append(stream)
        return {"ContentLength": len(data), "Body": stream}

    def put_object(self, **kwargs):
        assert kwargs["IfNoneMatch"] == "*"
        key = kwargs["Key"]
        if key in self.objects:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        self.puts.append(kwargs)
        self.objects[key] = kwargs["Body"]


def storage_settings(tmp_path):
    return Settings(service_name="test", service_identity="ai-core", _env_file=None,
                    audio_temp_dir=tmp_path, s3_storage_id="private", s3_bucket="media",
                    s3_endpoint_url="https://storage.internal", s3_region="test",
                    s3_access_key_id="private-access", s3_secret_access_key="private-secret")


def descriptor(data=b"accepted audio", **overrides):
    digest = hashlib.sha256(data).hexdigest()
    fields = dict(sourceMediaId=str(uuid4()), sourceRevision=digest, storageId="private",
                  objectKey="private/key", contentType="audio/wav", sizeBytes=len(data),
                  sha256=digest, durationMs=1000)
    fields.update(overrides)
    return SourceDescriptor.model_validate(fields)


def test_source_stream_verification_and_private_cleanup(tmp_path):
    s3 = S3()
    with ObjectStorage(storage_settings(tmp_path), client=s3) as storage:
        with storage.source_file(descriptor()) as path:
            assert path.read_bytes() == s3.data
            assert path.stat().st_mode & 0o077 == 0
        assert not path.exists()
    assert all(stream.closed for stream in s3.streams)
    assert not list(tmp_path.rglob("source.media"))


@pytest.mark.parametrize("kind,category", [
    ("missing", "NOT_FOUND"), ("size", "INTEGRITY"), ("digest", "INTEGRITY"),
    ("timeout", "TIMEOUT"), ("alias", "VALIDATION"), ("oversize", "VALIDATION"),
])
def test_storage_failures_cleanup_and_sanitization(tmp_path, kind, category):
    s3 = S3()
    source = descriptor()
    if kind == "missing":
        s3.error = ClientError({"Error": {"Code": "NoSuchKey", "Message": "private/key"}}, "GetObject")
    elif kind == "timeout":
        s3.error = ReadTimeoutError(endpoint_url="https://private-secret")
    elif kind == "size":
        source = descriptor(sizeBytes=1)
    elif kind == "digest":
        source = descriptor(b"another source")
        s3.data = b"x" * source.sizeBytes
    elif kind == "alias":
        source = descriptor(storageId="unapproved")
    elif kind == "oversize":
        source = descriptor(sizeBytes=2147483649)
    with ObjectStorage(storage_settings(tmp_path), client=s3) as storage:
        with pytest.raises(StorageError) as caught:
            with storage.source_file(source):
                pytest.fail("invalid source reached inference")
    assert caught.value.category == category
    assert "private" not in "".join(traceback.format_exception(caught.value))
    assert all(stream.closed for stream in s3.streams)
    assert not list(tmp_path.rglob("source.media"))


def test_result_create_only_and_uncertain_put_readback(tmp_path):
    s3 = S3()
    key = f"processing/{uuid4()}/transcription/results/{uuid4()}.json"
    with ObjectStorage(storage_settings(tmp_path), client=s3) as storage:
        assert storage.put_result("private", key, b"corrected") == b"corrected"
        assert storage.put_result("private", key, b"different") == b"corrected"
    assert len(s3.puts) == 1
    assert s3.objects[key] == b"corrected"


def test_uncertain_put_recovers_existing_bytes_without_overwriting(tmp_path):
    class UncertainS3(S3):
        def put_object(self, **kwargs):
            super().put_object(**kwargs)
            raise ReadTimeoutError(endpoint_url="https://private-storage")

    s3 = UncertainS3()
    key = f"processing/{uuid4()}/transcription/results/{uuid4()}.json"
    with ObjectStorage(storage_settings(tmp_path), client=s3) as storage:
        assert storage.put_result("private", key, b"corrected") == b"corrected"
    assert len(s3.puts) == 1


def test_orphan_recovery_respects_live_process_locks(tmp_path):
    import fcntl
    import os

    base = tmp_path / "sme-transcription-worker"
    base.mkdir(mode=0o700)
    stale = base / "run-orphan"
    stale.mkdir(mode=0o700)
    (stale / ".lock").touch(mode=0o600)
    (stale / "private-source").write_bytes(b"private")
    live = base / "run-live"
    live.mkdir(mode=0o700)
    fd = os.open(live / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        with ObjectStorage(storage_settings(tmp_path), client=S3()):
            assert not stale.exists()
            assert live.exists()
    finally:
        os.close(fd)


def envelope(data, code="OK", success=True):
    return {"success": success, "code": code, "message": "safe", "data": data,
            "meta": {"requestId": "request-1", "timestamp": "2026-10-31T12:00:00Z"}}


def test_http_transport_budget_and_no_sensitive_errors():
    async def run():
        calls = []

        async def handler(request):
            calls.append(request)
            return httpx.Response(503, json=envelope(None, "UNAVAILABLE", False))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = CoreApiClient(Settings(service_name="test", service_identity="ai-core",
                                           _env_file=None), client=http, sleep=lambda _: asyncio.sleep(0))
            with pytest.raises(CoreError) as caught:
                await client.lookup(decode(event_body()))
        assert len(calls) == 3
        assert all(r.headers["x-request-id"] == "request-1" for r in calls)
        assert "https://" not in "".join(traceback.format_exception(caught.value))
    asyncio.run(run())


@pytest.mark.parametrize("status,code", [(401, "UNAUTHORIZED"), (403, "FORBIDDEN"),
                                        (422, "WORKER_CONTRACT_UNSUPPORTED")])
def test_security_and_version_errors_stop_intake(status, code):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _: httpx.Response(status, json=envelope(None, code, False)),
        )) as http:
            client = CoreApiClient(Settings(service_name="test", service_identity="ai-core",
                                           _env_file=None), client=http)
            with pytest.raises(CoreError) as caught:
                await client.lookup(decode(event_body()))
            assert caught.value.stop_intake
    asyncio.run(run())
