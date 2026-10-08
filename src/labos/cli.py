from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .agents import SUPPORTED_PROVIDERS
from .comparison import build_comparison, render_comparison_markdown
from .doctor import doctor_text, run_doctor
from .knowledge import (
    add_port,
    approve_fact,
    approve_power_profile,
    device_knowledge,
    edit_fact,
    edit_port,
    edit_power_profile,
    remove_port,
)
from .ledger import (
    active_session,
    add_note,
    attach_artifact,
    checkpoint,
    default_home,
    end_session,
    export_events,
    recent_events,
    start_session,
)
from .logbook import (asset_renames, bulk_retag, capture, current_setup, daily_log_id, effective_entries, list_sessions,
                      record_asset_rename, revise, save_setup, set_tag, setup_history,
                      tags_for_day, update_markdown_log, write_daily_markdown)
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
    start.add_argument("--setup-json", help="Explicit setup to use; defaults to an empty setup.")

    note = sub.add_parser("note", help="Append a note; works even without a session.")
    note.add_argument("text", nargs="+")

    good = sub.add_parser("good", help="Mark a WORKING checkpoint and snapshot Git.")
    good.add_argument("text", nargs="*")
    good.add_argument("--tag")
    good.add_argument("--at")
    good.add_argument("--links-json", default="[]")
    good.add_argument("--setup-json")
    good.add_argument("--session-id")
    good.add_argument("--json", action="store_true", dest="as_json")

    bad = sub.add_parser("bad", help="Mark a BROKEN checkpoint and snapshot Git.")
    bad.add_argument("text", nargs="*")
    bad.add_argument("--tag")
    bad.add_argument("--at")
    bad.add_argument("--links-json", default="[]")
    bad.add_argument("--setup-json")
    bad.add_argument("--session-id")
    bad.add_argument("--json", action="store_true", dest="as_json")

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
    recent.add_argument("--json", action="store_true", dest="as_json")

    export = sub.add_parser("export", help="Export portable events.jsonl from SQLite.")
    export.add_argument("path", nargs="?", type=Path, help="Defaults to HOME/exports/events.jsonl.")

    setup = sub.add_parser("setup", help="Read or append a complete hardware setup snapshot.")
    setup_sub = setup.add_subparsers(dest="setup_command", required=True)
    setup_sub.add_parser("get")
    setup_sub.add_parser("history")
    setup_set = setup_sub.add_parser("set")
    setup_set.add_argument("--json", required=True, dest="setup_json")
    setup_set.add_argument("--base-event-id", default=None,
                           help="Refuse unless this is the latest setup snapshot id (empty string: none yet).")

    capture_parser = sub.add_parser("capture", help="Capture a dated observation or measurement.")
    capture_parser.add_argument("text", nargs="*", default=[])
    capture_parser.add_argument("--kind", choices=["note", "measurement"], default="note")
    capture_parser.add_argument("--tag")
    capture_parser.add_argument("--at", dest="occurred_at")
    capture_parser.add_argument("--target")
    capture_parser.add_argument("--current", type=float)
    capture_parser.add_argument("--unit", choices=["A", "mA"])
    capture_parser.add_argument("--voltage", type=float)
    capture_parser.add_argument("--links-json", default="[]")
    capture_parser.add_argument("--setup-json")
    capture_parser.add_argument("--session-id")

    log = sub.add_parser("log", help="Query effective entries for a local calendar day.")
    log.add_argument("day")
    log.add_argument("--session-id")
    log.add_argument("--tag")
    log.add_argument("--search")
    log.add_argument("--offset", type=int, default=0)
    log.add_argument("--limit", type=int, default=100)

    revision = sub.add_parser("revise", help="Append an entry revision.")
    revision.add_argument("entry_id")
    revision.add_argument("--changes-json", required=True)

    sub.add_parser("sessions", help="List sessions for explicit historical log association.")

    tag = sub.add_parser("tag", help="Define or bulk-retag work tags for a day.")
    tag_sub = tag.add_subparsers(dest="tag_command", required=True)
    tag_list = tag_sub.add_parser("list")
    tag_list.add_argument("day")
    tag_set = tag_sub.add_parser("set")
    tag_set.add_argument("day")
    tag_set.add_argument("name")
    tag_set.add_argument("color")
    tag_move = tag_sub.add_parser("retag")
    tag_move.add_argument("day")
    tag_move.add_argument("old_tag")
    tag_move.add_argument("new_tag")

    markdown = sub.add_parser("markdown", help="Update a dated Markdown log in a vault.")
    markdown.add_argument("day")
    markdown.add_argument("path", type=Path)

    asset = sub.add_parser("asset", help="Record an explicit asset path change.")
    asset_sub = asset.add_subparsers(dest="asset_command", required=True)
    renamed = asset_sub.add_parser("rename")
    renamed.add_argument("old_path")
    renamed.add_argument("new_path")

    sync_log = sub.add_parser("sync-log", help="Preview or apply Markdown log edits as append-only evidence.")
    sync_log.add_argument("path", type=Path)
    sync_log.add_argument("--apply", action="store_true")
    sync_log.add_argument("--remove-id", action="append", default=[])

    log_id = sub.add_parser("log-id", help="Read the stable identifier for a daily log.")
    log_id.add_argument("day")
    sub.add_parser("asset-map", help="Resolve current paths for explicitly renamed assets.")

    device = sub.add_parser("device", help="Manage persistent physical devices.")
    device_sub = device.add_subparsers(dest="device_command", required=True)

    device_add = device_sub.add_parser("add", help="Register a physical device.")
    device_add.add_argument("--fingerprint", required=True)
    device_add.add_argument("--alias", required=True)
    device_add.add_argument("--kind", default="other")

    device_sub.add_parser("list", help="List registered devices.")

    device_show = device_sub.add_parser("show", help="Show one device.")
    device_show.add_argument("target", help="Alias, fingerprint, or resource ID.")

    device_edit = device_sub.add_parser("edit", help="Correct device metadata.")
    device_edit.add_argument("target", help="Alias, fingerprint, or resource ID.")
    device_edit.add_argument("--fingerprint")
    device_edit.add_argument("--alias")
    device_edit.add_argument("--kind")

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

    device_port = device_sub.add_parser("port", help="Manage device interface/port definitions.")
    device_port_sub = device_port.add_subparsers(dest="port_command", required=True)
    for port_name, port_help in (("add", "Define a port."), ("edit", "Edit a port definition.")):
        port_parser = device_port_sub.add_parser(port_name, help=port_help)
        port_parser.add_argument("target", help="Alias, fingerprint, or resource ID.")
        if port_name == "edit":
            port_parser.add_argument("port_id")
        port_parser.add_argument("--label", required=True)
        port_parser.add_argument("--kind", default="other")
        port_parser.add_argument("--direction", default="unknown")
        port_parser.add_argument("--connector")
        port_parser.add_argument("--notes")
    port_remove = device_port_sub.add_parser("remove", help="Forget a port definition.")
    port_remove.add_argument("target", help="Alias, fingerprint, or resource ID.")
    port_remove.add_argument("port_id")

    record = sub.add_parser(
        "record",
        help="Build the deterministic Session Record for active/latest work.",
    )
    record.add_argument("--session-id")
    record.add_argument("--json", action="store_true", dest="as_json")
    record.add_argument("--output", type=Path)

    compare = sub.add_parser("compare", help="Compare recorded evidence from two sessions.")
    compare.add_argument("left_session_id", metavar="LEFT_SESSION_ID")
    compare.add_argument("right_session_id", metavar="RIGHT_SESSION_ID")
    compare.add_argument("--json", action="store_true", dest="as_json")

    doctor = sub.add_parser(
        "doctor",
        help="Check SQLite integrity, session state, paths and local agent CLIs.",
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
            setup = json.loads(args.setup_json) if args.setup_json else None
            event = start_session(home, args.project, args.label, args.cwd, setup)
            print(f"STARTED {event['project']}  {event['session_id']}")
        elif args.command == "note":
            event = add_note(home, _text(args.text) or "")
            print(_short_event(event))
        elif args.command == "good":
            event = checkpoint(home, "working", _text(args.text), tag=args.tag, occurred_at=args.at, links=json.loads(args.links_json), setup=json.loads(args.setup_json) if args.setup_json else None, historical_session_id=args.session_id)
            print(json.dumps(event, ensure_ascii=False) if args.as_json else _short_event(event))
        elif args.command == "bad":
            event = checkpoint(home, "broken", _text(args.text), tag=args.tag, occurred_at=args.at, links=json.loads(args.links_json), setup=json.loads(args.setup_json) if args.setup_json else None, historical_session_id=args.session_id)
            print(json.dumps(event, ensure_ascii=False) if args.as_json else _short_event(event))
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
            events = recent_events(home, args.limit)
            if args.as_json:
                print(json.dumps(events, sort_keys=True))
            else:
                for event in events:
                    print(_short_event(event))
        elif args.command == "export":
            print(export_events(home, args.path))
        elif args.command == "setup":
            if args.setup_command == "get":
                print(json.dumps(current_setup(home), ensure_ascii=False))
            elif args.setup_command == "history":
                print(json.dumps(setup_history(home), ensure_ascii=False))
            else:
                value = json.loads(args.setup_json)
                print(json.dumps(save_setup(home, value, args.base_event_id), ensure_ascii=False))
        elif args.command == "capture":
            try:
                links = json.loads(args.links_json)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid --links-json: {exc}") from exc
            if not isinstance(links, list):
                raise ValueError("--links-json must be an array")
            setup_value = json.loads(args.setup_json) if args.setup_json else None
            if setup_value is not None and not isinstance(setup_value, dict):
                raise ValueError("--setup-json must be an object")
            event = capture(home, kind=args.kind, text=_text(args.text) or "", tag=args.tag,
                            occurred_at=args.occurred_at, target=args.target,
                            current=args.current, unit=args.unit, voltage=args.voltage, links=links,
                            setup=setup_value, session_id=args.session_id)
            print(json.dumps(event, ensure_ascii=False))
        elif args.command == "log":
            if args.offset < 0 or args.limit < 1:
                raise ValueError("offset must be non-negative and limit positive")
            print(json.dumps(effective_entries(home, day=args.day, session_id=args.session_id,
                                               tag=args.tag, query=args.search,
                                               offset=args.offset, limit=args.limit), ensure_ascii=False))
        elif args.command == "revise":
            print(json.dumps(revise(home, args.entry_id, json.loads(args.changes_json)), ensure_ascii=False))
        elif args.command == "sessions":
            print(json.dumps(list_sessions(home), ensure_ascii=False))
        elif args.command == "tag":
            if args.tag_command == "list":
                print(json.dumps(tags_for_day(home, args.day)))
            elif args.tag_command == "set":
                print(json.dumps(set_tag(home, args.day, args.name, args.color), ensure_ascii=False))
            else:
                print(json.dumps(bulk_retag(home, day=args.day, old_tag=args.old_tag, new_tag=args.new_tag), ensure_ascii=False))
        elif args.command == "markdown":
            print(write_daily_markdown(home, args.day, args.path))
        elif args.command == "log-id":
            print(daily_log_id(home, args.day))
        elif args.command == "asset-map":
            print(json.dumps(asset_renames(home), ensure_ascii=False))
        elif args.command == "asset":
            print(json.dumps(record_asset_rename(home, args.old_path, args.new_path), ensure_ascii=False))
        elif args.command == "sync-log":
            print(json.dumps(update_markdown_log(home, args.path, apply=args.apply, remove_ids=set(args.remove_id)), ensure_ascii=False))
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
            elif args.device_command == "port":
                if args.port_command == "add":
                    result = add_port(home, args.target, label=args.label, kind=args.kind,
                                      direction=args.direction, connector=args.connector, notes=args.notes)
                elif args.port_command == "edit":
                    result = edit_port(home, args.target, args.port_id, label=args.label, kind=args.kind,
                                       direction=args.direction, connector=args.connector, notes=args.notes)
                else:
                    result = remove_port(home, args.target, args.port_id)
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
        elif args.command == "compare":
            comparison = build_comparison(home, args.left_session_id, args.right_session_id)
            if args.as_json:
                print(json.dumps(comparison, sort_keys=True, ensure_ascii=False))
            else:
                print(render_comparison_markdown(comparison), end="")
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
