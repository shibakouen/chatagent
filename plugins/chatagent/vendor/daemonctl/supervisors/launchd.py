"""macOS supervisor. Writes a LaunchAgent plist and drives it with launchctl."""

from __future__ import annotations

import os
import plistlib
import re
from pathlib import Path

from .base import Supervisor, SupervisorError


class LaunchdSupervisor(Supervisor):
    name = "launchd"

    # ---- paths ---------------------------------------------------------
    def unit_path(self, manifest) -> Path:
        return Path.home() / "Library" / "LaunchAgents" / (self.label(manifest) + ".plist")

    def _domain(self) -> str:
        return "gui/%d" % os.getuid()

    def _target(self, manifest) -> str:
        return "%s/%s" % (self._domain(), self.label(manifest))

    # ---- lifecycle -----------------------------------------------------
    def install(self, manifest) -> Path:
        plist = {
            "Label": self.label(manifest),
            "ProgramArguments": self.program_args(manifest),
            "WorkingDirectory": manifest["working_dir"],
            "EnvironmentVariables": self.env_block(manifest),
            "StandardOutPath": manifest["stdout_log"],
            "StandardErrorPath": manifest["stderr_log"],
            "ProcessType": "Background",
        }
        if manifest["mode"] == "service":
            plist["RunAtLoad"] = True
            plist["KeepAlive"] = {"SuccessfulExit": False, "Crashed": True}
            plist["ThrottleInterval"] = int(manifest.get("restart_delay_seconds", 10))
        else:
            interval = int(manifest["interval_seconds"])
            plist["StartInterval"] = interval
            # A missed interval (laptop asleep) should fire once on wake, not
            # immediately at install time for a job that only runs nightly.
            plist["RunAtLoad"] = interval <= 3600

        path = self.unit_path(manifest)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(str(path), "wb") as fh:
            plistlib.dump(plist, fh)

        # bootout first so re-install picks up edits instead of silently keeping
        # the old definition loaded.
        self.run(["launchctl", "bootout", self._target(manifest)])
        proc = self.run(["launchctl", "bootstrap", self._domain(), str(path)])
        if proc.returncode != 0:
            legacy = self.run(["launchctl", "load", "-w", str(path)])
            if legacy.returncode != 0:
                raise SupervisorError(
                    "launchctl could not load %s\nbootstrap: %s\nload: %s"
                    % (path, proc.stderr.strip(), legacy.stderr.strip())
                )
        return path

    def uninstall(self, manifest) -> None:
        self.run(["launchctl", "bootout", self._target(manifest)])
        path = self.unit_path(manifest)
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    def start(self, manifest) -> None:
        path = self.unit_path(manifest)
        if not path.exists():
            raise SupervisorError("not installed: %s" % path)
        self.run(["launchctl", "bootstrap", self._domain(), str(path)])
        self.run(["launchctl", "enable", self._target(manifest)])
        if manifest["mode"] == "service":
            self.run(["launchctl", "kickstart", "-k", self._target(manifest)])

    def stop(self, manifest) -> None:
        self.run(["launchctl", "bootout", self._target(manifest)])

    def kick(self, manifest) -> None:
        # -k restarts a running job, which for an interval daemon would SIGTERM
        # work already in flight. Only a service wants that.
        cmd = ["launchctl", "kickstart"]
        if manifest["mode"] == "service":
            cmd.append("-k")
        proc = self.run(cmd + [self._target(manifest)])
        if proc.returncode != 0:
            raise SupervisorError("kickstart failed: %s" % proc.stderr.strip())

    # ---- introspection -------------------------------------------------
    def status(self, manifest) -> dict:
        proc = self.run(["launchctl", "print", self._target(manifest)])
        if proc.returncode != 0:
            return {"loaded": False, "running": False, "last_exit": None,
                    "detail": "not loaded in %s" % self._domain()}
        text = proc.stdout
        pid_match = re.search(r"^\s*pid\s*=\s*(\d+)", text, re.M)
        exit_match = re.search(r"^\s*last exit code\s*=\s*(\S+)", text, re.M)
        last_exit = None
        if exit_match and exit_match.group(1).isdigit():
            last_exit = int(exit_match.group(1))
        state = re.search(r"^\s*state\s*=\s*(\S+)", text, re.M)
        return {
            "loaded": True,
            "running": bool(pid_match),
            "pid": int(pid_match.group(1)) if pid_match else None,
            "last_exit": last_exit,
            "detail": (state.group(1) if state else "loaded"),
        }
