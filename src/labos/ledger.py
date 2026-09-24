from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 1
CANONICAL_EVENT_FIELDS = frozenset({
    "schema_version", "id", "timestamp", "type", "session_id", "project", "cwd", "payload"
})


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


def _database_path(home: Path) -> Path:
    return ensure_home(home) / "labos.db"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _atomic_json_write(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _validate_legacy(home: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Read all old evidence before the first import; never infer missing transitions."""
    events: list[dict[str, Any]] = []
    sessions: dict[str, dict[str, Any]] = {}
    path = home / "events.jsonl"
    if path.exists():
        with path.open("r", encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                    if (not isinstance(event, dict) or
                        not CANONICAL_EVENT_FIELDS.issubset(event) or
                        not isinstance(event.get("id"), str) or not event["id"] or
                        not isinstance(event.get("timestamp"), str) or
                        not isinstance(event.get("type"), str) or
                        not isinstance(event.get("cwd"), str) or
                        not isinstance(event.get("payload"), dict) or
                        type(event.get("schema_version")) is not int or
                        event["schema_version"] != SCHEMA_VERSION or
                        (event.get("project") is not None and
                         not isinstance(event["project"], str)) or
                        (event.get("session_id") is not None and
                         not isinstance(event["session_id"], str))):
                        raise ValueError("invalid event shape or version")
                    sid = event.get("session_id")
                    if event["type"] == "session_start":
                        if not sid or sid in sessions or any(s["ended_at"] is None for s in sessions.values()):
                            raise ValueError("duplicate or overlapping session start")
                        if not isinstance(event.get("project"), str):
                            raise ValueError("session start has no project")
                        sessions[sid] = {
                            "session_id": sid, "project": event["project"],
                            "label": event["payload"].get("label"),
                            "started_at": event["timestamp"], "ended_at": None,
                            "started_cwd": event["cwd"],
                        }
                    elif sid:
                        session = sessions.get(sid)
                        if session is None or session["ended_at"] is not None:
                            raise ValueError("event refers to a missing or ended session")
                        if event.get("project") != session["project"] or event["cwd"] != session["started_cwd"]:
                            raise ValueError("session context differs from its start")
                        if event["type"] == "session_end":
                            session["ended_at"] = event["timestamp"]
                    elif event["type"] == "session_end":
                        raise ValueError("session end has no session ID")
                    events.append(event)
                except (ValueError, KeyError, TypeError) as exc:
                    raise RuntimeError(f"Invalid legacy events.jsonl line {number}: {exc}") from exc
    if len({e["id"] for e in events}) != len(events):
        raise RuntimeError("Invalid legacy events.jsonl: duplicate event IDs")
    state_path = home / ".active-session.json"
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if not isinstance(state, dict) or not isinstance(state.get("session_id"), str):
                raise ValueError("invalid active-session state")
            active = next((s for s in sessions.values() if s["ended_at"] is None), None)
            if active is None or active["session_id"] != state["session_id"]:
                raise ValueError("active-session state contradicts event history")
        except (ValueError, TypeError) as exc:
            raise RuntimeError(f"Invalid legacy .active-session.json: {exc}") from exc
    return events, sessions


def _event_row(event: dict[str, Any]) -> tuple[Any, ...]:
    extra = {key: value for key, value in event.items() if key not in CANONICAL_EVENT_FIELDS}
    return (event["id"], event["timestamp"], event["type"],
            event.get("session_id"), event.get("project"), event["cwd"],
            json.dumps(event["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=False),
            event["schema_version"],
            json.dumps(extra, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def _insert_event(db: sqlite3.Connection, event: dict[str, Any]) -> None:
    db.execute("INSERT INTO events (id,timestamp,type,session_id,project,cwd,payload_json,schema_version,extra_json) VALUES (?,?,?,?,?,?,?,?,?)", _event_row(event))


@contextmanager
def _db(home: Path) -> Iterator[sqlite3.Connection]:
    home = ensure_home(home)
    db = sqlite3.connect(_database_path(home), timeout=5, isolation_level=None)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA foreign_keys=ON")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version == 0:
            # Journal mode is persistent. Only an uninitialized database may switch to WAL.
            if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
                if db.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
                    raise RuntimeError("SQLite WAL is unavailable for this LabOS directory")
            db.execute("BEGIN IMMEDIATE")
            try:
                # Another process may have completed initialization while we waited.
                version = db.execute("PRAGMA user_version").fetchone()[0]
                if version == 0:
                    _initialize(db, home)
                elif version != 1:
                    raise RuntimeError(f"Unsupported LabOS database schema version: {version}")
                db.commit()
            except BaseException:
                db.rollback()
                raise
        elif version != 1:
            raise RuntimeError(f"Unsupported LabOS database schema version: {version}")
        elif db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
            raise RuntimeError("LabOS database is not in WAL mode; refusing to write")
        yield db
    finally:
        db.close()


def _initialize(db: sqlite3.Connection, home: Path) -> None:
    if db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").fetchone():
        raise RuntimeError("Unversioned LabOS database; refusing to change it")
    events, sessions = _validate_legacy(home)
    # execute() keeps schema creation and legacy import in one transaction.
    for statement in ("""CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY, project TEXT NOT NULL,
            label TEXT, started_at TEXT NOT NULL, ended_at TEXT,
            started_cwd TEXT NOT NULL
        )""",
        "CREATE UNIQUE INDEX one_active_session ON sessions((1)) WHERE ended_at IS NULL",
        """CREATE TABLE events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL,
            type TEXT NOT NULL, session_id TEXT REFERENCES sessions(session_id),
            project TEXT, cwd TEXT NOT NULL, payload_json TEXT NOT NULL,
            schema_version INTEGER NOT NULL, extra_json TEXT NOT NULL
        )""",
        """CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events
            BEGIN SELECT RAISE(ABORT, 'events are append-only'); END""",
        """CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events
            BEGIN SELECT RAISE(ABORT, 'events are append-only'); END"""):
        db.execute(statement)
    for session in sessions.values():
        db.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?)", tuple(session[k] for k in
                   ("session_id", "project", "label", "started_at", "ended_at", "started_cwd")))
    for event in events:
        _insert_event(db, event)
    db.execute("PRAGMA user_version=1")

@contextmanager
def _transaction(home: Path) -> Iterator[sqlite3.Connection]:
    with _db(home) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise


def _active_session_db(db: sqlite3.Connection) -> dict[str, Any] | None:
    row = db.execute("SELECT * FROM sessions WHERE ended_at IS NULL").fetchone()
    return {"schema_version": SCHEMA_VERSION, **dict(row)} if row else None


def active_session(home: Path) -> dict[str, Any] | None:
    with _db(home) as db:
        return _active_session_db(db)


def _session_workdir(session: dict[str, Any]) -> Path:
    stored = session.get("started_cwd")
    if isinstance(stored, str) and stored:
        return Path(stored).expanduser().resolve()
    return Path.cwd().resolve()


def _append_event_db(
    db: sqlite3.Connection,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    event_id: str | None = None,
    session: dict[str, Any] | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    if session is None:
        session = _active_session_db(db)
    elif session.get("session_id"):
        current = _active_session_db(db)
        if current is None or current["session_id"] != session["session_id"]:
            raise RuntimeError("Session is no longer active")
        session = current

    event_cwd = _session_workdir(session) if session else Path.cwd().resolve()
    event = {
        "schema_version": SCHEMA_VERSION,
        "id": event_id or _new_id("ev"),
        "timestamp": timestamp or now_iso(),
        "type": event_type,
        "session_id": session.get("session_id") if session else None,
        "project": session.get("project") if session else None,
        "cwd": str(event_cwd),
        "payload": payload or {},
    }

    _insert_event(db, event)
    return event


def append_event(
    home: Path,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    event_id: str | None = None,
    session: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if event_type in {"session_start", "session_end"}:
        raise ValueError("Use start_session/end_session for lifecycle events")
    with _transaction(home) as db:
        return _append_event_db(
            db,
            event_type,
            payload,
            event_id=event_id,
            session=session,
        )


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


def start_session(
    home: Path,
    project: str,
    label: str | None = None,
    workdir: Path | None = None,
) -> dict[str, Any]:
    home = ensure_home(home)
    session_workdir = (workdir or Path.cwd()).expanduser().resolve()
    if not session_workdir.is_dir():
        raise FileNotFoundError(f"LabOS work directory does not exist: {session_workdir}")

    snapshot = git_snapshot(session_workdir)
    with _transaction(home) as db:
        if _active_session_db(db):
            raise RuntimeError(
                "A LabOS session is already active. End it before starting another."
            )

        state = {
            "schema_version": SCHEMA_VERSION,
            "session_id": _new_id("ses"),
            "project": project,
            "label": label,
            "started_at": now_iso(),
            "started_cwd": str(session_workdir),
        }
        db.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?)", (
            state["session_id"], project, label, state["started_at"], None, state["started_cwd"]
        ))
        return _append_event_db(db, "session_start", {"label": label, "git": snapshot},
                                session=state, timestamp=state["started_at"])


def add_note(home: Path, text: str) -> dict[str, Any]:
    return append_event(home, "note", {"text": text})


def checkpoint(home: Path, state: str, text: str | None = None) -> dict[str, Any]:
    if state not in {"working", "broken"}:
        raise ValueError("checkpoint state must be 'working' or 'broken'")
    session = active_session(home)
    if session is None:
        raise RuntimeError("WORKING/BROKEN checkpoints require an active session.")
    snapshot = git_snapshot(_session_workdir(session))
    with _transaction(home) as db:
        if _active_session_db(db) != session:
            raise RuntimeError("Active session changed while capturing Git; retry checkpoint")
        return _append_event_db(
            db,
            "checkpoint",
            {
                "state": state,
                "text": text,
                "git": snapshot,
            },
            session=session,
        )


def end_session(home: Path, text: str | None = None) -> dict[str, Any]:
    session = active_session(home)
    if session is None:
        raise RuntimeError("No active LabOS session.")
    snapshot = git_snapshot(_session_workdir(session))
    with _transaction(home) as db:
        if _active_session_db(db) != session:
            raise RuntimeError("Active session changed while capturing Git; retry end")
        event = _append_event_db(
            db,
            "session_end",
            {"text": text, "git": snapshot},
            session=session,
        )
        db.execute("UPDATE sessions SET ended_at=? WHERE session_id=? AND ended_at IS NULL", (
            event["timestamp"], session["session_id"]
        ))
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

    with _transaction(home) as db:
        return _append_event_db(
            db,
            "artifact",
            payload,
            event_id=event_id,
        )


def _decode_event(row: sqlite3.Row) -> dict[str, Any]:
    extra = json.loads(row["extra_json"])
    if not isinstance(extra, dict):
        raise RuntimeError("Invalid LabOS event extras in database")
    return {**extra, "id": row["id"], "timestamp": row["timestamp"], "type": row["type"],
            "session_id": row["session_id"], "project": row["project"],
            "cwd": row["cwd"], "payload": json.loads(row["payload_json"]),
            "schema_version": row["schema_version"]}


def _read_events_db(db: sqlite3.Connection) -> list[dict[str, Any]]:
    return [_decode_event(row) for row in db.execute("SELECT * FROM events ORDER BY sequence")]


def read_events(home: Path) -> list[dict[str, Any]]:
    with _db(home) as db:
        return _read_events_db(db)


def iter_events(home: Path) -> Iterable[dict[str, Any]]:
    return iter(read_events(home))


def recent_events(home: Path, limit: int = 20) -> list[dict[str, Any]]:
    if limit < 1:
        return []
    with _db(home) as db:
        rows = db.execute("SELECT * FROM events ORDER BY sequence DESC LIMIT ?", (limit,)).fetchall()
        return [_decode_event(row) for row in reversed(rows)]


def export_events(home: Path, path: Path | None = None) -> Path:
    home = ensure_home(home)
    default_output = home / "exports" / "events.jsonl"
    output = (path or default_output).expanduser().resolve()
    if output in (home / "events.jsonl", home / "labos.db",
                  home / "resources.json", home / "device_knowledge.json",
                  home / ".active-session.json"):
        raise ValueError("Export path must not replace LabOS evidence or state")
    if output.exists() and output != default_output:
        raise ValueError(f"Export destination already exists: {output}")
    events = read_events(home)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(f"{output.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as handle:
            for event in events:
                handle.write(json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, output)
    finally:
        temp.unlink(missing_ok=True)
    return output
