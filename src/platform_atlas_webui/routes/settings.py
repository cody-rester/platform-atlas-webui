"""Settings routes — appearance prefs (theme palette + light/dark mode).

Maps onto Aurora & Horizon: ``data-theme`` (palette) and ``data-mode``
(light/dark) attributes on the document root, persisted to
``~/.atlas/config.json`` under ``webui_theme`` and ``webui_mode``.

Also handles small ambient prefs like the "Upgrade to Extended" sidebar
panel dismiss state.
"""

from __future__ import annotations

from fastapi import APIRouter, Form, HTTPException, Response

from platform_atlas_webui.services import config as config_svc

router = APIRouter(prefix="/api/settings", tags=["settings"])

_VALID_THEMES = {"aurora", "horizon", "obsidian", "meadow", "carbon", "itential", "dracula"}
# "auto" follows the OS prefers-color-scheme — the client resolves it to
# light/dark at runtime; we only persist the intent.
_VALID_MODES = {"light", "dark", "auto"}


@router.api_route("/appearance", methods=["PATCH", "POST"])
async def patch_appearance(
    theme: str | None = Form(None),
    mode: str | None = Form(None),
) -> Response:
    """Update appearance prefs. Accepts a partial body — either field is optional.

    Returns 204 on success, 400 on validation failure. Client is expected
    to flip ``data-theme`` / ``data-mode`` on ``<html>`` optimistically
    and use this endpoint only for durable storage.
    """
    updates: dict[str, str] = {}

    if theme is not None:
        if theme not in _VALID_THEMES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid theme '{theme}'. Allowed: {sorted(_VALID_THEMES)}",
            )
        updates["webui_theme"] = theme

    if mode is not None:
        if mode not in _VALID_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid mode '{mode}'. Allowed: {sorted(_VALID_MODES)}",
            )
        updates["webui_mode"] = mode

    if not updates:
        raise HTTPException(
            status_code=400,
            detail="At least one of 'theme' or 'mode' must be provided.",
        )

    config_svc.update_config(updates)
    return Response(status_code=204)


@router.api_route("/upgrade-panel", methods=["PATCH", "POST"])
async def patch_upgrade_panel(dismissed: str = Form(...)) -> Response:
    """Persist the dismissed state of the sidebar 'Upgrade to Extended' panel."""
    truthy = {"1", "true", "yes", "on"}
    config_svc.update_config({
        "webui_upgrade_panel_dismissed": dismissed.strip().lower() in truthy,
    })
    return Response(status_code=204)
