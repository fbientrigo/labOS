from datetime import datetime
from pathlib import Path
import re

import pytest

from labos.ledger import active_session, end_session, read_events, start_session
from labos.ledger import checkpoint
from labos.logbook import (
    bulk_retag,
    capture,
    effective_entries,
    current_setup,
    record_asset_rename,
    render_daily_markdown,
    revise,
    save_setup,
    set_tag,
    update_markdown_log,
    write_daily_markdown,
)


def _device(rid: str, alias: str) -> dict:
    return {"resource_id": rid, "fingerprint": "fp-" + rid, "alias": alias,
            "kind": "cable", "activation": "unknown", "x": 10, "y": 20}


@pytest.mark.parametrize("invalid", ["activation", "layout", "port"])
def test_start_and_setup_edits_share_validation_without_saving_invalid_evidence(tmp_path: Path, invalid: str) -> None:
    home = tmp_path / "home"
    setup = {"devices": [_device("a", "A"), _device("b", "B")],
             "connections": [{"from": "a", "to": "b", "from_port": "J1"}]}
    if invalid == "activation":
        setup["devices"][0]["activation"] = "invalid"
    elif invalid == "layout":
        setup["devices"][0]["x"] = float("inf")
    else:
        setup["connections"][0]["from_port"] = 42
    with pytest.raises(ValueError):
        start_session(home, "bench", setup=setup)
    assert active_session(home) is None
    assert read_events(home) == []
    start_session(home, "bench")
    before = read_events(home)
    with pytest.raises(ValueError):
        save_setup(home, setup)
    assert read_events(home) == before


def test_setup_snapshots_are_atomic_and_measurements_keep_explicit_context(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    before = len(read_events(home))
    with pytest.raises(ValueError, match="endpoint"):
        save_setup(home, {"devices": [_device("a", "A")], "connections": [{"from": "a", "to": "missing"}]})
    assert len(read_events(home)) == before

    setup = {"devices": [_device("a", "A"), _device("b", "B")],
             "connections": [{"from": "a", "to": "b", "from_port": "J1", "to_port": "P2"}]}
    save_setup(home, setup)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    measured = capture(home, kind="measurement", current=0.025, unit="A", voltage=3.3,
                       target="rail +3V3", occurred_at=now)
    assert measured["payload"]["setup"] is None
    assert measured["session_id"] is None
    assert measured["payload"]["current"] == 0.025
    with pytest.raises(ValueError, match="non-negative"):
        capture(home, kind="measurement", current=-1, unit="mA")
    measured = capture(home, kind="measurement", current=0.1, unit="A")
    with pytest.raises(ValueError, match="finite non-negative"):
        revise(home, measured["id"], {"current": float("nan")})


def test_revisions_fold_tombstones_tags_and_day_queries(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    note = capture(home, kind="note", text="first", occurred_at=now, tag="bringup")
    revise(home, note["id"], {"text": "second"})
    revise(home, note["id"], {"tag": "scope"})
    day = now[:10]
    entries = effective_entries(home, day=day, tag="scope")
    assert len(entries) == 1
    assert entries[0]["effective_payload"]["text"] == "second"
    set_tag(home, day, "scope", "#12abEF")
    assert bulk_retag(home, day=day, old_tag="scope", new_tag="reviewed")
    assert effective_entries(home, day=day, tag="reviewed")[0]["effective_payload"]["text"] == "second"
    revise(home, note["id"], {"removed": True})
    assert effective_entries(home, day=day) == []


def test_day_pagination_returns_newest_first_then_older(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    capture(home, kind="note", text="older", occurred_at="2026-10-03T09:00:00-03:00")
    capture(home, kind="note", text="newer", occurred_at="2026-10-03T10:00:00-03:00")
    first = effective_entries(home, day="2026-10-03", offset=0, limit=1)
    second = effective_entries(home, day="2026-10-03", offset=1, limit=1)
    assert first[0]["effective_payload"]["text"] == "newer"
    assert second[0]["effective_payload"]["text"] == "older"


def test_past_capture_has_explicit_session_metadata_and_session_record(tmp_path: Path) -> None:
    from labos.session_record import build_session_record

    home = tmp_path / "home"
    started = start_session(home, "old")
    sid = started["session_id"]
    end_session(home)
    entry = capture(home, kind="note", text="historical", occurred_at="2020-02-03T12:00:00-03:00", session_id=sid)
    assert entry["session_id"] is None
    assert entry["payload"]["historical_session_id"] == sid
    assert entry["payload"]["setup"] is None
    record = build_session_record(home, sid)
    assert any(item["event_id"] == entry["id"] for item in record["effective_entries"])


def test_checkpoint_retains_git_snapshot_and_adds_context_metadata(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench", workdir=tmp_path)
    setup = {"devices": [_device("d1", "DUT")], "connections": []}
    save_setup(home, setup)
    entry = checkpoint(home, "broken", "brownout", tag="power", occurred_at="2026-10-03T11:30:00-03:00",
                       links=[{"title": "scope.png", "path": "assets/scope.png", "kind": "image"}], setup=setup)
    assert entry["payload"]["state"] == "broken"
    assert "git" in entry["payload"]
    assert entry["payload"]["tag"] == "power"
    assert entry["payload"]["setup"] == setup
    assert entry["payload"]["links"][0]["kind"] == "image"

    ordinary = checkpoint(home, "working", "restored")
    assert isinstance(ordinary["payload"]["occurred_at"], str)
    datetime.fromisoformat(ordinary["payload"]["occurred_at"])
    day = ordinary["payload"]["occurred_at"][:10]
    log_path = tmp_path / "vault" / "LabOS" / "Logs" / (day + ".md")
    write_daily_markdown(home, day, log_path)
    assert "### " + ordinary["payload"]["occurred_at"] + " · checkpoint" in log_path.read_text(encoding="utf-8")
    assert update_markdown_log(home, log_path, apply=True)["status"] == "no_op"


def test_daily_markdown_roundtrip_preserves_user_text_and_retry_is_idempotent(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    entry = capture(home, kind="note", text="original words", occurred_at=now)
    path = tmp_path / "vault" / "LabOS" / "Logs" / (now[:10] + ".md")
    path.parent.mkdir(parents=True)
    path.write_text("My heading\n\n" + render_daily_markdown(home, now[:10]) + "\nKeep this footer\n", encoding="utf-8")
    write_daily_markdown(home, now[:10], path)
    text = path.read_text(encoding="utf-8").replace("original words", "corrected words")
    path.write_text(text, encoding="utf-8")
    preview = update_markdown_log(home, path)
    assert preview["changed"] == [entry["id"]]
    result = update_markdown_log(home, path, apply=True)
    count = len(read_events(home))
    assert result["status"] == "updated"
    assert "My heading" in path.read_text(encoding="utf-8")
    assert "Keep this footer" in path.read_text(encoding="utf-8")
    retry = update_markdown_log(home, path, apply=True)
    assert retry["status"] == "no_op"
    assert len(read_events(home)) == count


def test_markdown_removals_require_confirmation_and_markers_must_be_unique(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    entry = capture(home, kind="note", text="remove me", occurred_at=now)
    path = tmp_path / "daily.md"
    write_daily_markdown(home, now[:10], path)
    text = path.read_text(encoding="utf-8")
    block = re.compile(r"<!-- labos-entry:" + re.escape(entry["id"]) + r" -->.*?(?=<!-- LabOS entries end -->)", re.S)
    path.write_text(block.sub("", text), encoding="utf-8")
    preview = update_markdown_log(home, path)
    assert preview["removed"] == [entry["id"]]
    assert update_markdown_log(home, path, apply=True)["status"] == "confirmation_required"
    update_markdown_log(home, path, apply=True, remove_ids={entry["id"]})
    assert effective_entries(home, day=now[:10]) == []
    path.write_text(path.read_text(encoding="utf-8") + "<!-- LabOS entries begin -->", encoding="utf-8")
    with pytest.raises(ValueError, match="markers"):
        update_markdown_log(home, path)


def test_markdown_retry_repairs_failed_write_and_multiline_note_headings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import labos.logbook as logbook

    home = tmp_path / "home"
    start_session(home, "bench")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    entry = capture(home, kind="note", text="first paragraph\n\n### Subheading\n\nsecond paragraph", occurred_at=now)
    path = tmp_path / "daily.md"
    write_daily_markdown(home, now[:10], path)
    original_write = logbook._atomic_markdown_write
    failed = False

    def fail_once(target: Path, content: str) -> None:
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("simulated disk full")
        original_write(target, content)

    monkeypatch.setattr(logbook, "_atomic_markdown_write", fail_once)
    path.write_text(path.read_text(encoding="utf-8").replace("second paragraph", "corrected second paragraph"), encoding="utf-8")
    with pytest.raises(OSError, match="disk full"):
        update_markdown_log(home, path, apply=True)
    revision_count = sum(event["type"] == "entry_revision" for event in read_events(home))
    retry = update_markdown_log(home, path, apply=True)
    assert retry["status"] == "no_op"
    assert sum(event["type"] == "entry_revision" for event in read_events(home)) == revision_count == 1
    assert "corrected second paragraph" in path.read_text(encoding="utf-8")
    assert "<!-- labos-entry-end:" + entry["id"] + " -->" in path.read_text(encoding="utf-8")
    effective = effective_entries(home, day=now[:10])[0]["effective_payload"]
    assert effective["text"] == "first paragraph\n\n### Subheading\n\ncorrected second paragraph"


def test_markdown_allows_successive_edits_but_detects_concurrent_revision(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    entry = capture(home, kind="note", text="original", occurred_at=now)
    path = tmp_path / "daily.md"
    write_daily_markdown(home, now[:10], path)

    path.write_text(path.read_text(encoding="utf-8").replace("original", "first correction"), encoding="utf-8")
    assert update_markdown_log(home, path, apply=True)["status"] == "updated"
    path.write_text(path.read_text(encoding="utf-8").replace("first correction", "second correction"), encoding="utf-8")
    assert update_markdown_log(home, path, apply=True)["status"] == "updated"

    path.write_text(path.read_text(encoding="utf-8").replace("second correction", "Markdown version"), encoding="utf-8")
    revise(home, entry["id"], {"text": "LabOS version"})
    with pytest.raises(ValueError, match="conflicts with a newer"):
        update_markdown_log(home, path, apply=True)


def test_start_uses_explicit_setup_atomically_and_defaults_to_empty(tmp_path: Path) -> None:
    home = tmp_path / "home"
    cable = _device("cable-1", "JTAG cable")
    setup = {
        "devices": [cable, _device("som-1", "SoM"), _device("carrier-1", "Carrier"), _device("pc-1", "PC"), _device("scope-1", "Scope")],
        "connections": [
            {"id": "edge-1", "from": "som-1", "to": "carrier-1", "from_port": "J1", "to_port": "U1"},
            {"id": "edge-2", "from": "carrier-1", "to": "cable-1", "from_port": "JTAG", "to_port": "20-pin"},
            {"id": "edge-3", "from": "cable-1", "to": "pc-1", "from_port": "USB", "to_port": "USB-A"},
            {"id": "edge-4", "from": "carrier-1", "to": "scope-1", "from_port": "TP3", "to_port": "CH1"},
        ],
    }
    started = start_session(home, "bringup", setup=setup)
    history = [event for event in read_events(home) if event["session_id"] == started["session_id"]]
    assert [event["type"] for event in history[:2]] == ["session_start", "setup_snapshot"]
    assert current_setup(home) == setup

    first = capture(home, kind="note", text="wired", occurred_at="2026-10-03T10:00:00-03:00", setup=setup)
    changed = {**cable, "alias": "replacement cable", "activation": "active"}
    replacement = {
        "devices": [changed if device["resource_id"] == cable["resource_id"] else device
                    for device in setup["devices"] if device["alias"] != "Scope"],
        "connections": setup["connections"][:-1],
    }
    save_setup(home, replacement)
    second = capture(home, kind="note", text="swapped", occurred_at="2026-10-03T11:00:00-03:00", setup=replacement)
    events = read_events(home)
    assert next(event for event in events if event["id"] == first["id"])["payload"]["setup"] == setup
    assert next(event for event in events if event["id"] == second["id"])["payload"]["setup"] == replacement
    end_session(home)

    start_session(home, "next run")
    assert current_setup(home) == {"devices": [], "connections": []}


def test_referenced_asset_renames_only_and_daily_log_title_edits(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    entry = capture(home, kind="note", text="scope trace", occurred_at="2020-02-03T10:00:00-03:00",
                    links=[{"title": "trace.png", "path": "Images/trace.png", "kind": "image"}])
    ignored = record_asset_rename(home, "unreferenced.md", "renamed.md")
    assert ignored["recorded"] is False
    rename = record_asset_rename(home, "Images/trace.png", "Images/trace-2.png")
    assert rename["recorded"] is True
    chained = record_asset_rename(home, "Images/trace-2.png", "Archive/trace.png")
    assert chained["recorded"] is True

    path = tmp_path / "renamed daily title.md"
    write_daily_markdown(home, "2020-02-03", path)
    path.write_text(path.read_text(encoding="utf-8").replace("# LabOS Log · 2020-02-03", "# My edited title"), encoding="utf-8")
    path.write_text(path.read_text(encoding="utf-8").replace("scope trace", "edited observation"), encoding="utf-8")
    result = update_markdown_log(home, path, apply=True)
    assert result["status"] == "updated"
    assert effective_entries(home, day="2020-02-03")[0]["effective_payload"]["text"] == "edited observation"
    assert entry["id"] in path.read_text(encoding="utf-8")

    no_date = tmp_path / "missing date.md"
    no_date.write_text(path.read_text(encoding="utf-8").replace("<!-- labos-log-date:2020-02-03 -->\n", ""), encoding="utf-8")
    with pytest.raises(ValueError, match="exactly one immutable"):
        update_markdown_log(home, no_date)

    altered_date = tmp_path / "altered date.md"
    altered_date.write_text(path.read_text(encoding="utf-8").replace("labos-log-date:2020-02-03", "labos-log-date:2026-10-03"), encoding="utf-8")
    with pytest.raises(ValueError, match="does not match its baseline"):
        update_markdown_log(home, altered_date)
    duplicate_date = tmp_path / "duplicate date.md"
    duplicate_date.write_text(path.read_text(encoding="utf-8").replace("<!-- LabOS entries begin -->", "<!-- labos-log-date:2020-02-03 -->\n<!-- LabOS entries begin -->"), encoding="utf-8")
    with pytest.raises(ValueError, match="exactly one immutable"):
        update_markdown_log(home, duplicate_date)


def test_day_search_and_pagination_are_not_limited_to_recent_events(tmp_path: Path) -> None:
    home = tmp_path / "home"
    start_session(home, "bench")
    for index in range(125):
        capture(home, kind="note", text=f"observation {index}", occurred_at=f"2026-10-03T10:{index // 60:02d}:{index % 60:02d}-03:00")
    page = effective_entries(home, day="2026-10-03", offset=100, limit=25)
    assert len(page) == 25
    assert effective_entries(home, day="2026-10-03", query="observation 0", offset=0, limit=200)


def test_sessionless_historical_capture_retains_local_occurrence_and_revision(tmp_path: Path) -> None:
    home = tmp_path / "home"
    entry = capture(home, kind="note", text="lab note", occurred_at="2026-04-05T01:30:00-03:00")
    assert entry["session_id"] is None
    revise(home, entry["id"], {"text": "corrected note"})
    assert effective_entries(home, day="2026-04-05")[0]["effective_payload"]["text"] == "corrected note"


def test_plain_markdown_observation_inside_managed_block_is_preserved(tmp_path: Path) -> None:
    home = tmp_path / "home"
    path = tmp_path / "daily.md"
    write_daily_markdown(home, "2020-02-03", path)
    text = path.read_text(encoding="utf-8").replace(
        "<!-- LabOS entries begin -->", "<!-- LabOS entries begin -->\n\nPlain observation without a heading."
    )
    path.write_text(text, encoding="utf-8")
    assert update_markdown_log(home, path)["new"][0]["text"] == "Plain observation without a heading."
    update_markdown_log(home, path, apply=True)
    assert "Plain observation without a heading." in path.read_text(encoding="utf-8")
    assert len(effective_entries(home, day="2020-02-03")) == 1
    assert update_markdown_log(home, path, apply=True)["status"] == "no_op"


def test_daily_log_identity_is_consistent_during_concurrent_creation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from concurrent.futures import ThreadPoolExecutor
    import time
    import labos.logbook as logbook

    original_uuid = logbook.uuid.uuid4

    def slow_uuid():
        time.sleep(0.02)
        return original_uuid()

    monkeypatch.setattr(logbook.uuid, "uuid4", slow_uuid)
    with ThreadPoolExecutor(max_workers=8) as workers:
        identities = list(workers.map(lambda _: logbook.daily_log_id(tmp_path / "home", "2020-02-03"), range(8)))
    assert len(set(identities)) == 1
    assert re.fullmatch(r"[a-f0-9]{32}", identities[0])


def test_historical_checkpoint_does_not_join_the_save_time_session(tmp_path: Path) -> None:
    from labos.session_record import build_session_record

    home = tmp_path / "home"
    historical = start_session(home, "past")
    end_session(home)
    current = start_session(home, "present")
    entry = checkpoint(home, "broken", "past failure", occurred_at="2020-02-03T10:00:00-03:00",
                       historical_session_id=historical["session_id"])
    assert entry["session_id"] is None
    assert entry["payload"]["historical_session_id"] == historical["session_id"]
    assert entry["payload"]["git_capture_session_id"] == current["session_id"]
    assert entry["payload"]["git_captured_at"] != entry["payload"]["occurred_at"]
    assert entry["payload"]["setup"] is None
    assert any(item["event_id"] == entry["id"] for item in build_session_record(home, historical["session_id"])["effective_entries"])
    assert not any(item["event_id"] == entry["id"] for item in build_session_record(home, current["session_id"])["effective_entries"])
