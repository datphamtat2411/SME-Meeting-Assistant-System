from pathlib import Path

import pytest

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioNormalizer,
    SileroVadBackend,
    SpeechMapBuilder,
)
from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.core.config import ConfigurationError, load_settings
from sme_meeting_ai.pipeline import AudioPreprocessingPipeline

from .support import (
    EvaluationError,
    load_manifest,
    require,
    require_pinned_model,
    verify_source,
)


def pytest_addoption(parser):
    group = parser.getgroup("preprocessing evaluation")
    group.addoption("--evaluation-fixture-root", type=Path, default=None,
                    help="Explicit approved local dataset directory containing manifest.json")
    group.addoption("--evaluation-output", type=Path, default=None,
                    help="Required JSON output path outside the fixture root")


@pytest.fixture(scope="session")
def evaluation_run(request):
    root = request.config.getoption("evaluation_fixture_root")
    output = request.config.getoption("evaluation_output")
    backend = None
    try:
        require(root is not None and output is not None, "explicit fixture root and output")
        root, output = root.resolve(), output.absolute()
        require(output.parent.is_dir() and not output.is_symlink()
                and not output.resolve().is_relative_to(root), "output location")
        manifest = load_manifest(root)
        # Do not load an implicit .env file for an evaluation; require explicit env.
        settings = load_settings(env_file=None)
        require_pinned_model(settings)
        model = settings.audio_vad_model_path
        require(output.resolve() != model.resolve()
                and (not output.exists() or not output.samefile(model)), "output model alias")
        # Validate every fixture before loading/inferencing the model, and never
        # allow the report to overwrite original bytes through a hard-link alias.
        for fixture in manifest.fixtures:
            source = verify_source(root, fixture)
            require(not output.exists() or not output.samefile(source), "output source alias")
        # Both model bytes and SHA-256 are mandatory before this real adapter loads.
        backend = SileroVadBackend.from_settings(settings)
        pipeline = AudioPreprocessingPipeline(
            AudioNormalizer(settings), AudioEvidenceDetector(settings, backend), SpeechMapBuilder(settings),
        )
    except (EvaluationError, ConfigurationError, AudioProcessingError, OSError):
        pytest.fail("evaluation provisioning/configuration invalid; approved root, output and pinned local model required", pytrace=False)
    try:
        yield manifest, root, output, pipeline, settings.audio_vad_model_sha256
    finally:
        if backend is not None:
            backend.close()
