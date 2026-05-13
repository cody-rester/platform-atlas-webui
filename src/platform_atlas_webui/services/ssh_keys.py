"""SSH key discovery — list private keys under the current user's ``~/.ssh``."""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


# Filenames in ~/.ssh that are NEVER private keys, regardless of magic header.
# Keeps obvious config/known-hosts files out of the dropdown.
_NON_KEY_NAMES: frozenset[str] = frozenset({
    "config",
    "known_hosts",
    "known_hosts.old",
    "authorized_keys",
    "authorized_keys2",
    "environment",
    "ssh_config",
    "rc",
})

# Private-key headers we recognize. We only need the leading bytes — the file
# may be an unencrypted PEM or an encrypted OpenSSH key, both start with one
# of these markers.
_KEY_HEADERS: tuple[bytes, ...] = (
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN DSA PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN PRIVATE KEY-----",
    b"-----BEGIN ENCRYPTED PRIVATE KEY-----",
)


def _looks_like_private_key(path: Path) -> bool:
    """Return True if ``path`` appears to hold a private SSH key.

    Reads only the first ~80 bytes and matches against known PEM headers.
    Any I/O error is treated as "not a key" — we'd rather miss a key than
    surface a false positive that breaks the UX.
    """
    try:
        with path.open("rb") as fh:
            head = fh.read(80)
    except (OSError, PermissionError):
        return False
    return any(head.startswith(h) for h in _KEY_HEADERS)


def list_private_keys(ssh_dir: Path | None = None) -> list[dict[str, str]]:
    """Return a list of private-key entries under ``~/.ssh``.

    Each entry is ``{"path": str, "name": str}`` where ``path`` is the full
    absolute path (suitable for the ``ssh_key`` env field) and ``name`` is
    the basename (suitable for display). Sorted by name.

    Skips: ``.pub`` files, ``known_hosts``/``config``/``authorized_keys``,
    directories, dotfiles other than the dir itself, anything that doesn't
    start with a recognized private-key header.

    A missing ``~/.ssh`` returns ``[]`` — the form falls back to the legacy
    text input via the "custom path" option.
    """
    base = (ssh_dir or (Path.home() / ".ssh")).expanduser()
    if not base.is_dir():
        return []

    out: list[dict[str, str]] = []
    try:
        entries = sorted(base.iterdir())
    except (OSError, PermissionError) as exc:
        logger.debug("Could not list %s: %s", base, exc)
        return []

    for entry in entries:
        if not entry.is_file():
            continue
        name = entry.name
        if name.endswith(".pub"):
            continue
        if name.lower() in _NON_KEY_NAMES:
            continue
        # known_hosts.<random> / authorized_keys.<host> variants
        if name.startswith(("known_hosts", "authorized_keys")):
            continue
        if not _looks_like_private_key(entry):
            continue
        out.append({"path": str(entry), "name": name})

    return out
