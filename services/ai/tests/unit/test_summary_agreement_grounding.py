import json
from pathlib import Path

import pytest
from intelligence_support import settings, snapshot, stage, uid

from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.meeting_intelligence.summary import SummaryProcessor
from unit.test_summary import ScriptedAdapter, _evidence_output, _unit

_FIXTURE_PATH = Path(__file__).parents[1] / "fixtures" / "summary-agreement-grounding-vietnamese.json"
_FIXTURE = json.loads(_FIXTURE_PATH.read_text())
_SOURCES = _FIXTURE["sources"]


def _reference(evidence: dict, citation: str) -> dict:
    text = evidence["text"]
    if citation == "full":
        start, end = 0, len(text)
    else:
        start = text.index(citation)
        end = start + len(citation)
    return {
        "segment_id": evidence["segment_id"],
        "char_start": start,
        "char_end": end,
    }


def _adapter_for(probe: dict) -> ScriptedAdapter:
    def callback(request):
        assert request.task.schema.name == "summary_window_evidence"
        evidence = json.loads(request.window.evidence_json)["evidence"]
        units = []
        for specification in probe["units"]:
            source_item = evidence[specification["segment"]]
            units.append(_unit(
                specification["statement"],
                specification["category"],
                [_reference(source_item, specification["citation"])],
                specification.get("uncertainty", "NONE"),
            ))
        return _evidence_output(request, units)

    return ScriptedAdapter(callback)


@pytest.mark.parametrize(
    "probe",
    _FIXTURE["probes"],
    ids=[probe["name"] for probe in _FIXTURE["probes"]],
)
def test_agreement_grounding_fixture(probe):
    context = stage(snapshot(tuple(_SOURCES[probe["source"]])))
    adapter = _adapter_for(probe)

    try:
        SummaryProcessor(settings(), adapter)(context)
    except IntelligenceError as error:
        actual = "FAIL"
        diagnostic = error.diagnostic
    else:
        actual = "PASS"
        diagnostic = None

    assert actual == probe["expected"]
    if probe["expected"] == "FAIL":
        assert diagnostic is not None
        assert diagnostic.reason == "GROUNDING_FAILURE"
        assert diagnostic.rule == probe["rule"]
        assert diagnostic.item_index == 0
        evidence = diagnostic.evidence
        assert evidence is not None
        specification = probe["units"][0]
        assert evidence.source_snapshot_id == uid(6)
        assert evidence.transcript_id == uid(1)
        assert evidence.content_revision == 3
        assert evidence.model_category == specification["category"]
        assert evidence.references[0].segment_id == uid(100 + specification["segment"])
        assert evidence.references[0].char_start >= 0
        assert evidence.references[0].char_end > evidence.references[0].char_start
        assert len(evidence.source_sha256) == 64
        assert len(evidence.statement_sha256) == 64
        assert len(evidence.evidence_sha256) == 64
        assert evidence.assessment == probe["assessment"]
        assert not hasattr(evidence, "statement")
        if probe["assessment"] == "NEGATIVE_OR_TENTATIVE":
            assert evidence.negative_marker is True
        else:
            assert evidence.negative_marker is False
        assert isinstance(evidence.affirmative_marker, bool)
        if probe["assessment"] in {
            "UNSUPPORTED_MODEL_CLASSIFICATION",
            "INCOMPLETE_CITATION",
            "POSSIBLE_VALIDATOR_FALSE_NEGATIVE",
        }:
            assert evidence.affirmative_marker is False
    else:
        assert diagnostic is None


def test_live_failure_metadata_explicitly_marks_reconstruction_boundary():
    failure = _FIXTURE["liveFailure"]

    assert failure["validationRule"] == "AGREEMENT_UNSUPPORTED"
    assert failure["validationItemIndex"] == 3
    assert failure["providerOutputRetained"] is False
    assert failure["evidenceReferencesRetained"] is False
    assert failure["reconstruction"] == "UNRECOVERABLE"
