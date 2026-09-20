import json
import zipfile
from pathlib import Path

from labos.ledger import add_note, checkpoint, end_session, start_session
from labos.report import generate_report


class FakeRunner:
    def __init__(self, responses: list[dict]) -> None:
        self.responses = [json.dumps(item) for item in responses]
        self.calls: list[str] = []

    def run(
        self,
        provider: str,
        prompt: str,
        *,
        cwd: Path,
        timeout_seconds: int = 300,
    ) -> str:
        self.calls.append(provider)
        assert cwd.is_dir()
        assert timeout_seconds == 123
        assert "EVIDENCE_JSON" in prompt
        return self.responses.pop(0)


def test_validated_report_writes_markdown_latex_and_overleaf_zip(
    tmp_path: Path,
    monkeypatch,
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)

    home = tmp_path / "labos"
    start = start_session(home, "tgc", "trigger debug", workdir=work)
    note = add_note(home, "DMA works initially")
    checkpoint(home, "working", "baseline")
    broken = checkpoint(home, "broken", "events disappear after ~70 s")
    end_session(home, "continue tomorrow")

    draft = {
        "title": "TGC trigger debug",
        "executive_summary": "A short draft.",
        "facts": [
            {
                "claim": "DMA worked initially.",
                "evidence_event_ids": [note["id"]],
            }
        ],
        "changes": [],
        "advice": [],
        "open_questions": [],
        "uncertainties": [],
    }
    validation = {
        "approved": True,
        "issues": [],
        "unsupported_fact_indices": [],
        "unsupported_change_indices": [],
    }
    critique = {
        "strengths": ["Grounded"],
        "weaknesses": [],
        "missing_checks": ["Check DRS4 state at failure."],
        "revision_instructions": ["Add a falsifiable next check."],
    }
    final = {
        "title": "TGC trigger debug",
        "executive_summary": "The session reproduced a delayed failure.",
        "facts": [
            {
                "claim": "DMA worked initially.",
                "evidence_event_ids": [note["id"]],
            },
            {
                "claim": "Invented unsupported voltage.",
                "evidence_event_ids": [note["id"]],
            },
        ],
        "changes": [
            {
                "change": "A broken checkpoint recorded the delayed failure.",
                "evidence_event_ids": [broken["id"]],
            }
        ],
        "advice": [
            {
                "priority": "high",
                "recommendation": "Record DRS4 state at the failure boundary.",
                "reason": "It separates an upstream stop from a later readout problem.",
                "basis_event_ids": [broken["id"]],
                "verification": "Log DRS4 state before and immediately after event loss.",
            }
        ],
        "open_questions": ["Does DRS4 stop before DMA?"],
        "uncertainties": ["Causality is not established."],
    }

    final_validation = {
        "approved": False,
        "issues": [
            {
                "severity": "error",
                "claim": "Invented unsupported voltage.",
                "reason": "The cited event does not support a voltage claim.",
                "evidence_event_ids": [note["id"]],
            }
        ],
        "unsupported_fact_indices": [1],
        "unsupported_change_indices": [],
    }

    runner = FakeRunner([draft, validation, critique, final, final_validation])
    result = generate_report(
        home,
        tmp_path / "vault" / "LabOS" / "Reports",
        session_id=start["session_id"],
        worker="agy",
        validator="codex",
        critic="claude",
        runner=runner,
        timeout_seconds=123,
    )

    assert runner.calls == ["agy", "codex", "claude", "agy", "codex"]

    markdown = Path(result["markdown"])
    latex = Path(result["latex"])
    overleaf = Path(result["overleaf_zip"])
    provenance = Path(result["provenance"])

    assert markdown.is_file()
    assert latex.is_file()
    assert overleaf.is_file()
    assert provenance.is_file()

    rendered = markdown.read_text(encoding="utf-8")
    assert "DMA worked initially." in rendered
    assert "Invented unsupported voltage." not in rendered
    assert "Record DRS4 state at the failure boundary." in rendered
    assert note["id"] in rendered
    assert "Validator approved final report: **False**" in rendered

    with zipfile.ZipFile(overleaf) as archive:
        assert set(archive.namelist()) == {
            "main.tex",
            "report.md",
            "provenance.json",
        }

    provenance_data = json.loads(provenance.read_text(encoding="utf-8"))
    assert provenance_data["providers"] == {
        "worker": "agy",
        "validator": "codex",
        "critic": "claude",
    }


def test_report_defaults_to_active_session(tmp_path: Path, monkeypatch) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    home = tmp_path / "labos"
    start = start_session(home, "charm", workdir=work)
    note = add_note(home, "waveform stable")

    final = {
        "title": "CHARM",
        "executive_summary": "Stable observation.",
        "facts": [
            {
                "claim": "Waveform was recorded as stable.",
                "evidence_event_ids": [note["id"]],
            }
        ],
        "changes": [],
        "advice": [],
        "open_questions": [],
        "uncertainties": [],
    }
    runner = FakeRunner(
        [
            final,
            {
                "approved": True,
                "issues": [],
                "unsupported_fact_indices": [],
                "unsupported_change_indices": [],
            },
            {
                "strengths": [],
                "weaknesses": [],
                "missing_checks": [],
                "revision_instructions": [],
            },
            final,
            {
                "approved": True,
                "issues": [],
                "unsupported_fact_indices": [],
                "unsupported_change_indices": [],
            },
        ]
    )

    result = generate_report(
        home,
        tmp_path / "reports",
        runner=runner,
        timeout_seconds=123,
    )
    assert result["session_id"] == start["session_id"]
