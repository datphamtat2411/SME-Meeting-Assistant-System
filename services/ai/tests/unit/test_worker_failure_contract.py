"""Focused cross-language Worker V1 failure contract; no external services."""

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree

import pytest
from integration.test_offline_transcription_pipeline import workflow as workflow
from integration.test_transcription_worker_integration import Delivery, cleanup, setup

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.integrations.object_storage import ObjectStorage, StorageError
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionFailure,
    OfflineTranscriptionStage,
    _failure,
)
from sme_meeting_ai.pipeline.preprocessing import AudioPreprocessingPipeline
from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory
from sme_meeting_ai.transcription.asr_strategy import AsrStrategyRunner
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
)
from sme_meeting_ai.workers.transcription import (
    _CATEGORIES,
    WorkFailure,
    _eligible_failure,
    pipeline_failure,
)

ROOT = Path(__file__).resolve().parents[4]
CASES = json.loads((ROOT / "contracts/CORE_API_AI_TRANSCRIPTION_WORKER_V1.failure-fixtures.json").read_text())


@pytest.fixture(scope="session", autouse=True)
def java_classifier(tmp_path_factory):
    path = tmp_path_factory.mktemp("failure-matrix") / "requests.csv"
    phases = [stage.name for stage in OfflineTranscriptionStage] + [
        "SOURCE_DOWNLOAD", "RESULT_VALIDATION", "RESULT_STORAGE", "PUBLICATION", "INTERRUPTED"]
    stages = ["TRANSCRIPTION", "CONTEXTUAL_CORRECTION", "FINALIZING_TRANSCRIPT"]
    requests = [(p, c, s) for p in phases for c in sorted(_CATEGORIES) for s in stages]
    assert len(requests) == 528
    path.write_text("".join(",".join(row) + "\n" for row in requests))
    result = subprocess.run(["mvn", "-q", "-Dtest=WorkerFailureContractTests", f"-Df02.matrix={path}", "test"],
                            cwd=ROOT / "services/api", capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, "Focused Java classifier/parser tests failed:\n" + result.stdout + result.stderr
    report = ROOT / "services/api/target/surefire-reports/TEST-com.sme.meetingassistant.api.media.worker.WorkerFailureContractTests.xml"
    summary = ElementTree.parse(report).getroot()
    assert int(summary.attrib["tests"]) >= 3
    assert int(summary.attrib["failures"]) == int(summary.attrib["errors"]) == int(summary.attrib["skipped"]) == 0
    results = Path(str(path) + ".results").read_text().splitlines()
    assert len(results) == len(requests)
    for request, row in zip(requests, results, strict=True):
        phase, category, stage, code, _retryable = row.split(",")
        assert (phase, category, stage) == request
        assert _eligible_failure(WorkFailure(phase, category), stage) == (code != "422")


@pytest.mark.parametrize("case", [c for c in CASES if c["phase"] in OfflineTranscriptionStage.__members__])
def test_pipeline_mapping_preserves_category_and_sanitizes(case):
    stage = OfflineTranscriptionStage[case["phase"]]
    outcome = SimpleNamespace(failure=OfflineTranscriptionFailure(stage, case["category"]),
                              completed_stages=(), evidence=SimpleNamespace(), provenance=SimpleNamespace())
    failure = pipeline_failure(outcome)
    assert (failure.phase, failure.category) == (case["phase"], case["category"])
    assert failure.completed_through is None and failure.metrics == {}
    assert "private" not in str(failure)


@pytest.mark.parametrize("case", CASES)
def test_worker_eligibility_matches_shared_classifier_cases(case):
    failure = WorkFailure(case["phase"], case["category"])
    assert _eligible_failure(failure, case.get("stage", "TRANSCRIPTION")) is (case["code"] is not None)


@pytest.mark.parametrize("category", ["TIMEOUT", "MODEL_UNAVAILABLE", "RESOURCE", "VALIDATION"])
def test_asr_preflight_preserves_typed_audio_errors(category):
    runner = object.__new__(AsrStrategyRunner)
    def fail(*args):
        raise AudioProcessingError(category)
    runner._prepare = fail
    with pytest.raises((AudioProcessingError, AsrError)) as error:
        runner.prepare(None, None)
    assert error.value.category.value.upper() == category


@pytest.mark.parametrize("stage", list(OfflineTranscriptionStage))
def test_unclassified_local_exception_is_resource(stage):
    result = _failure(RuntimeError("private exception"), stage)
    assert result.category == "RESOURCE"
    assert "private exception" not in repr(result)


@pytest.mark.parametrize("stage", list(OfflineTranscriptionStage))
@pytest.mark.parametrize("error,category", [
    *[(AudioProcessingError(c), c) for c in ("VALIDATION", "DECODING", "TIMEOUT", "RESOURCE", "MODEL_UNAVAILABLE", "INFERENCE")],
    *[(AsrError(c), c.value.upper()) for c in AsrErrorCategory],
    *[(CorrectionError(c), c.value.upper()) for c in CorrectionErrorCategory],
])
def test_typed_exception_envelope_retains_category(stage, error, category):
    assert _failure(error, stage).category == category


def test_invalid_storage_alias_is_configuration():
    storage = ObjectStorage(SimpleNamespace(s3_storage_id="private"), client=object())
    with pytest.raises(StorageError) as error:
        storage._store("wrong")
    assert error.value.category == "CONFIGURATION"


@pytest.mark.parametrize("origin,expected", [("source", "source"), ("evidence", "evidence")])
def test_preprocessing_keeps_validation_origin(origin, expected, tmp_path):
    from sme_meeting_ai.audio import AudioSource
    class Normalizer:
        def normalize(self, source):
            raise AudioProcessingError("VALIDATION", origin=origin)
    output = AudioPreprocessingPipeline(Normalizer(), None, None).run(AudioSource("source", tmp_path / "audio"))
    try:
        assert output.failure.category == "VALIDATION"
        assert output.failure.origin == expected
    finally:
        output.close()


@pytest.mark.parametrize("count,through", [(0, None), (None, None), (16000, "RECONCILIATION")])
def test_partial_proof_never_claims_invalid_sample_count(count, through):
    stage = OfflineTranscriptionStage.CORRECTION
    provenance = SimpleNamespace(source_id="source", sample_count=count, reconciliation="safe")
    evidence = SimpleNamespace(source_id="source", reconciliation=SimpleNamespace(provenance="safe"),
                               coverage=SimpleNamespace(unresolved_intervals=()))
    outcome = SimpleNamespace(failure=OfflineTranscriptionFailure(stage, "PROVIDER"),
                              completed_stages=tuple(OfflineTranscriptionStage)[:-1],
                              provenance=provenance, evidence=evidence, warnings=())
    failure = pipeline_failure(outcome)
    assert failure.completed_through == through
    assert failure.metrics == ({"sampleCount": count, "warningCount": 0, "unresolvedRegionCount": 0}
                               if through else {})


def test_uncertain_result_put_not_found_does_not_send_fail_or_ack(workflow):
    async def run():
        resources = await setup(workflow())
        def fail(*args):
            raise WorkFailure("RESULT_STORAGE", "NOT_FOUND")
        resources.worker._prepare = fail
        try:
            delivery = Delivery(resources.body)
            await resources.worker.handle(delivery)
            assert delivery.actions == ["nack"]
            assert resources.core.failures == []
        finally:
            await cleanup(resources)
    asyncio.run(run())
