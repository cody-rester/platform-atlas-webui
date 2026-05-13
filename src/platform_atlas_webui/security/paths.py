"""Path traversal guards."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException


def safe_under(path: Path, root: Path) -> Path:
    """Resolve *path* and verify it is under *root*.

    Raises HTTPException(403) if the resolved path escapes the root.
    Returns the resolved absolute path on success.
    """
    try:
        resolved = path.resolve(strict=True)
    except (OSError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=f"File not found: {path.name}") from exc
    root_resolved = root.expanduser().resolve()
    if not resolved.is_relative_to(root_resolved):
        raise HTTPException(status_code=403, detail="Access denied")
    return resolved
