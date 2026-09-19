from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def default_home() -> Path:
    configured = os.environ.get("LABOS_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "labos-data").resolve()


def ensure_home(home: Path) -> Path:
    home = home.expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    (home / "artifacts").mkdir(exist_ok=True)
    return home


def _events_path(home: Path) -> Path:
    return ensure_home(home) / "events.jsonl"


def _state_path(home: Path) -> Path:
    return ensure_home(home) / ".active-session.json"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _atomic_json_write(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def active_session(home: Path) -> dict[str, Any] | None:
    path = _state_path(home)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def append_event(
    home: Path,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    event_id: str | None = None,
    session: dict[str, Any] | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    if session is None:
        session = active_session(home)

    event = {
        "schema_version": SCHEMA_VERSION,
        "id": event_id or _new_id("ev"),
        "timestamp": now_iso(),
        "type": event_type,
        "session_id": session.get("session_id") if session else None,
        "project": session.get("project") if session else None,
        "cwd": str(Path.cwd().resolve()),
        "payload": payload or {},
    }

    path = _events_path(home)
    line = json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())
    return event


def _run_git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        timeout=3,
    )
    return result.stdout.strip()


def git_snapshot(cwd: Path | None = None) -> dict[str, Any]:
    cwd = (cwd or Path.cwd()).resolve()
    try:
        root = Path(_run_git(cwd, "rev-parse", "--show-toplevel"))
        commit = _run_git(cwd, "rev-parse", "HEAD")
        branch = _run_git(cwd, "branch", "--show-current") or "(detached)"
        porcelain = _run_git(cwd, "status", "--porcelain=v1")
        diff_stat = _run_git(cwd, "diff", "--stat", "HEAD")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return {"available": False}

    status_lines = [line for line in porcelain.splitlines() if line]
    return {
        "available": True,
        "repository": str(root),
        "commit": commit,
        "branch": branch,
        "dirty": bool(status_lines),
        "status": status_lines,
        "diff_stat": diff_stat,
    }


def start_session(home: Path, project: str, label: str | None = None) -> dict[str, Any]:
    home = ensure_home(home)
    if active_session(home):
        raise RuntimeError("A LabOS session is already active. End it before starting another.")

    state = {
        "schema_version": SCHEMA_VERSION,
        "session_id": _new_id("ses"),
        "project": project,
        "label": label,
        "started_at": now_iso(),
        "started_cwd": str(Path.cwd().resolve()),
    }
    _atomic_json_write(_state_path(home), state)
    return append_event(
        home,
        "session_start",
        {"label": label, "git": git_snapshot()},
        session=state,
    )


def add_note(home: Path, text: str) -> dict[str, Any]:
    return append_event(home, "note", {"text": text})


def checkpoint(home: Path, state: str, text: str | None = None) -> dict[str, Any]:
    if state not in {"working", "broken"}:
        raise ValueError("checkpoint state must be 'working' or 'broken'")
    session = active_session(home)
    if session is None:
        raise RuntimeError("WORKING/BROKEN checkpoints require an active session.")
    return append_event(
        home,
        "checkpoint",
        {"state": state, "text": text, "git": git_snapshot()},
        session=session,
    )


def end_session(home: Path, text: str | None = None) -> dict[str, Any]:
    session = active_session(home)
    if session is None:
        raise RuntimeError("No active LabOS session.")
    event = append_event(
        home,
        "session_end",
        {"text": text, "git": git_snapshot()},
        session=session,
    )
    _state_path(home).unlink(missing_ok=True)
    return event


def _sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def attach_artifact(
    home: Path,
    source: Path,
    *,
    kind: str = "artifact",
    copy: bool = False,
    hash_file: bool = False,
    note: str | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    source = source.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)

    event_id = _new_id("ev")
    stat = source.stat()
    payload: dict[str, Any] = {
        "kind": kind,
        "name": source.name,
        "source_path": str(source),
        "size_bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "storage": "reference",
        "note": note,
    }

    if hash_file:
        payload["sha256"] = _sha256(source)

    if copy:
        destination_dir = home / "artifacts" / event_id
        destination_dir.mkdir(parents=True, exist_ok=False)
        destination = destination_dir / source.name
        shutil.copy2(source, destination)
        payload["storage"] = "managed-copy"
        payload["managed_path"] = str(destination.relative_to(home))

    return append_event(home, "artifact", payload, event_id=event_id)


def iter_events(home: Path) -> Iterable[dict[str, Any]]:
    path = _events_path(home)
    if not path.exists():
        return []

    def _generator() -> Iterable[dict[str, Any]]:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)

    return _generator()


def recent_events(home: Path, limit: int = 20) -> list[dict[str, Any]]:
    events = list(iter_events(home))
    return events[-limit:]
