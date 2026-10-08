"""Append-only setup and daily-log operations used by the CLI and Obsidian."""
from __future__ import annotations

import json
import math
import re
import uuid
import difflib
import hashlib
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from .ledger import _active_session_db, _append_event_db, _transaction, now_iso, read_events


def _iso(value: str | None) -> str:
    if not value:
        return now_iso()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("occurrence time must be an ISO date/time") from exc
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.isoformat(timespec="seconds")


def _local_day(value: str) -> str:
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if instant.tzinfo is None:
            instant = instant.astimezone()
        return instant.astimezone().date().isoformat()
    except ValueError:
        return value[:10]


def current_setup(home: Path) -> dict[str, Any]:
    events = read_events(home)
    for event in reversed(events):
        if event["type"] == "setup_snapshot":
            return event["payload"].get("setup", {"devices": [], "connections": []})
    return {"devices": [], "connections": []}


def setup_history(home: Path) -> list[dict[str, Any]]:
    return [{"event_id": event["id"], "timestamp": event["timestamp"],
             "session_id": event["session_id"], "setup": event["payload"].get("setup", {})}
            for event in read_events(home) if event["type"] == "setup_snapshot"]


def list_sessions(home: Path) -> list[dict[str, Any]]:
    sessions: dict[str, dict[str, Any]] = {}
    for event in read_events(home):
        sid = event.get("session_id")
        if event["type"] == "session_start" and sid:
            sessions[sid] = {"session_id": sid, "project": event.get("project"),
                             "started_at": event["timestamp"], "ended_at": None}
        elif event["type"] == "session_end" and sid in sessions:
            sessions[sid]["ended_at"] = event["timestamp"]
    return list(sessions.values())


def validate_setup(setup: dict[str, Any]) -> None:
    if not isinstance(setup, dict) or not isinstance(setup.get("devices"), list) or not isinstance(setup.get("connections"), list):
        raise ValueError("setup must contain devices and connections arrays")
    devices = setup.get("devices", [])
    ids = [str(device.get("resource_id") or device.get("id") or "") for device in devices if isinstance(device, dict)]
    if len(ids) != len(devices) or any(not value for value in ids) or len(ids) != len(set(ids)):
        raise ValueError("every setup device needs a unique resource_id or id")
    id_set = set(ids)
    schema = setup.get("setup_schema")
    if schema is not None and (type(schema) is not int or schema < 1):
        raise ValueError("setup_schema must be a positive integer")
    # Port descriptors are optional (legacy snapshots have none). When present they are the
    # snapshot's own copy of the device ports, so connections never depend on current device knowledge.
    port_labels: dict[str, dict[str, str]] = {}
    for rid, device in zip(ids, devices):
        raw_ports = device.get("ports", [])
        if not isinstance(raw_ports, list):
            raise ValueError("device ports must be a list")
        labels: dict[str, str] = {}
        seen_labels: set[str] = set()
        for port in raw_ports:
            if not isinstance(port, dict) or not all(isinstance(port.get(key), str) and port[key].strip() for key in ("port_id", "label")):
                raise ValueError("every device port needs a port_id and label")
            if port["port_id"] in labels or port["label"].strip().casefold() in seen_labels:
                raise ValueError("device port ids and labels must be unique")
            labels[port["port_id"]] = port["label"]
            seen_labels.add(port["label"].strip().casefold())
        port_labels[rid] = labels
    for connection in setup.get("connections", []):
        if not isinstance(connection, dict) or str(connection.get("from", "")) not in id_set or str(connection.get("to", "")) not in id_set:
            raise ValueError("every connection endpoint must refer to a setup device")
        if any(not isinstance(connection.get(key, ""), str) for key in ("from_port", "to_port")):
            raise ValueError("connection endpoint labels must be text")
        port_ids = {side: connection.get(side + "_port_id") for side in ("from", "to")}
        for side, port_id in port_ids.items():
            if port_id is None:
                continue
            labels = port_labels[str(connection[side])]
            if not isinstance(port_id, str) or port_id not in labels:
                raise ValueError("connection port_id must refer to a port of that setup device")
            if connection.get(side + "_port", labels[port_id]) != labels[port_id]:
                raise ValueError("connection port label must match the snapshot port descriptor")
        if connection.get("from") == connection.get("to"):
            if port_ids["from"] is None or port_ids["to"] is None or port_ids["from"] == port_ids["to"]:
                raise ValueError("a device cannot connect to itself")
    for device in devices:
        if not all(isinstance(device.get(field), str) and device[field].strip() for field in ("fingerprint", "alias", "kind")):
            raise ValueError("setup devices require identity fingerprint, alias, and kind")
        activation = device.get("activation", "unknown")
        if not isinstance(activation, str) or activation not in {"active", "inactive", "unknown"}:
            raise ValueError("device activation must be active, inactive, or unknown")
        for key in ("x", "y"):
            if key in device and (type(device[key]) not in (int, float) or not math.isfinite(device[key])):
                raise ValueError("device layout coordinates must be finite numbers")


def save_setup(home: Path, setup: dict[str, Any], base_event_id: str | None = None) -> dict[str, Any]:
    """Append one complete setup snapshot.

    base_event_id guards against committing a draft built on a superseded setup: it must equal the
    latest setup_snapshot event id ("" means no snapshot exists yet). None skips the check.
    """
    validate_setup(setup)
    devices = setup["devices"]
    session = _active_session_db
    with _transaction(home) as db:
        active = session(db)
        if active is None:
            raise RuntimeError("Setup changes require an active session.")
        if base_event_id is not None:
            row = db.execute("SELECT id FROM events WHERE type='setup_snapshot' ORDER BY sequence DESC LIMIT 1").fetchone()
            latest = row["id"] if row else ""
            if latest != base_event_id:
                raise RuntimeError("The recorded setup changed since this draft was started. Discard the draft and retry.")
        current_resources: dict[str, dict[str, Any]] = {}
        for item in db.execute("SELECT type,payload_json,session_id FROM events WHERE session_id=? ORDER BY sequence", (active["session_id"],)):
            kind = item["type"]
            identity = json.loads(item["payload_json"])
            rid = identity.get("resource_id")
            if kind == "resource_add" and rid:
                current_resources[str(rid)] = identity
            elif kind == "resource_remove" and rid:
                current_resources.pop(str(rid), None)
        old_devices = current_resources
        new_devices = {str(d.get("resource_id") or d.get("id")): d for d in devices}
        # Keep the session's resource context aligned with the complete setup in the same transaction.
        for rid in old_devices.keys() - new_devices.keys():
            identity = old_devices[rid]
            _append_event_db(db, "resource_remove", {"resource_id": rid, "alias": identity.get("alias"), "kind": identity.get("kind")}, session=active)
        changed_ids = {rid for rid in old_devices.keys() & new_devices.keys()
                       if any(old_devices[rid].get(key) != new_devices[rid].get(key) for key in ("fingerprint", "alias", "kind"))}
        for rid in changed_ids:
            identity = old_devices[rid]
            _append_event_db(db, "resource_remove", {"resource_id": rid, "alias": identity.get("alias"), "fingerprint": identity.get("fingerprint"), "kind": identity.get("kind")}, session=active)
        for rid in (new_devices.keys() - old_devices.keys()) | changed_ids:
            identity = new_devices[rid]
            _append_event_db(db, "resource_add", {"resource_id": rid, "fingerprint": identity.get("fingerprint"), "alias": identity.get("alias"), "kind": identity.get("kind")}, session=active)
        event = _append_event_db(db, "setup_snapshot", {"setup": setup}, session=active)
    return event


def capture(home: Path, *, kind: str, text: str = "", tag: str | None = None,
            occurred_at: str | None = None, target: str | None = None,
            current: float | None = None, unit: str | None = None,
            voltage: float | None = None, links: list[dict[str, str]] | None = None,
            session_id: str | None = None, setup: dict[str, Any] | None = None) -> dict[str, Any]:
    if kind not in {"note", "measurement", "checkpoint"}:
        raise ValueError("entry kind must be note, measurement, or checkpoint")
    if session_id and occurred_at is None:
        raise ValueError("historical session selection requires an explicit occurrence date/time")
    if current is not None and (not math.isfinite(current) or current < 0):
        raise ValueError("current must be non-negative")
    if voltage is not None and not math.isfinite(voltage):
        raise ValueError("voltage must be finite")
    if unit is not None and unit not in {"A", "mA"}:
        raise ValueError("current unit must be A or mA")
    when = _iso(occurred_at)
    payload: dict[str, Any] = {"text": text, "occurred_at": when, "tag": tag,
                               "links": links or []}
    if kind == "measurement":
        if current is None or unit is None:
            raise ValueError("measurement requires current and unit")
        payload.update(target=target or "setup", current=current, unit=unit, voltage=voltage)
    if kind == "checkpoint":
        payload["state"] = "working"
    # An explicitly entered occurrence time always requires an explicitly selected setup.
    payload["setup"] = setup
    if session_id:
        if not any(event.get("session_id") == session_id and event.get("type") == "session_start" for event in read_events(home)):
            raise ValueError("selected historical session does not exist")
        payload["historical_session_id"] = session_id
    with _transaction(home) as db:
        active = _active_session_db(db)
        if setup is None and occurred_at is None and session_id is None:
            row = db.execute("SELECT payload_json FROM events WHERE type='setup_snapshot' ORDER BY sequence DESC LIMIT 1").fetchone()
            payload["setup"] = json.loads(row["payload_json"]).get("setup", {"devices": [], "connections": []}) if row else {"devices": [], "connections": []}
        # Explicit occurrence times require explicit session association. This prevents historical
        # entries from inheriting whichever session happens to be active when they are typed.
        event_session = active if occurred_at is None and session_id is None else {}
        return _append_event_db(db, kind, payload, session=event_session)


def effective_entries(home: Path, *, day: str, session_id: str | None = None,
                      tag: str | None = None, query: str | None = None,
                      offset: int = 0, limit: int = 100) -> list[dict[str, Any]]:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("day must be YYYY-MM-DD")
    events = read_events(home)
    revisions: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        if event["type"] == "entry_revision":
            target = event["payload"].get("entry_id", "")
            revisions.setdefault(target, []).append(event)
    output = []
    for event in events:
        payload = event["payload"]
        if event["type"] not in {"note", "checkpoint", "measurement", "artifact"}:
            continue
        when = str(payload.get("occurred_at") or event["timestamp"])
        if _local_day(when) != day or (session_id and event.get("session_id") != session_id and payload.get("historical_session_id") != session_id):
            continue
        revision_events = revisions.get(event["id"], [])
        changes: dict[str, Any] = {}
        for revision in revision_events:
            changes.update(revision["payload"].get("changes", {}))
        entry = {**event, "effective_payload": {**payload, **changes},
                 "revision": revision_events[-1] if revision_events else None,
                 "revision_history": revision_events}
        effective = entry["effective_payload"]
        if effective.get("removed"):
            continue
        if tag and effective.get("tag") != tag:
            continue
        if query:
            haystack = json.dumps([effective, event.get("project"), event.get("session_id")], ensure_ascii=False).casefold()
            if query.casefold() not in haystack:
                continue
        output.append(entry)
    def sort_key(item: dict[str, Any]) -> tuple[float, str]:
        value = str(item["payload"].get("occurred_at") or item["timestamp"])
        try:
            instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if instant.tzinfo is None:
                instant = instant.astimezone()
            return instant.timestamp(), item["timestamp"]
        except ValueError:
            return 0.0, item["timestamp"]
    output.sort(key=sort_key, reverse=True)
    return output[offset:offset + limit]


def revise(home: Path, entry_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    allowed = {"text", "tag", "links", "removed", "target", "current", "unit", "voltage"}
    if not changes or not set(changes).issubset(allowed):
        raise ValueError("revision contains unsupported fields")
    original = next((e for e in read_events(home) if e["id"] == entry_id), None)
    if not original or original["type"] not in {"note", "checkpoint", "measurement", "artifact"}:
        raise ValueError("entry not found")
    if "current" in changes and (not isinstance(changes["current"], (int, float)) or not math.isfinite(changes["current"]) or changes["current"] < 0):
        raise ValueError("current must be a finite non-negative number")
    if "voltage" in changes and changes["voltage"] is not None and (not isinstance(changes["voltage"], (int, float)) or not math.isfinite(changes["voltage"])):
        raise ValueError("voltage must be a finite number")
    if "unit" in changes and changes["unit"] not in {"A", "mA"}:
        raise ValueError("current unit must be A or mA")
    if set(changes) & {"current", "unit", "voltage", "target"} and original["type"] != "measurement":
        raise ValueError("measurement fields can only revise a measurement")
    return __import__("labos.ledger", fromlist=["append_event"]).append_event(
        home, "entry_revision", {"entry_id": entry_id, "changes": changes}, session=None)


def set_tag(home: Path, day: str, name: str, color: str) -> dict[str, Any]:
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
        raise ValueError("tag color must be a six-digit HEX color")
    if not name.strip():
        raise ValueError("tag name must not be empty")
    from .ledger import append_event
    return append_event(home, "tag_definition", {"day": day, "name": name.strip(), "color": color.upper()})


def tags_for_day(home: Path, day: str) -> list[dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for event in read_events(home):
        payload = event.get("payload", {})
        if event["type"] == "tag_definition" and (day == "*" or payload.get("day") == day):
            key = f"{payload['name']}:{payload['color']}" if day == "*" else str(payload["name"])
            result[key] = {"name": str(payload["name"]), "color": str(payload["color"])}
    return list(result.values())


def record_asset_rename(home: Path, old_path: str, new_path: str) -> dict[str, Any]:
    events = read_events(home)
    renames = asset_renames(home)
    referenced: set[str] = set()
    revisions: dict[str, dict[str, Any]] = {}
    for event in events:
        if event["type"] == "entry_revision":
            revisions.setdefault(str(event["payload"].get("entry_id", "")), {}).update(
                event["payload"].get("changes", {})
            )
        elif event["type"] == "artifact":
            path = event["payload"].get("source_path") or event["payload"].get("path")
            if path:
                referenced.add(str(path))
    for event in events:
        if event["type"] not in {"note", "checkpoint", "measurement", "artifact"}:
            continue
        payload = {**event.get("payload", {}), **revisions.get(event["id"], {})}
        for link in payload.get("links") or []:
            if isinstance(link, dict) and link.get("path"):
                referenced.add(str(link["path"]))
    if not any(_resolve_asset(path, renames) == old_path for path in referenced):
        return {"recorded": False, "old_path": old_path, "new_path": new_path}
    from .ledger import append_event
    event = append_event(home, "asset_rename", {"old_path": old_path, "new_path": new_path})
    return {"recorded": True, **event}


def _resolve_asset(path: str, renames: dict[str, str]) -> str:
    visited: set[str] = set()
    while path in renames and renames[path] != path and path not in visited:
        visited.add(path)
        path = renames[path]
    return path


def asset_renames(home: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for event in read_events(home):
        if event["type"] == "asset_rename":
            result[str(event["payload"].get("old_path", ""))] = str(event["payload"].get("new_path", ""))
    return result


def daily_log_id(home: Path, day: str) -> str:
    try:
        if datetime.fromisoformat(day).date().isoformat() != day:
            raise ValueError
    except ValueError as exc:
        raise ValueError("day must be YYYY-MM-DD") from exc
    identity_file = Path(home).expanduser().resolve() / "logs" / f"{day}.id"
    identity_file.parent.mkdir(parents=True, exist_ok=True)
    from .locking import ledger_lock

    with ledger_lock(Path(home)):
        if not identity_file.exists():
            _atomic_markdown_write(identity_file, uuid.uuid4().hex)
        value = identity_file.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError(f"invalid daily log identity for {day}")
    return value


def bulk_retag(home: Path, *, day: str, old_tag: str, new_tag: str) -> list[dict[str, Any]]:
    entries = effective_entries(home, day=day, tag=old_tag, limit=1000000)
    with _transaction(home) as db:
        return [_append_event_db(db, "entry_revision", {"entry_id": entry["id"], "changes": {"tag": new_tag}})
                for entry in entries]


def render_daily_markdown(home: Path, day: str) -> str:
    entries: list[dict[str, Any]] = []
    renames: dict[str, str] = {}
    for event in read_events(home):
        if event["type"] == "asset_rename":
            renames[event["payload"].get("old_path", "")] = event["payload"].get("new_path", "")
    offset = 0
    while True:
        page = effective_entries(home, day=day, offset=offset, limit=500)
        entries.extend(page)
        if len(page) < 500:
            break
        offset += len(page)
    log_id = daily_log_id(home, day)
    lines = [f"<!-- labos-log-id:{log_id} -->", f"<!-- labos-log-date:{day} -->",
             f"# LabOS Log · {day}", "", "<!-- LabOS entries begin -->", ""]
    for entry in entries:
        p = entry["effective_payload"]
        eid = entry["id"]
        lines.extend([f"<!-- labos-entry:{eid} -->", f"### {p.get('occurred_at') or entry['timestamp']} · {entry['type']}",
                      f"<!-- event-id:{eid} -->"])
        if p.get("tag"):
            lines.append(f"Tag: {p['tag']}")
        if p.get("text"):
            lines.extend(["", str(p["text"])])
        if entry["type"] == "measurement":
            voltage = f" · {p['voltage']} V" if p.get("voltage") is not None else ""
            lines.append(f"\n{p.get('target', 'setup')}: {p.get('current')} {p.get('unit')}{voltage}")
        for link in p.get("links", []):
            if link.get("title"):
                prefix = "!" if link.get("kind") == "image" else ""
                target = link.get("path") or link["title"]
                target = _resolve_asset(target, renames)
                lines.append(f"\n{prefix}[[{target}]]")
        lines.extend(["", f"<!-- labos-entry-end:{eid} -->", ""])
    lines.extend(["<!-- LabOS entries end -->", ""])
    return "\n".join(lines)


def write_daily_markdown(home: Path, day: str, path: Path, *, allow_user_edits: bool = False) -> Path:
    path = path.expanduser().resolve()
    generated = render_daily_markdown(home, day)
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        start_marker, end_marker = "<!-- LabOS entries begin -->", "<!-- LabOS entries end -->"
        if existing.count(start_marker) != 1 or existing.count(end_marker) != 1 or existing.index(start_marker) > existing.index(end_marker):
            raise ValueError("Markdown log has conflicting or missing LabOS entry markers")
        stable_ids = re.findall(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", existing, re.I)
        if len(stable_ids) > 1:
            raise ValueError("Markdown log contains duplicate stable LabOS log IDs")
        if stable_ids and stable_ids[0] != daily_log_id(home, day):
            raise ValueError("Markdown log stable ID does not match its recorded day")
        date_markers = re.findall(r"<!--\s*labos-log-date:(\d{4}-\d\d-\d\d)\s*-->", existing, re.I)
        if len(date_markers) > 1 or (date_markers and date_markers[0] != day):
            raise ValueError("Markdown log date does not match its recorded day")
        stable_id = re.search(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", existing, re.I)
        if stable_id and not allow_user_edits:
            baseline_path = Path(home).expanduser().resolve() / "logs" / f"{stable_id.group(1)}.md"
            if baseline_path.is_file():
                baseline = baseline_path.read_text(encoding="utf-8")
                if baseline.count(start_marker) != 1 or baseline.count(end_marker) != 1:
                    raise ValueError("Markdown baseline has conflicting LabOS markers")
                existing_managed = existing[existing.index(start_marker):existing.index(end_marker) + len(end_marker)]
                baseline_managed = baseline[baseline.index(start_marker):baseline.index(end_marker) + len(end_marker)]
                if existing_managed != baseline_managed:
                    raise ValueError("Markdown log has unreviewed edits; run Update log in LabOS first")
        start, end = existing.index(start_marker), existing.index(end_marker) + len(end_marker)
        gen_start, gen_end = generated.index(start_marker), generated.index(end_marker) + len(end_marker)
        prefix = existing[:start]
        log_marker = re.search(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", existing, re.I)
        if not log_marker:
            stable = re.search(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", generated, re.I)
            prefix = (stable.group(0) + "\n" if stable else "") + prefix
        if not re.search(r"<!--\s*labos-log-date:\d{4}-\d\d-\d\d\s*-->", prefix, re.I):
            prefix = re.sub(r"(<!--\s*labos-log-id:[^>]+-->\s*)", rf"\1<!-- labos-log-date:{day} -->\n", prefix, count=1, flags=re.I)
            if not re.search(r"<!--\s*labos-log-date:", prefix, re.I):
                prefix = f"<!-- labos-log-date:{day} -->\n" + prefix
        merged = prefix + generated[gen_start:gen_end] + existing[end:]
        _atomic_markdown_write(path, merged)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_markdown_write(path, generated)
    final_text = path.read_text(encoding="utf-8")
    marker = re.search(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", final_text, re.I)
    if marker:
        baseline = Path(home).expanduser().resolve() / "logs" / f"{marker.group(1)}.md"
        baseline.parent.mkdir(parents=True, exist_ok=True)
        baseline.write_text(final_text, encoding="utf-8")
    return path


def _atomic_markdown_write(path: Path, content: str) -> None:
    temp_path = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def _entry_blocks(markdown: str) -> tuple[dict[str, str], list[str]]:
    begin, end = "<!-- LabOS entries begin -->", "<!-- LabOS entries end -->"
    if markdown.count(begin) != 1 or markdown.count(end) != 1 or markdown.index(begin) > markdown.index(end):
        raise ValueError("Markdown log has conflicting or missing LabOS entry markers")
    body = markdown[markdown.index(begin) + len(begin):markdown.index(end)]
    matches = list(re.finditer(r"<!--\s*labos-entry:([^>]+?)\s*-->", body))
    ids = [match.group(1).strip() for match in matches]
    if len(ids) != len(set(ids)):
        raise ValueError("Markdown log contains duplicate entry markers")
    blocks: dict[str, str] = {}
    for index, match in enumerate(matches):
        entry_id = ids[index]
        end = re.search(r"<!--\s*labos-entry-end:" + re.escape(entry_id) + r"\s*-->", body[match.end():])
        next_marker = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        if end:
            stop = match.end() + end.end()
        else:
            # Accept older generated logs that lacked explicit end markers.
            stop = next_marker
        if stop > next_marker:
            raise ValueError("Markdown entry markers overlap")
        blocks[entry_id] = body[match.start():stop].strip()
    return blocks, ids


def _markdown_changes(block: str, original: dict[str, Any] | None = None) -> dict[str, Any]:
    lines = block.splitlines()
    changes: dict[str, Any] = {}
    content = []
    links: list[dict[str, str]] = []
    for line in lines:
        if (line.startswith("<!-- labos-entry:") or line.startswith("<!-- labos-entry-end:")
                or line.startswith("<!-- event-id:")
                or re.match(r"###\s+\d{4}-\d\d-\d\dT.*\s[·-]\s(?:note|measurement|checkpoint|artifact)\s*$", line)):
            continue
        if line.startswith("Tag: "):
            changes["tag"] = line[5:].strip() or None
            continue
        link_match = re.fullmatch(r"(!)?\[\[([^\]]+)\]\]", line.strip())
        if link_match:
            target = link_match.group(2)
            links.append({"title": target.rsplit("/", 1)[-1].rsplit(".", 1)[0], "path": target,
                          "kind": "image" if link_match.group(1) else "note"})
            continue
        if original and original.get("type") == "measurement":
            measurement = re.fullmatch(r"(.+?):\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(A|mA)(?:\s*·\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*V)?", line)
            if measurement:
                changes["target"] = measurement.group(1)
                changes["current"] = float(measurement.group(2))
                changes["unit"] = measurement.group(3)
                changes["voltage"] = float(measurement.group(4)) if measurement.group(4) is not None else None
                continue
        content.append(line)
    text = "\n".join(content).strip()
    changes["text"] = text
    changes.setdefault("tag", None)
    changes["links"] = links
    return changes


def update_markdown_log(home: Path, path: Path, *, apply: bool = False,
                        remove_ids: set[str] | None = None) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    current = path.read_text(encoding="utf-8")
    id_markers = re.findall(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", current, re.I)
    if len(id_markers) != 1:
        raise ValueError("Markdown log is missing its stable LabOS log ID")
    log_id = id_markers[0]
    baseline_path = Path(home).expanduser().resolve() / "logs" / f"{log_id}.md"
    if not baseline_path.is_file():
        raise ValueError("No LabOS baseline exists for this log; export it once before updating")
    baseline = baseline_path.read_text(encoding="utf-8")
    baseline_ids = re.findall(r"<!--\s*labos-log-id:([a-f0-9-]+)\s*-->", baseline, re.I)
    if baseline_ids != [log_id]:
        raise ValueError("Markdown log stable ID does not match its baseline")
    current_dates = re.findall(r"<!--\s*labos-log-date:(\d{4}-\d\d-\d\d)\s*-->", current, re.I)
    baseline_dates = re.findall(r"<!--\s*labos-log-date:(\d{4}-\d\d-\d\d)\s*-->", baseline, re.I)
    if len(current_dates) != 1 or len(baseline_dates) != 1:
        raise ValueError("Markdown log must contain exactly one immutable LabOS log date")
    if current_dates[0] != baseline_dates[0]:
        raise ValueError("Markdown log date does not match its baseline")
    current_blocks, current_ids = _entry_blocks(current)
    baseline_blocks, baseline_ids = _entry_blocks(baseline)
    all_events = read_events(home)
    event_by_id = {event["id"]: event for event in all_events}
    conflicts = [entry_id for entry_id in current_ids if entry_id not in event_by_id]
    # A marker cannot disappear while its event-id marker remains; that is an incomplete edit.
    inside = current[current.index("<!-- LabOS entries begin -->"):current.index("<!-- LabOS entries end -->")]
    orphan_event_ids = re.findall(r"<!--\s*event-id:([^>]+?)\s*-->", inside)
    conflicts.extend(item.strip() for item in orphan_event_ids if item.strip() not in current_blocks)
    end_ids = re.findall(r"<!--\s*labos-entry-end:([^>]+?)\s*-->", inside)
    conflicts.extend(item.strip() for item in end_ids if item.strip() not in current_blocks)
    if conflicts:
        raise ValueError("Markdown log has missing or unknown entry markers: " + ", ".join(sorted(set(conflicts))))
    removed = sorted(set(baseline_ids) - set(current_ids))
    confirmed = remove_ids or set()
    if apply and set(removed) - confirmed:
        return {"status": "confirmation_required", "log_id": log_id, "changed": [], "new": [], "removed": removed, "events": []}

    revisions: list[tuple[str, dict[str, Any]]] = []
    changed_details: list[dict[str, Any]] = []
    concurrent_conflicts: list[str] = []
    for entry_id in set(current_ids) & set(baseline_ids):
        if current_blocks[entry_id] != baseline_blocks[entry_id]:
            original = event_by_id[entry_id]
            changes = _markdown_changes(current_blocks[entry_id], original)
            effective = {**original["payload"]}
            for revision in all_events:
                if revision["type"] == "entry_revision" and revision["payload"].get("entry_id") == entry_id:
                    effective.update(revision["payload"].get("changes", {}))
            baseline_effective = {**original["payload"], **_markdown_changes(baseline_blocks[entry_id], original)}
            newer_revisions = [revision for revision in all_events
                               if revision["type"] == "entry_revision" and revision["payload"].get("entry_id") == entry_id]
            if newer_revisions and any(effective.get(key) != baseline_effective.get(key)
                                       and effective.get(key) != value for key, value in changes.items()):
                concurrent_conflicts.append(entry_id)
            remaining_changes = {key: value for key, value in changes.items() if effective.get(key) != value}
            if remaining_changes:
                revisions.append((entry_id, remaining_changes))
                changed_details.append({"entry_id": entry_id, "changes": {
                    key: {"before": effective.get(key), "after": value} for key, value in remaining_changes.items()
                }})
    if concurrent_conflicts:
        raise ValueError("Markdown entry conflicts with a newer LabOS revision: " + ", ".join(sorted(concurrent_conflicts)))

    new_items: list[dict[str, Any]] = []
    log_day = baseline_dates[0]
    body = current[current.index("<!-- LabOS entries begin -->") + len("<!-- LabOS entries begin -->"):current.index("<!-- LabOS entries end -->")]
    unmarked = body
    for block in current_blocks.values():
        unmarked = unmarked.replace(block, "", 1)
    for section in re.split(r"(?=^### )", unmarked, flags=re.M):
        if not section.strip():
            continue
        heading = re.match(r"^###\s+(.+?)\s*$", section.strip(), re.M)
        heading_text = heading.group(1) if heading else ""
        timestamp_match = re.match(r"(\d{4}-\d\d-\d\dT[^ ]+)\s*·\s*(?:note)?", heading_text)
        changes = _markdown_changes(section)
        if changes.get("text") or changes.get("links"):
            new_items.append({"occurred_at": timestamp_match.group(1) if timestamp_match else "",
                              **changes})

    outside_before = baseline[:baseline.index("<!-- LabOS entries begin -->")] + baseline[baseline.index("<!-- LabOS entries end -->") + len("<!-- LabOS entries end -->"):]
    outside_now = current[:current.index("<!-- LabOS entries begin -->")] + current[current.index("<!-- LabOS entries end -->") + len("<!-- LabOS entries end -->"):]
    text_diff = "".join(difflib.unified_diff(outside_before.splitlines(True), outside_now.splitlines(True), fromfile="previous", tofile="current"))
    summary = {"status": "preview", "log_id": log_id, "changed": [eid for eid, _ in revisions], "changed_details": changed_details, "new": new_items, "removed": removed, "text_diff": text_diff, "events": []}
    if not apply:
        return summary
    if not revisions and not new_items and not removed and not text_diff:
        # Evidence may already have been saved when the previous Markdown write failed.
        # Regenerate from that evidence so retry repairs the file and baseline without
        # appending the revision again.
        output_path = write_daily_markdown(home, log_day, path, allow_user_edits=True)
        summary.update(status="no_op", path=str(output_path))
        return summary

    created: list[dict[str, Any]] = []
    for entry_id, changes in revisions:
        created.append(revise(home, entry_id, changes))
    for entry_id in removed:
        was_removed = any(e["type"] == "entry_revision" and e["payload"].get("entry_id") == entry_id
                          and e["payload"].get("changes", {}).get("removed") for e in all_events)
        if entry_id in confirmed and not was_removed:
            created.append(revise(home, entry_id, {"removed": True}))
    for item in new_items:
        at = item["occurred_at"] or datetime.fromisoformat(log_day + "T12:00:00").astimezone().isoformat(timespec="seconds")
        key = hashlib.sha256((log_id + json.dumps(item, sort_keys=True, ensure_ascii=False)).encode("utf-8")).hexdigest()
        duplicate = any(event.get("payload", {}).get("markdown_source_hash") == key for event in all_events)
        if duplicate:
            continue
        with _transaction(home) as db:
            created.append(_append_event_db(db, "note", {"text": item.get("text", ""), "occurred_at": _iso(at), "tag": item.get("tag"), "links": item.get("links", []), "setup": None, "historical_session_id": None, "markdown_source_hash": key}, session={}))
    if text_diff:
        digest = hashlib.sha256(text_diff.encode("utf-8")).hexdigest()
        if not any(e["type"] == "markdown_edit" and e["payload"].get("log_id") == log_id and e["payload"].get("diff_sha256") == digest for e in all_events):
            from .ledger import append_event
            created.append(append_event(home, "markdown_edit", {"log_id": log_id, "diff": text_diff, "diff_sha256": digest}))
    output_path = write_daily_markdown(home, log_day, path, allow_user_edits=True)
    summary.update(status="updated", events=[event["id"] for event in created], path=str(output_path))
    return summary
