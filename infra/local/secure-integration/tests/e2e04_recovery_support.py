"""Shared isolated fixtures and read-only recovery evidence, reusing Level A/R01."""

import asyncio
import hashlib
import json
import os
import re
import selectors
import signal
import socket
import subprocess
import time
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from uuid import uuid4

import boto3
import httpx
import pytest
import test_e2e04_recovery_r01 as r01
import test_worker_e2e04 as e2e
from botocore.config import Config
from botocore.exceptions import ClientError
from e2e04_recovery_control import Environment, RecoveryControl

from sme_meeting_ai.workers.transcription import validate_result_bytes

OPT_IN = [pytest.mark.live_infrastructure, pytest.mark.skipif(
    os.environ.get("RUN_WORKER_REAL_ACCEPTANCE") != "1",
    reason="Explicit isolated E2E-04 recovery acceptance opt-in is required")]


def poll(read, predicate, *, timeout=30, interval=0.2, label="recovery evidence"):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if predicate(value):
            return value
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(label + " timed out")
        time.sleep(min(interval, remaining))


def assert_redelivery_ack(original, recovered, event_id, receipt_id):
    original = [item for item in original if item["eventId"] == event_id]
    recovered = [item for item in recovered if item["eventId"] == event_id]
    assert [item["operation"] for item in original] == ["invoked"]
    assert original[0]["redelivered"] is False
    assert [item["operation"] for item in recovered] == ["invoked", "client_completed"]
    assert all(item["redelivered"] is True for item in recovered)
    assert all(item["terminal"] == {"state": "RESULT_ACCEPTED", "receiptId": receipt_id}
               for item in original + recovered)
    assert (recovered[0]["channel"], recovered[0]["deliveryTag"]) == (
        recovered[1]["channel"], recovered[1]["deliveryTag"])


def assert_ack_confirmations(http, acknowledgements):
    for ack in acknowledgements:
        terminal = ack.get("terminal") or {}
        assert terminal.get("state") in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"), (
            "ACK lacks durable confirmation")
        assert any(item["eventId"] == ack["eventId"] and item["status"] == 200
                   and item.get("state") == terminal["state"]
                   and item.get("receiptId") == terminal.get("receiptId")
                   and item["monotonicNs"] < ack["monotonicNs"] for item in http), (
                       "ACK lacks preceding bound durable confirmation")


def validate_seed(raw, **binding):
    validated = validate_result_bytes(raw, **binding)
    return hashlib.sha256(raw).hexdigest(), validated.correctionProof.outputSha256


def assert_claim_overlap(waiters, root_blocker):
    assert len(waiters) == 2, "both real claims must be simultaneously waiting in PostgreSQL"
    assert len({item["pid"] for item in waiters}) == 2, "claims need distinct database sessions"
    assert all(item["rootBlocker"] == root_blocker and item["waitEventType"] == "Lock" for item in waiters)


def stop_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        pass
    # Maven's JVM child may outlive Maven; finish the fixture-owned group only.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


class JobLock:
    """One bounded read-only job-row lock to witness two real HTTP claim waiters."""

    def __init__(self, run):
        self.run = run
        self.process = None

    def __enter__(self):
        db = self.run.database
        env = dict(os.environ, PGPASSWORD=db["password"])
        self.process = subprocess.Popen(
            ["docker", "exec", "-i", db["name"], "psql", "-X", "-U", db["user"],
             "-d", db["database"], "-At", "-v", "ON_ERROR_STOP=1"], env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            sql = ("SET idle_in_transaction_session_timeout='20s'; SET statement_timeout='20s'; BEGIN; "
                   f"SELECT id FROM processing_jobs WHERE id='{self.run.job_id}'::uuid FOR UPDATE; "
                   "SELECT 'E2E04_LOCK_HELD:' || pg_backend_pid();\n")
            self.process.stdin.write(sql.encode())
            self.process.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(self.process.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 10
                output = b""
                while time.monotonic() < deadline:
                    if selector.select(timeout=max(0, deadline - time.monotonic())):
                        chunk = os.read(self.process.stdout.fileno(), 4096)
                        if not chunk:
                            break
                        output += chunk
                        marker = re.search(rb"E2E04_LOCK_HELD:(\d+)", output)
                        if marker:
                            self.pid = int(marker[1])
                            return self
            raise AssertionError("bounded PostgreSQL claim barrier failed")
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def waiters(self):
        raw = e2e._psql(self.run.database, self.run.database["password"], f"""
            WITH RECURSIVE blocked(pid) AS (
                SELECT pid FROM pg_stat_activity WHERE {self.pid}=ANY(pg_blocking_pids(pid))
                UNION
                SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
            )
            SELECT COALESCE(json_agg(json_build_object('pid',a.pid,'rootBlocker',{self.pid},
                'waitEventType',a.wait_event_type)), '[]'::json)
            FROM pg_stat_activity a WHERE a.pid IN (SELECT pid FROM blocked)
                AND a.wait_event_type='Lock' AND a.query LIKE '%SELECT id FROM processing_jobs%FOR UPDATE%'
        """)
        return json.loads(raw)

    def __exit__(self, *_):
        if self.process is None:
            return
        try:
            if self.process.poll() is None:
                try:
                    self.process.stdin.write(b"ROLLBACK;\n\\q\n")
                    self.process.stdin.flush()
                    self.process.wait(timeout=5)
                except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            self.process.stdin.close()
            self.process.stdout.close()


class RecoveryRun:
    def __init__(self, services, storage_boundary, postgres, tmp_path):
        settings, self.pki, self.names = services
        self.boundary, boundary_pki, topology = storage_boundary
        assert self.pki == boundary_pki and topology["backend"]
        self.database, self.path = postgres, tmp_path
        self.transport = {"broker_port": e2e._docker_port(self.names[0], "5671/tcp"),
                          "endpoint": self.boundary.s3_endpoint_url,
                          "bucket": self.boundary.s3_bucket, "names": self.names,
                          "root_secret": settings.s3_secret_access_key.get_secret_value()}
        self.credentials = e2e._application_credentials(self.transport, self.pki)
        self.workers = []
        self.contexts = ExitStack()
        self.job_id = self.event_id = None

    def __enter__(self):
        try:
            ai_url = self.contexts.enter_context(e2e._ai_process(self.path, self.pki))
            self.core = self.contexts.enter_context(e2e._core_process(
                self.path, self.database, self.transport, self.credentials, self.pki, ai_url))
            email, password = e2e._seed_user(self.database, self.core)
            self.admission = e2e.CoreAdmission(SimpleNamespace(s3_ca_file=self.pki / "ca.crt"),
                                              public_url=self.core.public_url,
                                              email=email, password=password)
            return self
        except BaseException:
            self.contexts.close()
            raise

    def __exit__(self, kind, error, traceback):
        try:
            if error is not None:
                self.diagnostic()
            for worker in reversed(self.workers):
                if worker.process.poll() is None:
                    self.kill(worker)
                if not worker.log.closed:
                    worker.log.close()
        finally:
            self.contexts.close()

    async def exercise(self, action):
        try:
            return await r01._with_admission(self.admission, action)
        except BaseException:
            self.diagnostic()
            raise

    def control(self, *, timeout=25):
        return self.contexts.enter_context(RecoveryControl.parent(Environment.TEST, timeout=timeout))

    def start(self, label, *, control=None, fault="", extra=None):
        path = self.path / label
        path.mkdir(mode=0o700)
        environment = {**(control.environment if control else {}), "AI_E2E04_FAULT": fault,
                       "AI_E2E04_CONTROL_TIMEOUT": "25", **(extra or {})}
        process, log = e2e._start_worker(path, self.database, self.transport, self.credentials,
                                       self.core, self.pki, control_environment=environment)
        worker = SimpleNamespace(path=path, process=process, log=log, control=control)
        self.workers.append(worker)
        return worker

    def stop(self, worker):
        e2e._stop_worker(worker.process, worker.log)

    def kill(self, worker):
        if worker.process.poll() is None:
            os.killpg(worker.process.pid, signal.SIGKILL)
            worker.process.wait(timeout=10)
        worker.log.close()
        assert worker.process.returncode == -signal.SIGKILL

    def stop_core(self):
        stop_group(self.core.process)

        def port_closed():
            with socket.socket() as connection:
                connection.settimeout(0.5)
                return connection.connect_ex(("127.0.0.1", self.core.private_port)) != 0

        poll(port_closed, bool, timeout=10, label="Core private listener shutdown")

    def restart_core(self):
        assert self.core.process.poll() is not None
        log_path = self.path / "core-restarted.log"
        log = log_path.open("w", encoding="utf-8")
        self.contexts.callback(log.close)
        process = subprocess.Popen(["mvn", "-q", "-DskipTests", "spring-boot:run"],
                                   cwd=e2e.ROOT / "services/api", env=self.core.environment,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.contexts.callback(stop_group, process)
        self.core.process = process

        def ready():
            if process.poll() is not None:
                raise AssertionError("restarted isolated Core exited")
            try:
                response = httpx.get(self.core.public_url + "/actuator/health/readiness",
                                     trust_env=False, timeout=2)
                return response.status_code == 200 and "PASS core-api-to-ai readiness (Java mTLS)" in log_path.read_text()
            except httpx.HTTPError:
                return False

        poll(ready, bool, timeout=180, interval=0.5, label="same-state Core restart")
        with e2e._tls_client(self.pki, certificate="ai-worker") as client:
            response = client.get(f"https://localhost:{self.core.private_port}/internal/v1/worker/"
                                  f"processing-jobs/{self.job_id}/transcription/deliveries/{self.event_id}",
                                  headers={"X-Request-Id": "e2e04-restart-probe"})
            assert response.status_code == 200
            return response.json()["data"]

    def records(self, worker, prefix):
        return e2e._log_records(worker.path / "worker.log", prefix + " ")

    def wait_record(self, worker, prefix, predicate=lambda _: True, *, timeout=30):
        return e2e._wait_for_log_record(worker.path / "worker.log", prefix + " ", predicate, timeout=timeout)

    async def admit(self):
        self.meeting_id, self.media_id, self.job_id = await self.admission.admit(e2e.synthetic_wav())
        self.event_id = await asyncio.to_thread(poll, self.delivery_id, bool, label="Core delivery")
        return self.event_id

    def delivery_id(self):
        return e2e._psql(self.database, self.database["password"],
                         "SELECT event_id FROM transcription_worker_deliveries "
                         f"WHERE processing_job_id='{self.job_id}'::uuid ORDER BY generation DESC LIMIT 1")

    def evidence(self):
        return r01._r01_evidence(self.database, self.job_id, self.event_id)

    def receipts(self):
        return json.loads(e2e._psql(self.database, self.database["password"], f"""
            SELECT COALESCE(json_agg(json_build_object(
                'eventId', d.event_id, 'generation', d.generation, 'receiptId', r.receipt_id,
                'outcome', r.outcome, 'executionStageRunId', r.execution_stage_run_id,
                'producerStageRunId', r.producer_stage_run_id, 'transcriptId', r.transcript_id,
                'commandId', r.command_id, 'errorCode', r.error_code,
                'retryable', r.retryable, 'retryExhausted', r.retry_exhausted,
                'recordedAt', r.recorded_at) ORDER BY d.generation), '[]'::json)
            FROM transcription_worker_receipts r JOIN transcription_worker_deliveries d ON d.event_id=r.event_id
            WHERE r.processing_job_id='{self.job_id}'::uuid
        """))

    def owner(self):
        raw = e2e._psql(self.database, self.database["password"], f"""
            SELECT json_build_object('eventId',c.event_id,'stageRunId',c.execution_stage_run_id,
                'generation',d.generation,'stageStatus',s.status,'errorCode',s.error_code,
                'claimedAt',c.claimed_at,'leaseExpiresAt',s.lease_expires_at,'serverTime',clock_timestamp(),
                'remainingSeconds',extract(epoch FROM s.lease_expires_at-clock_timestamp()),
                'live',s.status='RUNNING' AND s.lease_expires_at>clock_timestamp())
            FROM transcription_worker_claims c JOIN transcription_worker_deliveries d ON d.event_id=c.event_id
            JOIN processing_stage_runs s ON s.id=c.execution_stage_run_id WHERE c.event_id='{self.event_id}'::uuid
        """)
        return json.loads(raw) if raw else None

    def slot(self, producer=None):
        producer = producer or self.owner()["stageRunId"]
        return f"processing/{self.job_id}/transcription/results/{producer}.json"

    @contextmanager
    def storage_client(self):
        client = boto3.client("s3", endpoint_url=self.boundary.s3_endpoint_url,
                            verify=str(self.pki / "ca.crt"), region_name="us-east-1",
                            aws_access_key_id=self.credentials.storage_worker_user,
                            aws_secret_access_key=self.credentials.storage_worker_password,
                            config=Config(connect_timeout=3, read_timeout=5,
                                          retries={"total_max_attempts": 1}, s3={"addressing_style": "path"}))
        try:
            yield client
        finally:
            client.close()

    def object_bytes(self, key):
        with self.storage_client() as client:
            body = client.get_object(Bucket=self.boundary.s3_bucket, Key=key)["Body"]
            try:
                return body.read()
            finally:
                body.close()

    def assert_source(self):
        evidence = self.evidence()
        raw = self.object_bytes(evidence["sourceObjectKey"])
        assert raw == e2e.synthetic_wav()
        assert hashlib.sha256(raw).hexdigest() == evidence["sourceSha256"]
        return evidence["sourceSha256"]

    def assert_immutable(self, key, raw):
        with self.storage_client() as client:
            for operation, expected in (
                (lambda: client.put_object(Bucket=self.boundary.s3_bucket, Key=key,
                                           Body=b"replacement", IfNoneMatch="*"), (409, 412)),
                (lambda: client.put_object(Bucket=self.boundary.s3_bucket, Key=key,
                                           Body=b"replacement"), (403,)),
                (lambda: client.delete_object(Bucket=self.boundary.s3_bucket, Key=key), (403,)),
            ):
                with pytest.raises(ClientError) as error:
                    operation()
                assert error.value.response["ResponseMetadata"]["HTTPStatusCode"] in expected
        assert self.object_bytes(key) == raw

    def assert_missing(self, key):
        with self.storage_client() as client:
            with pytest.raises(ClientError) as error:
                client.get_object(Bucket=self.boundary.s3_bucket, Key=key)
            assert error.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404

    async def retry(self, generation):
        job = await self.admission.request("POST", f"/api/v1/processing-jobs/{self.job_id}/retry",
                                           headers={"Idempotency-Key": str(uuid4())}, json={})
        assert job["retryCount"] == generation
        self.event_id = self.delivery_id()
        assert self.owner() is None or self.owner()["generation"] == generation
        return job

    def wait_failure(self, code, *, timeout=210):
        return poll(self.receipts, lambda items: any(item["eventId"] == self.event_id
                    and item["outcome"] == "FAILURE_RECORDED" and item["errorCode"] == code for item in items),
                    timeout=timeout, interval=0.5, label="durable failure " + code)

    def settled_failure(self, *, code, count=1):
        evidence = self.evidence()
        receipts = self.receipts()
        assert len(receipts) == evidence["receiptCount"] == count
        assert evidence["acceptedReceiptCount"] == evidence["resultCount"] == 0
        assert evidence["transcriptCount"] == evidence["canonicalTranscriptCount"] == 0
        assert all(item["outcome"] == "FAILURE_RECORDED" and item["errorCode"] == code for item in receipts)
        e2e._assert_acknowledged(self.names[0], self.credentials, timeout=60)
        self.assert_source()
        self.assert_ack_order()
        return evidence, receipts

    def settled_retry(self):
        evidence, receipts = self.evidence(), self.receipts()
        assert len(receipts) == evidence["receiptCount"] == 2
        assert [item["generation"] for item in receipts] == [0, 1]
        assert receipts[0]["outcome"] == "FAILURE_RECORDED" and receipts[0]["errorCode"] == "STAGE_LEASE_EXPIRED"
        assert receipts[1]["outcome"] == "RESULT_ACCEPTED"
        assert receipts[0]["eventId"] != receipts[1]["eventId"]
        assert receipts[0]["executionStageRunId"] != receipts[1]["executionStageRunId"]
        assert evidence["acceptedReceiptCount"] == evidence["failureReceiptCount"] == 1
        assert evidence["transcriptCount"] == evidence["canonicalTranscriptCount"] == 1
        assert evidence["receiptToTranscriptCount"] == evidence["resultCount"] == 1
        assert evidence["generation"] == 1
        e2e._assert_acknowledged(self.names[0], self.credentials, timeout=60)
        self.assert_source()
        e2e._assert_result_storage(self.boundary, self.job_id, evidence, self.credentials)
        self.assert_ack_order()
        return evidence, receipts

    def broker(self):
        return r01._broker_evidence(self.names[0])

    def wait_broker(self, predicate, *, timeout=30):
        return poll(self.broker, predicate, timeout=timeout, interval=0.5, label="broker state")

    async def accepted(self, worker):
        return await self.admission.wait_for_acceptance(
            self.meeting_id, self.job_id, worker_alive=lambda: worker.process.poll() is None)

    def settled_success(self, *, inference=1):
        evidence = self.evidence()
        e2e._assert_r01_evidence(evidence)
        assert evidence["sourceSha256"] == hashlib.sha256(e2e.synthetic_wav()).hexdigest()
        assert sum(len(self.records(worker, "E2E04_INFERENCE")) for worker in self.workers) == inference
        e2e._assert_acknowledged(self.names[0], self.credentials, timeout=45)
        e2e._assert_result_storage(self.boundary, self.job_id, evidence, self.credentials)
        self.assert_ack_order()
        return evidence

    def assert_ack_order(self):
        for worker in self.workers:
            assert_ack_confirmations(self.records(worker, "E2E04_HTTP"), self.records(worker, "E2E04_ACK"))

    def report(self, scenario, **details):
        if re.fullmatch(r"R0[2-9][AB]?", scenario):
            evidence = self.evidence()
            details["durable"] = {key: evidence[key] for key in (
                "processingJobId", "eventId", "generation", "jobStatus", "claimCount",
                "claimStageRunId", "producerStageRunId", "receiptId", "transcriptId",
                "receiptCount", "acceptedReceiptCount", "failureReceiptCount", "canonicalTranscriptCount",
                "transcriptCount", "resultCount", "sourceSha256", "resultSha256", "correctionSha256",
                "outboxStatus", "reconciliationDispositions")}
        print("E2E04_" + scenario + "_EVIDENCE " + json.dumps({
            "jobId": self.job_id, "eventId": self.event_id, **details,
        }, separators=(",", ":")), flush=True)

    def diagnostic(self):
        if not self.event_id:
            return
        try:
            evidence = self.evidence()
            evidence.pop("sourceObjectKey", None)
            self.report("RECOVERY_DIAGNOSTIC", durable=evidence, broker=self.broker(),
                        workers=[{"label": worker.path.name, "exit": worker.process.poll(),
                                  **{prefix: self.records(worker, prefix)[-30:] for prefix in (
                                      "E2E04_MESSAGE", "E2E04_CLAIM", "E2E04_HTTP", "E2E04_FAULT",
                                      "E2E04_ACK", "E2E04_INFERENCE", "E2E04_PIPELINE_RESULT",
                                      "E2E04_FAILURE", "E2E04_STORAGE")}} for worker in self.workers])
        except Exception:
            print("E2E04_RECOVERY_DIAGNOSTIC unavailable", flush=True)


@pytest.fixture
def recovery(services, storage_boundary, postgres, tmp_path):
    with RecoveryRun(services, storage_boundary, postgres, tmp_path) as run:
        yield run
