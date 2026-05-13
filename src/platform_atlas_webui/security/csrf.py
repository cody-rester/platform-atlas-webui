"""Stateless HMAC-based CSRF tokens."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Optional

from platform_atlas_webui.security.tokens import COOKIE_NAME, load_secret


def _session_id_from_cookie(cookie_value: Optional[str]) -> str:
    """Extract the session_id portion from the signed cookie value."""
    if not cookie_value:
        return ""
    # Cookie format: "{session_id}:{mac}" — see tokens.py
    return cookie_value.rsplit(":", 1)[0]


def generate_csrf_token(cookie_value: Optional[str]) -> str:
    """Generate a CSRF token bound to the current session.

    Format: ``{nonce}:{HMAC(secret, session_id:nonce)}``
    Both parts are hex strings; ":" is the single separator.
    """
    secret = load_secret()
    session_id = _session_id_from_cookie(cookie_value)
    nonce = secrets.token_hex(16)
    message = f"{session_id}:{nonce}"
    mac = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()
    return f"{nonce}:{mac}"


def validate_csrf_token(token: Optional[str], cookie_value: Optional[str]) -> bool:
    """Return True if *token* is a valid CSRF token for the current session."""
    if not token:
        return False
    try:
        nonce, mac = token.split(":", 1)
    except ValueError:
        return False
    secret = load_secret()
    session_id = _session_id_from_cookie(cookie_value)
    message = f"{session_id}:{nonce}"
    expected = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, mac)
