from __future__ import annotations

import json
import os
import socket
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class LabOSLockTimeout(RuntimeError):
    pass


def _pid_alive(pid: int, host: str | None) -> bool | None:
    if host and host != socket.gethostname():
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError):
        return None
    return True


def _stale_lock(path: Path, stale_after_seconds: float) -> bool:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        pid = int(raw.get("pid", -1))
        host = raw.get("host")
        alive = _pid_alive(pid, host)
        if alive is False:
            return True
        if alive is True:
            return False
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass

    try:
        age = time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return False
    return age > stale_after_seconds


@contextmanager
def ledger_lock(
    home: Path,
    *,
    timeout_seconds: float = 10.0,
    stale_after_seconds: float = 300.0,
    poll_seconds: float = 0.05,
) -> Iterator[None]:
    """Portable single-writer lock for the LabOS ledger/session state."""

    home = home.expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    path = home / ".labos.lock"
    deadline = time.monotonic() + timeout_seconds
    token = uuid.uuid4().hex
    metadata = {
        "version": 1,
        "token": token,
        "pid": os.getpid(),
        "host": socket.gethostname(),
        "created_unix": time.time(),
    }

    fd: int | None = None
    while fd is None:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if _stale_lock(path, stale_after_seconds):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise LabOSLockTimeout(
                    f"Timed out waiting for LabOS ledger lock: {path}"
                )
            time.sleep(poll_seconds)

    try:
        payload = (json.dumps(metadata, sort_keys=True) + "\n").encode("utf-8")
        os.write(fd, payload)
        os.fsync(fd)
        os.close(fd)
        fd = None
        yield
    finally:
        if fd is not None:
            os.close(fd)
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
            if current.get("token") == token:
                path.unlink(missing_ok=True)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            pass
