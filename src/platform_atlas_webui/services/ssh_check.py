"""Inline SSH connectivity test for the environment form.

Runs the CLI's own ``SSHTransport`` (same key handling, same error
messages, ``auto_add`` host-key policy — what WebUI-built topologies run
with), so a green result here means the capture's SSH leg will work.
Sync — call via ``run_in_threadpool``.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Connect/banner timeouts are tighter than capture's defaults — this is an
# interactive button; nobody wants to stare at a spinner for 25 seconds.
_CONNECT_TIMEOUT = 8.0
_BANNER_TIMEOUT = 10.0
_COMMAND_TIMEOUT = 10


def _stored_passphrase(env_name: str) -> str:
    """The environment's stored SSH passphrase, or ``""``.

    Reads the env-scoped local store (keyring or encrypted file, per the
    env's ``credential_backend``) so an edit-form test with a blank
    passphrase field uses the same secret a capture would. Vault-backed
    environments return ``""`` — Vault is only read at capture time, so
    the test needs the passphrase typed in.
    """
    if not env_name:
        return ""
    try:
        from platform_atlas.core.paths import ATLAS_ENVIRONMENTS_DIR
        from platform_atlas.core.credentials import (
            CredentialKey,
            FileSecretStore,
            KeyringSecretStore,
            scoped_service_name,
        )
        env_file = ATLAS_ENVIRONMENTS_DIR / f"{env_name}.json"
        if not env_file.is_file():
            return ""
        backend = (json.loads(env_file.read_text(encoding="utf-8"))
                   .get("credential_backend") or "keyring").strip().lower()
        if backend == "vault":
            return ""
        store = FileSecretStore() if backend == "file" else KeyringSecretStore()
        return store.get(scoped_service_name(env_name), CredentialKey.SSH_PASSPHRASE.value) or ""
    except Exception:  # noqa: BLE001 — a broken store must not break the test button
        logger.debug("Stored-passphrase lookup failed for env %r", env_name, exc_info=True)
        return ""


def test_ssh_connection(
    *,
    host: str,
    port: Any,
    username: str,
    key_path: str,
    passphrase: str,
    env_name: str = "",
) -> dict[str, Any]:
    """Attempt an SSH connection and a trivial command; never raises.

    Returns ``{"ok": bool, "message": str, "used_stored_passphrase": bool}``.
    A blank ``passphrase`` falls back to the environment's stored one (so
    testing on the edit form works without retyping the secret).
    """
    host = (host or "").strip()
    username = (username or "").strip() or "atlas"
    key_path = (key_path or "").strip()
    passphrase = passphrase or ""

    if not host:
        return {"ok": False, "message": "Enter the gateway SSH host first.",
                "used_stored_passphrase": False}
    try:
        port_num = int(str(port).strip() or 22)
    except (TypeError, ValueError):
        port_num = 22

    if key_path:
        expanded = Path(key_path).expanduser()
        if not expanded.is_file():
            return {"ok": False,
                    "message": f"SSH key not found: {expanded}",
                    "used_stored_passphrase": False}
        key_path = str(expanded)

    used_stored = False
    if not passphrase:
        passphrase = _stored_passphrase(env_name)
        used_stored = bool(passphrase)

    from platform_atlas.core.transport import SSHCredentials, SSHTransport

    try:
        creds = SSHCredentials(
            hostname=host,
            username=username,
            port=port_num,
            key_path=key_path or None,
            key_passphrase=passphrase or None,
            # No explicit key → agent auth, exactly like a saved "None
            # (use SSH agent)" selection. With a key, the transport forces
            # explicit-key mode itself (agent + discovery off).
            use_agent=not key_path,
            # WebUI-built topology nodes default to auto_add — mirror it
            # so the test predicts what the capture will actually do.
            host_key_policy="auto_add",
            timeout=_CONNECT_TIMEOUT,
            banner_timeout=_BANNER_TIMEOUT,
        )
    except ValueError as exc:
        return {"ok": False, "message": str(exc), "used_stored_passphrase": used_stored}

    transport = SSHTransport(creds)
    started = time.monotonic()
    try:
        transport.connect()
        result = transport.run_command("echo atlas-ssh-ok", timeout=_COMMAND_TIMEOUT)
        elapsed = time.monotonic() - started
        message = f"Connected as {username}@{host}:{port_num} in {elapsed:.1f}s — auth and command OK."
        if "atlas-ssh-ok" not in (getattr(result, "stdout", "") or ""):
            message = (
                f"Connected as {username}@{host}:{port_num} in {elapsed:.1f}s — "
                f"auth OK, but the test command returned no output (restricted shell?)."
            )
        return {"ok": True, "message": message, "used_stored_passphrase": used_stored}
    except Exception as exc:  # noqa: BLE001 — every failure renders inline
        # Transport raises CollectorConnectionError with human-readable
        # messages (auth failed, encrypted key, timeout…) — pass through.
        message = str(exc).strip() or type(exc).__name__
        return {"ok": False, "message": message, "used_stored_passphrase": used_stored}
    finally:
        try:
            transport.close()
        except Exception:  # noqa: BLE001
            pass
