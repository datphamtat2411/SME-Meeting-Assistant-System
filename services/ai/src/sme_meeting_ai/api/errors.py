"""Stable HTTP errors without exception text or input-bearing details."""

from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": message}}, status_code=status
    )


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    code, message = {
        401: ("service_authentication_required", "Service authentication required"),
        403: ("service_access_denied", "Service access denied"),
        404: ("not_found", "Resource not found"),
        405: ("method_not_allowed", "Method not allowed"),
        503: ("service_security_unavailable", "Service security unavailable"),
    }.get(exc.status_code, ("http_error", "Request failed"))
    response = error_response(exc.status_code, code, message)
    # Only the method-error protocol header is needed by the current surface.
    if exc.status_code == 405 and exc.headers:
        for name, value in exc.headers.items():
            if name.lower() == "allow" and all(
                part.strip() in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}
                for part in value.split(",")
            ):
                response.headers["Allow"] = ", ".join(part.strip() for part in value.split(","))
    return response


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return error_response(422, "validation_error", "Request validation failed")


async def unexpected_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return error_response(500, "internal_error", "Internal server error")
