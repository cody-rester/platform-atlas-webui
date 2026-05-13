# Changelog — Platform Atlas WebUI

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-05-13

Initial release. The WebUI works together with CLI `platform-atlas` 1.7.x.

### Added

- **Full session lifecycle in the browser** — create, capture, validate, and report against any environment without leaving the page; live job output streamed via Server-Sent Events; force-kill button appears on long-running jobs after 60 s
- **Environment management** — create, edit, activate, and delete environments; activation atomically restores tier, ruleset, and profile alongside the active environment
- **Tier switcher** — Standard / Extended toggle with a confirmation modal explaining what changes; tier overview page renders both tiers as cards with a "when to use" hint and an active-tier accent
- **Reports browser** — direct links to compliance, operational, and architecture HTML reports for every session
- **`/fleet`** — multi-environment compliance overview from local cache (read-only); per-env tier, last session age, pass rate, continuous-audit state, unacked alerts
- **`/continuous`** — status, settings, run history; Alerting section with `alert_policy` (any | regression) and rule-number `watchlist` chip editor; always-on topbar pill with state + last-run age
- **`/alerts`** — drift timeline with ack / ack-all; bell icon in the topbar with unacked count; deleted-rule rendering as `(rule deleted)` muted text when an alert references a rule no longer in the ruleset
- **`/notifications`** — Slack incoming webhooks and generic JSON webhooks (HMAC-SHA256 signing optional); per-environment channels persisted on the env overlay
- **Lightweight daemon mode** — `platform-atlas-webui --daemon` detaches via POSIX double-fork, writes `~/.atlas/webui.pid`, logs to `~/.atlas/webui.log`; `stop`, `status`, `restart` subcommands operate on the PID file. Linux + macOS
- **`platform-atlas-webui login-url`** — mints a fresh nonce-signed login URL on demand, useful after a daemon restart where the URL is otherwise tucked into the log
- **Aurora & Horizon theme system** — palette and light/dark mode are independent axes:
  - Aurora — confident, technical (deep navy + electric blue) — default
  - Horizon — warm, editorial (charcoal + terracotta)
  - Topbar moon/sun toggles mode only and preserves the chosen palette
- **Settings page theme picker** — Aurora/Horizon swatch cards with mini-palette previews; Light/Dark mode segmented control alongside
- **Sidebar Upgrade-to-Extended panel is dismissible** — × button persists `webui_upgrade_panel_dismissed` so it doesn't return on every page load
- **Dashboard zero-state helpers** — KPI tiles showing `0` render a one-line italic teaching helper; the audit-activity heatmap collapses to a "no captures in last 48h" prompt with direct links to start a session or run preflight
- **Header TIER pill standardized** — same structure as ORG/ENV pills (label + mono value), no longer a celebratory color-coded chip
- **Tabular numerals** applied across counters, timestamps, durations, deltas, version strings, and `code`/`pre` blocks so digit-heavy columns don't shift between values
- **Section legend scope helpers** — Settings fieldsets include a small mono-formatted scope label (e.g. `workspace-scoped, persisted to config.json`, `secrets in OS keyring or Vault`)
- **Motion tokens + responsive layout** — `--ease-standard|emphasized|decel`, `--dur-fast|base|slow` design tokens with `prefers-reduced-motion` collapse; `<960px` sidebar collapses to icon rail, `<720px` hero + grid-2 reflow; `.toolbar` gains `overflow-x: auto`; ack-row fade + chip-pop on alert acknowledgment; standardized `.pill`, `.chip`, `.tile` transitions
- **Themed status classes** — `.pill--state-*`, `.card--error`, `.card--warn`, `tr.is-drifted`, `.tier-card.is-active` replace inline `oklch()` styles in the topbar pill, run-detail page, and tier overview
- **Form helper** — generic `data-loading-label` + `data-confirm-action` driver for loading state and confirmations on Ack / Ack-all / Run-now / Disable / Test / Remove
- **Credentials reconfigure form** — added `AppRole (Wrapped)` option (was missing); `token_file_path` is now an editable input pre-filled from saved config; `vault_wrapping_token` and `vault_token_file_path` now submit and persist correctly
- **Setup wizard** — first-run redirect-to-setup middleware bootstraps a fresh install before any other route is reachable
- `webui_theme`, `webui_accent`, `webui_mode`, and `webui_upgrade_panel_dismissed` fields persisted to `config.json`

### Changed

- **Appearance config migration** — `webui_theme` no longer holds `light|dark` (that is now `webui_mode`); legacy accent values (`cyan|amber|violet|lime|mono`) are migrated transparently on read (`cyan|violet|mono → aurora`, `amber|lime → horizon`) so existing config.json files keep working

### Fixed

- Tier page not reflecting a tier change until hard-refresh — page now reads tier directly from disk on every load and includes `Cache-Control: no-store`; changing the tier reloads the in-memory context immediately
- Environment Activate button appearing to do nothing — `ctx()` singleton was not refreshed after writing the new `active_environment` to disk, so the list page rendered stale state
- Session list showing stale active-session indicator after switching sessions (same stale-context pattern)
- Fresh installs deadlocked at first run — `/setup` was not in `_AUTH_BYPASS_PREFIXES`, so the redirect-to-setup middleware hit a 401 before the wizard could load
- `--reload` / `ATLAS_WEBUI_RELOAD=1` crashed immediately — uvicorn requires an import-string for reload; the dev path now passes the factory correctly
- Dashboard / sessions / reports / diff routes blocking the event loop — sync session-metadata reads and `pd.read_parquet` calls now run via `run_in_threadpool`; reports list no longer reopens every `session.json` a second time, halving disk I/O
- Job cancellation could deliver two terminal SSE events and leave half-open network connections — `cancel()` now signals a cooperative `threading.Event` that workers consult at safe checkpoints; status flips only when the worker actually unwinds
- `JobRegistry._lock` was an `asyncio.Lock` bound to the first request's loop — switched to `threading.Lock` so the registry survives reload and test loops cleanly
- Terminal SSE event silently dropped when a subscriber's queue was full — full queues now drop the oldest event to make room for the close signal
- Report links broken when audited log content contained literal `03_report.html` / `04_operational.html` / `05_arch.html` strings — anchor-targeted regex now only mutates `href="…"` attributes
- `services/config.update_config` had a read-modify-write race — concurrent `PATCH /api/settings/appearance` could lose the earlier writer's update; now serialized via a process-wide lock
- Temp files leaked into `/tmp` indefinitely — diff renders and JSON exports now delete their temp file via a `BackgroundTask` after the response streams
- Session activation only moved the active-session pointer, leaving the previous session's environment, ruleset, and profile in place — now restores the full context atomically via `activate_session_context`, matching the CLI
- Session creation read tier from root `config.json` only, recording the wrong tier when the active environment overlay disagreed — now resolves tier through the same overlay-aware path as `load_config()`
- `POST /config` wrote tier to root `config.json` only; the active environment overlay's `tier` would silently undo the change — tier is now mirrored into the active overlay alongside the root write
- `/continuous/run-now` returns `429` when a run is already in flight for the env, instead of silently launching a duplicate

### Security

- **Self-signed TLS** auto-generated on first launch (`~/.atlas/.webui-cert.pem`); SHA-256 fingerprint printed to stderr; `--reset-tls` to regenerate
- **OS-user binding** via filesystem token (`~/.atlas/.webui-token`); browser auto-opens with a one-time nonce URL; all routes require a signed session cookie; `--reset-token` invalidates all sessions
- **Session cookies** signed with `HMAC(SHA-256(token ⊕ cookie_secret), session_id)` — a process running as the same OS user can no longer forge cookies from `~/.atlas/.webui-token` alone. Cookie secret persists at `~/.atlas/.webui-cookie-secret` (mode 0600) so browser sessions survive `restart`, reboots, and auto-restarts; rotating either file invalidates every outstanding cookie
- **Stateless HMAC CSRF tokens** on every `POST` / `PATCH` / `DELETE`; hidden input injected in all forms; AJAX calls send `X-CSRF-Token` header
- **Path-traversal guard** (`security/paths.py`) on all `FileResponse` routes
- **Credential redaction** (`security/redact.py`) in all exception log handlers; uvicorn access log strips query strings
- **Response headers** on every response: `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Strict-Transport-Security`, `Permissions-Policy`
- **Self-hosted fonts** — Google Fonts CDN removed; Inter, JetBrains Mono, and Instrument Serif self-hosted as WOFF2 under `static/fonts/`
- **Inline scripts extracted** — SSE inline script moved from `jobs/detail.html` to `static/js/job-stream.js`
- **Append-only audit log** at `~/.atlas/webui-audit.log` (chmod 600, rotates at 10 MB); one JSON line per state-changing request including OS user, path, status, session ID, and redacted form payload
- `_used_nonces` is now mutated under a lock — two parallel `/auth?nonce=…` requests for the same nonce can no longer both succeed
- CSP per-response nonce is generated and threaded through templates; enforcement against inline scripts is staged (still `script-src 'self' 'unsafe-inline'` until templates' `onclick=`/`onchange=` handlers migrate to delegated listeners)
- Setup error rendering shows a generic message — full exception class/message/traceback no longer reaches the browser
- Job records no longer carry `metadata["traceback"]` — full tracebacks are server-log only and can no longer be exposed via the job-detail view
- `POST /architecture/save` caps body at 256 KB and validates field shapes (status enum, section name allowlist) before persisting — disk-fill DoS and stored-data-into-report-XSS paths closed
- Compliance / operational / architecture reports are served with a sandboxed CSP (`default-src 'none'`, `connect-src` blocked, `form-action 'none'`, `base-uri 'none'`) — captured data rendered in a report can no longer reach back into the WebUI's authenticated origin

### Performance

- HTML responses are gzip-compressed (≥1 KB)
- `/static` assets ship with `Cache-Control: public, max-age=31536000, immutable`
- Dashboard reads the session list once per request (not twice) and reuses it for the heatmap aggregation
- `os_scheduler.status()` cached per-env for 30 s with explicit invalidation on install / uninstall — the topbar pill no longer shells out 4–5 times to `systemctl` / `launchctl` on every page render
