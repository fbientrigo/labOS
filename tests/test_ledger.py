import json
import subprocess
from pathlib import Path

import pytest

from labos.ledger import (
    active_session,
    add_note,
    attach_artifact,
    checkpoint,
    end_session,
    export_events,
    recent_events,
    start_session,
)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )


def test_session_flow_is_append_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    work = tmp_path / "work"
    work.mkdir()
    home = tmp_path / "labos"
    monkeypatch.chdir(work)

    start = start_session(home, "tgc", "zynq debugging")
    note = add_note(home, "DMA works")
    good = checkpoint(home, "working", "baseline")
    bad = checkpoint(home, "broken", "dies after ~70 s")
    end = end_session(home, "stop for today")

    events = recent_events(home, 20)
    assert [event["type"] for event in events] == [
        "session_start",
        "note",
        "checkpoint",
        "checkpoint",
        "session_end",
    ]
    assert {event["session_id"] for event in events} == {start["session_id"]}
    assert note["payload"]["text"] == "DMA works"
    assert good["payload"]["state"] == "working"
    assert bad["payload"]["state"] == "broken"
    assert end["payload"]["text"] == "stop for today"
    assert active_session(home) is None

    assert (home / "labos.db").is_file()
    assert not (home / "events.jsonl").exists()
    raw_lines = export_events(home).read_text(encoding="utf-8").splitlines()
    assert len(raw_lines) == 5
    assert all(json.loads(line)["schema_version"] == 1 for line in raw_lines)


def test_session_workdir_anchors_git_snapshots(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "labos@example.invalid")
    _git(repo, "config", "user.name", "LabOS Test")
    tracked = repo / "firmware.txt"
    tracked.write_text("known-good\n", encoding="utf-8")
    _git(repo, "add", "firmware.txt")
    _git(repo, "commit", "-m", "baseline")

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    home = tmp_path / "labos"
    start = start_session(home, "tgc", workdir=repo)
    assert start["cwd"] == str(repo.resolve())
    assert start["payload"]["git"]["available"] is True
    assert Path(start["payload"]["git"]["repository"]).resolve() == repo.resolve()

    tracked.write_text("changed\n", encoding="utf-8")
    good = checkpoint(home, "working")
    assert good["cwd"] == str(repo.resolve())
    assert good["payload"]["git"]["dirty"] is True
    assert Path(good["payload"]["git"]["repository"]).resolve() == repo.resolve()

    end = end_session(home)
    assert end["cwd"] == str(repo.resolve())
    assert Path(end["payload"]["git"]["repository"]).resolve() == repo.resolve()


def test_note_can_exist_without_active_session(tmp_path: Path) -> None:
    event = add_note(tmp_path / "labos", "unscoped observation")
    assert event["session_id"] is None
    assert event["project"] is None


def test_artifact_reference_does_not_copy_by_default(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    source = tmp_path / "scope.csv"
    source.write_text("t,v\n0,1\n", encoding="utf-8")

    event = attach_artifact(home, source)

    assert event["payload"]["storage"] == "reference"
    assert event["payload"]["source_path"] == str(source.resolve())
    assert list((home / "artifacts").iterdir()) == []


def test_artifact_managed_copy_and_hash(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    source = tmp_path / "scope.png"
    source.write_bytes(b"not-really-a-png")

    event = attach_artifact(home, source, kind="photo", copy=True, hash_file=True)
    managed = home / event["payload"]["managed_path"]

    assert managed.read_bytes() == source.read_bytes()
    assert event["payload"]["kind"] == "photo"
    assert len(event["payload"]["sha256"]) == 64


def test_cannot_start_two_sessions(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    start_session(home, "tgc")
    with pytest.raises(RuntimeError, match="already active"):
        start_session(home, "charm")
