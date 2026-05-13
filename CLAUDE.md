# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

**Working style:** Discuss approaches before implementing anything non-trivial. Cody prefers
to evaluate options first. Ask for clarification rather than guessing on architecture
questions — he'd rather explain upfront than debug a wrong assumption later.

---

## Project Overview

**Platform Atlas WebUI** is an optional FastAPI-based web interface for the Platform Atlas
CLI tool. It ships as a separate wheel (`platform-atlas-webui`) alongside the core
`platform-atlas` wheel and imports the core library directly rather than shelling out.
Customers who only need CLI auditing install the core wheel only; the WebUI is opt-in.

- **Package:** `platform-atlas-webui` (entry point: `platform_atlas_webui.main:main`)
- **Command:** `platform-atlas-webui`
- **Python:** `>=3.11,<4.0`
- **Dependency management:** Poetry
- **Core dependency:** `platform-atlas >=1.7,<2.0`
- **Distribution:** `.whl` via GitHub Releases on `itential/platform-atlas-webui`

### Branding & Identity

Matches the core CLI branding:

| Field | Value |
|---|---|
| CLI command | `platform-atlas-webui` |
| Runtime data dir | `~/.atlas/` (shared with core CLI) |
| Brand colors | Navy `#101625`, Blue `#1B93D2`, Orange `#FF6633`, Green `#99CA3C`, Pink `#C5258F` |
| Fonts | Inter (body), JetBrains Mono (code), Instrument Serif (display) — all self-hosted WOFF2 |

---

## Commands

### Install & Build

```bash
# Install all dependencies (run from repo root)
poetry install

# Build distributable wheel
poetry build

# Run the dev server with auto-reload
poetry run platform-atlas-webui --reload --log-level debug

# Run a specific action
poetry run platform-atlas-webui stop
poetry run platform-atlas-webui status
poetry run platform-atlas-webui login-url
```

### Running Tests

```bash
pytest tests/
pytest tests/ -v
pytest tests/ --cov=src/platform_atlas_webui
```

### Linting

```bash
pylint src/platform_atlas_webui/
bandit -r src/platform_atlas_webui/ --skip B105,B106
```

---

## Architecture

### High-Level Model

The WebUI runs as a local HTTPS server on `127.0.0.1:8765` (default). It imports
`platform_atlas` as a library, initializes the same `AtlasContext` singleton the CLI uses,
and calls the same capture/validate/report engine functions. There is no REST API between
the WebUI and the core — they share process space.

Long-running operations (capture, validate, report, preflight) run in a thread pool via
`asyncio.to_thread` and stream progress to the browser over **Server-Sent Events (SSE)**.

### Entry Point & Startup Flow

`main.py` is the CLI entry point. On `platform-atlas-webui` (no subcommand):

1. Parse CLI args → build `WebUISettings`
2. Print version banner (WebUI + platform-atlas versions)
3. Verify `platform-atlas >=1.7,<2.0` is installed
4. Generate / rotate self-signed TLS cert (`~/.atlas/webui-cert.pem`, 365-day validity)
5. Set up logging (file at `~/.atlas/webui.log` + optional console)
6. Generate / load OS-user binding token (`~/.atlas/.webui-token`, mode 0600)
7. Create one-time login nonce (60-second TTL, burns on first `/auth` use)
8. Optionally daemonize (POSIX double-fork via `daemon.py`)
9. Start uvicorn with TLS cert/key

Subcommands (`stop`, `status`, `restart`, `login-url`) handle daemon lifecycle via PID file.

### FastAPI Application (`app.py`)

`create_app(settings)` is the factory. On startup it:
- Initializes `AtlasContext` singleton (calls `platform_atlas.core.context.init_context()`)
- Syncs bundled rulesets/profiles into `~/.atlas/`
- Starts the `ContinuousAuditScheduler`

**Middleware stack** (outermost first):
1. Session authentication (OS-user binding cookie)
2. Setup redirect (unauthenticated + uninitialized → `/setup`)
3. CSRF enforcement (POST/PATCH/PUT/DELETE require token)
4. Audit log (append-only JSON to `~/.atlas/webui-audit.log`)
5. Security headers (`X-Frame-Options`, `CSP`, `HSTS`, etc.)
6. GZip (responses ≥1 KB)

Static assets mounted at `/static/` with 1-year immutable `Cache-Control`.
Version-busting via `?v={{ ATLAS_VERSION }}` query string in templates.

### Security Model (Seven Layers)

1. **TLS** — self-signed cert auto-generated, SHA-256 fingerprint printed at startup
2. **OS-user binding** — session cookie HMAC-signed with a token only readable by the
   OS user who owns `~/.atlas/`
3. **One-time nonce** — each launch mints a fresh nonce; `/auth?nonce=...` exchanges it for
   a session cookie; burned on first use
4. **CSRF tokens** — per-session HMAC token in forms + `X-CSRF-Token` header for AJAX
5. **Path safety** — `safe_under()` clamps all file-serving paths to known-safe ancestors
6. **Credential redaction** — nonce/cookie values stripped before any log write
7. **Security headers** — strict CSP with per-response nonces on inline scripts

### Job System

`JobRegistry` (singleton in `services/jobs.py`) manages all background work:
- Each job runs a sync runner function in `asyncio.to_thread`
- Jobs emit `JobEvent` objects (kind: info/success/warning/error/phase/check/status)
- Per-subscriber `asyncio.Queue` enables SSE fan-out to multiple browser tabs
- Terminal events (success/error) are always delivered even when the queue is full

**To add a new long-running operation:** write a sync runner in `services/runners.py`
that accepts a `JobLogger` as its first argument, then submit via
`get_registry().submit(name, runner, **kwargs)`. SSE wiring is automatic.

### Route & Template Structure

19 routers, each with its own module in `routes/` and template directory in `templates/`.
All routers are registered in `routes/__init__.py`.

| Route | Purpose |
|---|---|
| `/` | Dashboard — KPI tiles, session calendar heatmap, recent jobs |
| `/sessions` | Session CRUD + capture/validate/report job kickoffs |
| `/environments` | Environment CRUD + credential backend selection |
| `/rulesets` | Ruleset and profile picker |
| `/tier` | Standard ↔ Extended toggle |
| `/preflight` | Live preflight check stream |
| `/jobs` | Job list and SSE-streamed detail view |
| `/reports` | HTML report browser (iframe + PDF links) |
| `/architecture` | Infrastructure metadata form |
| `/diff` | Session comparison viewer |
| `/fleet` | Multi-environment health aggregate |
| `/continuous` | Scheduled audit config and history |
| `/alerts` | Drift alert feed with ack/ack-all |
| `/notifications` | Slack + JSON webhook routing |
| `/config` | Read-only config display |
| `/setup` | First-run wizard (multi-step) |
| `/settings` | Appearance preferences (theme + light/dark mode) |
| `/health` | Readiness probe |
| `/auth` | Nonce → session cookie exchange |

**To add a route:**
1. Create `routes/foo.py` with a FastAPI `APIRouter`
2. Register it in `routes/__init__.py`
3. Add templates under `templates/foo/`

### Configuration

`WebUISettings` (`config.py`) is a frozen dataclass. Fields and their env var overrides:

| Field | Default | Env var |
|---|---|---|
| `host` | `127.0.0.1` | `ATLAS_WEBUI_HOST` |
| `port` | `8765` | `ATLAS_WEBUI_PORT` |
| `reload` | `False` | `ATLAS_WEBUI_RELOAD` |
| `log_level` | `info` | `ATLAS_WEBUI_LOG_LEVEL` |
| `allow_remote` | `False` | `ATLAS_WEBUI_ALLOW_REMOTE` |

Public bind (`0.0.0.0` / `::`) without `--allow-remote` silently falls back to `127.0.0.1`.

### Themes & Styling

CSS variables per theme on `:root[data-theme="itential|aurora|horizon|obsidian|meadow|carbon|dracula"]`.
Light/dark via `[data-mode="light|dark"]`. Theme preference persisted server-side per OS user.
No external CDN — all fonts, icons, and scripts are self-hosted.

---

## Key File Locations

| File | Purpose |
|---|---|
| `src/platform_atlas_webui/main.py` | CLI entry point, startup orchestration |
| `src/platform_atlas_webui/app.py` | FastAPI factory + middleware stack |
| `src/platform_atlas_webui/config.py` | `WebUISettings` dataclass |
| `src/platform_atlas_webui/daemon.py` | POSIX daemonization (double-fork + PID file) |
| `src/platform_atlas_webui/routes/__init__.py` | Router registration |
| `src/platform_atlas_webui/services/jobs.py` | `JobRegistry` singleton + SSE streaming |
| `src/platform_atlas_webui/services/runners.py` | Job runner functions (capture, validate, report, preflight) |
| `src/platform_atlas_webui/services/sessions.py` | Session CRUD + metadata helpers |
| `src/platform_atlas_webui/services/environments.py` | Environment CRUD |
| `src/platform_atlas_webui/services/config.py` | Thread-safe config read/write |
| `src/platform_atlas_webui/services/continuous.py` | `ContinuousAuditScheduler` |
| `src/platform_atlas_webui/security/tokens.py` | OS-user binding + nonce + HMAC cookies |
| `src/platform_atlas_webui/security/tls.py` | Self-signed cert generation + rotation |
| `src/platform_atlas_webui/security/csrf.py` | CSRF token generation + validation |
| `src/platform_atlas_webui/security/paths.py` | `safe_under()` path traversal guard |
| `src/platform_atlas_webui/templates/base.html` | Shared layout, nav, sidebar |
| `src/platform_atlas_webui/static/css/atlas.css` | Theme CSS variables + global styles |
| `src/platform_atlas_webui/__init__.py` | Version string (`__version__`) |

---

## Coding Conventions

- **Dataclasses** for settings and data-holding structures
- **Singletons** for `JobRegistry` and `ContinuousAuditScheduler` — never instantiate directly,
  always access via `get_registry()` / `get_scheduler()`
- **Sync runners only** in `services/runners.py` — `asyncio.to_thread` handles the async
  boundary; keep runners free of `async/await`
- `ensure_ascii=False` on all `json.dumps` calls (em dashes appear in rule messages)
- Template context: pass only what the template needs — no dumping entire dataclasses
- No external CDN references in templates — all assets must be in `static/`

---

## Hard-Won Lessons

1. **SSE queues need backpressure** — the `JobRegistry` drops the oldest non-terminal event
   when a subscriber's queue is full. Never drop terminal events (success/error) or the
   browser spinner will hang forever.

2. **`asyncio.to_thread` + sync runners** — keep runners fully synchronous. Mixing
   `async/await` into a runner passed to `to_thread` causes subtle deadlocks.

3. **CSRF on HTMX requests** — HTMX sends `HX-Request: true` but does not automatically
   include custom headers. Ensure `hx-headers='{"X-CSRF-Token": "{{ csrf_token }}"}'` is
   set on any `hx-post`/`hx-patch`/`hx-delete` element, or attach it once on `<body>`.

4. **TLS cert on first launch** — uvicorn won't start if the cert files don't exist yet.
   `main.py` generates them synchronously before starting uvicorn. Don't move cert
   generation into an async startup hook.

5. **Template version-busting** — CSS/JS files use `?v={{ ATLAS_VERSION }}` query strings.
   After a release, users need one hard refresh. This is intentional; don't remove it.

6. **Static files and `Cache-Control: immutable`** — because assets are version-busted,
   the 1-year immutable cache is safe. But this means a filename change without a version
   bump will serve a stale file. Always bump the version when changing static assets.

7. **`safe_under()` for all file-serving** — any route that reads a file path from user
   input or URL parameters must call `safe_under(path, allowed_root)` before opening.
   Path traversal is a real risk on report-serving and log-tail routes.
