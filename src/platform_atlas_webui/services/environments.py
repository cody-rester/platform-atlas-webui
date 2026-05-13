"""Environment service — list, inspect, create, edit, delete, set active."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from platform_atlas.core.context import ctx
from platform_atlas.core.environment import (
    Environment,
    get_environment_manager,
    propagate_ssh_key,
    validate_env_name,
)
from platform_atlas.core.topology import DeploymentTopology
from platform_atlas.core.paths import ATLAS_ENVIRONMENTS_DIR


_TOPOLOGY_FORM_FIELDS = (
    "deployment_mode", "iap_host", "mongo_host", "redis_host", "iag_host",
    "iap_host_ha", "iap_host_2", "iap_host_3",
    "mongo_host_ha", "mongo_host_2", "mongo_host_3",
    "redis_host_ha", "redis_host_2", "redis_host_3",
    "iag_host_ha",
    "ssh_user", "ssh_port",
    "iap_transport", "iap_cm_socket", "iap_cm_target", "iap_cm_port",
)


def _host_from_uri(uri: str) -> str:
    """Best-effort hostname extraction from a URI ('https://x.com:443/p' → 'x.com')."""
    if not uri:
        return ""
    raw = uri.strip()
    if not raw:
        return ""
    # urlparse needs a scheme to populate netloc; tolerate bare hosts too.
    if "://" not in raw:
        raw = "//" + raw
    try:
        parsed = urlparse(raw)
    except Exception:
        return ""
    return (parsed.hostname or "").strip()


_PRESERVED_TRANSPORTS: tuple[str, ...] = ("control_master", "local")


def _preserve_transport_fields(existing_node: dict, host: str, primary: bool) -> dict:
    """Carry over a non-SSH node's transport-specific fields (CM socket/target,
    local marker, etc.) while updating the host/primary slot. Strips SSH-only
    fields so the persisted node doesn't carry stale ssh_user/ssh_key/ssh_port."""
    preserved = dict(existing_node)
    preserved["host"] = host
    preserved["primary"] = primary
    for ssh_only in ("ssh_user", "ssh_key"):
        preserved.pop(ssh_only, None)
    # Keep ssh_port on ControlMaster nodes — it's the master connection port.
    if preserved.get("transport") != "control_master":
        preserved.pop("ssh_port", None)
    return preserved


def build_topology_from_form(payload: dict[str, Any], existing: dict | None = None) -> dict | None:
    """Construct a ``deployment`` dict from the env form's topology fields.

    Returns None for Standard envs (deployment is synthesized from
    ``platform_uri`` at capture time). For Extended envs, builds the
    deployment dict for standalone or HA2 modes; Kubernetes saves no
    SSH topology (the K8s collectors drive it via kubectl/values.yaml);
    Custom passes through the existing topology unchanged.

    When ``existing`` already has nodes whose transport is ``control_master``
    or ``local`` (configured via the CLI wizard), those transport fields are
    preserved across save — only the host fields are updated. The form's HA2
    pane explicitly tells the user this happens; the standalone pane silently
    extends the same protection to Mongo/Redis so a no-op WebUI save can't
    downgrade an entire PSMP-routed deployment back to plain SSH.
    """
    tier = (payload.get("tier") or "").strip().lower()
    if tier == "standard":
        return None

    mode = (payload.get("deployment_mode") or "standalone").strip().lower()

    # Custom mode is CLI-managed — never overwrite from the WebUI form.
    if mode == "custom":
        return existing if isinstance(existing, dict) else None

    # Kubernetes mode doesn't use SSH host fields. The kubectl context and
    # values.yaml fields (handled separately as top-level env attrs) drive
    # capture there. Drop any prior SSH-style topology so it doesn't pretend
    # to still be in effect.
    if mode == "kubernetes":
        result = DeploymentTopology.kubernetes().to_dict()
        result["capture_scope"] = "primary_only"
        return result

    ssh_user = (payload.get("ssh_user") or "atlas").strip() or "atlas"
    try:
        ssh_port = int((payload.get("ssh_port") or 22))
    except (TypeError, ValueError):
        ssh_port = 22
    ssh_key = (payload.get("ssh_key") or "").strip()

    # IAP transport: applies to the primary IAP node in standalone and HA2.
    # Secondary/tertiary HA2 IAP slots are preserved-from-existing (same as
    # before) — Atlas only uses the primary for protocol-level checks anyway.
    iap_transport = (payload.get("iap_transport") or "ssh").strip().lower()
    if iap_transport not in ("ssh", "control_master", "local"):
        iap_transport = "ssh"
    iap_cm_socket = (payload.get("iap_cm_socket") or "").strip()
    iap_cm_target = (payload.get("iap_cm_target") or "").strip()
    try:
        iap_cm_port = int((payload.get("iap_cm_port") or 22))
    except (TypeError, ValueError):
        iap_cm_port = 22

    # Required-field validation: without these the saved env would fail at
    # capture time inside ControlMasterConfig with the same message — surface
    # it at form-submit instead so the user can correct it immediately.
    if mode in ("standalone", "ha2") and iap_transport == "control_master":
        if not iap_cm_socket:
            raise ValueError(
                "ControlMaster socket path is required when 'Platform connection type' "
                "is ControlMaster."
            )
        if not iap_cm_target:
            raise ValueError(
                "ControlMaster SSH destination is required when 'Platform connection type' "
                "is ControlMaster."
            )

    fallback_host = _host_from_uri(payload.get("platform_uri") or "") or "localhost"

    existing_nodes_list: list[dict] = []
    if isinstance(existing, dict):
        for n in existing.get("nodes") or []:
            if isinstance(n, dict):
                existing_nodes_list.append(n)

    def _node(role: str, host: str, primary: bool) -> dict[str, Any]:
        n: dict[str, Any] = {
            "role": role, "host": host,
            "ssh_user": ssh_user, "ssh_port": ssh_port,
            "primary": primary,
        }
        if ssh_key:
            n["ssh_key"] = ssh_key
        return n

    def _existing_role_node(role: str, slot: int = 0) -> dict | None:
        """Return the slot-th existing node for this role (or None)."""
        matches = [
            n for n in existing_nodes_list
            if (n.get("role") or "").lower() == role
        ]
        return matches[slot] if slot < len(matches) else None

    def _iap_node(host: str, primary: bool) -> dict[str, Any]:
        """Build the IAP node respecting the chosen transport type."""
        if iap_transport == "local":
            return {"role": "iap", "host": host, "transport": "local", "primary": primary}
        if iap_transport == "control_master":
            n: dict[str, Any] = {
                "role": "iap", "host": host,
                "transport": "control_master",
                "primary": primary,
                "ssh_control_socket": iap_cm_socket,
                "ssh_control_target": iap_cm_target,
            }
            if iap_cm_port != 22:
                n["ssh_port"] = iap_cm_port
            return n
        return _node("iap", host, primary=primary)

    def _node_preserve(role: str, host: str, primary: bool, slot: int = 0) -> dict[str, Any]:
        """Build a node, preserving an existing CM/local transport for this role-slot.

        Falls through to a fresh SSH node when no matching existing node has a
        non-SSH transport — preserving today's behavior for SSH-only envs.
        """
        ex = _existing_role_node(role, slot)
        if ex is not None and ex.get("transport") in _PRESERVED_TRANSPORTS:
            return _preserve_transport_fields(ex, host, primary)
        return _node(role, host, primary=primary)

    nodes: list[dict[str, Any]] = []
    if mode == "ha2":
        # HA2 reads its own _ha-suffixed primary fields so the standalone and
        # HA2 panes can both have a "first IAP host" input without colliding.
        iap1 = (payload.get("iap_host_ha") or fallback_host).strip()
        iap2 = (payload.get("iap_host_2") or "").strip()
        iap3 = (payload.get("iap_host_3") or "").strip()
        mongo1 = (payload.get("mongo_host_ha") or "").strip()
        mongo2 = (payload.get("mongo_host_2") or "").strip()
        mongo3 = (payload.get("mongo_host_3") or "").strip()
        redis1 = (payload.get("redis_host_ha") or "").strip()
        redis2 = (payload.get("redis_host_2") or "").strip()
        redis3 = (payload.get("redis_host_3") or "").strip()
        iag = (payload.get("iag_host_ha") or "").strip()

        # IAP slots: the form's transport selector applies to the PRIMARY
        # only (Atlas just uses the primary for protocol-level checks).
        # Secondary and tertiary IAP slots preserve whatever transport the
        # CLI wizard previously set for them.
        for i, h in enumerate((iap1, iap2, iap3)):
            if not h:
                continue
            if i == 0:
                nodes.append(_iap_node(h, primary=True))
            else:
                nodes.append(_node_preserve("iap", h, primary=False, slot=i))
        for i, h in enumerate((mongo1, mongo2, mongo3)):
            if h:
                nodes.append(_node_preserve("mongo", h, primary=(i == 0), slot=i))
        for i, h in enumerate((redis1, redis2, redis3)):
            if h:
                nodes.append(_node_preserve("redis", h, primary=(i == 0), slot=i))
        if iag:
            nodes.append(_node_preserve("iag", iag, primary=True))

        deployment: dict[str, Any] = {
            "mode": "ha2",
            "capture_scope": "primary_only",
            "nodes": nodes,
        }
    else:  # standalone (default)
        iap_host = (payload.get("iap_host") or fallback_host).strip()
        mongo_host = (payload.get("mongo_host") or iap_host).strip()
        redis_host = (payload.get("redis_host") or iap_host).strip()
        iag_host = (payload.get("iag_host") or "").strip()

        nodes = [
            _iap_node(iap_host, primary=True),
            _node_preserve("mongo", mongo_host, primary=True),
            _node_preserve("redis", redis_host, primary=True),
        ]
        if iag_host:
            nodes.append(_node_preserve("iag", iag_host, primary=True))

        deployment = {
            "mode": "standalone",
            "capture_scope": "primary_only",
            "nodes": nodes,
        }

    if ssh_key:
        deployment["ssh_defaults"] = {"key_path": ssh_key, "username": ssh_user, "port": ssh_port}
    return deployment


def topology_summary(env_data: dict | None) -> dict:
    """Pull a human-friendly topology summary out of ``env_data`` for the
    detail page card. Returns ``{configured: False}`` when no topology is
    set so the template can render an empty/seed state."""
    deployment = (env_data or {}).get("deployment") or {}
    if not deployment:
        return {"configured": False, "mode": "", "nodes": []}
    mode = (deployment.get("mode") or "").strip()
    raw_nodes = deployment.get("nodes") or []
    nodes = []
    for n in raw_nodes:
        if not isinstance(n, dict):
            continue
        nodes.append({
            "role": str(n.get("role") or "").lower(),
            "host": str(n.get("host") or ""),
            "primary": bool(n.get("primary")),
        })
    return {"configured": True, "mode": mode, "nodes": nodes}


def active_env_allows_legacy() -> bool:
    """Return True when the active environment has the legacy_profile field set.

    When True, the WebUI shows 2023.x rulesets and profiles. When False (the
    default for all new installs) those legacy options are hidden so users
    are not confused by ruleset choices that don't apply to their deployment.
    """
    from platform_atlas.core.paths import ATLAS_CONFIG_FILE, ATLAS_ENVIRONMENTS_DIR
    try:
        cfg = json.loads(ATLAS_CONFIG_FILE.read_text(encoding="utf-8")) if ATLAS_CONFIG_FILE.is_file() else {}
        env_name = cfg.get("active_environment") or ""
        if not env_name:
            return False
        env_file = ATLAS_ENVIRONMENTS_DIR / f"{env_name}.json"
        if not env_file.is_file():
            return False
        env_data = json.loads(env_file.read_text(encoding="utf-8"))
        return bool(env_data.get("legacy_profile"))
    except Exception:
        return False


def list_environments() -> list[dict[str, Any]]:
    """Return all environment definitions as a list of plain dicts."""
    if not ATLAS_ENVIRONMENTS_DIR.is_dir():
        return []
    try:
        active_name = ctx().active_environment
    except Exception:
        active_name = None

    items: list[dict[str, Any]] = []
    for path in sorted(ATLAS_ENVIRONMENTS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        name = path.stem
        items.append({
            "name": name,
            "is_active": name == active_name,
            "organization_name": data.get("organization_name") or "",
            "platform_uri": data.get("platform_uri") or "",
            "tier": data.get("tier") or "extended",
            "deployment_mode": (data.get("deployment") or {}).get("mode") or "",
            "credential_backend": data.get("credential_backend") or "keyring",
        })
    return items


def get_environment(name: str) -> dict[str, Any] | None:
    """Return a single environment by name, or None if missing."""
    path: Path = ATLAS_ENVIRONMENTS_DIR / f"{name}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return {
        "name": name,
        "data": data,
        "tier": data.get("tier") or "extended",
    }


def save_environment(payload: dict[str, Any]) -> Environment:
    """Validate the payload, persist it, and return the Environment.

    The caller is responsible for routing to /environments/<name> on success.
    Raises ValueError on bad name, FileExistsError if creating a duplicate.
    """
    name = (payload.get("name") or "").strip()
    if not validate_env_name(name):
        raise ValueError(
            f"Invalid environment name '{name}'. Names must start with a "
            "letter or digit and may only contain letters, digits, spaces, "
            "dots, hyphens, and underscores (1–128 characters). Examples: "
            "'production', 'Acme Prod', 'dev-2', 'qa.staging'."
        )

    mgr = get_environment_manager()
    creating = not mgr.exists(name)

    # Build a clean dict — start from existing on edit so we don't drop fields
    # the form didn't include.
    base: dict[str, Any] = {}
    if not creating:
        existing = mgr.load(name)
        base = existing.to_dict()

    # Whitelist fields we accept from the form. Anything else is ignored.
    # ``organization_name`` is intentionally absent — it lives in the global
    # Configuration as the single source of truth, so the env form shows it
    # read-only and the WebUI never writes it into an env overlay.
    accepted = {
        "name", "description", "platform_uri",
        "platform_client_id", "credential_backend", "tier",
        "gateway4_uri", "gateway4_username", "legacy_profile",
        "ssh_key",
        "values_yaml_path", "iag5_values_yaml_path",
        "kubectl_context", "kubectl_namespace", "use_kubectl", "kubectl_binary_path",
        "deployment",
    }
    for key in accepted:
        if key in payload:
            base[key] = payload[key]

    # Coerce tier to None if blank — keeps it out of the overlay.
    if not base.get("tier"):
        base["tier"] = None

    # use_kubectl arrives as a string from the form
    base["use_kubectl"] = bool(base.get("use_kubectl")) and base.get("use_kubectl") not in ("0", "off", "false", "False", "")

    # Build / refresh the deployment topology from the form's topology fields
    # if any were posted. Skipping this for Standard tier (returns None) keeps
    # the env file slim — Standard captures synthesize their target list from
    # platform_uri at runtime and never read ``deployment``. For Extended this
    # is what stops captures from blowing up with "No 'deployment' section".
    posted_topo = any(k in payload for k in _TOPOLOGY_FORM_FIELDS)
    if posted_topo:
        new_topo = build_topology_from_form(payload, existing=base.get("deployment"))
        if new_topo is not None:
            base["deployment"] = new_topo
        elif (base.get("tier") or "").strip().lower() == "standard":
            # Switching to Standard — drop the now-unused topology so it
            # doesn't drift out of date silently.
            base.pop("deployment", None)
    elif creating and (base.get("tier") or "extended").strip().lower() != "standard" and not base.get("deployment"):
        # Brand-new Extended env with no topology fields posted → seed a
        # placeholder deployment so the first capture attempt doesn't error
        # out on missing 'deployment'. The user can refine it on edit.
        seeded = build_topology_from_form({**payload, "deployment_mode": "standalone"}, existing=None)
        if seeded is not None:
            base["deployment"] = seeded

    # Propagate ssh_key into the deployment topology so the transport layer
    # reads the updated path from nodes and ssh_defaults without requiring a
    # topology re-wizard.
    if "ssh_key" in payload and base.get("deployment"):
        base["deployment"] = propagate_ssh_key(base["deployment"], (payload["ssh_key"] or "").strip())

    env = Environment.from_dict(base)
    mgr.save(env)
    return env


def delete_environment(name: str) -> None:
    mgr = get_environment_manager()
    mgr.remove(name)


def set_active(name: str) -> None:
    mgr = get_environment_manager()
    mgr.set_active(name)
