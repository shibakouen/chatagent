"""Linux supervisor. Writes systemd --user units and drives them with systemctl.

Interval daemons get a oneshot .service plus a .timer. Service daemons get a
single .service with Restart=always. Both live under ~/.config/systemd/user so
nothing needs root.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .base import Supervisor, SupervisorError


def _quote(value: str) -> str:
    return '"%s"' % str(value).replace('\\', '\\\\').replace('"', '\\"')


class SystemdSupervisor(Supervisor):
    name = "systemd"

    # ---- paths ---------------------------------------------------------
    def _unit_dir(self) -> Path:
        return Path.home() / ".config" / "systemd" / "user"

    def _service_name(self, manifest) -> str:
        return "daemon-agent-%s.service" % manifest["slug"]

    def _timer_name(self, manifest) -> str:
        return "daemon-agent-%s.timer" % manifest["slug"]

    def unit_path(self, manifest) -> Path:
        return self._unit_dir() / self._service_name(manifest)

    def _timer_path(self, manifest) -> Path:
        return self._unit_dir() / self._timer_name(manifest)

    def _primary_unit(self, manifest) -> str:
        return self._timer_name(manifest) if manifest["mode"] == "interval" \
            else self._service_name(manifest)

    def _systemctl(self, *args, check=False):
        return self.run(["systemctl", "--user"] + list(args), check=check)

    # ---- unit rendering -------------------------------------------------
    def _render_service(self, manifest) -> str:
        env_lines = "\n".join(
            "Environment=%s=%s" % (k, v) for k, v in self.env_block(manifest).items()
        )
        exec_start = " ".join(_quote(a) for a in self.program_args(manifest))
        lines = [
            "[Unit]",
            "Description=%s" % (manifest.get("description") or manifest["slug"]),
            "Documentation=https://github.com/daemon-agent",
            "",
            "[Service]",
            "ExecStart=%s" % exec_start,
            "WorkingDirectory=%s" % manifest["working_dir"],
            env_lines,
            "StandardOutput=append:%s" % manifest["stdout_log"],
            "StandardError=append:%s" % manifest["stderr_log"],
        ]
        if manifest["mode"] == "service":
            lines += [
                "Type=simple",
                "Restart=always",
                "RestartSec=%d" % int(manifest.get("restart_delay_seconds", 10)),
                # Stop systemd from giving up permanently on a flapping worker.
                "StartLimitIntervalSec=0",
                "",
                "[Install]",
                "WantedBy=default.target",
            ]
        else:
            lines += ["Type=oneshot"]
        return "\n".join(l for l in lines if l is not None) + "\n"

    def _render_timer(self, manifest) -> str:
        interval = int(manifest["interval_seconds"])
        return "\n".join([
            "[Unit]",
            "Description=timer for %s" % manifest["slug"],
            "",
            "[Timer]",
            "OnBootSec=%ds" % min(interval, 120),
            "OnUnitActiveSec=%ds" % interval,
            "AccuracySec=1s",
            "Persistent=true",
            "Unit=%s" % self._service_name(manifest),
            "",
            "[Install]",
            "WantedBy=timers.target",
            "",
        ])

    # ---- lifecycle -----------------------------------------------------
    def install(self, manifest) -> Path:
        unit_dir = self._unit_dir()
        unit_dir.mkdir(parents=True, exist_ok=True)
        service_path = self.unit_path(manifest)
        service_path.write_text(self._render_service(manifest), encoding="utf-8")
        if manifest["mode"] == "interval":
            self._timer_path(manifest).write_text(self._render_timer(manifest),
                                                  encoding="utf-8")
        self._systemctl("daemon-reload", check=True)
        proc = self._systemctl("enable", "--now", self._primary_unit(manifest))
        if proc.returncode != 0:
            raise SupervisorError(
                "systemctl enable failed: %s\n"
                "On a headless box run: loginctl enable-linger $USER"
                % proc.stderr.strip()
            )
        self._enable_linger()
        return service_path

    def _enable_linger(self) -> None:
        """Keep user units running when nobody is logged in. Best effort."""
        if not shutil.which("loginctl"):
            return
        import getpass
        self.run(["loginctl", "enable-linger", getpass.getuser()])

    def uninstall(self, manifest) -> None:
        primary = self._primary_unit(manifest)
        self._systemctl("disable", "--now", primary)
        self._systemctl("stop", self._service_name(manifest))
        for path in (self.unit_path(manifest), self._timer_path(manifest)):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        self._systemctl("daemon-reload")
        self._systemctl("reset-failed", self._service_name(manifest))

    def start(self, manifest) -> None:
        self._systemctl("enable", "--now", self._primary_unit(manifest), check=True)

    def stop(self, manifest) -> None:
        self._systemctl("disable", "--now", self._primary_unit(manifest))
        self._systemctl("stop", self._service_name(manifest))

    def kick(self, manifest) -> None:
        self._systemctl("start", self._service_name(manifest), check=True)

    # ---- introspection -------------------------------------------------
    def status(self, manifest) -> dict:
        primary = self._primary_unit(manifest)
        enabled = self._systemctl("is-enabled", primary).stdout.strip()
        active = self._systemctl("is-active", self._service_name(manifest)).stdout.strip()
        props = self._systemctl(
            "show", self._service_name(manifest),
            "-p", "MainPID", "-p", "ExecMainStatus", "-p", "Result",
        ).stdout
        values = dict(
            line.split("=", 1) for line in props.strip().splitlines() if "=" in line
        )
        pid = int(values.get("MainPID", "0") or 0)
        try:
            last_exit = int(values.get("ExecMainStatus", "")) if values.get("ExecMainStatus") else None
        except ValueError:
            last_exit = None
        return {
            "loaded": enabled in ("enabled", "enabled-runtime", "static", "linked"),
            "running": active == "active" and pid > 0,
            "pid": pid or None,
            "last_exit": last_exit,
            "detail": "%s / %s (%s)" % (enabled or "unknown", active or "unknown",
                                        values.get("Result", "")),
        }
