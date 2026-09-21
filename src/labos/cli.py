from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .agents import SUPPORTED_PROVIDERS
from .doctor import doctor_text, run_doctor
from .ledger import (
    active_session,
    add_note,
    attach_artifact,
    checkpoint,
    default_home,
    end_session,
    recent_events,
    start_session,
)
from .report import REPORT_MODES, generate_report
from .session_record import (
    build_session_record,
    evidence_sha256,
    render_session_record_markdown,
)


def _text(parts: list[str] | None) -> str | None:
    if not parts:
        return None
    return " ".join(parts).strip() or None


def _home(args: argparse.Namespace) -> Path:
    return Path(args.home).expanduser().resolve() if args.home else default_home()


def _short_event(event: dict) -> str:
    timestamp = event["timestamp"]
    kind = event["type"]
    payload = event.get("payload", {})
    if kind == "note":
        detail = payload.get("text", "")
    elif kind == "checkpoint":
        detail = payload.get("state", "").upper()
        if payload.get("text"):
            detail += f" — {payload['text']}"
    elif kind == "session_start":
        detail = f"START {event.get('project') or ''}".strip()
    elif kind == "session_end":
        detail = "END"
        if payload.get("text"):
            detail += f" — {payload['text']}"
    elif kind == "artifact":
        detail = f"{payload.get('kind', 'artifact')}: {payload.get('name', '')}"
    else:
        detail = json.dumps(payload, sort_keys=True)
    return f"{timestamp}  {detail}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="labos",
        description="Low-friction experimental evidence ledger.",
    )
    parser.add_argument(
        "--home",
        help="Evidence directory. Defaults to $LABOS_HOME or ~/labos-data.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="Start an explicit work session.")
    start.add_argument("project")
    start.add_argument("--label")
    start.add_argument(
        "--cwd",
        type=Path,
        help="Experiment/repository working directory. Defaults to the current directory.",
    )

    note = sub.add_parser("note", help="Append a note; works even without a session.")
    note.add_argument("text", nargs="+")

    good = sub.add_parser("good", help="Mark a WORKING checkpoint and snapshot Git.")
    good.add_argument("text", nargs="*")

    bad = sub.add_parser("bad", help="Mark a BROKEN checkpoint and snapshot Git.")
    bad.add_argument("text", nargs="*")

    attach = sub.add_parser("attach", help="Attach a file by reference or managed copy.")
    attach.add_argument("path", type=Path)
    attach.add_argument("--kind", default="artifact", choices=["artifact", "photo"])
    attach.add_argument("--copy", action="store_true", help="Copy into LabOS-managed raw artifacts.")
    attach.add_argument("--hash", action="store_true", dest="hash_file", help="Compute SHA-256 (opt-in for large files).")
    attach.add_argument("--note")

    end = sub.add_parser("end", help="End the active session and snapshot Git.")
    end.add_argument("text", nargs="*")

    sub.add_parser("status", help="Show active session state.")

    recent = sub.add_parser("recent", help="Show recent evidence events.")
    recent.add_argument("-n", "--limit", type=int, default=20)

    record = sub.add_parser(
        "record",
        help="Build the deterministic Session Record for active/latest work.",
    )
    record.add_argument("--session-id")
    record.add_argument("--json", action="store_true", dest="as_json")
    record.add_argument("--output", type=Path)

    doctor = sub.add_parser(
        "doctor",
        help="Check ledger integrity, locking, and local agent CLI availability.",
    )
    doctor.add_argument("--json", action="store_true", dest="as_json")
    doctor.add_argument(
        "--provider",
        action="append",
        choices=SUPPORTED_PROVIDERS,
        dest="providers",
        help="Limit agent preflight to selected provider(s).",
    )

    report = sub.add_parser(
        "report",
        help="Generate a versioned factual/reviewed/rigorous report run.",
    )
    report.add_argument("--output-dir", type=Path, required=True)
    report.add_argument("--session-id")
    report.add_argument("--mode", choices=REPORT_MODES, default="rigorous")
    report.add_argument("--worker", choices=SUPPORTED_PROVIDERS, default="agy")
    report.add_argument("--validator", choices=SUPPORTED_PROVIDERS, default="codex")
    report.add_argument("--critic", choices=SUPPORTED_PROVIDERS, default="claude")
    report.add_argument("--timeout", type=int, default=300)
    report.add_argument("--progress-file", type=Path)
    report.add_argument("--cancel-file", type=Path)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    home = _home(args)

    try:
        if args.command == "start":
            event = start_session(home, args.project, args.label, args.cwd)
            print(f"STARTED {event['project']}  {event['session_id']}")
        elif args.command == "note":
            event = add_note(home, _text(args.text) or "")
            print(_short_event(event))
        elif args.command == "good":
            event = checkpoint(home, "working", _text(args.text))
            print(_short_event(event))
        elif args.command == "bad":
            event = checkpoint(home, "broken", _text(args.text))
            print(_short_event(event))
        elif args.command == "attach":
            event = attach_artifact(
                home,
                args.path,
                kind=args.kind,
                copy=args.copy,
                hash_file=args.hash_file,
                note=args.note,
            )
            print(_short_event(event))
        elif args.command == "end":
            event = end_session(home, _text(args.text))
            print(_short_event(event))
        elif args.command == "status":
            state = active_session(home)
            if state is None:
                print("No active session.")
            else:
                print(json.dumps(state, indent=2, sort_keys=True))
        elif args.command == "recent":
            for event in recent_events(home, args.limit):
                print(_short_event(event))
        elif args.command == "record":
            record = build_session_record(home, args.session_id)
            digest = evidence_sha256(record)
            if args.output:
                output = args.output.expanduser().resolve()
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    render_session_record_markdown(record, digest),
                    encoding="utf-8",
                )
            if args.as_json:
                print(
                    json.dumps(
                        {"evidence_sha256": digest, "record": record},
                        sort_keys=True,
                    )
                )
            elif args.output:
                print(str(output))
            else:
                print(render_session_record_markdown(record, digest))
        elif args.command == "doctor":
            result = run_doctor(
                home,
                providers=args.providers or SUPPORTED_PROVIDERS,
            )
            if args.as_json:
                print(json.dumps(result, sort_keys=True))
            else:
                print(doctor_text(result))
        elif args.command == "report":
            result = generate_report(
                home,
                args.output_dir,
                session_id=args.session_id,
                mode=args.mode,
                worker=args.worker,
                validator=args.validator,
                critic=args.critic,
                timeout_seconds=args.timeout,
                progress_path=args.progress_file,
                cancel_path=args.cancel_file,
            )
            print(json.dumps(result, sort_keys=True))
        else:
            parser.error(f"unknown command: {args.command}")
    except (RuntimeError, FileNotFoundError, ValueError) as exc:
        parser.exit(2, f"labos: {exc}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
