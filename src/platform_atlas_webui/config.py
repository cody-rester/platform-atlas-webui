"""
WebUI configuration.

The WebUI server is intentionally minimal — it reads its host/port and a
small set of UX flags from environment variables. Atlas-side configuration
(environments, sessions, rulesets) is handled by the core library exactly
as it is for the CLI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class WebUISettings:
    """Runtime settings for the WebUI server."""

    host: str = "127.0.0.1"
    port: int = 8765
    reload: bool = False
    log_level: str = "info"

    # Bind to localhost by default — admins who need a remote-accessible server
    # have to opt in explicitly. This stops accidental exposure on shared hosts.
    allow_remote: bool = False

    # Future-proofing slots; not consumed yet but documented so the surface stays
    # stable as the WebUI grows.
    static_url_prefix: str = "/static"
    templates_url_prefix: str = ""

    @classmethod
    def from_env(cls) -> "WebUISettings":
        host = os.environ.get("ATLAS_WEBUI_HOST", "127.0.0.1")
        port = int(os.environ.get("ATLAS_WEBUI_PORT", "8765"))
        reload = os.environ.get("ATLAS_WEBUI_RELOAD", "0") in ("1", "true", "True")
        log_level = os.environ.get("ATLAS_WEBUI_LOG_LEVEL", "info").lower()
        allow_remote = os.environ.get("ATLAS_WEBUI_ALLOW_REMOTE", "0") in ("1", "true", "True")

        # Refuse to bind to 0.0.0.0 unless the operator explicitly opted in,
        # so a fat-finger ATLAS_WEBUI_HOST doesn't accidentally publish the UI.
        if host in ("0.0.0.0", "::") and not allow_remote:
            host = "127.0.0.1"

        return cls(
            host=host,
            port=port,
            reload=reload,
            log_level=log_level,
            allow_remote=allow_remote,
        )
