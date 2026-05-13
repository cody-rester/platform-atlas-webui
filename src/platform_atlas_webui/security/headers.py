"""Security response headers middleware."""

from __future__ import annotations

import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


def _csp_for(nonce: str) -> str:
    """Build the response CSP.

    Today: ``script-src 'self' 'unsafe-inline' 'unsafe-eval'``.

    - ``'unsafe-inline'`` — templates rely on ``onclick=``/``onchange=``
      inline event handlers which CSP3 blocks whenever a nonce is present
      (the nonce makes the browser ignore ``'unsafe-inline'``).
    - ``'unsafe-eval'`` — Alpine.js (vanilla build) evaluates every
      directive expression (``x-data``, ``x-show``, ``@click``, ``x-text``,
      …) via ``new Function(expression)``, which CSP classifies as eval.
      Without this, Alpine fails on every directive — and worse, it still
      strips ``x-cloak`` attributes before the eval fails, so dropdowns
      and modals end up rendered without their hide-by-default styles.
      The proper long-term fix is to swap in the ``@alpinejs/csp`` build
      and refactor inline expressions to registered ``Alpine.data()``
      components, but that is a multi-template migration.

    The nonce is still emitted (and templates carry ``nonce="…"`` on their
    <script> blocks) so we can flip on enforcement once the inline handlers
    migrate to delegated listeners — without needing a second template pass.

    Style-src keeps ``'unsafe-inline'`` because inline styles can't run
    code and template surgery is high-risk.
    """
    # NOTE: keep the ``nonce`` parameter in the signature even though it is
    # currently unused — flipping this to ``'self' 'nonce-{nonce}'`` is the
    # one-line change that turns enforcement on once handlers are migrated.
    _ = nonce
    return (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )


def get_csp_nonce(request: Request) -> str:
    """Return the per-request CSP nonce, generating one if absent.

    Templates that emit inline ``<script>`` tags must include ``nonce``
    matching this value. Routes that bypass the middleware can call this
    to receive a fresh value rather than rendering an empty attribute.
    """
    nonce = getattr(request.state, "csp_nonce", None)
    if not nonce:
        nonce = secrets.token_urlsafe(16)
        request.state.csp_nonce = nonce
    return nonce


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        # Generate the nonce up-front so templates can read it via
        # ``request.state.csp_nonce`` (exposed in template_context()).
        nonce = secrets.token_urlsafe(16)
        request.state.csp_nonce = nonce
        response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", _csp_for(nonce))
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        # HSTS will be meaningful once TLS (§1) is on; harmless until then.
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response
