import subprocess
import sys
from pathlib import Path

import pytest

from labos.ledger import add_note, end_session, read_events, start_session
from labos.logbook import capture, current_setup, save_setup
from labos.resources import (
    add_resource,
    edit_resource,
    list_resources,
    remove_resource,
    resource_context_timeline,
    show_resource,
    use_resource,
)
from labos.session_record import build_session_record, evidence_sha256, session_events


def test_fingerprint_unique_but_alias_may_repeat(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    first = add_resource(
        home,
        fingerprint="210308B2A4C7",
        alias="Zynq",
        kind="board",
    )
    second = add_resource(
        home,
        fingerprint="210308B2A4C8",
        alias="Zynq",
        kind="board",
    )

    assert first["resource_id"] != second["resource_id"]
    assert len(list_resources(home)) == 2
    with pytest.raises(ValueError, match="fingerprint already exists"):
        add_resource(
            home,
            fingerprint="210308B2A4C7",
            alias="Other",
            kind="board",
        )
    with pytest.raises(RuntimeError, match="Ambiguous device alias"):
        show_resource(home, "Zynq")


def test_alias_and_fingerprint_correction_preserve_resource_id(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    original = add_resource(
        home,
        fingerprint="WRONG",
        alias="Zynq temp",
        kind="board",
    )

    edited = edit_resource(
        home,
        original["resource_id"],
        fingerprint="210308B2A4C7",
        alias="Zynq #2",
    )

    assert edited["resource_id"] == original["resource_id"]
    assert edited["fingerprint"] == "210308B2A4C7"
    assert edited["alias"] == "Zynq #2"
    assert show_resource(home, "210308B2A4C7")["resource_id"] == original["resource_id"]
    assert show_resource(home, "Zynq #2")["resource_id"] == original["resource_id"]


def test_resource_context_switch_is_historical_and_append_only(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start = start_session(home, "tgc", workdir=work)

    z2 = add_resource(
        home,
        fingerprint="210308B2A4C7",
        alias="Zynq #2",
        kind="board",
    )
    z3 = add_resource(
        home,
        fingerprint="210308B2A4D0",
        alias="Zynq #3",
        kind="board",
    )

    add_z2 = use_resource(home, "Zynq #2")
    before = add_note(home, "baseline")
    remove_z2 = remove_resource(home, z2["resource_id"])
    add_z3 = use_resource(home, z3["fingerprint"])
    after = add_note(home, "replacement installed")
    end_session(home)

    events = session_events(home, start["session_id"])
    context = resource_context_timeline(events)["by_event"]

    assert [r["resource_id"] for r in context[add_z2["id"]]] == [z2["resource_id"]]
    assert [r["resource_id"] for r in context[before["id"]]] == [z2["resource_id"]]
    assert [r["resource_id"] for r in context[remove_z2["id"]]] == [z2["resource_id"]]
    assert [r["resource_id"] for r in context[add_z3["id"]]] == [z3["resource_id"]]
    assert [r["resource_id"] for r in context[after["id"]]] == [z3["resource_id"]]


def test_registry_correction_does_not_rewrite_historical_snapshots(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start = start_session(home, "tgc", workdir=work)
    device = add_resource(
        home,
        fingerprint="TEMP-001",
        alias="Board temp",
        kind="board",
    )

    use_resource(home, device["resource_id"])
    old_note = add_note(home, "before identity correction")
    edit_resource(
        home,
        device["resource_id"],
        fingerprint="SERIAL-001",
        alias="Zynq #2",
    )
    still_same_unit = add_note(home, "after registry correction")
    remove_resource(home, "Zynq #2")
    use_resource(home, "SERIAL-001")
    readded = add_note(home, "after explicit re-add")

    events = session_events(home, start["session_id"])
    context = resource_context_timeline(events)["by_event"]

    assert context[old_note["id"]][0]["fingerprint"] == "TEMP-001"
    assert context[still_same_unit["id"]][0]["fingerprint"] == "TEMP-001"
    assert context[readded["id"]][0]["fingerprint"] == "SERIAL-001"
    assert context[readded["id"]][0]["resource_id"] == device["resource_id"]


def test_use_and_remove_require_active_session(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    add_resource(home, fingerprint="A1", alias="Board", kind="board")
    with pytest.raises(RuntimeError, match="active LabOS session"):
        use_resource(home, "Board")
    with pytest.raises(RuntimeError, match="active LabOS session"):
        remove_resource(home, "Board")


def test_session_record_resource_context_is_deterministic(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start = start_session(home, "tgc", workdir=work)
    device = add_resource(home, fingerprint="A1", alias="Board", kind="board")
    use_resource(home, device["resource_id"])
    note = add_note(home, "working with board")

    first = build_session_record(home, start["session_id"])
    second = build_session_record(home, start["session_id"])

    assert first == second
    assert evidence_sha256(first) == evidence_sha256(second)
    assert first["record_version"] == 4
    assert first["resource_context"]["by_event"][note["id"]][0]["resource_id"] == device["resource_id"]


def test_old_sessions_without_resources_remain_valid(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start = start_session(home, "legacy", workdir=work)
    note = add_note(home, "no device context recorded")
    end_session(home)

    record = build_session_record(home, start["session_id"])

    assert record["resource_context"]["by_event"][note["id"]] == []
    assert record["resource_context"]["active_at_end"] == []


RESOURCE_WRITER = r"""
import sys
from pathlib import Path
from labos.resources import add_resource

home = Path(sys.argv[1])
prefix = sys.argv[2]
for index in range(8):
    add_resource(
        home,
        fingerprint=f"{prefix}-{index}",
        alias=f"{prefix} board {index}",
        kind="board",
    )
"""


def test_cross_process_resource_registry_writes_are_serialized(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", RESOURCE_WRITER, str(home), prefix],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for prefix in ("terminal", "obsidian")
    ]

    for process in processes:
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 0, stderr or stdout

    resources = list_resources(home)
    assert len(resources) == 16
    assert len({r["fingerprint"] for r in resources}) == 16


def test_start_use_capture_save_setup_retains_device(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start_session(home, "tgc", workdir=work, setup={"devices": [], "connections": []})
    dev = add_resource(home, fingerprint="FP-001", alias="DUT-A", kind="board")

    # Reproduction sequence: use_resource on registered device
    use_resource(home, dev["resource_id"])

    # setup and active resources must be coherent immediately
    setup_now = current_setup(home)
    assert any(d["resource_id"] == dev["resource_id"] for d in setup_now["devices"])

    # capture note embeds the coherent setup
    note = capture(home, kind="note", text="baseline observation")
    assert note["payload"]["setup"] is not None
    assert any(d["resource_id"] == dev["resource_id"] for d in note["payload"]["setup"]["devices"])

    # saving current_setup must NOT remove DUT-A
    save_setup(home, setup_now)
    events_after = read_events(home)
    # DUT-A must NOT have any resource_remove event
    assert not any(e["type"] == "resource_remove" and e["payload"].get("resource_id") == dev["resource_id"] for e in events_after)
    active = resource_context_timeline(events_after)["active_at_end"]
    assert any(r["resource_id"] == dev["resource_id"] for r in active)


def test_use_resource_starts_from_the_active_sessions_setup_only(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    prior = add_resource(home, fingerprint="FP-PRIOR", alias="Prior", kind="board")
    current = add_resource(home, fingerprint="FP-CURRENT", alias="Current", kind="board")

    start_session(home, "first", workdir=work, setup={"devices": [{
        "resource_id": prior["resource_id"], "fingerprint": prior["fingerprint"],
        "alias": prior["alias"], "kind": prior["kind"],
    }], "connections": []})
    end_session(home)
    start_session(home, "second", workdir=work)

    use_resource(home, current["resource_id"])

    assert [device["resource_id"] for device in current_setup(home)["devices"]] == [current["resource_id"]]


def test_remove_resource_prunes_connections_and_readd_preserves_card(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start_session(home, "tgc", workdir=work)
    dev_a = add_resource(home, fingerprint="FP-A", alias="Device A", kind="board")
    dev_b = add_resource(home, fingerprint="FP-B", alias="Device B", kind="psu")

    # Initial setup with custom coordinates, ports, and a connection
    setup = {
        "devices": [
            {"resource_id": dev_a["resource_id"], "fingerprint": "FP-A", "alias": "Device A", "kind": "board", "activation": "active", "x": 120, "y": 240, "ports": [{"port_id": "P1", "label": "P1"}]},
            {"resource_id": dev_b["resource_id"], "fingerprint": "FP-B", "alias": "Device B", "kind": "psu", "activation": "active", "x": 300, "y": 240, "ports": [{"port_id": "VOUT", "label": "VOUT"}]},
        ],
        "connections": [
            {"from": dev_b["resource_id"], "to": dev_a["resource_id"], "from_port": "VOUT", "to_port": "P1"},
        ],
        "layout_extension": {"zoom": 1.25, "note": "retain unknown setup data"},
    }
    save_setup(home, setup)

    # Removal of Device A prunes the incident connection
    remove_resource(home, "Device A")
    setup_after_remove = current_setup(home)
    assert len(setup_after_remove["devices"]) == 1
    assert setup_after_remove["devices"][0]["resource_id"] == dev_b["resource_id"]
    # Incident connection is pruned
    assert len(setup_after_remove["connections"]) == 0
    assert setup_after_remove["layout_extension"] == setup["layout_extension"]

    # Re-adding Device A preserves prior card (layout, ports) and uses unknown activation
    use_resource(home, "Device A")
    setup_after_readd = current_setup(home)
    readded_card = next(d for d in setup_after_readd["devices"] if d["resource_id"] == dev_a["resource_id"])
    assert readded_card["x"] == 120
    assert readded_card["y"] == 240
    assert readded_card["ports"] == [{"port_id": "P1", "label": "P1"}]
    assert readded_card["activation"] == "unknown"
    assert current_setup(home)["layout_extension"] == setup["layout_extension"]


def test_use_resource_atomicity_and_rollback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    start_session(home, "tgc", workdir=work)
    dev = add_resource(home, fingerprint="FP-FAIL", alias="Device Fail", kind="board")
    events_before = read_events(home)

    import labos.logbook

    def fail_validate(setup: dict) -> None:
        if any(d.get("resource_id") == dev["resource_id"] for d in setup.get("devices", [])):
            raise ValueError("simulated validation failure")
        return None

    monkeypatch.setattr(labos.logbook, "validate_setup", fail_validate)

    with pytest.raises(ValueError, match="simulated validation failure"):
        use_resource(home, dev["resource_id"])

    # Rollback must leave events exactly as before (neither resource_add nor setup_snapshot)
    events_after = read_events(home)
    assert events_after == events_before
