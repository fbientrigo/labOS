from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .agents import SUPPORTED_PROVIDERS
from .doctor import doctor_text, run_doctor
from .knowledge import (
    approve_fact,
    approve_power_profile,
    device_knowledge,
    edit_fact,
    edit_power_profile,
)
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
from .resources import (
    RESOURCE_KINDS,
    add_resource,
    edit_resource,
    list_resources,
    remove_resource,
    show_resource,
    use_resource,
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


def _rails_json(raw: str) -> list[dict]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid --rails-json: {exc}") from exc
    if not isinstance(value, list):
        raise ValueError("--rails-json must be a JSON array")
    return value


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
    elif kind in {"resource_add", "resource_remove"}:
        action = "USE" if kind == "resource_add" else "REMOVE"
        detail = f"{action} {payload.get('alias') or payload.get('resource_id', '')}"
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

    device = sub.add_parser("device", help="Manage persistent physical devices.")
    device_sub = device.add_subparsers(dest="device_command", required=True)

    device_add = device_sub.add_parser("add", help="Register a physical device.")
    device_add.add_argument("--fingerprint", required=True)
    device_add.add_argument("--alias", required=True)
    device_add.add_argument("--kind", choices=RESOURCE_KINDS, default="other")

    device_sub.add_parser("list", help="List registered devices.")

    device_show = device_sub.add_parser("show", help="Show one device.")
    device_show.add_argument("target", help="Alias, fingerprint, or resource ID.")

    device_edit = device_sub.add_parser("edit", help="Correct device metadata.")
    device_edit.add_argument("target", help="Alias, fingerprint, or resource ID.")
    device_edit.add_argument("--fingerprint")
    device_edit.add_argument("--alias")
    device_edit.add_argument("--kind", choices=RESOURCE_KINDS)

    device_use = device_sub.add_parser("use", help="Add a device to the active session.")
    device_use.add_argument("target", help="Alias, fingerprint, or resource ID.")

    device_remove = device_sub.add_parser(
        "remove", help="Remove a device from the active session."
    )
    device_remove.add_argument("target", help="Alias, fingerprint, or resource ID.")

    device_knowledge_parser = device_sub.add_parser(
        "knowledge", help="Show human-approved facts and power profiles."
    )
    device_knowledge_parser.add_argument(
        "target", help="Alias, fingerprint, or resource ID."
    )

    device_fact = device_sub.add_parser("fact", help="Manage human-approved facts.")
    device_fact_sub = device_fact.add_subparsers(dest="fact_command", required=True)

    fact_approve = device_fact_sub.add_parser(
        "approve", help="Explicitly approve a device fact."
    )
    fact_approve.add_argument("target", help="Alias, fingerprint, or resource ID.")
    fact_approve.add_argument("--name", required=True)
    fact_approve.add_argument("--value", required=True)
    fact_approve.add_argument("--evidence", action="append", default=[])
    fact_approve.add_argument("--notes")

    fact_edit = device_fact_sub.add_parser(
        "edit", help="Explicitly re-approve a corrected device fact."
    )
    fact_edit.add_argument("target", help="Alias, fingerprint, or resource ID.")
    fact_edit.add_argument("fact_id")
    fact_edit.add_argument("--name", required=True)
    fact_edit.add_argument("--value", required=True)
    fact_edit.add_argument("--evidence", action="append", default=[])
    fact_edit.add_argument("--notes")

    device_power = device_sub.add_parser(
        "power", help="Manage human-approved Power Profiles."
    )
    device_power_sub = device_power.add_subparsers(
        dest="power_command", required=True
    )

    power_approve = device_power_sub.add_parser(
        "approve", help="Explicitly approve a Power Profile."
    )
    power_approve.add_argument("target", help="Alias, fingerprint, or resource ID.")
    power_approve.add_argument("--name", required=True)
    power_approve.add_argument(
        "--rails-json",
        required=True,
        help="JSON array of rails with label, voltage/unit, current limit/unit, polarity.",
    )
    power_approve.add_argument("--evidence", action="append", default=[])
    power_approve.add_argument("--notes")

    power_edit = device_power_sub.add_parser(
        "edit", help="Explicitly re-approve a corrected Power Profile."
    )
    power_edit.add_argument("target", help="Alias, fingerprint, or resource ID.")
    power_edit.add_argument("profile_id")
    power_edit.add_argument("--name", required=True)
    power_edit.add_argument("--rails-json", required=True)
    power_edit.add_argument("--evidence", action="append", default=[])
    power_edit.add_argument("--notes")

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
        elif args.command == "device":
            if args.device_command == "add":
                resource = add_resource(
                    home,
                    fingerprint=args.fingerprint,
                    alias=args.alias,
                    kind=args.kind,
                )
                print(json.dumps(resource, sort_keys=True))
            elif args.device_command == "list":
                for resource in list_resources(home):
                    print(
                        f"{resource['alias']}\t{resource['fingerprint']}\t"
                        f"{resource['kind']}\t{resource['resource_id']}"
                    )
            elif args.device_command == "show":
                print(json.dumps(show_resource(home, args.target), sort_keys=True))
            elif args.device_command == "edit":
                if (
                    args.fingerprint is None
                    and args.alias is None
                    and args.kind is None
                ):
                    raise ValueError(
                        "device edit requires --fingerprint, --alias, or --kind"
                    )
                resource = edit_resource(
                    home,
                    args.target,
                    fingerprint=args.fingerprint,
                    alias=args.alias,
                    kind=args.kind,
                )
                print(json.dumps(resource, sort_keys=True))
            elif args.device_command == "use":
                print(_short_event(use_resource(home, args.target)))
            elif args.device_command == "remove":
                print(_short_event(remove_resource(home, args.target)))
            elif args.device_command == "knowledge":
                print(json.dumps(device_knowledge(home, args.target), sort_keys=True))
            elif args.device_command == "fact":
                if args.fact_command == "approve":
                    result = approve_fact(
                        home,
                        args.target,
                        name=args.name,
                        value=args.value,
                        evidence_refs=args.evidence,
                        notes=args.notes,
                    )
                elif args.fact_command == "edit":
                    result = edit_fact(
                        home,
                        args.target,
                        args.fact_id,
                        name=args.name,
                        value=args.value,
                        evidence_refs=args.evidence,
                        notes=args.notes,
                    )
                else:
                    parser.error(f"unknown fact command: {args.fact_command}")
                print(json.dumps(result, sort_keys=True))
            elif args.device_command == "power":
                rails = _rails_json(args.rails_json)
                if args.power_command == "approve":
                    result = approve_power_profile(
                        home,
                        args.target,
                        name=args.name,
                        rails=rails,
                        evidence_refs=args.evidence,
                        notes=args.notes,
                    )
                elif args.power_command == "edit":
                    result = edit_power_profile(
                        home,
                        args.target,
                        args.profile_id,
                        name=args.name,
                        rails=rails,
                        evidence_refs=args.evidence,
                        notes=args.notes,
                    )
                else:
                    parser.error(f"unknown power command: {args.power_command}")
                print(json.dumps(result, sort_keys=True))
            else:
                parser.error(f"unknown device command: {args.device_command}")
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
