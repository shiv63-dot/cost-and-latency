from fastapi import Header, HTTPException, Request, status

from app.core.config import get_settings
from app.core.security import constant_time_equals


def authenticate_client_key(
    request: Request,
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    x_client_id: str | None = Header(default=None),
) -> str:
    settings = get_settings()
    token = (x_api_key or "").strip()
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API key or Bearer token.",
        )

    expected_client_key = settings.proxy_client_api_key
    expected_admin = settings.admin_passcode
    if expected_client_key and constant_time_equals(token, expected_client_key):
        return (x_client_id or "default-client")[:64]
    if expected_admin and constant_time_equals(token, expected_admin):
        return (x_client_id or "admin-operator")[:64]

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid client API key.",
    )


def require_admin_auth(
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    token = (x_api_key or "").strip()
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if not settings.admin_passcode or not constant_time_equals(token, settings.admin_passcode):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin authorization required.",
        )
