from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

from .ledger import active_session, read_events

SESSION_RECORD_VERSION = 1


def choose_session_id(home: Path, requested: str | None = None) -> str:
    if requested:
        return requested
    active = active_session(home)
    if active:
        return str(active["session_id"])
    for event in reversed(read_events(home)):
        session_id = event.get("session_id")
        if session_id:
            return str(session_id)
    raise RuntimeError("No LabOS session exists yet.")


def session_events(home: Path, session_id: str) -> list[dict[str, Any]]:
    events = [
        event
        for event in read_events(home)
        if event.get("session_id") == session_id
    ]
    if not events:
        raise RuntimeError(f"Session not found: {session_id}")
    return events


def _git(event: dict[str, Any] | None) -> dict[str, Any] | None:
    if not event:
        return None
    value = event.get("payload", {}).get("git")
    return value if isinstance(value, dict) else None


def evidence_coverage(events: list[dict[str, Any]]) -> dict[str, Any]:
    counts = Counter(event.get("type") for event in events)
    checkpoints = [
        event for event in events if event.get("type") == "checkpoint"
    ]
    working = [
        event for event in checkpoints
        if event.get("payload", {}).get("state") == "working"
    ]
    broken = [
        event for event in checkpoints
        if event.get("payload", {}).get("state") == "broken"
    ]
    artifacts = [
        event for event in events if event.get("type") == "artifact"
    ]
    managed = [
        event for event in artifacts
        if event.get("payload", {}).get("storage") == "managed-copy"
    ]
    hashed = [
        event for event in artifacts
        if event.get("payload", {}).get("sha256")
    ]
    start = next((e for e in events if e.get("type") == "session_start"), None)
    end = next(
        (e for e in reversed(events) if e.get("type") == "session_end"),
        None,
    )
    start_git = _git(start) or {}
    end_git = _git(end) or {}

    items = [
        {
            "id": "session_start",
            "label": "Session start recorded",
            "state": "present" if start else "absent",
            "detail": "1" if start else "0",
        },
        {
            "id": "session_end",
            "label": "Session end recorded",
            "state": "present" if end else "absent",
            "detail": "1" if end else "0",
        },
        {
            "id": "notes",
            "label": "Observational notes",
            "state": "present" if counts.get("note", 0) else "absent",
            "detail": str(counts.get("note", 0)),
        },
        {
            "id": "working_checkpoint",
            "label": "WORKING checkpoint",
            "state": "present" if working else "absent",
            "detail": str(len(working)),
        },
        {
            "id": "broken_checkpoint",
            "label": "BROKEN checkpoint",
            "state": "present" if broken else "absent",
            "detail": str(len(broken)),
        },
        {
            "id": "artifacts",
            "label": "Attached artifacts",
            "state": "present" if artifacts else "absent",
            "detail": str(len(artifacts)),
        },
        {
            "id": "managed_artifacts",
            "label": "Managed artifact copies",
            "state": "present" if managed else "absent",
            "detail": str(len(managed)),
        },
        {
            "id": "hashed_artifacts",
            "label": "Hashed artifacts",
            "state": "present" if hashed else "absent",
            "detail": str(len(hashed)),
        },
        {
            "id": "git_start",
            "label": "Git snapshot at start",
            "state": "present" if start_git.get("available") else "absent",
            "detail": (
                str(start_git.get("commit", ""))[:12]
                if start_git.get("available")
                else "not available"
            ),
        },
        {
            "id": "git_end",
            "label": "Git snapshot at end",
            "state": (
                "present"
                if end_git.get("available")
                else ("not_applicable" if not end else "absent")
            ),
            "detail": (
                str(end_git.get("commit", ""))[:12]
                if end_git.get("available")
                else ("session active" if not end else "not available")
            ),
        },
    ]

    return {
        "items": items,
        "counts": {
            "events": len(events),
            "notes": counts.get("note", 0),
            "checkpoints_working": len(working),
            "checkpoints_broken": len(broken),
            "artifacts": len(artifacts),
            "managed_artifacts": len(managed),
            "hashed_artifacts": len(hashed),
        },
        "absent": [
            item["id"] for item in items if item["state"] == "absent"
        ],
    }


def build_session_record(
    home: Path,
    session_id: str | None = None,
) -> dict[str, Any]:
    chosen = choose_session_id(home, session_id)
    events = session_events(home, chosen)
    first = events[0]
    start = next((e for e in events if e.get("type") == "session_start"), first)
    end = next(
        (e for e in reversed(events) if e.get("type") == "session_end"),
        None,
    )
    checkpoints = [
        e for e in events if e.get("type") == "checkpoint"
    ]
    artifacts = [e for e in events if e.get("type") == "artifact"]

    event_aliases = {
        event["id"]: f"E{index:02d}"
        for index, event in enumerate(events, start=1)
    }
    coverage = evidence_coverage(events)

    return {
        "record_version": SESSION_RECORD_VERSION,
        "session": {
            "session_id": chosen,
            "project": first.get("project"),
            "label": start.get("payload", {}).get("label"),
            "workdir": first.get("cwd"),
            "started_at": start.get("timestamp"),
            "ended_at": end.get("timestamp") if end else None,
            "status": "ended" if end else "active",
        },
        "event_aliases": event_aliases,
        "allowed_evidence_ids": [
            *event_aliases.keys(),
            *[f"coverage:{item['id']}" for item in coverage["items"]],
        ],
        "coverage": coverage,
        "git": {
            "start": _git(start),
            "end": _git(end),
            "working": [
                {
                    "event_id": event["id"],
                    "timestamp": event["timestamp"],
                    "git": _git(event),
                }
                for event in checkpoints
                if event.get("payload", {}).get("state") == "working"
            ],
            "broken": [
                {
                    "event_id": event["id"],
                    "timestamp": event["timestamp"],
                    "git": _git(event),
                }
                for event in checkpoints
                if event.get("payload", {}).get("state") == "broken"
            ],
        },
        "artifacts": [
            {
                "event_id": event["id"],
                "timestamp": event["timestamp"],
                **event.get("payload", {}),
            }
            for event in artifacts
        ],
        "events": events,
    }


def canonical_bytes(record: dict[str, Any]) -> bytes:
    return json.dumps(
        record,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def evidence_sha256(record: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bytes(record)).hexdigest()


def _event_detail(event: dict[str, Any]) -> str:
    payload = event.get("payload", {})
    kind = event.get("type")
    if kind == "note":
        return str(payload.get("text", ""))
    if kind == "checkpoint":
        state = str(payload.get("state", "")).upper()
        text = str(payload.get("text") or "")
        return state + (f" — {text}" if text else "")
    if kind == "artifact":
        return f"{payload.get('kind', 'artifact')}: {payload.get('name', '')}"
    if kind == "session_start":
        label = payload.get("label")
        return "START" + (f" — {label}" if label else "")
    if kind == "session_end":
        text = payload.get("text")
        return "END" + (f" — {text}" if text else "")
    return str(kind)


def render_session_record_markdown(
    record: dict[str, Any],
    evidence_sha: str | None = None,
) -> str:
    session = record["session"]
    aliases = record["event_aliases"]
    title = str(session.get("project") or "LabOS session")
    if session.get("label"):
        title += f" — {session['label']}"

    lines = [
        f"# {title}",
        "",
        "> Deterministic LabOS Session Record. No AI interpretation is required to produce this document.",
        "",
        "## Context",
        "",
        f"- Session: `{session['session_id']}`",
        f"- Status: {session['status']}",
        f"- Started: {session['started_at']}",
        f"- Ended: {session['ended_at'] or 'active'}",
        f"- Workdir: `{session.get('workdir') or ''}`",
    ]
    if evidence_sha:
        lines.append(f"- Evidence SHA-256: `{evidence_sha}`")

    lines += ["", "## Evidence coverage", "", "| Evidence | State | Detail |", "|---|---|---|"]
    for item in record["coverage"]["items"]:
        marker = {
            "present": "present",
            "absent": "absent",
            "not_applicable": "n/a",
        }.get(item["state"], item["state"])
        lines.append(
            f"| {item['label']} | {marker} | {item['detail']} |"
        )

    lines += ["", "## Timeline", ""]
    for event in record["events"]:
        alias = aliases[event["id"]]
        lines.append(
            f"- **{alias}** · {event['timestamp']} · {_event_detail(event)}"
        )

    lines += ["", "## Artifacts", ""]
    if record["artifacts"]:
        for artifact in record["artifacts"]:
            alias = aliases[artifact["event_id"]]
            storage = artifact.get("storage", "reference")
            lines.append(
                f"- **{alias}** · {artifact.get('name', '')} · {storage}"
            )
    else:
        lines.append("_No artifact events recorded._")

    lines += ["", "## Evidence references", ""]
    for event in record["events"]:
        lines.append(f"- {aliases[event['id']]} = `{event['id']}`")
    lines.append("")
    return "\n".join(lines)
