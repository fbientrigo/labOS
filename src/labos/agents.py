from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from typing import Protocol


SUPPORTED_PROVIDERS = ("agy", "codex", "claude")


class AgentInvocationError(RuntimeError):
    pass


class AgentRunner(Protocol):
    def run(
        self,
        provider: str,
        prompt: str,
        *,
        cwd: Path,
        timeout_seconds: int = 300,
    ) -> str: ...


def _command_from_env(provider: str) -> list[str]:
    env_name = f"LABOS_{provider.upper()}_CMD"
    configured = os.environ.get(env_name)
    if configured:
        parts = shlex.split(configured)
        if not parts:
            raise AgentInvocationError(f"{env_name} is empty.")
        return parts
    return [provider]


class SubprocessAgentRunner:
    """Run an already-authenticated local agent CLI without a shell."""

    def run(
        self,
        provider: str,
        prompt: str,
        *,
        cwd: Path,
        timeout_seconds: int = 300,
    ) -> str:
        if provider not in SUPPORTED_PROVIDERS:
            raise AgentInvocationError(
                f"Unsupported provider '{provider}'. "
                f"Choose one of: {', '.join(SUPPORTED_PROVIDERS)}."
            )

        command = _command_from_env(provider)
        if provider == "codex":
            args = [
                *command,
                "exec",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "-",
            ]
            stdin = prompt
        elif provider == "claude":
            args = [
                *command,
                "-p",
                prompt,
                "--output-format",
                "text",
                "--permission-mode",
                "dontAsk",
            ]
            stdin = None
        else:
            # Agy uses the small local contract: agy -p PROMPT.
            # Override the executable/prefix with LABOS_AGY_CMD.
            args = [*command, "-p", prompt]
            stdin = None

        try:
            result = subprocess.run(
                args,
                cwd=cwd,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            raise AgentInvocationError(
                f"Could not find the '{provider}' CLI. Install/login first or "
                f"set LABOS_{provider.upper()}_CMD."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise AgentInvocationError(
                f"{provider} timed out after {timeout_seconds} seconds."
            ) from exc

        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        if result.returncode != 0:
            detail = stderr or stdout or f"exit code {result.returncode}"
            raise AgentInvocationError(f"{provider} failed: {detail}")
        if not stdout:
            raise AgentInvocationError(f"{provider} returned no output.")
        return stdout
