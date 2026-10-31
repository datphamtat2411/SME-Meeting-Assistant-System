from contextlib import ExitStack
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
from .transcription_runner import require_live_evaluation
from .transcription_support import (
    external_file,
    load_baseline,
    load_configuration,
    load_reference,
    require_transcription_manifest,
    validate_output_path,
)


def pytest_addoption(parser):
    group = parser.getgroup("preprocessing evaluation")
    group.addoption("--evaluation-fixture-root", type=Path, default=None,
                    help="Explicit approved local dataset directory containing manifest.json")
    group.addoption("--evaluation-output", type=Path, default=None,
                    help="Required JSON output path outside the fixture root")
    group.addoption("--transcription-evaluation-config", type=Path, default=None,
                    help="Required versioned transcription configuration matrix")
    group.addoption("--transcription-evaluation-output", type=Path, default=None,
                    help="Required transcription JSON output outside Git, fixtures and model directories")
    group.addoption("--transcription-evaluation-baseline", type=Path, default=None,
                    help="Optional external sanitized transcription report for compatible comparisons")


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


@pytest.fixture(scope="session")
def transcription_evaluation_run(request):
    __tracebackhide__ = True
    resources = ExitStack()
    try:
        # No implicit .env, credential search, model loading or provider creation
        # before the explicit live opt-in and all local assets are validated.
        settings = load_settings(env_file=None)
        require_live_evaluation(settings)
        root = request.config.getoption("evaluation_fixture_root")
        output = request.config.getoption("transcription_evaluation_output")
        config_path = request.config.getoption("transcription_evaluation_config")
        baseline_path = request.config.getoption("transcription_evaluation_baseline")
        require(root is not None and output is not None and config_path is not None, "explicit transcription options")
        require(not root.is_symlink(), "fixture root")
        root = root.absolute()
        repository = Path(__file__).resolve().parents[4]
        require(not root.resolve().is_relative_to(repository), "external fixture root")
        manifest = load_manifest(root)
        require_transcription_manifest(manifest)
        matrix = load_configuration(config_path)
        for variant in matrix.variants:
            variant.settings(settings)  # Validate every variant before inference.
        require_pinned_model(settings)
        protected = [settings.audio_vad_model_path]
        for fixture in manifest.fixtures:
            protected.append(external_file(root, fixture.path))
            verify_source(root, fixture)
            if fixture.reference is not None:
                load_reference(root, fixture)
                protected.append(external_file(root, fixture.reference.path))
        require(all(not path.resolve().is_relative_to(repository) for path in protected), "external private assets")
        for path in (config_path, baseline_path):
            if path is not None:
                require(not path.resolve().is_relative_to(repository), "external evaluation inputs")

        def check_output():
            validate_output_path(output, root, protected)
            for path in (config_path, baseline_path):
                if path is not None:
                    require(output.resolve() != path.resolve()
                            and (not output.exists() or not path.exists() or not output.samefile(path)), "output input alias")

        check_output()
        baseline = load_baseline(baseline_path) if baseline_path is not None else None
        backend = SileroVadBackend.from_settings(settings)
        resources.callback(backend.close)

        def factory(effective):
            from sme_meeting_ai.providers.openrouter_instruction_llm import (
                OpenRouterInstructionLlmAdapter,
            )
            from sme_meeting_ai.providers.openrouter_whisper import (
                OpenRouterWhisperAdapter,
            )

            transcriber = resources.enter_context(OpenRouterWhisperAdapter(effective))
            corrector = resources.enter_context(OpenRouterInstructionLlmAdapter(effective))
            pipeline = AudioPreprocessingPipeline(
                AudioNormalizer(effective), AudioEvidenceDetector(effective, backend), SpeechMapBuilder(effective),
            )
            return pipeline, transcriber, corrector
    except (EvaluationError, ConfigurationError, AudioProcessingError, OSError, ValueError):
        resources.close()
        pytest.fail("transcription evaluation unavailable; explicit opt-in, approved references/configuration, credentials and pinned model required", pytrace=False)
    try:
        yield manifest, root, output, matrix, factory, settings, baseline, check_output
    finally:
        resources.close()
