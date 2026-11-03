"""Bounded, test-only parent/child controls for isolated E2E-04 recovery runs."""

import asyncio
import json
import os
import re
import socket
import stat
import tempfile
import threading
import time
from pathlib import Path
from uuid import UUID, uuid4

from sme_meeting_ai.core.config import Environment

POST_CLAIM = "post_claim"
PRE_ACK = "pre_ack"
_CHECKPOINTS = frozenset((POST_CLAIM, PRE_ACK))
_ACTIONS = frozenset(("ack", "nack", "reject"))
_PHASES = frozenset(("invoked", "client_completed"))
_CONTROL_SOCKET = "AI_E2E04_CONTROL_SOCKET"
_CONTROL_RUN_ID = "AI_E2E04_CONTROL_RUN_ID"
_SAFE_TEXT = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_MAX_TIMEOUT = 30.0
_MAX_MESSAGE = 4096


class ControlError(RuntimeError):
    """Sanitized control-channel failure."""


class ControlTimeout(ControlError):
    pass


class ControlClosed(ControlError):
    pass


class ControlAborted(ControlError):
    pass


def _test_environment(environment):
    return environment is Environment.TEST or environment == Environment.TEST.value


def _timeout(value):
    if type(value) not in (int, float) or not 0 < value <= _MAX_TIMEOUT:
        raise ValueError("invalid control timeout")
    return float(value)


def _safe_text(value):
    value = str(value)
    if not _SAFE_TEXT.fullmatch(value):
        raise ControlError("invalid control identifier")
    return value


def _run_id(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ControlError("invalid control run") from None


def sanitize_observation(fields):
    """Retain only bounded delivery metadata; never copy arbitrary input."""
    event_id = _safe_text(fields["eventId"])
    delivery_tag = fields["deliveryTag"]
    if type(delivery_tag) is not int or delivery_tag <= 0:
        raise ControlError("invalid delivery observation")
    channel = fields.get("channel")
    if channel is None:
        channel = "unknown"
    elif type(channel) is int:
        if channel <= 0:
            raise ControlError("invalid delivery observation")
    else:
        channel = _safe_text(channel)
    redelivered = fields["redelivered"]
    if type(redelivered) is not bool:
        raise ControlError("invalid delivery observation")
    action = fields["action"]
    phase = fields["phase"]
    if action not in _ACTIONS or phase not in _PHASES:
        raise ControlError("invalid delivery observation")
    return {
        "eventId": event_id,
        "deliveryTag": delivery_tag,
        "channel": channel,
        "redelivered": redelivered,
        "action": action,
        "phase": phase,
    }


def _checkpoint_fields(message):
    checkpoint = message.get("checkpoint")
    if checkpoint not in _CHECKPOINTS:
        raise ControlError("invalid checkpoint")
    fields = {"checkpoint": checkpoint}
    if "eventId" in message:
        fields["eventId"] = _safe_text(message["eventId"])
    return fields


def _encode(message):
    try:
        raw = (json.dumps(message, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
    except (TypeError, ValueError):
        raise ControlError("invalid control message") from None
    if len(raw) > _MAX_MESSAGE:
        raise ControlError("control message too large")
    return raw


def _decode(raw):
    if not raw or len(raw) > _MAX_MESSAGE:
        raise ControlError("invalid control message")
    try:
        message = json.loads(raw)
    except (TypeError, ValueError, RecursionError):
        raise ControlError("invalid control message") from None
    if not isinstance(message, dict) or type(message.get("runId")) is not str:
        raise ControlError("invalid control message")
    return message


class _DisabledControl:
    enabled = False
    environment = {}

    async def checkpoint(self, _checkpoint, *, event_id=None):
        return None

    async def observe_delivery(self, **_fields):
        return None

    async def close(self):
        return None


class RecoveryControl:
    """Factory for the explicit test parent and the worker-side child control."""

    @classmethod
    def parent(cls, environment, *, timeout=5.0):
        if not _test_environment(environment):
            return _DisabledControl()
        return _ParentControl(timeout=_timeout(timeout))

    @classmethod
    def child(cls, environment, environment_values=None, *, timeout=5.0):
        if not _test_environment(environment):
            return _DisabledControl()
        values = environment_values or {}
        endpoint = values.get(_CONTROL_SOCKET)
        run_id = values.get(_CONTROL_RUN_ID)
        if not endpoint or not run_id:
            return _DisabledControl()
        try:
            run_id = _run_id(run_id)
            path = Path(endpoint)
            if (not path.is_absolute() or path.name != "control.sock"
                    or not path.parent.name.startswith("e2e04-recovery-")):
                return _DisabledControl()
            mode = path.stat().st_mode
            parent_mode = path.parent.stat().st_mode
            if (not stat.S_ISSOCK(mode) or path.stat().st_uid != os.getuid()
                    or path.parent.stat().st_uid != os.getuid()
                    or parent_mode & 0o077 or mode & 0o077):
                return _DisabledControl()
        except (OSError, ControlError):
            return _DisabledControl()
        return _ChildControl(path, run_id, timeout=_timeout(timeout))


class _ParentControl:
    enabled = True

    def __init__(self, *, timeout):
        self._timeout = timeout
        self._run_id = str(uuid4())
        self._directory = Path(tempfile.mkdtemp(prefix="e2e04-recovery-"))
        self._directory.chmod(0o700)
        self._path = self._directory / "control.sock"
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(self._path))
        self._path.chmod(0o600)
        self._server.listen(1)
        self._server.settimeout(0.1)
        self._accept_deadline = time.monotonic() + _MAX_TIMEOUT
        self._connection = None
        self._send_lock = threading.Lock()
        self._condition = threading.Condition()
        self._closed = False
        self._connection_closed = False
        self._aborted = False
        self._armed = set()
        self._used = set()
        self._active = set()
        self._activated = {}
        self._observations = []
        self._thread = threading.Thread(target=self._serve, name="e2e04-control", daemon=True)
        self._thread.start()

    @property
    def environment(self):
        return {_CONTROL_SOCKET: str(self._path), _CONTROL_RUN_ID: self._run_id}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def arm(self, checkpoint):
        if checkpoint not in _CHECKPOINTS:
            raise ControlError("invalid checkpoint")
        with self._condition:
            if self._closed or self._aborted:
                raise ControlClosed("control channel closed")
            if checkpoint in self._armed or checkpoint in self._used:
                raise ControlError("checkpoint is one-shot")
            self._armed.add(checkpoint)

    def wait_for_checkpoint(self, checkpoint, *, timeout=None):
        if checkpoint not in _CHECKPOINTS:
            raise ControlError("invalid checkpoint")
        deadline = time.monotonic() + _timeout(self._timeout if timeout is None else timeout)
        with self._condition:
            while checkpoint not in self._activated:
                if self._connection_closed:
                    raise ControlClosed("control channel closed")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._send({"kind": "expire", "runId": self._run_id, "checkpoint": checkpoint})
                    raise ControlTimeout("checkpoint timed out")
                self._condition.wait(remaining)
            return dict(self._activated[checkpoint])

    def release(self, checkpoint):
        with self._condition:
            if checkpoint not in self._active:
                raise ControlError("checkpoint is not active")
        if not self._send({"kind": "release", "runId": self._run_id, "checkpoint": checkpoint}):
            raise ControlClosed("control channel closed")

    def abort(self):
        with self._condition:
            if self._closed:
                return
            self._aborted = True
            active = tuple(self._active)
        if active:
            self._send({"kind": "abort", "runId": self._run_id})

    def observations(self):
        with self._condition:
            return tuple(dict(item) for item in self._observations)

    def close(self):
        with self._condition:
            if self._closed:
                return
            self._closed = True
            active = tuple(self._active)
        if active:
            self._send({"kind": "abort", "runId": self._run_id})
        with self._send_lock:
            connection = self._connection
            self._connection = None
            if connection is not None:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()
            try:
                self._server.close()
            except OSError:
                pass
        self._thread.join(timeout=max(1.0, self._timeout))
        try:
            self._path.unlink()
        except FileNotFoundError:
            pass
        try:
            self._directory.rmdir()
        except OSError:
            pass

    def _send(self, message):
        raw = _encode(message)
        with self._send_lock:
            connection = self._connection
            if connection is None:
                return False
            try:
                connection.sendall(raw)
                return True
            except OSError:
                self._mark_closed(connection)
                return False

    def _mark_closed(self, connection):
        with self._condition:
            if self._connection is connection:
                self._connection_closed = True
                self._connection = None
                self._condition.notify_all()
        try:
            connection.close()
        except OSError:
            pass

    def _serve(self):
        connection = None
        try:
            while True:
                with self._condition:
                    if self._closed:
                        return
                if time.monotonic() >= self._accept_deadline:
                    self._mark_closed(self._server)
                    return
                try:
                    connection, _ = self._server.accept()
                except socket.timeout:
                    continue
                connection.settimeout(0.1)
                with self._condition:
                    if self._connection is not None or self._closed:
                        connection.close()
                        return
                    self._connection = connection
                self._read_loop(connection)
                return
        except OSError:
            if connection is not None:
                self._mark_closed(connection)

    def _read_loop(self, connection):
        buffer = b""
        hello = False
        while True:
            try:
                chunk = connection.recv(_MAX_MESSAGE)
            except socket.timeout:
                with self._condition:
                    if self._closed:
                        return
                continue
            except OSError:
                self._mark_closed(connection)
                return
            if not chunk:
                self._mark_closed(connection)
                return
            buffer += chunk
            if len(buffer) > _MAX_MESSAGE:
                self._mark_closed(connection)
                return
            while b"\n" in buffer:
                raw, buffer = buffer.split(b"\n", 1)
                try:
                    message = _decode(raw)
                    if _run_id(message["runId"]) != self._run_id:
                        raise ControlError("invalid control run")
                    if not hello:
                        if message.get("kind") != "hello":
                            raise ControlError("invalid control handshake")
                        hello = True
                        if not self._send({"kind": "hello_ack", "runId": self._run_id}):
                            return
                        continue
                    self._handle_message(message)
                except ControlError:
                    self._mark_closed(connection)
                    return

    def _handle_message(self, message):
        kind = message.get("kind")
        if kind == "checkpoint":
            fields = _checkpoint_fields(message)
            checkpoint = fields["checkpoint"]
            with self._condition:
                if checkpoint in self._armed:
                    self._armed.remove(checkpoint)
                    self._used.add(checkpoint)
                    self._active.add(checkpoint)
                    observation = {**fields, "status": "activated"}
                    self._activated[checkpoint] = observation
                    self._observations.append(observation)
                    self._condition.notify_all()
                    response = {"kind": "activate", "runId": self._run_id, "checkpoint": checkpoint}
                elif self._aborted:
                    response = {"kind": "abort", "runId": self._run_id}
                else:
                    response = {"kind": "continue", "runId": self._run_id}
            self._send(response)
            return
        if kind == "observe":
            observation = sanitize_observation(message)
            with self._condition:
                self._observations.append(observation)
            self._send({"kind": "observed", "runId": self._run_id})
            return
        if kind == "resumed":
            fields = _checkpoint_fields(message)
            with self._condition:
                self._active.discard(fields["checkpoint"])
                self._observations.append({**fields, "status": "released"})
                self._condition.notify_all()
            self._send({"kind": "resumed_ack", "runId": self._run_id})
            return
        if kind == "timeout":
            fields = _checkpoint_fields(message)
            with self._condition:
                checkpoint = fields["checkpoint"]
                if checkpoint in self._active:
                    self._active.discard(checkpoint)
                    self._observations.append({
                        "runId": self._run_id,
                        **fields,
                        "status": "timeout",
                    })
                self._condition.notify_all()
            self._send({
                "kind": "timeout_ack",
                "runId": self._run_id,
                "checkpoint": fields["checkpoint"],
            })
            return
        raise ControlError("invalid control message")


class _ChildControl:
    enabled = True

    def __init__(self, path, run_id, *, timeout):
        self._path = path
        self._run_id = run_id
        self._timeout = timeout
        self._reader = None
        self._writer = None
        self._lock = asyncio.Lock()
        self._closed = False

    async def checkpoint(self, checkpoint, *, event_id=None):
        if checkpoint not in _CHECKPOINTS:
            raise ControlError("invalid checkpoint")
        message = {"kind": "checkpoint", "runId": self._run_id, "checkpoint": checkpoint}
        if event_id is not None:
            message["eventId"] = _safe_text(event_id)
        async with self._lock:
            await self._ensure_connected()
            await self._write(message)
            response = await self._read()
            kind = response.get("kind")
            if kind == "continue":
                return None
            if kind == "abort":
                raise ControlAborted("control channel aborted")
            if kind == "timeout":
                raise ControlTimeout("checkpoint timed out")
            if kind != "activate":
                raise ControlClosed("control channel closed")
            try:
                response = await asyncio.wait_for(self._read(), self._timeout)
            except asyncio.TimeoutError:
                await self._send_timeout(checkpoint, event_id=event_id)
                raise ControlTimeout("checkpoint timed out") from None
            if response.get("kind") == "release":
                await self._write({"kind": "resumed", "runId": self._run_id, "checkpoint": checkpoint})
                response = await self._read()
                if response.get("kind") != "resumed_ack":
                    raise ControlClosed("control channel closed")
                return None
            if response.get("kind") == "abort":
                raise ControlAborted("control channel aborted")
            if response.get("kind") == "timeout":
                raise ControlTimeout("checkpoint timed out")
            raise ControlClosed("control channel closed")

    async def observe_delivery(self, **fields):
        observation = sanitize_observation({
            "eventId": fields["event_id"],
            "deliveryTag": fields["delivery_tag"],
            "channel": fields.get("channel"),
            "redelivered": fields["redelivered"],
            "action": fields["action"],
            "phase": fields["phase"],
        })
        async with self._lock:
            await self._ensure_connected()
            await self._write({"kind": "observe", "runId": self._run_id, **observation})
            response = await self._read()
            if response.get("kind") != "observed":
                raise ControlClosed("control channel closed")

    async def close(self):
        if self._closed:
            return
        self._closed = True
        writer = self._writer
        self._writer = None
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), self._timeout)
            except (OSError, asyncio.TimeoutError):
                pass

    async def _ensure_connected(self):
        if self._closed:
            raise ControlClosed("control channel closed")
        if self._writer is not None:
            return
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(self._path)), self._timeout,
            )
            await self._write({"kind": "hello", "runId": self._run_id})
            response = await self._read()
            if response.get("kind") != "hello_ack":
                raise ControlClosed("control channel closed")
        except (OSError, asyncio.TimeoutError, ControlError):
            await self._close_unlocked()
            raise ControlClosed("control channel closed") from None

    async def _write(self, message):
        if self._writer is None:
            raise ControlClosed("control channel closed")
        try:
            self._writer.write(_encode(message))
            await asyncio.wait_for(self._writer.drain(), self._timeout)
        except (OSError, asyncio.TimeoutError):
            await self._close_unlocked()
            raise ControlClosed("control channel closed") from None

    async def _read(self):
        if self._reader is None:
            raise ControlClosed("control channel closed")
        try:
            raw = await self._reader.readline()
        except (OSError, asyncio.TimeoutError):
            await self._close_unlocked()
            raise ControlClosed("control channel closed") from None
        if not raw:
            await self._close_unlocked()
            raise ControlClosed("control channel closed")
        try:
            return _decode(raw.rstrip(b"\n"))
        except ControlError:
            await self._close_unlocked()
            raise ControlClosed("control channel closed") from None

    async def _send_timeout(self, checkpoint, *, event_id=None):
        try:
            message = {"kind": "timeout", "runId": self._run_id, "checkpoint": checkpoint}
            if event_id is not None:
                message["eventId"] = _safe_text(event_id)
            await self._write(message)
            response = await asyncio.wait_for(self._read(), self._timeout)
            if response.get("kind") == "abort":
                raise ControlAborted("control channel aborted")
            if (response.get("kind") != "timeout_ack"
                    or response.get("runId") != self._run_id
                    or response.get("checkpoint") != checkpoint):
                raise ControlClosed("control channel closed")
        except asyncio.TimeoutError:
            raise ControlClosed("control channel closed") from None
        finally:
            await self._close_unlocked()

    async def _close_unlocked(self):
        writer = self._writer
        self._writer = None
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), self._timeout)
            except (OSError, asyncio.TimeoutError):
                pass
