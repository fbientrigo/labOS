import multiprocessing
from pathlib import Path

from labos.ledger import add_note, read_events


def _writer(home: str, prefix: str, count: int) -> None:
    path = Path(home)
    for index in range(count):
        add_note(path, f"{prefix}-{index}")


def test_cross_process_writers_do_not_corrupt_jsonl(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    ctx = multiprocessing.get_context("spawn")
    processes = [
        ctx.Process(target=_writer, args=(str(home), "a", 15)),
        ctx.Process(target=_writer, args=(str(home), "b", 15)),
        ctx.Process(target=_writer, args=(str(home), "c", 15)),
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=20)
        assert process.exitcode == 0

    events = read_events(home)
    assert len(events) == 45
    texts = {event["payload"]["text"] for event in events}
    assert {f"a-{i}" for i in range(15)} <= texts
    assert {f"b-{i}" for i in range(15)} <= texts
    assert {f"c-{i}" for i in range(15)} <= texts
