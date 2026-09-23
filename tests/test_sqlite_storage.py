import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import labos.ledger as ledger
from labos.doctor import run_doctor
from labos.session_record import build_session_record


def test_reopen_and_export_are_stable(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    start = ledger.start_session(home, "tgc", "bench")
    ledger.add_note(home, "μA measurement")
    assert ledger.active_session(home)["session_id"] == start["session_id"]
    record = build_session_record(home)
    assert record["session"]["status"] == "active"
    output = ledger.export_events(home)
    first = output.read_bytes()
    assert [json.loads(line)["id"] for line in first.splitlines()] == [
        event["id"] for event in ledger.read_events(home)
    ]
    ledger.export_events(home)
    assert output.read_bytes() == first
    ledger.end_session(home)
    assert ledger.active_session(home) is None
    assert build_session_record(home)["session"]["status"] == "ended"
    assert run_doctor(home, providers=[])["core_ok"] is True


@pytest.mark.parametrize("boundary", ["before_event", "after_event"])
@pytest.mark.parametrize("action", ["start", "end"])
def test_session_transaction_rolls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                        boundary: str, action: str) -> None:
    home = tmp_path / "labos"
    if action == "end":
        ledger.start_session(home, "tgc")
    before = ledger.read_events(home)
    original = ledger._append_event_db

    def fail(db, event_type, *args, **kwargs):
        if event_type == f"session_{action}" and boundary == "before_event":
            raise RuntimeError("injected insertion failure")
        event = original(db, event_type, *args, **kwargs)
        if event_type == f"session_{action}" and boundary == "after_event":
            raise RuntimeError("injected pre-commit failure")
        return event

    monkeypatch.setattr(ledger, "_append_event_db", fail)
    with pytest.raises(RuntimeError, match="injected"):
        if action == "start":
            ledger.start_session(home, "tgc")
        else:
            ledger.end_session(home)
    assert ledger.read_events(home) == before
    assert (ledger.active_session(home) is not None) == (action == "end")
    assert run_doctor(home, providers=[])["core_ok"] is True


def _legacy_event(event_id: str, kind: str, session_id: str | None) -> dict:
    return {"schema_version": 1, "id": event_id, "timestamp": "2026-01-01T10:00:00+00:00",
            "type": kind, "session_id": session_id,
            "project": "tgc" if session_id else None, "cwd": "/work",
            "payload": {"label": "bench"} if kind == "session_start" else {"text": "hello"}}


def test_valid_legacy_import_once_preserves_original(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    home.mkdir()
    events = [_legacy_event("ev_start", "session_start", "ses_1"),
              _legacy_event("ev_note", "note", "ses_1")]
    legacy = home / "events.jsonl"
    original = "".join(json.dumps(e) + "\n" for e in events).encode()
    legacy.write_bytes(original)
    (home / ".active-session.json").write_text(json.dumps({"session_id": "ses_1"}))
    assert ledger.read_events(home) == events
    assert ledger.active_session(home)["session_id"] == "ses_1"
    ledger.add_note(home, "new")
    assert [e["id"] for e in ledger.read_events(home)[:2]] == ["ev_start", "ev_note"]
    assert len(ledger.read_events(home)) == 3
    assert legacy.read_bytes() == original
    assert len(ledger.export_events(home).read_text().splitlines()) == 3
    # Once imported, old JSONL is never consulted as an operational store.
    legacy.write_bytes(original + b"broken historical copy\n")
    assert len(ledger.read_events(home)) == 3


def test_export_will_not_replace_legacy_evidence(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    ledger.add_note(home, "measurement")
    legacy = home / "events.jsonl"
    legacy.write_bytes(b"preserve this\n")
    with pytest.raises(ValueError, match="must not replace"):
        ledger.export_events(home, legacy)
    assert legacy.read_bytes() == b"preserve this\n"


@pytest.mark.parametrize("bad", ['{"id":', json.dumps({"type": "note"})])
def test_invalid_legacy_refuses_import(tmp_path: Path, bad: str) -> None:
    home = tmp_path / "labos"
    home.mkdir()
    legacy = home / "events.jsonl"
    legacy.write_text(bad + "\n")
    with pytest.raises(RuntimeError, match="Invalid legacy events.jsonl line 1"):
        ledger.add_note(home, "cannot write")
    assert legacy.read_text() == bad + "\n"
    assert run_doctor(home, providers=[])["core_ok"] is False


def test_contradictory_legacy_state_refuses_import(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    home.mkdir()
    (home / "events.jsonl").write_text(json.dumps(_legacy_event("a", "session_start", "ses_1")) + "\n")
    (home / ".active-session.json").write_text(json.dumps({"session_id": "ses_else"}))
    with pytest.raises(RuntimeError, match="contradicts"):
        ledger.read_events(home)


def test_database_guards_events_and_active_session(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    ledger.start_session(home, "a")
    with sqlite3.connect(home / "labos.db") as db:
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO sessions VALUES ('second','b',NULL,'now',NULL,'/work')")
        db.rollback()
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            db.execute("DELETE FROM events")
    assert run_doctor(home, providers=[])["core_ok"] is True


@pytest.mark.parametrize("action", ["start", "end"])
def test_process_exit_before_commit_rolls_back(tmp_path: Path, action: str) -> None:
    home = tmp_path / "labos"
    if action == "end":
        ledger.start_session(home, "tgc")
    before = ledger.read_events(home)
    program = """
import os, sys
from pathlib import Path
import labos.ledger as ledger

original = ledger._append_event_db
def crash(db, kind, *args, **kwargs):
    result = original(db, kind, *args, **kwargs)
    if kind == 'session_' + sys.argv[2]:
        os._exit(42)
    return result
ledger._append_event_db = crash
if sys.argv[2] == 'start':
    ledger.start_session(Path(sys.argv[1]), 'tgc')
else:
    ledger.end_session(Path(sys.argv[1]))
"""
    result = subprocess.run([sys.executable, "-c", program, str(home), action],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 42, result.stderr
    assert ledger.read_events(home) == before
    assert (ledger.active_session(home) is not None) == (action == "end")
    assert run_doctor(home, providers=[])["core_ok"] is True


def test_doctor_detects_manual_session_event_mismatch(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    ledger.start_session(home, "tgc")
    with sqlite3.connect(home / "labos.db") as db:
        db.execute("UPDATE sessions SET ended_at='now' WHERE ended_at IS NULL")
    checks = {item["id"]: item for item in run_doctor(home, providers=[])["checks"]}
    assert checks["session_invariants"]["ok"] is False
