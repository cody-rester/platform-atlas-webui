"""Auth route — validate one-time nonce and issue session cookie."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse, Response

from platform_atlas_webui.security.tokens import (
    COOKIE_NAME,
    _COOKIE_MAX_AGE,
    make_session_cookie_value,
    validate_nonce,
)

router = APIRouter(tags=["auth"])


@router.get("/auth")
async def authenticate(nonce: str = Query(...)):
    """Consume a one-time nonce and set the session cookie."""
    if not validate_nonce(nonce):
        raise HTTPException(status_code=401, detail="Invalid or expired login link.")

    session_id = secrets.token_hex(32)
    cookie_value = make_session_cookie_value(session_id)

    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=cookie_value,
        max_age=_COOKIE_MAX_AGE,
        path="/",
        httponly=True,
        samesite="strict",
        secure=True,
    )
    return response
