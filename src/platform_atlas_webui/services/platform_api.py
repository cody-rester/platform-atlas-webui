"""
Platform API service — DISABLED.

Originally provided the executor that drove the WebUI's "Run a Platform API
request" feature. Deactivated pending product direction.

Architecture sketch (for when it's reintroduced):

    EndpointSpec(frozen dataclass):
        slug, operation_id, method, path, summary, description, columns

    ENDPOINTS: dict[slug, EndpointSpec]
        Hardcoded registry. v1 covered three Operations Manager calls:
            - automations  → GET /operations-manager/automations
            - tasks        → GET /operations-manager/tasks
            - jobs         → GET /operations-manager/jobs

    call_endpoint(slug, query) -> CallResult:
        - Pull ``EndpointSpec`` from registry
        - ``with PlatformCollector.from_config() as c: c._client.get(spec.path, params=query)``
          (piggybacks on the audit collector's OAuth client so credential
          resolution and TLS config stay in one place)
        - Normalize Itential collection responses ({data, total} / list / dict)
          to a ``records`` list and an optional ``total``
        - Run the response through ``redact(data, sensitive_keys=SENSITIVE_KEYS)``
          before returning it (collected payloads frequently embed creds in
          workflow variables)
        - Return CallResult(ok, status_code, duration_ms, raw, records, total,
          error, request_url)

    get_value(record, dot_path) -> Any:
        Safe dot-path lookup used by the table template to read each column
        out of a record dict.

When restoring: see git history for the original implementation. Keep the
registry hardcoded for v1 — adding a 4th endpoint should still be one
``EndpointSpec(...)`` line, not an OpenAPI parser.
"""

from __future__ import annotations

# Intentionally empty. The router stub in routes/platform_api.py registers no
# handlers, so nothing imports from this module right now.
