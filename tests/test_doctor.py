from pathlib import Path

from labos.doctor import run_doctor


class ProbeRunner:
    def probe(self, provider: str):
        return {
            "provider": provider,
            "available": provider != "claude",
            "version": f"{provider} test",
            "model": None if provider == "agy" else f"{provider}-model",
        }


def test_doctor_reports_core_and_agent_preflight(tmp_path: Path) -> None:
    result = run_doctor(
        tmp_path / "labos",
        providers=["agy", "codex", "claude"],
        runner=ProbeRunner(),
    )
    assert result["core_ok"] is True
    assert result["agents_available"] is False
    assert result["agents"]["codex"]["available"] is True
    assert result["agents"]["claude"]["available"] is False
    assert result["warnings"]
