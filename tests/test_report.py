import json
import os
import stat
import zipfile
from pathlib import Path

from labos.ledger import add_note, checkpoint, end_session, start_session
from labos.report import generate_report


def _approved() -> dict:
    return {
        "approved": True,
        "issues": [],
        "unsupported_summary": False,
        "unsupported_fact_indices": [],
        "unsupported_change_indices": [],
        "unsupported_advice_indices": [],
        "unsupported_open_question_indices": [],
        "unsupported_uncertainty_indices": [],
    }


class FakeRunner:
    def __init__(self, responses: list[dict] | None = None) -> None:
        self.responses = [json.dumps(item) for item in (responses or [])]
        self.calls: list[str] = []
        self.probes: list[str] = []

    def probe(self, provider: str) -> dict[str, object]:
        self.probes.append(provider)
        return {
            "provider": provider,
            "available": True,
            "version": f"{provider} 1.2.3",
            "version_ok": True,
            "model": f"{provider}-test-model",
            "model_source": "test",
            "resolved_executable": f"/usr/bin/{provider}",
        }

    def run(
        self,
        provider: str,
        prompt: str,
        *,
        cwd: Path,
        timeout_seconds: int = 300,
        cancelled=None,
    ) -> str:
        self.calls.append(provider)
        assert cwd.is_dir()
        assert timeout_seconds == 123
        assert "EVIDENCE_JSON" in prompt
        if cancelled and cancelled():
            raise RuntimeError("unexpected cancellation")
        return self.responses.pop(0)


def _candidate(note_id: str, broken_id: str) -> dict:
    return {
        "summary": {
            "text": "A delayed failure was recorded after an initially working state.",
            "evidence_ids": [note_id, broken_id],
        },
        "facts": [
            {
                "claim": "DMA was recorded as working initially.",
                "evidence_ids": [note_id],
            },
            {
                "claim": "The supply was 12 V.",
                "evidence_ids": [note_id],
            },
        ],
        "changes": [
            {
                "change": "A BROKEN checkpoint recorded event loss.",
                "evidence_ids": [broken_id],
            }
        ],
        "advice": [
            {
                "recommendation": "Record DRS4 state across the failure boundary.",
                "reason": "This can discriminate an upstream stop from later readout loss.",
                "basis_evidence_ids": [broken_id],
                "verification": "Log state immediately before and after event loss.",
            }
        ],
        "open_questions": [
            {
                "question": "Does DRS4 stop before event loss?",
                "evidence_ids": [broken_id],
            }
        ],
        "uncertainties": [
            {
                "statement": "The cause of the delayed failure is not established.",
                "evidence_ids": [broken_id],
            }
        ],
    }


def test_rigorous_report_is_versioned_grounded_and_editable(
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

    candidate = _candidate(note["id"], broken["id"])
    final_validation = _approved()
    final_validation.update(
        {
            "approved": False,
            "unsupported_fact_indices": [1],
            "issues": [
                {
                    "severity": "error",
                    "section": "facts[1]",
                    "reason": "The cited note does not support a voltage value.",
                    "evidence_ids": [note["id"]],
                }
            ],
        }
    )
    critique = {
        "strengths": ["Grounded timeline"],
        "weaknesses": [],
        "missing_checks": ["Capture DRS4 state."],
        "revision_instructions": [],
    }

    runner = FakeRunner(
        [
            candidate,
            _approved(),
            critique,
            candidate,
            final_validation,
        ]
    )
    result = generate_report(
        home,
        tmp_path / "vault" / "LabOS" / "Reports",
        session_id=start["session_id"],
        mode="rigorous",
        worker="agy",
        validator="codex",
        critic="claude",
        runner=runner,
        timeout_seconds=123,
    )

    assert result["status"] == "REVIEW_REQUIRED"
    assert runner.calls == ["agy", "codex", "claude", "agy", "codex"]

    report_dir = Path(result["report_dir"])
    expected = {
        "evidence.json",
        "session_record.md",
        "generated.md",
        "report.md",
        "main.tex",
        "provenance.json",
        "overleaf.zip",
        "run.json",
        "progress.json",
    }
    assert expected <= {path.name for path in report_dir.iterdir()}

    generated = Path(result["generated"]).read_text(encoding="utf-8")
    editable = Path(result["report"]).read_text(encoding="utf-8")
    assert "DMA was recorded as working initially." in generated
    assert "The supply was 12 V." not in generated
    assert "REVIEW_REQUIRED" in generated
    assert "labos_generated_sha256:" in editable

    generated_mode = Path(result["generated"]).stat().st_mode
    report_mode = Path(result["report"]).stat().st_mode
    if os.name != "nt":
        assert not generated_mode & stat.S_IWUSR
        assert report_mode & stat.S_IWUSR

    manifest = json.loads(Path(result["run_manifest"]).read_text(encoding="utf-8"))
    assert manifest["evidence_sha256"] == result["evidence_sha256"]
    assert manifest["pipeline_version"] == "labos-report-v2"
    assert manifest["provider_provenance"]["worker"]["model"] == "agy-test-model"

    provenance = json.loads(Path(result["provenance"]).read_text(encoding="utf-8"))
    assert provenance["final_validation"]["approved"] is False
    assert provenance["provider_provenance"]["validator"]["version"] == "codex 1.2.3"

    with zipfile.ZipFile(result["overleaf_zip"]) as archive:
        assert {
            "main.tex",
            "report.md",
            "generated.md",
            "session_record.md",
            "provenance.json",
            "evidence.json",
        } <= set(archive.namelist())


def test_factual_mode_requires_no_agents_and_runs_are_immutable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    home = tmp_path / "labos"
    start = start_session(home, "charm", workdir=work)
    add_note(home, "waveform stable")
    end_session(home)

    runner = FakeRunner()
    first = generate_report(
        home,
        tmp_path / "reports",
        session_id=start["session_id"],
        mode="factual",
        runner=runner,
        timeout_seconds=123,
    )
    second = generate_report(
        home,
        tmp_path / "reports",
        session_id=start["session_id"],
        mode="factual",
        runner=runner,
        timeout_seconds=123,
    )

    assert first["status"] == "FACTUAL"
    assert second["status"] == "FACTUAL"
    assert first["run_id"] != second["run_id"]
    assert first["report_dir"] != second["report_dir"]
    assert first["evidence_sha256"] == second["evidence_sha256"]
    assert runner.calls == []
    assert runner.probes == []
    assert "Deterministic LabOS Session Record" in Path(first["generated"]).read_text(
        encoding="utf-8"
    )


def test_reviewed_mode_uses_only_worker_and_validator(
    tmp_path: Path,
    monkeypatch,
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    home = tmp_path / "labos"
    start = start_session(home, "tgc", workdir=work)
    note = add_note(home, "DMA works")
    broken = checkpoint(home, "broken", "event loss")

    candidate = _candidate(note["id"], broken["id"])
    runner = FakeRunner([candidate, _approved()])
    result = generate_report(
        home,
        tmp_path / "reports",
        session_id=start["session_id"],
        mode="reviewed",
        worker="agy",
        validator="codex",
        critic="claude",
        runner=runner,
        timeout_seconds=123,
    )

    assert result["status"] == "VALIDATED"
    assert runner.calls == ["agy", "codex"]
    assert "claude" not in runner.probes


class FailingRunner(FakeRunner):
    def run(self, *args, **kwargs) -> str:
        raise RuntimeError("agent unavailable after preflight")


def test_agent_failure_keeps_deterministic_fallback(
    tmp_path: Path,
    monkeypatch,
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    home = tmp_path / "labos"
    start = start_session(home, "tgc", workdir=work)
    add_note(home, "baseline observation")

    result = generate_report(
        home,
        tmp_path / "reports",
        session_id=start["session_id"],
        mode="reviewed",
        runner=FailingRunner(),
        timeout_seconds=123,
    )

    assert result["status"] == "FAILED"
    assert "agent unavailable" in (result["error"] or "")
    assert Path(result["session_record"]).is_file()
    assert Path(result["report"]).is_file()
    assert "deterministic Session Record" in Path(result["report"]).read_text(
        encoding="utf-8"
    )


class CancelAfterFirstRunner(FakeRunner):
    def __init__(self, cancel_path: Path, response: dict) -> None:
        super().__init__([response])
        self.cancel_path = cancel_path

    def run(self, provider: str, prompt: str, **kwargs) -> str:
        result = super().run(provider, prompt, **kwargs)
        self.cancel_path.write_text("cancel\n", encoding="utf-8")
        return result


def test_cancellation_stops_pipeline_and_preserves_versioned_bundle(
    tmp_path: Path,
    monkeypatch,
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    home = tmp_path / "labos"
    start = start_session(home, "tgc", workdir=work)
    note = add_note(home, "DMA works")
    broken = checkpoint(home, "broken", "event loss")
    cancel_path = tmp_path / "cancel"

    runner = CancelAfterFirstRunner(
        cancel_path,
        _candidate(note["id"], broken["id"]),
    )
    result = generate_report(
        home,
        tmp_path / "reports",
        session_id=start["session_id"],
        mode="rigorous",
        runner=runner,
        timeout_seconds=123,
        cancel_path=cancel_path,
    )

    assert result["status"] == "CANCELLED"
    assert runner.calls == ["agy"]
    assert Path(result["session_record"]).is_file()
    assert Path(result["report"]).is_file()
    assert Path(result["provenance"]).is_file()
    assert Path(result["overleaf_zip"]).is_file()
    manifest = json.loads(Path(result["run_manifest"]).read_text(encoding="utf-8"))
    assert manifest["status"] == "CANCELLED"
