from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Protocol


SUPPORTED_PROVIDERS = ("agy", "codex", "claude")


class AgentInvocationError(RuntimeError):
    pass


class AgentCancelled(AgentInvocationError):
    pass


class AgentRunner(Protocol):
    def run(
        self,
        provider: str,
        prompt: str,
        *,
        cwd: Path,
        timeout_seconds: int = 300,
        cancelled: Callable[[], bool] | None = None,
    ) -> str: ...

    def probe(self, provider: str) -> dict[str, object]: ...


def _command_from_env(provider: str) -> list[str]:
    env_name = f"LABOS_{provider.upper()}_CMD"
    configured = os.environ.get(env_name)
    if configured:
        parts = shlex.split(configured)
        if not parts:
            raise AgentInvocationError(f"{env_name} is empty.")
        return parts
    return [provider]


def _model_from_env(provider: str) -> tuple[str | None, str]:
    value = os.environ.get(f"LABOS_{provider.upper()}_MODEL")
    if value and value.strip():
        return value.strip(), "LABOS_*_MODEL"
    return None, "cli-default-unresolved"


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


class SubprocessAgentRunner:
    """Run already-authenticated local agent CLIs without invoking a shell."""

    def probe(self, provider: str) -> dict[str, object]:
        if provider not in SUPPORTED_PROVIDERS:
            raise AgentInvocationError(
                f"Unsupported provider '{provider}'. "
                f"Choose one of: {', '.join(SUPPORTED_PROVIDERS)}."
            )

        command = _command_from_env(provider)
        executable = command[0]
        resolved = shutil.which(executable)
        if resolved is None and Path(executable).expanduser().is_file():
            resolved = str(Path(executable).expanduser().resolve())

        model, model_source = _model_from_env(provider)
        result: dict[str, object] = {
            "provider": provider,
            "configured_executable": executable,
            "resolved_executable": resolved,
            "available": bool(resolved),
            "model": model,
            "model_source": model_source,
            "version": None,
            "version_ok": False,
        }
        if not resolved:
            return result

        try:
            version = subprocess.run(
                [*command, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            output = (version.stdout or version.stderr).strip()
            result["version"] = output.splitlines()[0] if output else None
            result["version_ok"] = version.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
        return result

    def run(
        self,
        provider: str,
        prompt: str,
        *,
        cwd: Path,
        timeout_seconds: int = 300,
        cancelled: Callable[[], bool] | None = None,
    ) -> str:
        if provider not in SUPPORTED_PROVIDERS:
            raise AgentInvocationError(
                f"Unsupported provider '{provider}'. "
                f"Choose one of: {', '.join(SUPPORTED_PROVIDERS)}."
            )

        command = _command_from_env(provider)
        model, _model_source = _model_from_env(provider)

        if provider == "codex":
            args = [
                *command,
                "exec",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
            ]
            if model:
                args.extend(["--model", model])
            args.append("-")
            stdin = prompt
        elif provider == "claude":
            args = [*command, "-p", prompt, "--output-format", "text"]
            if model:
                args.extend(["--model", model])
            args.extend(["--permission-mode", "dontAsk"])
            stdin = None
        else:
            # Agy is intentionally a tiny adapter contract. LABOS_AGY_CMD can
            # point at a wrapper; LABOS_AGY_MODEL is recorded as provenance but
            # is not forced onto an unknown wrapper CLI.
            args = [*command, "-p", prompt]
            stdin = None

        if cancelled and cancelled():
            raise AgentCancelled(f"{provider} invocation cancelled before start.")

        try:
            process = subprocess.Popen(
                args,
                cwd=cwd,
                stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except FileNotFoundError as exc:
            raise AgentInvocationError(
                f"Could not find the '{provider}' CLI. Install/login first or "
                f"set LABOS_{provider.upper()}_CMD."
            ) from exc

        started = time.monotonic()
        first_communicate = True
        while True:
            if cancelled and cancelled():
                _terminate(process)
                raise AgentCancelled(f"{provider} invocation cancelled.")
            remaining = timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                _terminate(process)
                raise AgentInvocationError(
                    f"{provider} timed out after {timeout_seconds} seconds."
                )
            try:
                stdout, stderr = process.communicate(
                    input=stdin if first_communicate else None,
                    timeout=min(0.25, remaining),
                )
                break
            except subprocess.TimeoutExpired:
                first_communicate = False
                continue

        stdout = stdout.strip()
        stderr = stderr.strip()
        if process.returncode != 0:
            detail = stderr or stdout or f"exit code {process.returncode}"
            raise AgentInvocationError(f"{provider} failed: {detail}")
        if not stdout:
            raise AgentInvocationError(f"{provider} returned no output.")
        return stdout
