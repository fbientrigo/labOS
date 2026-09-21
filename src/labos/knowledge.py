from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .ledger import _atomic_json_write, _new_id, ensure_home, now_iso
from .locking import ledger_lock
from .resources import show_resource

KNOWLEDGE_VERSION = 1


def _knowledge_path(home: Path) -> Path:
    return ensure_home(home) / "device_knowledge.json"


def _blank() -> dict[str, Any]:
    return {"knowledge_version": KNOWLEDGE_VERSION, "resources": {}}


def _clean(value: str, field: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field} must not be empty")
    return cleaned


def _string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text")
    return _clean(value, field)


def _clean_refs(values: list[str] | None) -> list[str]:
    if not values:
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _string(value, "evidence reference")
        if item not in seen:
            cleaned.append(item)
            seen.add(item)
    return cleaned


def _load_unlocked(home: Path) -> dict[str, Any]:
    path = _knowledge_path(home)
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Malformed LabOS device knowledge: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("resources"), dict):
        raise RuntimeError(
            "Malformed LabOS device knowledge: expected a resources object."
        )
    version = data.get("knowledge_version")
    if version != KNOWLEDGE_VERSION:
        raise RuntimeError(
            f"Unsupported LabOS device knowledge version: {version!r}"
        )
    return data


def _write_unlocked(home: Path, data: dict[str, Any]) -> None:
    _atomic_json_write(
        _knowledge_path(home),
        {
            "knowledge_version": KNOWLEDGE_VERSION,
            "resources": data["resources"],
        },
    )


def _resource_id(home: Path, target: str) -> str:
    return str(show_resource(home, target)["resource_id"])


def _resource_entry(data: dict[str, Any], resource_id: str) -> dict[str, Any]:
    resources = data["resources"]
    entry = resources.setdefault(
        resource_id,
        {"approved_facts": [], "power_profiles": []},
    )
    if not isinstance(entry, dict):
        raise RuntimeError("Malformed LabOS device knowledge resource entry.")
    facts = entry.setdefault("approved_facts", [])
    profiles = entry.setdefault("power_profiles", [])
    if not isinstance(facts, list) or not isinstance(profiles, list):
        raise RuntimeError("Malformed LabOS device knowledge lists.")
    return entry


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} must be finite")
    return number


def validate_rails(rails: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(rails, list) or not rails:
        raise ValueError("power profile requires at least one rail")

    validated: list[dict[str, Any]] = []
    labels: set[str] = set()
    for index, rail in enumerate(rails, start=1):
        if not isinstance(rail, dict):
            raise ValueError(f"rail {index} must be an object")
        label = _string(rail.get("label"), f"rail {index} label")
        key = label.casefold()
        if key in labels:
            raise ValueError(f"duplicate rail label: {label}")
        labels.add(key)

        voltage = _number(rail.get("voltage"), f"rail {index} voltage")
        voltage_unit = _string(
            rail.get("voltage_unit"),
            f"rail {index} voltage_unit",
        )
        current_limit = _number(
            rail.get("current_limit"),
            f"rail {index} current_limit",
        )
        if current_limit <= 0:
            raise ValueError(f"rail {index} current_limit must be positive")
        current_unit = _string(
            rail.get("current_unit"),
            f"rail {index} current_unit",
        )
        polarity = _string(
            rail.get("polarity"),
            f"rail {index} polarity",
        )

        result: dict[str, Any] = {
            "label": label,
            "voltage": voltage,
            "voltage_unit": voltage_unit,
            "current_limit": current_limit,
            "current_unit": current_unit,
            "polarity": polarity,
        }
        if rail.get("typical_draw") is not None:
            typical_draw = _number(
                rail.get("typical_draw"),
                f"rail {index} typical_draw",
            )
            if typical_draw < 0:
                raise ValueError(f"rail {index} typical_draw must be non-negative")
            result["typical_draw"] = typical_draw
        validated.append(result)
    return validated


def device_knowledge(home: Path, target: str) -> dict[str, Any]:
    home = ensure_home(home)
    resource_id = _resource_id(home, target)
    with ledger_lock(home):
        data = _load_unlocked(home)
        existing = data["resources"].get(resource_id)
        if existing is None:
            entry = {"approved_facts": [], "power_profiles": []}
        else:
            if not isinstance(existing, dict):
                raise RuntimeError("Malformed LabOS device knowledge resource entry.")
            entry = existing
        facts = entry.get("approved_facts", [])
        profiles = entry.get("power_profiles", [])
        if not isinstance(facts, list) or not isinstance(profiles, list):
            raise RuntimeError("Malformed LabOS device knowledge lists.")
        return {
            "knowledge_version": KNOWLEDGE_VERSION,
            "resource_id": resource_id,
            "approved_facts": [dict(item) for item in facts],
            "power_profiles": [dict(item) for item in profiles],
        }


def approve_fact(
    home: Path,
    target: str,
    *,
    name: str,
    value: str,
    evidence_refs: list[str] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    resource_id = _resource_id(home, target)
    name = _clean(name, "fact name")
    value = _clean(value, "fact value")
    evidence_refs = _clean_refs(evidence_refs)
    notes = notes.strip() if notes and notes.strip() else None

    with ledger_lock(home):
        data = _load_unlocked(home)
        entry = _resource_entry(data, resource_id)
        if any(
            str(item.get("name", "")).casefold() == name.casefold()
            for item in entry["approved_facts"]
        ):
            raise ValueError(
                f"approved fact already exists: {name}; edit it explicitly instead"
            )
        fact = {
            "fact_id": _new_id("fact"),
            "name": name,
            "value": value,
            "approved_at": now_iso(),
            "evidence_refs": evidence_refs,
            "notes": notes,
        }
        entry["approved_facts"].append(fact)
        _write_unlocked(home, data)
        return dict(fact)


def edit_fact(
    home: Path,
    target: str,
    fact_id: str,
    *,
    name: str,
    value: str,
    evidence_refs: list[str] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    resource_id = _resource_id(home, target)
    fact_id = _clean(fact_id, "fact ID")
    name = _clean(name, "fact name")
    value = _clean(value, "fact value")
    evidence_refs = _clean_refs(evidence_refs)
    notes = notes.strip() if notes and notes.strip() else None

    with ledger_lock(home):
        data = _load_unlocked(home)
        entry = _resource_entry(data, resource_id)
        facts = entry["approved_facts"]
        current = next((item for item in facts if item.get("fact_id") == fact_id), None)
        if current is None:
            raise RuntimeError(f"Approved fact not found: {fact_id}")
        if any(
            item.get("fact_id") != fact_id
            and str(item.get("name", "")).casefold() == name.casefold()
            for item in facts
        ):
            raise ValueError(f"approved fact already exists: {name}")

        replacement = {
            "fact_id": fact_id,
            "name": name,
            "value": value,
            "approved_at": now_iso(),
            "evidence_refs": evidence_refs,
            "notes": notes,
        }
        entry["approved_facts"] = [
            replacement if item.get("fact_id") == fact_id else item
            for item in facts
        ]
        _write_unlocked(home, data)
        return dict(replacement)


def approve_power_profile(
    home: Path,
    target: str,
    *,
    name: str,
    rails: list[dict[str, Any]],
    evidence_refs: list[str] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    resource_id = _resource_id(home, target)
    name = _clean(name, "power profile name")
    rails = validate_rails(rails)
    evidence_refs = _clean_refs(evidence_refs)
    notes = notes.strip() if notes and notes.strip() else None

    with ledger_lock(home):
        data = _load_unlocked(home)
        entry = _resource_entry(data, resource_id)
        if any(
            str(item.get("name", "")).casefold() == name.casefold()
            for item in entry["power_profiles"]
        ):
            raise ValueError(
                f"power profile already exists: {name}; edit it explicitly instead"
            )
        profile = {
            "profile_id": _new_id("pwr"),
            "name": name,
            "rails": rails,
            "approved_at": now_iso(),
            "evidence_refs": evidence_refs,
            "notes": notes,
        }
        entry["power_profiles"].append(profile)
        _write_unlocked(home, data)
        return dict(profile)


def edit_power_profile(
    home: Path,
    target: str,
    profile_id: str,
    *,
    name: str,
    rails: list[dict[str, Any]],
    evidence_refs: list[str] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    resource_id = _resource_id(home, target)
    profile_id = _clean(profile_id, "profile ID")
    name = _clean(name, "power profile name")
    rails = validate_rails(rails)
    evidence_refs = _clean_refs(evidence_refs)
    notes = notes.strip() if notes and notes.strip() else None

    with ledger_lock(home):
        data = _load_unlocked(home)
        entry = _resource_entry(data, resource_id)
        profiles = entry["power_profiles"]
        current = next(
            (item for item in profiles if item.get("profile_id") == profile_id),
            None,
        )
        if current is None:
            raise RuntimeError(f"Power profile not found: {profile_id}")
        if any(
            item.get("profile_id") != profile_id
            and str(item.get("name", "")).casefold() == name.casefold()
            for item in profiles
        ):
            raise ValueError(f"power profile already exists: {name}")

        replacement = {
            "profile_id": profile_id,
            "name": name,
            "rails": rails,
            "approved_at": now_iso(),
            "evidence_refs": evidence_refs,
            "notes": notes,
        }
        entry["power_profiles"] = [
            replacement if item.get("profile_id") == profile_id else item
            for item in profiles
        ]
        _write_unlocked(home, data)
        return dict(replacement)
