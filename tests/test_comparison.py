from __future__ import annotations

import json
from pathlib import Path

import pytest

from labos import ledger
from labos.cli import main
from labos.comparison import build_comparison, render_comparison_markdown
from labos.ledger import attach_artifact, checkpoint, end_session, read_events, start_session
from labos.logbook import capture, revise, save_setup


def _device(resource_id: str, fingerprint: str, alias: str, kind: str, x: int = 0) -> dict:
    return {"resource_id": resource_id, "fingerprint": fingerprint, "alias": alias,
            "kind": kind, "x": x, "y": 0}


def _setup(to_port: str = "ch1", *, include_scope: bool = True, x: int = 0) -> dict:
    devices = [_device("board", "fp-board", "board", "board", x)]
    if include_scope:
        devices.append(_device("scope", "fp-scope", "scope", "scope", x))
    connections = ([{"from": "board", "from_port": "out", "to": "scope", "to_port": to_port}]
                   if include_scope else [])
    return {"devices": devices, "connections": connections}


def _git_snapshot(commit: str, *, dirty: bool = False) -> dict:
    return {"available": True, "repository": "C:/lab", "commit": commit * 40,
            "branch": "main", "dirty": dirty,
            "status": [" M result.txt | edit"] if dirty else [], "diff_stat": "1 file changed" if dirty else ""}


def test_comparison_tracks_session_evidence_and_is_read_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    home = tmp_path / "labos"
    left_dir, right_dir = tmp_path / "left", tmp_path / "right"
    left_dir.mkdir()
    right_dir.mkdir()
    snapshots = iter([
        _git_snapshot("a"), _git_snapshot("b", dirty=True), _git_snapshot("c"),
        _git_snapshot("d", dirty=True), _git_snapshot("e"), _git_snapshot("f"),
        _git_snapshot("g"), _git_snapshot("h", dirty=True),
    ])
    monkeypatch.setattr(ledger, "git_snapshot", lambda cwd=None: next(snapshots))

    started_left = start_session(home, "scope-test", "before", left_dir, _setup())
    working = checkpoint(home, "working", "original")
    checkpoint(home, "broken", "failure")
    measurement_left = capture(home, kind="measurement", target="VIN", current=0.1, unit="A")
    artifact_left = tmp_path / "before.csv"
    artifact_left.write_text("x,y\n0,1\n", encoding="utf-8")
    artifact_event_left = attach_artifact(home, artifact_left)
    removed_artifact_path = tmp_path / "removed.bin"
    removed_artifact_path.write_bytes(b"temporary")
    removed_artifact = attach_artifact(home, removed_artifact_path)
    revise(home, removed_artifact["id"], {"removed": True})
    revise(home, working["id"], {"text": "corrected baseline"})
    save_setup(home, _setup("ch2", include_scope=False, x=100))
    end_session(home)

    started_right = start_session(home, "scope-test", "after", right_dir, _setup("ch2"))
    checkpoint(home, "working", "new baseline")
    capture(home, kind="measurement", target="VOUT", current=0.2, unit="A")
    artifact_right = tmp_path / "after.csv"
    artifact_right.write_text("x,y\n0,2\n", encoding="utf-8")
    artifact_event_right = attach_artifact(home, artifact_right)
    historical = checkpoint(
        home, "working", "entered later", occurred_at="2024-01-01T12:00:00-03:00",
        historical_session_id=started_left["session_id"],
    )
    end_session(home)

    before_events = read_events(home)
    comparison = build_comparison(home, started_left["session_id"], started_right["session_id"])
    assert build_comparison(home, started_left["session_id"], started_right["session_id"]) == comparison
    assert read_events(home) == before_events

    sections = comparison["comparisons"]
    assert sections["git"]["start"]["status"] == "changed"
    assert sections["git"]["start"]["before"]["event_ids"] == [started_left["id"]]
    assert sections["git"]["latest_broken"]["status"] == "unrecorded"
    assert sections["git"]["latest_working"]["before"]["event_ids"] == [working["id"]]
    assert sections["git"]["latest_working"]["before"]["state"] == "recorded"
    assert historical["session_id"] is None
    assert sections["setup"]["status"] == "changed"
    assert sections["setup"]["before"]["value"]["connections"] == []
    assert sections["resources"]["status"] == "changed"
    assert sections["checkpoints"]["status"] == "changed"
    left_checkpoint = sections["checkpoints"]["before"][0]
    assert left_checkpoint["event_id"] == working["id"]
    assert left_checkpoint["revision_ids"]
    assert left_checkpoint["value"]["text"] == "corrected baseline"
    assert sections["measurements"]["status"] == "changed"
    assert sections["measurements"]["before"][0]["event_id"] == measurement_left["id"]
    assert sections["artifacts"]["status"] == "changed"
    assert sections["artifacts"]["before"][0]["event_id"] == artifact_event_left["id"]
    assert sections["artifacts"]["after"][0]["event_id"] == artifact_event_right["id"]
    assert all(item["event_id"] != removed_artifact["id"] for item in sections["artifacts"]["before"])

    md = render_comparison_markdown(comparison)
    assert "Latest explicit setup (changed)" in md
    assert "scope:ch2" in md
    assert "unrecorded" in md
    assert "Recorded differences do not establish that one change caused another" in md

    assert main(["--home", str(home), "compare", started_left["session_id"],
                 started_right["session_id"], "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == comparison
    assert main(["--home", str(home), "compare", started_left["session_id"],
                 started_right["session_id"]]) == 0
    assert "# LabOS session comparison" in capsys.readouterr().out
    with pytest.raises(SystemExit) as exc:
        main(["--home", str(home), "compare", started_left["session_id"], started_left["session_id"]])
    assert exc.value.code == 2


def test_layout_changes_are_ignored_and_missing_git_is_not_treated_as_available(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "labos"
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    monkeypatch.setattr(ledger, "git_snapshot", lambda cwd=None: {"available": False})
    one = start_session(home, "p", "one", first, _setup(x=1))
    end_session(home)
    two = start_session(home, "p", "two", second, _setup(x=999))
    end_session(home)

    comparison = build_comparison(home, one["session_id"], two["session_id"])
    assert comparison["comparisons"]["setup"]["status"] == "same"
    assert comparison["comparisons"]["git"]["start"]["status"] == "unrecorded"
    assert comparison["comparisons"]["git"]["start"]["before"]["state"] == "unavailable"
    assert comparison["comparisons"]["git"]["latest_working"]["status"] == "unrecorded"
