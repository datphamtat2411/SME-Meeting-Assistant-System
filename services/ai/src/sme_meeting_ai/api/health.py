"""Minimal process liveness and HTTP runtime readiness."""

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

router = APIRouter(prefix="/health")


@router.get("/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def ready(request: Request) -> JSONResponse:
    if request.app.state.runtime.initialized:
        return JSONResponse({"status": "ready"})
    return JSONResponse({"status": "not_ready"}, status_code=503)
