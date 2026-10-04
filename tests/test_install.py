import json
import os
from pathlib import Path

import pytest

import install


def _mock_commands(monkeypatch, fail_final_cli=False):
    calls = {"cli_help": 0}

    def fake_run(args, cwd):
        if "wheel" in args:
            wheel_index = args.index("--wheel-dir") + 1
            wheels = Path(args[wheel_index])
            (wheels / "labos-0.1.0-py3-none-any.whl").write_bytes(b"wheel")
        if len(args) >= 3 and args[1:3] == ["-m", "venv"]:
            venv = Path(args[3])
            scripts = venv / "Scripts"
            scripts.mkdir(parents=True)
            (scripts / "python.exe").write_text("python", encoding="utf-8")
            (scripts / "labos.exe").write_text("cli", encoding="utf-8")
        if args and str(args[0]).endswith("labos.exe") and "--help" in args:
            calls["cli_help"] += 1
            if fail_final_cli and calls["cli_help"] == 2:
                raise RuntimeError("simulated verification failure")

    monkeypatch.setattr(install, "run", fake_run)
    monkeypatch.setattr(install.shutil, "which", lambda command: f"/fake/{command}")
    return calls


def _vault(tmp_path: Path) -> Path:
    vault = tmp_path / "Vault with spaces"
    (vault / ".obsidian").mkdir(parents=True)
    return vault


def test_installer_repeated_update_preserves_settings_and_updates_managed_files(tmp_path, monkeypatch):
    vault = _vault(tmp_path)
    local = tmp_path / "local data"
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setattr(install.sys, "argv", ["install.py", str(vault)])
    _mock_commands(monkeypatch)
    assert install.main() == 0
    plugin = vault / ".obsidian" / "plugins" / install.PLUGIN_NAME
    settings = {"home": "D:/evidence", "executable": "custom-labos"}
    (plugin / "data.json").write_text(json.dumps(settings), encoding="utf-8")
    (plugin / "user-note.txt").write_text("retain", encoding="utf-8")
    assert install.main() == 0
    assert json.loads((plugin / "data.json").read_text(encoding="utf-8")) == settings
    assert (plugin / "user-note.txt").read_text(encoding="utf-8") == "retain"
    assert (plugin / "main.js").is_file()


def test_installer_restores_previous_files_when_replacement_verification_fails(tmp_path, monkeypatch):
    vault = _vault(tmp_path)
    local = tmp_path / "managed"
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setattr(install.sys, "argv", ["install.py", str(vault)])
    _mock_commands(monkeypatch)
    assert install.main() == 0
    plugin = vault / ".obsidian" / "plugins" / install.PLUGIN_NAME
    old_main = plugin / "main.js"
    old_main.write_text("previous plugin", encoding="utf-8")
    old_venv = local / "LabOS" / "venv"
    sentinel = old_venv / "sentinel.txt"
    sentinel.write_text("previous cli", encoding="utf-8")
    _mock_commands(monkeypatch, fail_final_cli=True)
    with pytest.raises(RuntimeError, match="simulated"):
        install.main()
    assert old_main.read_text(encoding="utf-8") == "previous plugin"
    assert sentinel.read_text(encoding="utf-8") == "previous cli"


def test_installer_rejects_non_vault_without_touching_it(tmp_path, monkeypatch):
    fake = tmp_path / "not a vault"
    fake.mkdir()
    monkeypatch.setattr(install.sys, "argv", ["install.py", str(fake)])
    with pytest.raises(SystemExit, match="Not an Obsidian vault"):
        install.main()
    assert list(fake.iterdir()) == []


def test_rename_retry_recovers_from_transient_windows_lock(tmp_path, monkeypatch):
    source = tmp_path / "stage"
    target = tmp_path / "managed"
    source.mkdir()
    target_path = target
    original_rename = Path.rename
    calls = 0

    def fail_twice(path, destination):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise PermissionError("temporary file lock")
        return original_rename(path, destination)

    monkeypatch.setattr(Path, "rename", fail_twice)
    monkeypatch.setattr(install.time, "sleep", lambda _delay: None)
    install.rename_with_retry(source, target_path)
    assert target.is_dir()
    assert calls == 3


def test_failed_rollback_keeps_previous_cli_backup_recoverable(tmp_path, monkeypatch):
    vault = _vault(tmp_path)
    local = tmp_path / "managed"
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setattr(install.sys, "argv", ["install.py", str(vault)])
    _mock_commands(monkeypatch)
    assert install.main() == 0
    plugin = vault / ".obsidian" / "plugins" / install.PLUGIN_NAME
    old_main = plugin / "main.js"
    old_main.write_text("previous plugin", encoding="utf-8")
    managed_venv = local / "LabOS" / "venv"
    (managed_venv / "sentinel.txt").write_text("previous cli", encoding="utf-8")

    _mock_commands(monkeypatch, fail_final_cli=True)
    original_rename = install.rename_with_retry

    def fail_backup_restore(source, destination):
        if source.name.startswith("venv.backup-"):
            raise PermissionError("simulated locked recovery directory")
        return original_rename(source, destination)

    monkeypatch.setattr(install, "rename_with_retry", fail_backup_restore)
    with pytest.raises(RuntimeError, match="previous CLI remains at"):
        install.main()
    backups = list((local / "LabOS").glob("venv.backup-*"))
    assert len(backups) == 1
    assert (backups[0] / "sentinel.txt").read_text(encoding="utf-8") == "previous cli"
    assert old_main.read_text(encoding="utf-8") == "previous plugin"
