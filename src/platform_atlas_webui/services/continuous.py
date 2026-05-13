"""
WebUI scheduler for continuous audit.

A single asyncio background task wakes every ``TICK_SECONDS`` and:

    1. Reads the active environment from the Atlas context.
    2. Reads its ``continuous_audit`` settings from the env overlay.
    3. If enabled and ``(now - last_finished_at) >= interval_seconds``,
       runs ``engine.run_once`` in a thread (the engine is sync I/O).
    4. Updates the ``status.json`` heartbeat (the engine already does this).

V1 limitation: only the currently-active environment is scheduled in-process.
Customers running continuous audit on multiple envs from a single host should
schedule the CLI ``platform-atlas continuous-audit run-once`` via OS cron for
the other envs — the on-disk format is identical, so the WebUI surfaces all
runs regardless of who wrote them.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from platform_atlas.continuous import alerts as alerts_mod, storage
from platform_atlas.continuous.engine import run_once
from platform_atlas.continuous.runtime import read_settings

logger = logging.getLogger(__name__)


# Tick cadence — independent of the per-env interval. We wake briefly to
# check whether a run is due. Short enough that a freshly-enabled env runs
# quickly; long enough that the loop is essentially idle.
TICK_SECONDS = 30


class ContinuousScheduler:
    """Background asyncio task that drives ``engine.run_once`` per the active env's settings."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._running_envs: set[str] = set()  # in-flight runs to prevent overlap
        self._last_started_at: dict[str, str] = {}

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if self.is_running:
            return
        self._stop_event.clear()
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._loop(), name="continuous-audit-scheduler")
        logger.info("Continuous audit scheduler started")

    async def stop(self) -> None:
        if not self.is_running:
            return
        self._stop_event.set()
        try:
            await asyncio.wait_for(self._task, timeout=10)
        except asyncio.TimeoutError:
            self._task.cancel()
        self._task = None
        logger.info("Continuous audit scheduler stopped")

    async def _loop(self) -> None:
        # First tick is immediate so an enabled env runs without waiting one
        # full TICK on startup. Subsequent ticks are spaced by TICK_SECONDS.
        first = True
        while not self._stop_event.is_set():
            try:
                if not first:
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=TICK_SECONDS)
                        # If wait returned (not timed out), stop was set.
                        break
                    except asyncio.TimeoutError:
                        pass
                first = False
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never let a tick crash the loop
                logger.warning("Continuous scheduler tick failed: %s", exc, exc_info=True)

    async def _tick(self) -> None:
        try:
            from platform_atlas.core.context import ctx
            atlas = ctx()
        except Exception as exc:  # noqa: BLE001
            logger.debug("Scheduler tick: Atlas context not available (%s)", exc)
            return

        env = atlas.active_environment
        if not env:
            return

        settings = read_settings(env)
        if not settings.enabled:
            return

        # Defer to the OS timer when one is installed and active — otherwise
        # we'd double-fire (in-process + systemd) and burn extra Platform calls.
        try:
            from platform_atlas.continuous import os_scheduler
            timer = os_scheduler.status(env)
            if timer.installed and timer.active:
                logger.debug("Scheduler tick: OS timer is active for env=%s; deferring", env)
                return
        except Exception as exc:  # noqa: BLE001 — fall through to in-process if check fails
            logger.debug("Scheduler tick: OS timer check failed (%s); running in-process", exc)

        if env in self._running_envs:
            logger.debug("Scheduler tick: env=%s still running, skipping", env)
            return

        if not _is_due(env, settings.interval_seconds):
            return

        logger.info("Scheduler firing run for env=%s", env)
        self._running_envs.add(env)
        self._last_started_at[env] = storage.now_iso()
        try:
            # engine.run_once is fully sync (httpx, json, file I/O). Push it
            # off the event loop so the FastAPI request loop stays snappy.
            await asyncio.to_thread(run_once, environment=env)
        finally:
            self._running_envs.discard(env)


_scheduler_singleton: ContinuousScheduler | None = None


def get_scheduler() -> ContinuousScheduler:
    global _scheduler_singleton
    if _scheduler_singleton is None:
        _scheduler_singleton = ContinuousScheduler()
    return _scheduler_singleton


def _is_due(environment: str, interval_seconds: int) -> bool:
    """True when at least ``interval_seconds`` have passed since last_finished_at."""
    status = storage.read_status(environment)
    last = status.get("last_finished_at")
    if not last:
        # Never run before — fire immediately.
        return True
    try:
        ts = last.rstrip("Z")
        when = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    age = (datetime.now(timezone.utc) - when).total_seconds()
    return age >= interval_seconds


# ── Read-helpers used by the routes ───────────────────────────────────

def topbar_summary(environment: str | None) -> dict:
    """Compact dict the base.html topbar pill renders.

    Returns ``{"enabled": bool, "state": str, "last_age": str, "unacked": int, ...}``
    where state ∈ {ON, STALE, FAILING, PENDING}.
    """
    if not environment:
        return {"enabled": False, "state": "OFF", "last_age": "", "unacked": 0}
    settings = read_settings(environment)
    if not settings.enabled:
        return {"enabled": False, "state": "OFF", "last_age": "", "unacked": 0}
    status = storage.read_status(environment)
    counts = alerts_mod.counts(environment)
    state = _staleness(status, settings.interval_seconds)

    os_scheduler_active = False
    try:
        from platform_atlas.continuous import os_scheduler as _os
        timer = _os.status(environment)
        os_scheduler_active = bool(timer.installed and timer.active)
    except Exception:  # noqa: BLE001
        pass

    return {
        "enabled": True,
        "state": state,
        "last_age": _humanize_age(status.get("last_finished_at")),
        "next_in": _humanize_countdown(status.get("last_finished_at"), settings.interval_seconds),
        "unacked": counts.get("unacked", 0),
        "total_alerts": counts.get("total", 0),
        "interval_seconds": settings.interval_seconds,
        "os_scheduler_active": os_scheduler_active,
    }


def _staleness(status: dict, interval_seconds: int) -> str:
    if not status:
        return "PENDING"
    if status.get("last_status") == "error":
        return "FAILING"
    last = status.get("last_finished_at")
    if not last:
        return "PENDING"
    try:
        ts = last.rstrip("Z")
        when = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except ValueError:
        return "PENDING"
    age = (datetime.now(timezone.utc) - when).total_seconds()
    if age > max(2 * interval_seconds, 600):
        return "STALE"
    return "ON"


def _humanize_age(iso_ts: str | None) -> str:
    if not iso_ts:
        return "never"
    try:
        ts = iso_ts.rstrip("Z")
        when = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except ValueError:
        return iso_ts
    seconds = int((datetime.now(timezone.utc) - when).total_seconds())
    if seconds < 30:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    return f"{seconds // 86400}d ago"


def _humanize_countdown(last_finished_at: str | None, interval_seconds: int) -> str:
    """Return a human-readable 'time until next run' string."""
    if not last_finished_at:
        return "soon"
    try:
        ts = last_finished_at.rstrip("Z")
        when = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
    except ValueError:
        return "soon"
    age = int((datetime.now(timezone.utc) - when).total_seconds())
    remaining = interval_seconds - age
    if remaining <= 0:
        return "now"
    if remaining < 60:
        return f"{remaining}s"
    if remaining < 3600:
        return f"{(remaining + 59) // 60}m"
    return f"{remaining // 3600}h"
