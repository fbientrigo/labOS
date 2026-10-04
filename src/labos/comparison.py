from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .session_record import build_session_record

COMPARISON_VERSION = 1


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _pair(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    if left["state"] != "recorded" or right["state"] != "recorded":
        status = "unrecorded"
    else:
        status = "same" if left.get("value") == right.get("value") else "changed"
    return {"status": status, "before": left, "after": right}


def _git_item(record: dict[str, Any], slot: str) -> dict[str, Any]:
    event_type = "session_start" if slot == "start" else "session_end"
    event = next((item for item in record["events"] if item["type"] == event_type), None)
    if event is None:
        return {"state": "unrecorded", "event_ids": [], "value": None}
    snapshot = event.get("payload", {}).get("git")
    if not isinstance(snapshot, dict):
        return {"state": "unrecorded", "event_ids": [event["id"]], "value": None}
    if not snapshot.get("available"):
        return {"state": "unavailable", "event_ids": [event["id"]], "value": None}
    return {"state": "recorded", "event_ids": [event["id"]], "value": snapshot}


def _latest_checkpoint(record: dict[str, Any], state: str) -> dict[str, Any]:
    session_id = record["session"]["session_id"]
    entries = []
    for item in record["effective_entries"]:
        if item["type"] != "checkpoint" or item["payload"].get("state") != state:
            continue
        source = next((event for event in record["events"] if event["id"] == item["event_id"]), {})
        payload = item["payload"]
        capture_session = payload.get("git_capture_session_id")
        if (source.get("session_id") != session_id or payload.get("historical_session_id")
                or (capture_session and capture_session != session_id)):
            continue
        entries.append(item)
    if not entries:
        return {"state": "unrecorded", "event_ids": [], "value": None}
    entry = entries[-1]
    payload = entry["payload"]
    snapshot = payload.get("git")
    if not isinstance(snapshot, dict):
        git_state, git_value = "unrecorded", None
    elif not snapshot.get("available"):
        git_state, git_value = "unavailable", None
    else:
        git_state, git_value = "recorded", snapshot
    return {"state": git_state, "event_ids": [entry["event_id"]], "value": git_value,
            "revision_ids": entry["revision_ids"], "checkpoint_text": payload.get("text")}


def _setup(record: dict[str, Any]) -> dict[str, Any]:
    events = [event for event in record["events"] if event["type"] == "setup_snapshot"]
    if not events:
        return {"state": "unrecorded", "event_ids": [], "value": None}
    event = events[-1]
    setup = event.get("payload", {}).get("setup")
    if not isinstance(setup, dict):
        return {"state": "unrecorded", "event_ids": [event["id"]], "value": None}
    devices = []
    for device in setup.get("devices", []):
        if isinstance(device, dict):
            devices.append({key: device[key] for key in
                            ("resource_id", "id", "fingerprint", "alias", "kind", "activation")
                            if key in device})
    connections = [{key: connection[key] for key in
                    ("from", "from_port", "to", "to_port") if key in connection}
                   for connection in setup.get("connections", []) if isinstance(connection, dict)]
    devices.sort(key=_canonical)
    connections.sort(key=_canonical)
    return {"state": "recorded", "event_ids": [event["id"]],
            "value": {"devices": devices, "connections": connections}}


def _resources(record: dict[str, Any]) -> dict[str, Any]:
    transitions = [event for event in record["events"]
                   if event["type"] in {"resource_add", "resource_remove"}]
    setup_events = [event for event in record["events"] if event["type"] == "setup_snapshot"]
    if not transitions and not setup_events:
        return {"state": "unrecorded", "event_ids": [], "value": None}
    if transitions:
        active = record["resource_context"]["active_at_end"]
    else:
        setup = setup_events[-1].get("payload", {}).get("setup", {})
        active = [{key: device[key] for key in ("resource_id", "id", "fingerprint", "alias", "kind")
                   if key in device} for device in setup.get("devices", []) if isinstance(device, dict)]
    value = sorted((dict(item) for item in active), key=_canonical)
    evidence = transitions or setup_events[-1:]
    return {"state": "recorded", "event_ids": [event["id"] for event in evidence], "value": value}


def _entry_list(record: dict[str, Any], kinds: set[str]) -> list[dict[str, Any]]:
    fields = {
        "checkpoint": ("state", "text", "tag", "occurred_at", "links"),
        "measurement": ("target", "current", "unit", "voltage", "text", "tag", "occurred_at"),
        "artifact": ("kind", "name", "storage", "source_path", "managed_path", "size_bytes",
                     "mtime_ns", "sha256", "note", "occurred_at"),
    }
    output = []
    for entry in record["effective_entries"]:
        if entry["type"] not in kinds:
            continue
        payload = entry["payload"]
        output.append({
            "type": entry["type"],
            "event_id": entry["event_id"],
            "revision_ids": entry["revision_ids"],
            "value": {key: payload[key] for key in fields[entry["type"]] if key in payload},
        })
    return output


def _entries(left_record: dict[str, Any], right_record: dict[str, Any], kinds: set[str]) -> dict[str, Any]:
    left = _entry_list(left_record, kinds)
    right = _entry_list(right_record, kinds)
    status = "unrecorded" if not left or not right else (
        "same" if [_entry_value(item) for item in left] == [_entry_value(item) for item in right]
        else "changed"
    )
    return {"status": status, "before": left, "after": right}


def _entry_value(entry: dict[str, Any]) -> dict[str, Any]:
    ignored = {"occurred_at", "mtime_ns"}
    return {"type": entry["type"],
            "value": {key: value for key, value in entry["value"].items() if key not in ignored}}


def build_comparison(home: Path, left_session_id: str, right_session_id: str) -> dict[str, Any]:
    if left_session_id == right_session_id:
        raise ValueError("Choose two different session IDs to compare")
    left = build_session_record(home, left_session_id)
    right = build_session_record(home, right_session_id)
    git = {
        slot: _pair(_git_item(left, slot), _git_item(right, slot))
        for slot in ("start", "end")
    }
    git["latest_working"] = _pair(_latest_checkpoint(left, "working"), _latest_checkpoint(right, "working"))
    git["latest_broken"] = _pair(_latest_checkpoint(left, "broken"), _latest_checkpoint(right, "broken"))
    return {
        "comparison_version": COMPARISON_VERSION,
        "sessions": {"before": left["session"], "after": right["session"]},
        "comparisons": {
            "git": git,
            "setup": _pair(_setup(left), _setup(right)),
            "resources": _pair(_resources(left), _resources(right)),
            "checkpoints": _entries(left, right, {"checkpoint"}),
            "measurements": _entries(left, right, {"measurement"}),
            "artifacts": _entries(left, right, {"artifact"}),
        },
        "limitations": [
            "Unrecorded evidence does not mean the experiment was unchanged.",
            "Measurements are listed as recorded; unmatched values are not paired or aggregated.",
            "Recorded differences do not establish that one change caused another outcome.",
            "Latest captured WORKING/BROKEN Git uses the latest live checkpoint by ledger event order; backdated entries are listed separately.",
            "Artifact paths and optional hashes are reported without reading or copying files.",
            "Setup reflects the latest explicit snapshot in each session, not every entry's capture-time setup.",
        ],
    }


def _display(value: Any) -> str:
    return "unrecorded" if value is None else json.dumps(value, sort_keys=True, ensure_ascii=False)


def _git_display(item: dict[str, Any]) -> str:
    if item["state"] != "recorded":
        return item["state"]
    snapshot = item["value"]
    commit = str(snapshot.get("commit", ""))[:12]
    dirty = "dirty" if snapshot.get("dirty") else "clean"
    branch = snapshot.get("branch") or "unknown branch"
    files = [str(line).replace("|", "\\|").replace("\n", " ")
             for line in snapshot.get("status", [])]
    summary = f"{branch} @ {commit} · {dirty}"
    if files:
        summary += "; " + ", ".join(files)
    return summary


def _setup_display(value: Any) -> str:
    if not isinstance(value, dict):
        return _display(value)
    devices = ", ".join(
        f"{item.get('alias') or item.get('resource_id') or item.get('id', 'device')}"
        f" [{item.get('fingerprint') or item.get('kind', 'unknown')}]"
        for item in value.get("devices", [])
    ) or "none"
    connections = ", ".join(
        f"{item.get('from')}:{item.get('from_port', '')} → {item.get('to')}:{item.get('to_port', '')}"
        for item in value.get("connections", [])
    ) or "none"
    return f"devices: {devices}; connections: {connections}"


def _event_refs(item: dict[str, Any]) -> str:
    return ", ".join([*item.get("event_ids", []), *item.get("revision_ids", [])]) or "none"


def render_comparison_markdown(comparison: dict[str, Any]) -> str:
    sessions = comparison["sessions"]
    lines = ["# LabOS session comparison", "",
             f"Before: `{sessions['before']['session_id']}` — {sessions['before'].get('project') or ''} {sessions['before'].get('label') or ''}".rstrip(),
             f"After: `{sessions['after']['session_id']}` — {sessions['after'].get('project') or ''} {sessions['after'].get('label') or ''}".rstrip(),
             "", "Missing evidence is shown as unrecorded; it does not prove the experiment was unchanged.",
             "", "## Git snapshots", "", "| Snapshot | Status | Before | After |", "|---|---|---|---|"]
    for name, title in (("start", "Session start"), ("end", "Session end"),
                        ("latest_working", "Latest captured WORKING Git"),
                        ("latest_broken", "Latest captured BROKEN Git")):
        item = comparison["comparisons"]["git"][name]
        before, after = item["before"], item["after"]
        left = f"{_git_display(before)} (events: {_event_refs(before)})"
        right = f"{_git_display(after)} (events: {_event_refs(after)})"
        lines.append(f"| {title} | {item['status']} | {left} | {right} |")
    for name, title in (("setup", "Latest explicit setup"), ("resources", "Last recorded resource membership"),
                        ("checkpoints", "Revision-aware checkpoints"), ("measurements", "Measurements"),
                        ("artifacts", "Artifact references")):
        item = comparison["comparisons"][name]
        lines += ["", f"## {title} ({item['status']})", ""]
        for side, label in (("before", "Before"), ("after", "After")):
            data = item[side]
            if isinstance(data, list):
                lines.append(f"**{label}:**")
                if not data:
                    lines.append("- unrecorded")
                for entry in data:
                    value = entry["value"]
                    details = _display(value)
                    refs = ", ".join([entry["event_id"], *entry["revision_ids"]])
                    lines.append(f"- {entry['type']}: {details} (events: {refs})")
            else:
                refs = _event_refs(data)
                shown = _setup_display(data["value"]) if name == "setup" else _display(data["value"])
                lines.append(f"**{label}:** {shown} (events: {refs})")
    lines += ["", "## Limits", ""]
    lines.extend(f"- {item}" for item in comparison["limitations"])
    lines.append("")
    return "\n".join(lines)
