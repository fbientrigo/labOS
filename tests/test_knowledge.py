import json
import subprocess
import sys
from pathlib import Path

import pytest

from labos.knowledge import (
    approve_fact,
    approve_power_profile,
    device_knowledge,
    edit_fact,
    edit_power_profile,
)
from labos.ledger import add_note, checkpoint, read_events, start_session
from labos.resources import add_resource, use_resource
from labos.session_record import build_session_record, evidence_sha256


def _device(home: Path) -> dict:
    return add_resource(
        home,
        fingerprint="210308B2A4C7",
        alias="Zynq #2",
        kind="board",
    )


def test_normal_capture_does_not_create_approved_knowledge(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    _device(home)
    start_session(home, "tgc", workdir=work)
    add_note(home, "powered on")
    checkpoint(home, "working", "looks stable")

    assert not (home / "device_knowledge.json").exists()
    knowledge = device_knowledge(home, "Zynq #2")
    assert knowledge["approved_facts"] == []
    assert knowledge["power_profiles"] == []
    assert not (home / "device_knowledge.json").exists()


def test_unknown_knowledge_version_fails_closed(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    _device(home)
    path = home / "device_knowledge.json"
    path.write_text(
        json.dumps({"knowledge_version": 999, "resources": {}}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="Unsupported LabOS device knowledge version"):
        device_knowledge(home, "Zynq #2")

    with pytest.raises(RuntimeError, match="Unsupported LabOS device knowledge version"):
        approve_fact(home, "Zynq #2", name="FPGA", value="XC7Z020")


def test_approved_fact_requires_explicit_write_and_keeps_provenance(
    tmp_path: Path,
) -> None:
    home = tmp_path / "labos"
    device = _device(home)

    fact = approve_fact(
        home,
        device["resource_id"],
        name="FPGA",
        value="XC7Z020",
        evidence_refs=["ev_manual_label", "doc_vendor"],
        notes="Read from package marking.",
    )

    assert fact["fact_id"].startswith("fact_")
    assert fact["approved_at"]
    assert fact["evidence_refs"] == ["ev_manual_label", "doc_vendor"]

    knowledge = device_knowledge(home, "210308B2A4C7")
    assert knowledge["approved_facts"] == [fact]


def test_fact_edit_is_explicit_reapproval_and_preserves_fact_id(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    _device(home)
    original = approve_fact(
        home,
        "Zynq #2",
        name="FPGA",
        value="TEMP",
        evidence_refs=["ev_1"],
    )

    edited = edit_fact(
        home,
        "Zynq #2",
        original["fact_id"],
        name="FPGA",
        value="XC7Z020",
        evidence_refs=["ev_2"],
        notes="Corrected after reading the package.",
    )

    assert edited["fact_id"] == original["fact_id"]
    assert edited["value"] == "XC7Z020"
    assert edited["evidence_refs"] == ["ev_2"]
    assert len(device_knowledge(home, "Zynq #2")["approved_facts"]) == 1


def test_duplicate_fact_names_require_edit_instead_of_silent_overwrite(
    tmp_path: Path,
) -> None:
    home = tmp_path / "labos"
    _device(home)
    approve_fact(home, "Zynq #2", name="FPGA", value="XC7Z020")

    with pytest.raises(ValueError, match="edit it explicitly"):
        approve_fact(home, "Zynq #2", name="fpga", value="OTHER")


def test_power_profile_supports_multiple_rails_and_optional_typical_draw(
    tmp_path: Path,
) -> None:
    home = tmp_path / "labos"
    _device(home)

    profile = approve_power_profile(
        home,
        "Zynq #2",
        name="Bench nominal",
        rails=[
            {
                "label": "VIN",
                "voltage": 12,
                "voltage_unit": "V",
                "current_limit": 2,
                "current_unit": "A",
                "polarity": "center-positive",
                "typical_draw": 0.7,
            },
            {
                "label": "AUX",
                "voltage": -5,
                "voltage_unit": "V",
                "current_limit": 0.5,
                "current_unit": "A",
                "polarity": "negative rail",
            },
        ],
        evidence_refs=["ev_psu_photo"],
        notes="Approved from bench setup.",
    )

    assert profile["profile_id"].startswith("pwr_")
    assert len(profile["rails"]) == 2
    assert profile["rails"][0]["typical_draw"] == 0.7
    assert "typical_draw" not in profile["rails"][1]


@pytest.mark.parametrize(
    "rails,match",
    [
        ([], "at least one rail"),
        (
            [
                {
                    "label": "VIN",
                    "voltage": 5,
                    "voltage_unit": "V",
                    "current_limit": 0,
                    "current_unit": "A",
                    "polarity": "positive",
                }
            ],
            "current_limit must be positive",
        ),
        (
            [
                {
                    "label": "VIN",
                    "voltage": 5,
                    "voltage_unit": "V",
                    "current_limit": 1,
                    "current_unit": "A",
                    "polarity": "positive",
                    "typical_draw": -0.1,
                }
            ],
            "typical_draw must be non-negative",
        ),
        (
            [
                {
                    "label": None,
                    "voltage": 5,
                    "voltage_unit": "V",
                    "current_limit": 1,
                    "current_unit": "A",
                    "polarity": "positive",
                }
            ],
            "label must be text",
        ),
    ],
)
def test_power_profile_validation(
    tmp_path: Path,
    rails: list[dict],
    match: str,
) -> None:
    home = tmp_path / "labos"
    _device(home)

    with pytest.raises(ValueError, match=match):
        approve_power_profile(home, "Zynq #2", name="Invalid", rails=rails)


def test_power_profile_edit_preserves_profile_id_and_reapproves(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    _device(home)
    original = approve_power_profile(
        home,
        "Zynq #2",
        name="Bench",
        rails=[
            {
                "label": "VIN",
                "voltage": 5,
                "voltage_unit": "V",
                "current_limit": 1,
                "current_unit": "A",
                "polarity": "positive",
            }
        ],
        evidence_refs=["ev_old"],
    )

    edited = edit_power_profile(
        home,
        "Zynq #2",
        original["profile_id"],
        name="Bench",
        rails=[
            {
                "label": "VIN",
                "voltage": 5,
                "voltage_unit": "V",
                "current_limit": 1.5,
                "current_unit": "A",
                "polarity": "positive",
                "typical_draw": 0.4,
            }
        ],
        evidence_refs=["ev_new"],
        notes="Raised current limit after review.",
    )

    assert edited["profile_id"] == original["profile_id"]
    assert edited["rails"][0]["current_limit"] == 1.5
    assert edited["evidence_refs"] == ["ev_new"]
    assert len(device_knowledge(home, "Zynq #2")["power_profiles"]) == 1


def test_approved_knowledge_does_not_change_session_record(
    tmp_path: Path,
) -> None:
    home = tmp_path / "labos"
    work = tmp_path / "work"
    work.mkdir()
    device = _device(home)
    start = start_session(home, "tgc", workdir=work)
    use_resource(home, device["resource_id"])
    add_note(home, "baseline")

    events_before = read_events(home)
    record_before = build_session_record(home, start["session_id"])
    digest_before = evidence_sha256(record_before)

    approve_fact(
        home,
        device["resource_id"],
        name="FPGA",
        value="XC7Z020",
        evidence_refs=["manual-label"],
    )
    approve_power_profile(
        home,
        device["resource_id"],
        name="Bench",
        rails=[
            {
                "label": "VIN",
                "voltage": 12,
                "voltage_unit": "V",
                "current_limit": 2,
                "current_unit": "A",
                "polarity": "center-positive",
            }
        ],
        evidence_refs=["bench-photo"],
    )

    assert read_events(home) == events_before
    record_after = build_session_record(home, start["session_id"])
    assert record_after == record_before
    assert evidence_sha256(record_after) == digest_before


def test_power_profile_rejects_non_finite_numbers(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    _device(home)

    for value in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError, match="must be finite"):
            approve_power_profile(
                home,
                "Zynq #2",
                name="Invalid",
                rails=[
                    {
                        "label": "VIN",
                        "voltage": value,
                        "voltage_unit": "V",
                        "current_limit": 1,
                        "current_unit": "A",
                        "polarity": "positive",
                    }
                ],
            )


KNOWLEDGE_WRITER = r"""
import sys
from pathlib import Path
from labos.knowledge import approve_fact

home = Path(sys.argv[1])
resource_id = sys.argv[2]
prefix = sys.argv[3]
for index in range(5):
    approve_fact(
        home,
        resource_id,
        name=f"{prefix}-{index}",
        value=str(index),
        evidence_refs=[f"{prefix}-evidence-{index}"],
    )
"""


def test_cross_process_approved_writes_are_serialized(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    device = _device(home)

    processes = [
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                KNOWLEDGE_WRITER,
                str(home),
                device["resource_id"],
                prefix,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for prefix in ("terminal", "obsidian")
    ]

    for process in processes:
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 0, stderr or stdout

    facts = device_knowledge(home, device["resource_id"])["approved_facts"]
    assert len(facts) == 10
    assert len({fact["name"] for fact in facts}) == 10
