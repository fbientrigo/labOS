import subprocess
import sys
from pathlib import Path

from labos.ledger import read_events


WRITER = r"""
import sys
from pathlib import Path
from labos.ledger import add_note

home = Path(sys.argv[1])
prefix = sys.argv[2]
count = int(sys.argv[3])

for index in range(count):
    add_note(home, f"{prefix}-{index}")
"""


def test_cross_process_writers_do_not_corrupt_jsonl(tmp_path: Path) -> None:
    home = tmp_path / "labos"
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", WRITER, str(home), prefix, "15"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for prefix in ("a", "b", "c")
    ]

    for process in processes:
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 0, stderr or stdout

    events = read_events(home)
    assert len(events) == 45
    texts = {event["payload"]["text"] for event in events}
    assert {f"a-{i}" for i in range(15)} <= texts
    assert {f"b-{i}" for i in range(15)} <= texts
    assert {f"c-{i}" for i in range(15)} <= texts
