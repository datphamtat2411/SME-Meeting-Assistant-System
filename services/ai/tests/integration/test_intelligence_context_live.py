"""Paid synthetic compatibility probe: requires separate operator authorization."""

import os

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.meeting_intelligence.qualification import qualify
from sme_meeting_ai.providers.openrouter_intelligence import (
    OpenRouterIntelligenceAdapter,
)

pytestmark = pytest.mark.live_provider


def test_opt_in_vietnamese_structured_output_compatibility():
    if os.environ.get("RUN_OPENROUTER_LIVE_INTELLIGENCE") != "1":
        pytest.skip("Explicit operator authorization is required for paid inference")
    if os.environ.get("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "").lower() != "true":
        pytest.fail("Explicit inference enablement is required")
    if not os.environ.get("OPENROUTER_API_KEY"):
        pytest.fail("Explicit environment provider credentials are required")
    conf = Settings(_env_file=None, service_name="t03-synthetic-probe", service_identity="ai-core")
    with OpenRouterIntelligenceAdapter(conf) as adapter:
        report = qualify(adapter, conf)
    assert report.passed == report.fixture_count == 4
