"""Bounded private S3 reads and immutable corrected-result writes; no deletion API."""

import fcntl
import hashlib
import os
import shutil
import stat
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectTimeoutError,
    ReadTimeoutError,
)

from .core_api import MAX_RESULT_BYTES


class StorageError(Exception):
    def __init__(self, category):
        self.category = category
        super().__init__(f"WORKER_STORAGE_{category}")


def _category(error):
    if isinstance(error, StorageError):
        return error.category
    if isinstance(error, (ConnectTimeoutError, ReadTimeoutError, TimeoutError)):
        return "TIMEOUT"
    if isinstance(error, ClientError):
        code = error.response.get("Error", {}).get("Code")
        if code in ("NoSuchKey", "NotFound", "404"):
            return "NOT_FOUND"
        if code in ("AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"):
            return "AUTHENTICATION"
    if isinstance(error, BotoCoreError):
        return "TRANSPORT"
    return "RESOURCE"


class ObjectStorage:
    def __init__(self, settings, *, client=None):
        self.settings = settings
        self.client = client
        self._owned = client is None
        self._root = None
        self._lock = None
        self._state = threading.Condition()
        self._readers = 0
        self._closing = False

    def __enter__(self):
        category = None
        try:
            if self.client is None:
                if not all((self.settings.s3_endpoint_url, self.settings.s3_bucket,
                            self.settings.s3_access_key_id, self.settings.s3_secret_access_key)):
                    raise StorageError("CONFIGURATION")
                self.client = boto3.client("s3", endpoint_url=self.settings.s3_endpoint_url,
                    region_name=self.settings.s3_region,
                    aws_access_key_id=self.settings.s3_access_key_id.get_secret_value(),
                    aws_secret_access_key=self.settings.s3_secret_access_key.get_secret_value(),
                    verify=str(self.settings.s3_ca_file) if self.settings.s3_ca_file else True,
                    config=Config(connect_timeout=self.settings.s3_connect_timeout_seconds,
                        read_timeout=self.settings.s3_read_timeout_seconds,
                        retries={"total_max_attempts": 1},
                        max_pool_connections=self.settings.worker_concurrency,
                        s3={"addressing_style": "path" if self.settings.s3_path_style else "virtual"}))
            base = self.settings.audio_temp_dir / "sme-transcription-worker"
            base.mkdir(mode=0o700, exist_ok=True)
            info = base.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise StorageError("CONFIGURATION")
            # Only process-private directories under this owned 0700 root are
            # candidates. A live process retains a POSIX lock, including while a
            # cancelled inference thread finishes reading its source.
            with os.scandir(base) as entries:
                for index, entry in enumerate(entries):
                    if index >= 32:
                        break
                    if not entry.name.startswith("run-") or not entry.is_dir(follow_symlinks=False):
                        continue
                    fd = None
                    try:
                        fd = os.open(Path(entry.path) / ".lock", os.O_RDWR | os.O_NOFOLLOW)
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        shutil.rmtree(entry.path)
                    except (OSError, BlockingIOError):
                        pass
                    finally:
                        if fd is not None:
                            os.close(fd)
            self._root = Path(tempfile.mkdtemp(prefix="run-", dir=base))
            self._lock = os.open(self._root / ".lock", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            fcntl.flock(self._lock, fcntl.LOCK_EX)
        except Exception as error:
            category = _category(error)
        if category:
            self.__exit__(None, None, None)
            raise StorageError(category)
        return self

    def _cleanup(self):
        if self._root is not None:
            shutil.rmtree(self._root)
            self._root = None
        if self._lock is not None:
            os.close(self._lock)
            self._lock = None
        if self._owned and self.client is not None:
            self.client.close()

    def __exit__(self, *_):
        with self._state:
            self._closing = True
            if not self._readers:
                self._cleanup()

    @contextmanager
    def _operation(self):
        with self._state:
            if self._closing:
                raise StorageError("CANCELLED")
            self._readers += 1
        try:
            yield
        finally:
            with self._state:
                self._readers -= 1
                if self._closing and not self._readers:
                    self._cleanup()

    def _store(self, storage_id):
        if storage_id != self.settings.s3_storage_id:
            raise StorageError("VALIDATION")

    def _read(self, storage_id, key, maximum, *, output=None, expected_size=None, fence=None):
        self._store(storage_id)
        stream = None
        category = None
        try:
            deadline = time.monotonic() + self.settings.s3_download_timeout_seconds
            response = self.client.get_object(Bucket=self.settings.s3_bucket, Key=key)
            stream = response["Body"]
            size = response["ContentLength"]
            if type(size) is not int or not 0 < size <= maximum or (expected_size is not None and size != expected_size):
                raise StorageError("INTEGRITY")
            data = bytearray()
            digest = hashlib.sha256()
            count = 0
            while True:
                if time.monotonic() >= deadline:
                    raise StorageError("TIMEOUT")
                if fence is not None and fence.is_set():
                    raise StorageError("CANCELLED")
                chunk = stream.read(min(65536, maximum - count + 1))
                if not chunk:
                    break
                count += len(chunk)
                if count > maximum or count > size:
                    raise StorageError("INTEGRITY")
                digest.update(chunk)
                if output is None:
                    data.extend(chunk)
                else:
                    output.write(chunk)
            if count != size:
                raise StorageError("INTEGRITY")
            return bytes(data), digest.hexdigest()
        except Exception as error:
            category = _category(error)
        finally:
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    category = category or "RESOURCE"
        raise StorageError(category)

    @contextmanager
    def source_file(self, source, fence=None):
        with self._operation():
            category = None
            temporary = None
            try:
                self._store(source.storageId)
                if (source.sizeBytes > self.settings.audio_max_input_bytes
                        or source.durationMs > self.settings.audio_max_duration_seconds * 1000
                        or source.contentType not in {
                            "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4",
                            "audio/x-m4a", "audio/aac", "audio/webm", "audio/ogg", "video/webm", "video/mp4",
                            "application/octet-stream",
                        }):
                    raise StorageError("VALIDATION")
                temporary = tempfile.TemporaryDirectory(prefix="source-", dir=self._root)
                path = Path(temporary.name) / "source.media"
                with path.open("xb") as output:
                    path.chmod(0o600)
                    _, digest = self._read(source.storageId, source.objectKey, source.sizeBytes,
                        expected_size=source.sizeBytes, output=output, fence=fence)
                if digest != source.sha256:
                    raise StorageError("INTEGRITY")
            except Exception as error:
                category = _category(error)
            if category:
                if temporary:
                    temporary.cleanup()
                raise StorageError(category)
            try:
                yield path
            finally:
                temporary.cleanup()

    def get_result(self, storage_id, key, fence=None):
        with self._operation():
            raw, _ = self._read(storage_id, key, MAX_RESULT_BYTES, fence=fence)
            return raw

    def put_result(self, storage_id, key, raw, fence=None):
        with self._operation():
            self._store(storage_id)
            if not 0 < len(raw) <= MAX_RESULT_BYTES or not key.startswith("processing/"):
                raise StorageError("VALIDATION")
            category = None
            try:
                if fence is not None and fence.is_set():
                    raise StorageError("CANCELLED")
                self.client.put_object(Bucket=self.settings.s3_bucket, Key=key, Body=raw,
                                       ContentType="application/json", IfNoneMatch="*")
                return raw
            except Exception as error:
                category = _category(error)
                # Both precondition failure and uncertain PUT recover exact stored
                # bytes. No overwrite, delete, or provider rerun is attempted.
                recover = not isinstance(error, StorageError) and category != "AUTHENTICATION"
            if recover:
                try:
                    existing, _ = self._read(storage_id, key, MAX_RESULT_BYTES, fence=fence)
                    return existing
                except StorageError as error:
                    if error.category != "NOT_FOUND":
                        category = error.category
            raise StorageError(category)
