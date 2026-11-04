"""Supervisor interface shared by launchd, systemd and Windows Task Scheduler.

A supervisor's only job is to make the OS run `python worker.py` on the right
schedule, restart it when it dies, and start it again after a reboot. All state,
logging and retry logic lives in daemon_runtime, so the three implementations
stay thin and comparable.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


class SupervisorError(RuntimeError):
    pass


class Supervisor:
    name = "base"

    # ---- required interface -------------------------------------------
    def unit_path(self, manifest) -> Path:
        raise NotImplementedError

    def install(self, manifest) -> Path:
        """Write the unit file and load it. Idempotent."""
        raise NotImplementedError

    def uninstall(self, manifest) -> None:
        """Unload and delete the unit file. Must not raise if already gone."""
        raise NotImplementedError

    def start(self, manifest) -> None:
        raise NotImplementedError

    def stop(self, manifest) -> None:
        raise NotImplementedError

    def status(self, manifest) -> dict:
        """{'loaded': bool, 'running': bool, 'last_exit': int|None, 'detail': str}"""
        raise NotImplementedError

    def kick(self, manifest) -> None:
        """Force a run right now, outside the schedule."""
        raise NotImplementedError

    # ---- helpers -------------------------------------------------------
    @staticmethod
    def run(cmd, check=False, timeout=60):
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )
        if check and proc.returncode != 0:
            raise SupervisorError(
                "%s failed (%d)\nstdout: %s\nstderr: %s"
                % (" ".join(str(c) for c in cmd), proc.returncode,
                   proc.stdout.strip(), proc.stderr.strip())
            )
        return proc

    @staticmethod
    def label(manifest) -> str:
        return manifest.get("label") or ("com.daemon-agent." + manifest["slug"])

    @staticmethod
    def env_block(manifest) -> dict:
        """Environment handed to the worker.

        PATH is pinned because launchd and systemd start with an almost empty
        one, which is the single most common reason a daemon that works in a
        terminal does nothing once installed.
        """
        python_bin = str(Path(manifest["python"]).parent)
        base_path = os.pathsep.join([
            python_bin,
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
            "/usr/sbin", "/sbin",
        ]) if platform.system() != "Windows" else os.environ.get("PATH", "")
        env = {
            "PATH": base_path,
            "HOME": str(Path.home()),
            "DAEMON_SLUG": manifest["slug"],
            "PYTHONUNBUFFERED": "1",
        }
        if os.environ.get("DAEMON_AGENT_HOME"):
            env["DAEMON_AGENT_HOME"] = os.environ["DAEMON_AGENT_HOME"]
        env.update(manifest.get("env", {}) or {})
        return env

    @staticmethod
    def program_args(manifest) -> list:
        return [manifest["python"], manifest["worker"], "--slug", manifest["slug"]]


def detect(force=None) -> Supervisor:
    """Pick the supervisor for this machine."""
    system = force or platform.system()
    if system == "Darwin":
        from . import launchd
        return launchd.LaunchdSupervisor()
    if system == "Linux":
        if not shutil.which("systemctl"):
            raise SupervisorError(
                "systemctl not found. daemon-agent needs systemd --user on Linux. "
                "On a container or a distro without systemd, run workers under "
                "supervisord or a process manager of your choice using "
                "`daemonctl show <slug> --command`."
            )
        from . import systemd
        return systemd.SystemdSupervisor()
    if system == "Windows":
        from . import windows_tasks
        return windows_tasks.WindowsTaskSupervisor()
    raise SupervisorError("unsupported platform: %s" % system)


def python_executable() -> str:
    """The interpreter to bake into the unit file.

    sys.executable is right when daemonctl runs from the same interpreter the
    worker should use. It is resolved to a real path because launchd and
    systemd will not follow a shim that depends on shell setup.
    """
    return str(Path(sys.executable).resolve())
