from __future__ import annotations

"""Install/update LabOS CLI and Obsidian plugin: python install.py <vault-path>."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLUGIN_NAME = "labos-obsidian"


def run(args: list[str], cwd: Path) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def rename_with_retry(source: Path, destination: Path) -> None:
    last_error: PermissionError | None = None
    for attempt in range(5):
        try:
            source.rename(destination)
            return
        except PermissionError as exc:
            last_error = exc
            if attempt < 4:
                time.sleep(0.2)
    assert last_error is not None
    raise last_error


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python install.py "<vault-path>"')
    vault = Path(sys.argv[1]).expanduser().resolve()
    if not vault.is_dir() or not (vault / ".obsidian").is_dir():
        raise SystemExit(f"Not an Obsidian vault (missing .obsidian): {vault}")
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or newer is required")
    npm = shutil.which("npm")
    node = shutil.which("node")
    if not npm or not node:
        raise SystemExit("Node.js and npm are required to build the Obsidian plugin")

    plugin_source = ROOT / "obsidian"
    node_modules = plugin_source / "node_modules"
    dependencies_ready = node_modules.is_dir()
    if dependencies_ready:
        try:
            run([npm, "ls", "--depth=0"], plugin_source)
        except subprocess.CalledProcessError:
            dependencies_ready = False
    if not dependencies_ready:
        run([npm, "ci"], plugin_source)
    run([npm, "run", "build"], plugin_source)
    for name in ("main.js", "manifest.json", "styles.css"):
        if not (plugin_source / name).is_file():
            raise SystemExit(f"Plugin build did not produce {name}")

    data_root = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local")) / "LabOS"
    if not os.environ.get("LOCALAPPDATA") and os.name == "nt":
        data_root = Path.home() / "AppData" / "Local" / "LabOS"
    if data_root.resolve() == Path(data_root.anchor).resolve():
        raise SystemExit(f"Unsafe managed data directory: {data_root}")
    data_root.mkdir(parents=True, exist_ok=True)
    managed_venv = data_root / "venv"
    executable = managed_venv / ("Scripts/labos.exe" if os.name == "nt" else "bin/labos")
    with tempfile.TemporaryDirectory(prefix="labos-install-", dir=data_root) as temp_name:
        temp = Path(temp_name)
        wheels = temp / "wheels"
        wheels.mkdir()
        run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(wheels), str(ROOT)], ROOT)
        wheel_files = list(wheels.glob("labos-*.whl"))
        if len(wheel_files) != 1:
            raise SystemExit("Could not stage a single LabOS wheel")
        wheel = wheel_files[0]
        staged_venv = temp / "venv"
        run([sys.executable, "-m", "venv", str(staged_venv)], ROOT)
        staged_python = staged_venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        run([str(staged_python), "-m", "pip", "install", "--no-index", "--no-deps", str(wheel)], ROOT)
        staged_cli = staged_venv / ("Scripts/labos.exe" if os.name == "nt" else "bin/labos")
        run([str(staged_cli), "--help"], ROOT)

        plugin_dir = vault / ".obsidian" / "plugins" / PLUGIN_NAME
        plugin_dir.parent.mkdir(parents=True, exist_ok=True)
        if not plugin_dir.resolve().is_relative_to(vault):
            raise SystemExit(f"Plugin path escapes the selected vault: {plugin_dir}")
        plugin_temp = Path(tempfile.mkdtemp(prefix="labos-plugin-", dir=plugin_dir.parent))
        staged_plugin = plugin_temp / "plugin"
        staged_plugin.mkdir()
        backup_plugin = plugin_temp / "plugin.backup"
        backup_venv = data_root / ("venv.backup-" + uuid.uuid4().hex)
        had_plugin = plugin_dir.exists()
        had_venv = managed_venv.exists()
        if had_plugin:
            shutil.copytree(plugin_dir, staged_plugin, dirs_exist_ok=True)
        for name in ("main.js", "manifest.json", "styles.css"):
            shutil.copy2(plugin_source / name, staged_plugin / name)
        manifest = json.loads((staged_plugin / "manifest.json").read_text(encoding="utf-8"))
        settings_path = staged_plugin / "data.json"
        settings: dict[str, object] = {}
        if settings_path.exists():
            try:
                existing = json.loads(settings_path.read_text(encoding="utf-8"))
                if not isinstance(existing, dict):
                    raise ValueError("LabOS plugin settings must be a JSON object")
                settings = existing
            except (json.JSONDecodeError, OSError) as exc:
                shutil.rmtree(plugin_temp)
                raise SystemExit(f"Cannot preserve existing LabOS settings: {exc}") from exc
        custom_executable = str(settings.get("executable") or "")
        if not custom_executable or custom_executable == "labos":
            settings["executable"] = str(executable)
            settings_path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
        plugin_backed = venv_backed = plugin_installed = venv_installed = False
        preserve_plugin_temp = False
        installation_complete = False
        cleanup_notes: list[str] = []
        try:
            if had_plugin:
                rename_with_retry(plugin_dir, backup_plugin)
                plugin_backed = True
            if had_venv:
                rename_with_retry(managed_venv, backup_venv)
                venv_backed = True
            rename_with_retry(staged_venv, managed_venv)
            venv_installed = True
            installed_python = managed_venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            run([str(installed_python), "-m", "pip", "install", "--no-index", "--no-deps", "--force-reinstall", str(wheel)], ROOT)
            installed_cli = managed_venv / ("Scripts/labos.exe" if os.name == "nt" else "bin/labos")
            run([str(installed_cli), "--help"], ROOT)
            rename_with_retry(staged_plugin, plugin_dir)
            plugin_installed = True
            installation_complete = True
        except BaseException as original:
            recovery_errors: list[str] = []
            if plugin_installed and plugin_dir.exists():
                try:
                    shutil.rmtree(plugin_dir)
                except OSError as error:
                    recovery_errors.append(f"could not remove new plugin: {error}")
            if venv_installed and managed_venv.exists():
                try:
                    shutil.rmtree(managed_venv)
                except OSError as error:
                    recovery_errors.append(f"could not remove new CLI environment: {error}")
            if plugin_backed and backup_plugin.exists():
                try:
                    rename_with_retry(backup_plugin, plugin_dir)
                except OSError as error:
                    recovery_errors.append(f"previous plugin remains at {backup_plugin}: {error}")
            if venv_backed and backup_venv.exists():
                try:
                    rename_with_retry(backup_venv, managed_venv)
                except OSError as error:
                    recovery_errors.append(f"previous CLI remains at {backup_venv}: {error}")
            if backup_plugin.exists():
                preserve_plugin_temp = True
            if recovery_errors:
                raise RuntimeError("Installation failed and recovery needs attention: " + "; ".join(recovery_errors)) from original
            raise
        finally:
            if plugin_temp.exists() and not preserve_plugin_temp:
                shutil.rmtree(plugin_temp)
            if installation_complete:
                for backup in (backup_plugin, backup_venv):
                    if backup.exists():
                        try:
                            shutil.rmtree(backup)
                        except OSError as error:
                            cleanup_notes.append(f"Previous installation backup retained at {backup}: {error}")
    print(f"LabOS plugin: {plugin_dir}")
    print(f"LabOS CLI: {executable}")
    for note in cleanup_notes:
        print(note)
    print("Reload Obsidian. For a first install, enable LabOS under Community plugins.")
    if custom_executable and custom_executable != str(executable):
        print(f"Custom CLI path preserved: {custom_executable}. Update it separately if it points to an older LabOS install.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
