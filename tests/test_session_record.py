from pathlib import Path

from labos.ledger import add_note, attach_artifact, checkpoint, end_session, start_session
from labos.session_record import (
    build_session_record,
    evidence_sha256,
    render_session_record_markdown,
)


def test_session_record_is_deterministic_and_has_coverage(
    tmp_path: Path,
    monkeypatch,
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    home = tmp_path / "labos"

    start = start_session(home, "tgc", "debug", workdir=work)
    add_note(home, "observation")
    checkpoint(home, "working", "baseline")
    source = tmp_path / "scope.csv"
    source.write_text("t,v\n0,1\n", encoding="utf-8")
    attach_artifact(home, source, hash_file=True)
    end_session(home)

    first = build_session_record(home, start["session_id"])
    second = build_session_record(home, start["session_id"])
    assert first == second
    assert evidence_sha256(first) == evidence_sha256(second)

    coverage = {item["id"]: item for item in first["coverage"]["items"]}
    assert coverage["session_end"]["state"] == "present"
    assert coverage["working_checkpoint"]["state"] == "present"
    assert coverage["artifacts"]["detail"] == "1"
    assert coverage["hashed_artifacts"]["detail"] == "1"
    assert coverage["broken_checkpoint"]["state"] == "absent"

    markdown = render_session_record_markdown(first, evidence_sha256(first))
    assert "Evidence coverage" in markdown
    assert "E01" in markdown
    assert start["id"] in markdown
