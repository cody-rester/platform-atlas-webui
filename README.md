# Platform Atlas WebUI

![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=flat-square&logo=fastapi&logoColor=white)
![License](https://img.shields.io/badge/license-GNU%20GPLv3-green?style=flat-square)
![Distribution](https://img.shields.io/badge/distribution-wheel-blue?style=flat-square)

> Browser-based companion to [Platform Atlas](../README.md) — manage sessions, run captures, watch jobs stream live, and browse compliance reports without ever touching a CLI.

`platform-atlas-webui` is an optional, separately-distributed wheel that imports `platform_atlas` as a library and adds a thin FastAPI presentation layer on top of the same capture, validation, and reporting engines that back the CLI. Customers who prohibit web/server components in their environment install only the core wheel and never have any web source on disk.

---

## Table of Contents

- [Why a WebUI](#why-a-webui)
- [Features](#features)
- [Screens](#screens)
- [Requirements](#requirements)
- [Install](#install)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Daemon Mode](#daemon-mode)
- [Configuration](#configuration)
- [Security Model](#security-model)
- [Themes](#themes)
- [Architecture](#architecture)
- [Local Development](#local-development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why a WebUI

The core `platform-atlas` CLI is fast, scriptable, and ideal for automation. The WebUI is for everything else:

- Walking a non-CLI user through their first audit
- Running a session interactively while watching live output
- Comparing two sessions side-by-side without exporting JSON
- Reviewing reports, fleet health, and continuous-audit results in a single pane
- Configuring environments, credentials, rulesets, and tiers without editing JSON files

The CLI is unchanged; the WebUI is purely additive. Sessions, environments, and reports created in either tool are interchangeable — they live in the same `~/.atlas/` tree.

---

## Features

- **Full session lifecycle** — Create, activate, capture, validate, generate reports, and delete sessions. Pagination on the session list (20 / 50 / 100 per page).
- **Live job streaming** — Long-running operations (preflight, capture, validate, report, full pipeline) run in a background thread and stream events to the browser via Server-Sent Events. Per-job toggle between **Human-friendly** and **Raw progress logs** views.
- **Pipeline progress bar** — `Run full pipeline` jobs render a clean three-stop bar (Capture → Validate → Report) that advances as each stage completes.
- **Preflight checks panel** — Default-on view shows phase headers and pass/fail rows as they arrive, plus a marching-ants indicator for the check currently in flight. The verbose event stream is one click away.
- **Environment management** — Create, edit, activate, and delete environments. Atlas-aware credential storage (OS keyring or HashiCorp Vault) handled inline.
- **Tier toggle** — Switch between **Standard** (Platform OAuth + IAG4 API only) and **Extended** (full SSH/Mongo/Redis/Gateway audit) tiers. The UI re-resolves rule counts and target requirements automatically.
- **Ruleset picker** — Choose the active ruleset and profile per session. Profile changes are reflected immediately in validation runs.
- **Architecture form** — Multi-section form for capturing infrastructure-as-deployed metadata that feeds the Architecture & Maintenance report.
- **Diff view** — Compare any two sessions and surface what changed.
- **Reports** — Browse and open generated reports (compliance, operational, architecture). Reports are styled to match the WebUI's Itential theme so the surfaces feel continuous.
- **Fleet view** — Aggregate health across all environments with cascade-reveal tile entrance, per-environment pass rate, and unacked drift counters.
- **Continuous audit** — Schedule recurring audits and inspect run history.
- **Notifications & alerts** — Wire alerts to webhooks/email when failures cross a threshold.
- **First-run setup wizard** — Guided experience that creates the first environment, stores credentials, picks a tier, and runs preflight before turning the user loose.
- **Theme system** — Itential, Aurora, Horizon, Obsidian, Meadow, Carbon, and Dracula palettes; light or dark mode for each. Preference is persisted server-side per OS user.
- **Built-in TLS** — A self-signed certificate is generated on first launch (365-day validity) and cached at `~/.atlas/webui-cert.pem`. The fingerprint is printed at startup so the user can verify before clicking through the browser warning.
- **OS-user binding** — Every browser session is gated by a token derived from the local OS user. A nonce-based login URL is minted per launch and burns on first use.
- **POSIX daemon mode** — Launch the WebUI as a backgrounded daemon (PID file + log file) and control it with `stop` / `status` / `restart` subcommands.
- **Reduced-motion aware** — All animation and transitions honor the user's `prefers-reduced-motion` OS setting.

---

## Screens

The WebUI ships with the following surfaces (route prefix in parentheses):

| Surface | Route | Purpose |
|---|---|---|
| Dashboard | `/` | At-a-glance KPIs and quick actions |
| Sessions | `/sessions` | Session list, detail, run actions |
| Environments | `/environments` | Environment CRUD, activation, credentials |
| Rulesets | `/rulesets` | Active ruleset and profile picker |
| Tier | `/tier` | Standard ⇄ Extended toggle and overview |
| Preflight | `/preflight` | Connectivity checks with live marching-ants |
| Jobs | `/jobs` | Job list, detail, live SSE stream |
| Reports | `/reports` | Browse generated HTML reports |
| Architecture | `/architecture` | Multi-section infrastructure form |
| Diff | `/diff` | Compare two sessions |
| Fleet | `/fleet` | Multi-environment health summary |
| Continuous | `/continuous` | Scheduled audit runs and history |
| Notifications | `/notifications` | Alert routing and rules |
| Alerts | `/alerts` | Live alert feed |
| Config | `/config` | Configuration overview, credentials |
| Setup | `/setup` | First-run wizard |
| Platform API | `/platform-api` | Platform OAuth credential helper |

---

## Requirements

- **Python** `>=3.11,<4.0`
- **OS** — Linux (RHEL/Rocky 8+9, Ubuntu) or macOS. Daemon mode is POSIX-only; on Windows, run the WebUI under your service supervisor of choice.
- **Browser** — Any modern Chromium / Firefox / Safari. The UI uses `EventSource`, `clip-path`, `@property`, and View Transitions — release-channel browsers from 2024 onwards work without polyfills.
- **`platform-atlas`** core — installed alongside (Poetry pulls it automatically; pip install both wheels for production).
- **Optional** — `keyring` (preinstalled with `platform-atlas`) for OS-keyring credential storage, or `hvac` for HashiCorp Vault.

---

## Install

End users install both wheels from a GitHub Release:

```bash
pip install platform_atlas-X.Y.Z-py3-none-any.whl \
            platform_atlas_webui-X.Y.Z-py3-none-any.whl

platform-atlas-webui
```

Customers who do not allow web/server components install only the core wheel and use the CLI:

```bash
pip install platform_atlas-X.Y.Z-py3-none-any.whl
platform-atlas
```

For an offline / air-gapped install bundle (RHEL/Rocky 8+9), see the root project's [installation guide](../GUIDES/USER-GUIDE-INSTALLATION-AND-USAGE.md).

---

## Quick Start

```bash
# 1. Launch (foreground, default port 8765)
platform-atlas-webui

# 2. Atlas prints a one-time login URL. Open it in your browser:
#       https://127.0.0.1:8765/auth?nonce=...
#
#    Your browser will warn about the self-signed certificate.
#    The TLS fingerprint is printed in the terminal — verify it,
#    then click through "Advanced -> Proceed".
#
# 3. If this is your first time, the setup wizard walks you through
#    creating an environment, storing credentials, and picking a tier.
```

That's it. The same `~/.atlas/` directory the CLI writes is what the WebUI reads — sessions you've already created via the CLI are visible immediately.

---

## CLI Reference

```text
platform-atlas-webui [--host HOST] [--port PORT] [--reload]
                     [--allow-remote] [--log-level LEVEL]
                     [--reset-tls] [--reset-token] [--no-browser]
                     [--daemon]
                     <action> ...
```

### Run flags

| Flag | Default | Effect |
|---|---|---|
| `--host` | `127.0.0.1` | Bind host. Loopback only unless `--allow-remote` is also passed. |
| `--port` | `8765` | Bind port. |
| `--reload` | off | Enable uvicorn reload (development only). Cannot combine with `--daemon`. |
| `--allow-remote` | off | Allow binding to non-loopback interfaces. Required to use `0.0.0.0` or `::`. |
| `--log-level` | `info` | One of `debug`, `info`, `warning`, `error`, `critical`. |
| `--reset-tls` | off | Regenerate the self-signed certificate and exit. |
| `--reset-token` | off | Regenerate the OS-user binding token (invalidates existing browser sessions). |
| `--no-browser` | off | Skip auto-opening the default browser on launch. |
| `--daemon` | off | Detach to the background, write a PID file, log to `~/.atlas/webui.log`. |

### Subcommands

| Action | Purpose |
|---|---|
| `stop` | Stop the running daemon (SIGTERM via PID file). |
| `status` | Report whether a daemon is running, its PID, and log path. |
| `restart` | Stop the existing daemon and start a fresh one in `--daemon` mode. Run flags accepted to change host/port at restart. |
| `login-url` | Print a fresh single-use login URL (valid for 60 s). Useful after a daemon restart, where the URL was logged to a file the user may not be tailing. |

### Examples

```bash
# Foreground on a custom port
platform-atlas-webui --port 9000

# Bind to all interfaces (LAN access)
platform-atlas-webui --host 0.0.0.0 --allow-remote

# Don't auto-open a browser (useful over SSH with port-forwarding)
platform-atlas-webui --no-browser

# Detach as a daemon
platform-atlas-webui --daemon

# Restart the running daemon on a different port
platform-atlas-webui restart --port 9001

# Mint a new login URL after a daemon restart
platform-atlas-webui login-url
```

---

## Daemon Mode

`--daemon` double-forks, redirects stdio to `~/.atlas/webui.log`, and writes the PID to `~/.atlas/webui.pid`. The grandchild keeps running after you log out.

```bash
platform-atlas-webui --daemon          # start backgrounded
platform-atlas-webui status            # is it running?
tail -f ~/.atlas/webui.log             # follow the log
platform-atlas-webui login-url         # mint a fresh URL
platform-atlas-webui restart           # stop + relaunch
platform-atlas-webui stop              # SIGTERM and exit
```

`--reload` is incompatible with `--daemon` because uvicorn's reloader spawns a child process that would re-enter `main()` and try to daemonize again. Pick one.

Daemon mode is POSIX-only. On Windows, run the WebUI under your service supervisor of choice.

---

## Configuration

All flags have environment-variable equivalents. Flags win over env vars.

| Variable | Maps to | Default |
|---|---|---|
| `ATLAS_WEBUI_HOST` | `--host` | `127.0.0.1` |
| `ATLAS_WEBUI_PORT` | `--port` | `8765` |
| `ATLAS_WEBUI_RELOAD` | `--reload` (`1` / `true` to enable) | `0` |
| `ATLAS_WEBUI_LOG_LEVEL` | `--log-level` | `info` |
| `ATLAS_WEBUI_ALLOW_REMOTE` | `--allow-remote` (`1` / `true` to enable) | `0` |
| `ATLAS_TIER` | Force tier (`standard` or `extended`) | _config_ |

If `ATLAS_WEBUI_HOST` is set to a public address (`0.0.0.0` or `::`) without `ATLAS_WEBUI_ALLOW_REMOTE=1`, the WebUI silently falls back to `127.0.0.1`. This is intentional — a fat-fingered env var should not accidentally publish the UI on a shared host.

---

## Security Model

The WebUI is a single-user, local-first tool by default. The defenses are stacked:

1. **Loopback bind by default.** `--allow-remote` (or `ATLAS_WEBUI_ALLOW_REMOTE=1`) is required for any non-loopback interface, and the public-bind check happens before uvicorn starts.

2. **Self-signed TLS.** A 365-day cert is generated on first launch and stored at `~/.atlas/webui-cert.pem` / `~/.atlas/webui-key.pem`. The SHA-256 fingerprint is printed at startup; verify it before clicking through the browser warning. Regenerate with `--reset-tls`.

3. **OS-user binding.** Every browser session is authenticated against a token derived from the local OS user. Resetting with `--reset-token` invalidates all existing sessions immediately.

4. **One-time login URL.** Each launch mints a fresh nonce-bearing URL valid for 60 seconds and good for one use. The nonce is exchanged for a session cookie on first hit.

5. **CSRF tokens.** Every state-changing form (POST/PATCH/DELETE) carries a per-session token; missing or mismatched tokens are rejected at the middleware layer.

6. **Path safety.** All file-serving routes (report HTML, JSON exports, log tails) clamp the requested path to a known-safe ancestor with a `safe_under()` helper before opening.

7. **Long Cache-Control on hashed assets.** Static assets ship with `Cache-Control: public, max-age=31536000, immutable` and version-busting via `?v=<atlas_version>` so a release bump invalidates browser caches deterministically.

8. **Secret redaction in logs.** `uvicorn.access` is filtered through a redact pass that strips `?nonce=` query strings, auth cookies, and known credential header names before they hit stdout or `~/.atlas/webui.log`.

9. **Security headers.** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` blocking camera/microphone/geolocation, and a strict CSP applied to every response.

For a defensive deployment, run with `--allow-remote --host 0.0.0.0` behind a reverse proxy that handles real TLS, drop the self-signed cert, and front the cookie with the proxy's auth.

---

## Themes

Seven palettes, each with a light and dark mode:

| Theme | Notes |
|---|---|
| **Itential** (default) | Brand navy + Itential blue. Single-mode (light/dark resolve to the same surface). |
| Aurora | Cool blue/purple, subtle ambient gradients. |
| Horizon | Warm amber/peach, daytime feel. |
| Obsidian | High-contrast black-and-white. |
| Meadow | Earthy greens, low saturation. |
| Carbon | Inspired monochrome, dense type. |
| Dracula | The official Dracula spec; light variant uses the Alucard palette. |

Switch themes from the gear icon in the top-right. Choices persist server-side per OS user; the CLI does not need to know about them.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       platform-atlas-webui                   │
│                                                              │
│   FastAPI app (uvicorn + TLS)                                │
│   ├── routes/      ── HTTP endpoints, one file per surface   │
│   ├── services/    ── Background job runner, SSE registry   │
│   ├── security/    ── TLS, tokens, CSRF, path safety         │
│   ├── templates/   ── Jinja2 templates, base + per-surface   │
│   └── static/      ── atlas.css, atlas.js, htmx, fonts, img  │
│                                                              │
└────────────────────────────┬─────────────────────────────────┘
                             │ imports
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                       platform-atlas                         │
│                                                              │
│   Capture engine ── Collectors (SSH, Mongo, Redis, OAuth)   │
│   Validation engine ── Rule evaluators, operators            │
│   Reporting engine ── Compliance / Operational / Arch HTML  │
│   Session manager ── ~/.atlas/sessions/<name>/               │
│   AtlasContext ── Singleton config + ruleset state           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The WebUI runs every long operation as a background job inside `JobRegistry`. Each runner gets a `JobLogger` it can call `info() / phase() / check() / debug()` on; events are broadcast over an SSE channel to all subscribed browser tabs. The runners reuse the **same** capture/validate/report functions the CLI calls — there is no duplicated business logic.

`~/.atlas/` is the source of truth for both tools. A session created via the WebUI is visible to the CLI immediately and vice versa.

---

## Local Development

From this `webui/` directory:

```bash
# Install deps + the sibling platform-atlas core as an editable path dep
poetry install

# Foreground with autoreload (CSS / JS / template changes pick up live)
poetry run platform-atlas-webui --reload --log-level debug

# Build a distributable wheel (writes to dist/)
poetry build
```

Useful patterns:

- **CSS changes** require a hard refresh (`Ctrl+Shift+R`) the first time after upgrading because static assets are served with `Cache-Control: immutable, max-age=1y`. The version-bust query string (`?v=<atlas_version>`) handles subsequent rollouts automatically — bump `__version__` in `platform_atlas.core._version` to force every browser to re-fetch.
- **Adding a route?** Drop a new file in `routes/`, register it in `routes/__init__.py`, and add a matching template under `templates/<name>/`. Routes are mounted at the prefix declared on their `APIRouter`.
- **Adding a long-running operation?** Write a runner in `services/runners.py` (sync function, takes `jlogger` as first arg, returns a dict). Submit it via `get_registry().submit(name, runner, **kwargs)` from your route. The browser side is automatic — the SSE stream is already wired.
- **Theme tokens** live in `static/css/atlas.css` under `:root[data-theme="<name>"]` blocks. Each theme defines `--bg`, `--text`, `--accent`, etc.; component CSS reads these variables exclusively.
- **Tests** live under the root project's `tests/` (see the root `pyproject.toml` for the pytest harness). Run with `poetry run pytest` from the repo root.

---

## Troubleshooting

**The browser warns about the certificate.**
This is expected — the cert is self-signed. Verify the SHA-256 fingerprint printed at launch matches the one your browser shows, then click `Advanced -> Proceed`. The warning won't repeat for that hostname/port combination.

**The browser session expired / I get redirected to a "session expired" page.**
Run `platform-atlas-webui login-url` (or restart the daemon) to mint a fresh login URL. The OS-user binding token is durable; only your browser cookie expired.

**`--daemon` says "Cannot combine --daemon with --reload".**
Pick one. The reloader spawns a child process that would try to daemonize itself, which deadlocks the PID file dance. Use `--reload` for development; use `--daemon` for "leave it running on a server somewhere".

**Static assets look stale after a release upgrade.**
Hard refresh once (`Ctrl+Shift+R`). Static files are served with a 1-year immutable cache; the cache key is bumped automatically when `__version__` changes, so subsequent upgrades roll out without manual refresh.

**It binds to localhost but I want LAN access.**
`platform-atlas-webui --host 0.0.0.0 --allow-remote`. Without `--allow-remote`, public binds are rejected before uvicorn starts.

**I want to put it behind a reverse proxy.**
Bind to loopback (`--host 127.0.0.1`), let nginx / Caddy terminate TLS with a real certificate, and proxy to `http://127.0.0.1:8765`. The WebUI's TLS will go unused but the cert files won't be in your way.

**The daemon won't stop.**
Check `~/.atlas/webui.pid` — if the process referenced there is dead, `platform-atlas-webui stop` will report a stale PID file and clean it up. If the process is genuinely stuck, `kill -9 $(cat ~/.atlas/webui.pid)` and remove the PID file by hand.

For deeper issues, see the root project's [troubleshooting guide](../README.md#troubleshooting).

---

## License

GPL-3.0-or-later. Same license as the core `platform-atlas` project. See [LICENSE](../LICENSE).
