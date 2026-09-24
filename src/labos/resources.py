from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import (
    _active_session_db,
    _append_event_db,
    _atomic_json_write,
    _new_id,
    _read_events_db,
    _transaction,
    ensure_home,
    now_iso,
)
from .locking import ledger_lock

RESOURCE_REGISTRY_VERSION = 1
RESOURCE_KINDS = ("board", "scope", "psu", "daq", "detector", "other")


def _registry_path(home: Path) -> Path:
    return ensure_home(home) / "resources.json"


def _clean(value: str, field: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field} must not be empty")
    return cleaned


def _validate_kind(kind: str) -> str:
    kind = _clean(kind, "kind")
    if kind not in RESOURCE_KINDS:
        choices = ", ".join(RESOURCE_KINDS)
        raise ValueError(f"kind must be one of: {choices}")
    return kind


def _load_registry_unlocked(home: Path) -> dict[str, Any]:
    path = _registry_path(home)
    if not path.exists():
        return {"registry_version": RESOURCE_REGISTRY_VERSION, "resources": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Malformed LabOS resource registry: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("resources"), list):
        raise RuntimeError("Malformed LabOS resource registry: expected a resources list.")
    return data


def _write_registry_unlocked(home: Path, data: dict[str, Any]) -> None:
    data = {
        "registry_version": RESOURCE_REGISTRY_VERSION,
        "resources": data["resources"],
    }
    _atomic_json_write(_registry_path(home), data)


def _snapshot(resource: dict[str, Any]) -> dict[str, Any]:
    return {
        "resource_id": resource["resource_id"],
        "fingerprint": resource["fingerprint"],
        "alias": resource["alias"],
        "kind": resource["kind"],
    }


def _resolve_unlocked(home: Path, target: str) -> dict[str, Any]:
    target = _clean(target, "device lookup")
    resources = _load_registry_unlocked(home)["resources"]

    by_id = [r for r in resources if r.get("resource_id") == target]
    if by_id:
        return by_id[0]

    by_fingerprint = [r for r in resources if r.get("fingerprint") == target]
    if by_fingerprint:
        return by_fingerprint[0]

    by_alias = [r for r in resources if r.get("alias") == target]
    if len(by_alias) == 1:
        return by_alias[0]
    if len(by_alias) > 1:
        ids = ", ".join(str(r.get("resource_id")) for r in by_alias)
        raise RuntimeError(
            f"Ambiguous device alias {target!r}; use fingerprint or resource ID ({ids})."
        )
    raise RuntimeError(f"Device not found: {target}")


def add_resource(home: Path, *, fingerprint: str, alias: str, kind: str) -> dict[str, Any]:
    home = ensure_home(home)
    fingerprint = _clean(fingerprint, "fingerprint")
    alias = _clean(alias, "alias")
    kind = _validate_kind(kind)

    with ledger_lock(home):
        registry = _load_registry_unlocked(home)
        if any(r.get("fingerprint") == fingerprint for r in registry["resources"]):
            raise ValueError(f"fingerprint already exists: {fingerprint}")
        timestamp = now_iso()
        resource = {
            "resource_id": _new_id("dev"),
            "fingerprint": fingerprint,
            "alias": alias,
            "kind": kind,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        registry["resources"].append(resource)
        _write_registry_unlocked(home, registry)
        return dict(resource)


def list_resources(home: Path) -> list[dict[str, Any]]:
    home = ensure_home(home)
    with ledger_lock(home):
        resources = [dict(item) for item in _load_registry_unlocked(home)["resources"]]
    return sorted(
        resources,
        key=lambda item: (
            str(item.get("alias", "")).casefold(),
            str(item.get("fingerprint", "")),
            str(item.get("resource_id", "")),
        ),
    )


def show_resource(home: Path, target: str) -> dict[str, Any]:
    home = ensure_home(home)
    with ledger_lock(home):
        return dict(_resolve_unlocked(home, target))


def edit_resource(
    home: Path,
    target: str,
    *,
    fingerprint: str | None = None,
    alias: str | None = None,
    kind: str | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    with ledger_lock(home):
        registry = _load_registry_unlocked(home)
        resource = _resolve_unlocked(home, target)
        resource_id = resource["resource_id"]
        replacement = dict(resource)

        if fingerprint is not None:
            cleaned = _clean(fingerprint, "fingerprint")
            if any(
                r.get("fingerprint") == cleaned and r.get("resource_id") != resource_id
                for r in registry["resources"]
            ):
                raise ValueError(f"fingerprint already exists: {cleaned}")
            replacement["fingerprint"] = cleaned
        if alias is not None:
            replacement["alias"] = _clean(alias, "alias")
        if kind is not None:
            replacement["kind"] = _validate_kind(kind)

        if replacement == resource:
            return replacement

        replacement["updated_at"] = now_iso()
        registry["resources"] = [
            replacement if r.get("resource_id") == resource_id else r
            for r in registry["resources"]
        ]
        _write_registry_unlocked(home, registry)
        return dict(replacement)


def _session_active_resources(
    events: list[dict[str, Any]],
    session_id: str,
) -> dict[str, dict[str, Any]]:
    active: dict[str, dict[str, Any]] = {}
    for event in events:
        if event.get("session_id") != session_id:
            continue
        event_type = event.get("type")
        payload = event.get("payload", {})
        resource_id = payload.get("resource_id")
        if not isinstance(resource_id, str):
            continue
        if event_type == "resource_add":
            active[resource_id] = {
                "resource_id": resource_id,
                "fingerprint": payload.get("fingerprint"),
                "alias": payload.get("alias"),
                "kind": payload.get("kind"),
            }
        elif event_type == "resource_remove":
            active.pop(resource_id, None)
    return active


def use_resource(home: Path, target: str) -> dict[str, Any]:
    home = ensure_home(home)
    with ledger_lock(home):
        with _transaction(home) as db:
            session = _active_session_db(db)
            if session is None:
                raise RuntimeError("Using a device requires an active LabOS session.")
            resource = _resolve_unlocked(home, target)
            events = _read_events_db(db)
            active = _session_active_resources(events, str(session["session_id"]))
            if resource["resource_id"] in active:
                raise RuntimeError(f"Device is already active: {resource['alias']}")
            return _append_event_db(db, "resource_add", _snapshot(resource), session=session)


def remove_resource(home: Path, target: str) -> dict[str, Any]:
    home = ensure_home(home)
    with ledger_lock(home):
        with _transaction(home) as db:
            session = _active_session_db(db)
            if session is None:
                raise RuntimeError("Removing a device requires an active LabOS session.")
            resource = _resolve_unlocked(home, target)
            events = _read_events_db(db)
            active = _session_active_resources(events, str(session["session_id"]))
            if resource["resource_id"] not in active:
                raise RuntimeError(f"Device is not active: {resource['alias']}")
            return _append_event_db(db, "resource_remove", _snapshot(resource), session=session)


def resource_context_timeline(
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Derive per-event resource context from transition events only."""

    active: dict[str, dict[str, Any]] = {}
    by_event: dict[str, list[dict[str, Any]]] = {}

    def current() -> list[dict[str, Any]]:
        return [dict(item) for item in active.values()]

    for event in events:
        event_type = event.get("type")
        payload = event.get("payload", {})
        resource_id = payload.get("resource_id")
        snapshot = None
        if isinstance(resource_id, str):
            snapshot = {
                "resource_id": resource_id,
                "fingerprint": payload.get("fingerprint"),
                "alias": payload.get("alias"),
                "kind": payload.get("kind"),
            }

        if event_type == "resource_add" and snapshot is not None:
            active[resource_id] = snapshot
            by_event[str(event["id"])] = current()
        elif event_type == "resource_remove" and isinstance(resource_id, str):
            by_event[str(event["id"])] = current()
            active.pop(resource_id, None)
        else:
            by_event[str(event["id"])] = current()

    return {
        "by_event": by_event,
        "active_at_end": current(),
    }
