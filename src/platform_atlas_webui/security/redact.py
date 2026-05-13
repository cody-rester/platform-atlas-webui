"""Credential redaction helpers for log output."""

from __future__ import annotations

import logging
from typing import Any

SENSITIVE_KEYS: frozenset[str] = frozenset({
    "vault_token",
    "token",
    "wrapping_token",
    "platform_client_secret",
    "platform_secret",
    "gateway4_password",
    "iag5_password",
    "secret_id",
    "role_id",
    "csrf_token",
})

_REDACTED = "***REDACTED***"


def redact(payload: Any) -> Any:
    """Return a deep copy of *payload* with sensitive keys replaced by ``***REDACTED***``.

    Works on dicts (recursively), lists, and scalars. The redacted value is a
    non-empty string so debug logs can still see that the field was present.
    """
    if isinstance(payload, dict):
        return {
            k: _REDACTED if k in SENSITIVE_KEYS else redact(v)
            for k, v in payload.items()
        }
    if isinstance(payload, list):
        return [redact(item) for item in payload]
    return payload


class _StripQueryStringFilter(logging.Filter):
    """Drop query strings from uvicorn access log records.

    Uvicorn passes the full request line (e.g. ``"GET /path?q=secret HTTP/1.1"``)
    as the third element of ``record.args``. We strip everything after ``?``
    so credentials that accidentally end up in a query parameter never reach
    the log file.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) >= 3:
            path = record.args[2]
            if isinstance(path, str) and "?" in path:
                record.args = (
                    record.args[0],
                    record.args[1],
                    path.split("?", 1)[0],
                    *record.args[3:],
                )
        return True


def install_uvicorn_access_filter() -> None:
    """Attach the query-string-stripping filter to the uvicorn access logger."""
    logging.getLogger("uvicorn.access").addFilter(_StripQueryStringFilter())
