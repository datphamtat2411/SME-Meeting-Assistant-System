# Diarization test gate

From `services/ai`, run the focused offline gate with:

```sh
uv run pytest tests/unit/test_diarization.py tests/unit/test_diarization_service.py tests/unit/test_demo_pipeline.py tests/integration/test_demo_composition.py
```

The existing AI CI commands are `uv run ruff check src tests` and `uv run pytest tests`.
Mandatory tests block non-loopback socket connections and use fake providers or mocked HTTP transports. Explicitly marked live-provider and live-infrastructure tests remain opt-in and are exempt from the socket guard; they require their existing environment configuration. The offline composition smoke test exercises the application contract, not model accuracy or DER.
