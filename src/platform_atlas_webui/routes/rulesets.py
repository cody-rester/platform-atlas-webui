"""Ruleset routes — list, view, switch active, switch profile."""

from __future__ import annotations

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from platform_atlas.core._version import __version__ as ATLAS_VERSION

from platform_atlas_webui.dependencies import get_templates, template_context
from platform_atlas_webui.services import rulesets as ruleset_svc
from platform_atlas_webui.services.environments import active_env_allows_legacy

router = APIRouter(prefix="/rulesets", tags=["rulesets"])
_templates = get_templates()


def _filter_legacy(items: list, allow: bool) -> list:
    if allow:
        return items
    return [item for item in items if not item.get("is_legacy")]


@router.get("", response_class=HTMLResponse)
async def view_rulesets(request: Request) -> HTMLResponse:
    summary = ruleset_svc.get_active_ruleset_summary()
    allow_legacy = active_env_allows_legacy()
    rulesets = _filter_legacy(ruleset_svc.list_rulesets(), allow_legacy)
    profiles = _filter_legacy(ruleset_svc.list_profiles(), allow_legacy)
    return _templates.TemplateResponse(
        "rulesets/active.html",
        template_context(
            request,
            atlas_version=ATLAS_VERSION,
            ruleset=summary,
            rulesets=rulesets,
            profiles=profiles,
        ),
    )


@router.post("/activate")
async def activate_ruleset(
    ruleset_id: str = Form(...),
    profile_id: str = Form(""),
):
    try:
        ruleset_svc.set_active(ruleset_id, profile_id=profile_id or None)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return RedirectResponse(url="/rulesets", status_code=303)
