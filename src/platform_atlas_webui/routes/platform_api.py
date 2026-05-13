"""
Platform API routes — DISABLED.

This module previously exposed three Operations Manager endpoints in the WebUI
(``Get Automations``, ``Get Tasks``, ``Get Jobs``). It has been deactivated
pending product direction.

The shape we'd restore looks like:

    GET  /platform-api                 → landing page listing available calls
    GET  /platform-api/{slug}          → table view of one endpoint's response
    GET  /platform-api/{slug}/raw      → raw JSON download (still redacted)

To bring it back:

    1. Re-implement the routes here. Each handler should:
         - resolve the EndpointSpec from services.platform_api.get_endpoint(slug)
         - call services.platform_api.call_endpoint(slug, query) in a threadpool
         - render templates/platform_api/{landing,result}.html (recreate from git
           history — see commit that introduced the feature)
    2. Re-flesh services/platform_api.py — the endpoint registry, ``call_endpoint``
       executor that piggybacks on PlatformCollector's OAuth client, and the
       redact() pass.
    3. Uncomment the ``platform_api`` import and ``include_router`` call in
       routes/__init__.py.
    4. Restore the "Platform API" sidebar block in templates/base.html.

The router below is intentionally empty — registering it is a no-op so we don't
have to touch routes/__init__.py twice when re-enabling.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/platform-api", tags=["platform-api"])
