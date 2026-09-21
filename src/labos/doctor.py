from __future__ import annotations

import json
import os
import uuid
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Iterable

from .agents import SUPPORTED_PROVIDERS, AgentRunner, SubprocessAgentRunner
from .ledger import active_session, ensure_home, read_events
from .locking import ledger_lock


def labos_version() -> str:
    try:
        return version("labos")
    except PackageNotFoundError:
        return "unknown"


def run_doctor(
    home: Path,
    *,
    providers: Iterable[str] = SUPPORTED_PROVIDERS,
    runner: AgentRunner | None = None,
) -> dict[str, object]:
    runner = runner or SubprocessAgentRunner()
    home = ensure_home(home)
    checks: list[dict[str, object]] = []

    probe_path = home / f".doctor-{uuid.uuid4().hex}.tmp"
    try:
        probe_path.write_text("labos\n", encoding="utf-8")
        probe_path.unlink()
        checks.append({"id": "home_writable", "ok": True, "detail": str(home)})
    except OSError as exc:
        checks.append({"id": "home_writable", "ok": False, "detail": str(exc)})

    try:
        with ledger_lock(home, timeout_seconds=2):
            pass
        checks.append({"id": "ledger_lock", "ok": True, "detail": "acquired"})
    except Exception as exc:
        checks.append({"id": "ledger_lock", "ok": False, "detail": str(exc)})

    try:
        events = read_events(home)
        checks.append(
            {
                "id": "ledger_parse",
                "ok": True,
                "detail": f"{len(events)} events",
            }
        )
    except Exception as exc:
        checks.append({"id": "ledger_parse", "ok": False, "detail": str(exc)})

    try:
        state = active_session(home)
        checks.append(
            {
                "id": "session_state",
                "ok": True,
                "detail": (
                    str(state.get("session_id"))
                    if state
                    else "no active session"
                ),
            }
        )
    except Exception as exc:
        checks.append({"id": "session_state", "ok": False, "detail": str(exc)})

    agents: dict[str, object] = {}
    for provider in providers:
        try:
            agents[provider] = runner.probe(provider)
        except Exception as exc:
            agents[provider] = {
                "provider": provider,
                "available": False,
                "error": str(exc),
                "model": None,
                "model_source": "unresolved",
            }

    core_ok = all(bool(item.get("ok")) for item in checks)
    requested_agents = list(agents.values())
    agents_available = all(
        bool(item.get("available"))
        for item in requested_agents
        if isinstance(item, dict)
    )
    unresolved_models = [
        provider
        for provider, item in agents.items()
        if isinstance(item, dict)
        and item.get("available")
        and not item.get("model")
    ]

    warnings = []
    if unresolved_models:
        warnings.append(
            "Model identity is not pinned for: "
            + ", ".join(unresolved_models)
            + ". Set LABOS_<PROVIDER>_MODEL for reproducible AI provenance."
        )

    return {
        "labos_version": labos_version(),
        "home": str(home),
        "core_ok": core_ok,
        "agents_available": agents_available,
        "checks": checks,
        "agents": agents,
        "warnings": warnings,
        "environment": {
            "pid": os.getpid(),
        },
    }


def doctor_text(result: dict[str, object]) -> str:
    lines = [
        f"LabOS {result.get('labos_version')}",
        f"Core: {'OK' if result.get('core_ok') else 'FAIL'}",
    ]
    for check in result.get("checks", []):
        if isinstance(check, dict):
            lines.append(
                f"  {'OK' if check.get('ok') else 'FAIL'} "
                f"{check.get('id')}: {check.get('detail')}"
            )
    lines.append("Agents:")
    agents = result.get("agents", {})
    if isinstance(agents, dict):
        for provider, item in agents.items():
            if not isinstance(item, dict):
                continue
            state = "OK" if item.get("available") else "MISSING"
            model = item.get("model") or "model unresolved"
            ver = item.get("version") or "version unknown"
            lines.append(f"  {state} {provider}: {ver}; {model}")
    for warning in result.get("warnings", []):
        lines.append(f"WARNING: {warning}")
    return "\n".join(lines)
