"""Health endpoint — JSON readiness probe used by uptime monitors."""

from __future__ import annotations

from fastapi import APIRouter

from platform_atlas.core._version import __version__ as ATLAS_VERSION

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    try:
        from platform_atlas.core.context import ctx
        atlas = ctx()
        return {
            "ok": True,
            "ready": True,
            "tier": atlas.tier,
            "version": ATLAS_VERSION,
        }
    except Exception as exc:  # noqa: BLE001 — health endpoint must not raise
        return {
            "ok": False,
            "ready": False,
            "version": ATLAS_VERSION,
            "error": str(exc),
        }
