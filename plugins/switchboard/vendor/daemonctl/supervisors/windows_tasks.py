"""Windows supervisor. Registers a Scheduled Task from a generated XML definition.

schtasks command-line flags cannot express restart-on-failure or an unbounded
execution time limit, so the task is always defined as XML. Environment
variables have no place in the task schema either, so every task launches a
generated run.cmd that sets the environment and redirects the two log files.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import Supervisor, SupervisorError

TASK_FOLDER = "\\daemon-agent\\"


def _xml_escape(value: str) -> str:
    return (str(value).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


class WindowsTaskSupervisor(Supervisor):
    name = "schtasks"

    # ---- naming ---------------------------------------------------------
    def task_name(self, manifest) -> str:
        return TASK_FOLDER + manifest["slug"]

    def unit_path(self, manifest) -> Path:
        return Path(manifest["working_dir"]) / "task.xml"

    def _launcher_path(self, manifest) -> Path:
        return Path(manifest["working_dir"]) / "run.cmd"

    # ---- generated files ------------------------------------------------
    def _write_launcher(self, manifest) -> Path:
        env = self.env_block(manifest)
        lines = ["@echo off", "setlocal"]
        for key, value in env.items():
            lines.append('set "%s=%s"' % (key, value))
        args = self.program_args(manifest)
        command = " ".join('"%s"' % a for a in args)
        lines.append('cd /d "%s"' % manifest["working_dir"])
        lines.append('%s >> "%s" 2>> "%s"'
                     % (command, manifest["stdout_log"], manifest["stderr_log"]))
        lines.append("exit /b %ERRORLEVEL%")
        path = self._launcher_path(manifest)
        path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
        return path

    def _render_xml(self, manifest) -> str:
        interval = int(manifest.get("interval_seconds") or 60)
        minutes = max(1, round(interval / 60))
        description = _xml_escape(manifest.get("description") or manifest["slug"])
        launcher = _xml_escape(str(self._launcher_path(manifest)))
        workdir = _xml_escape(manifest["working_dir"])

        if manifest["mode"] == "interval":
            trigger = (
                "    <LogonTrigger>\n"
                "      <Enabled>true</Enabled>\n"
                "      <Repetition>\n"
                "        <Interval>PT%dM</Interval>\n"
                "        <StopAtDurationEnd>false</StopAtDurationEnd>\n"
                "      </Repetition>\n"
                "    </LogonTrigger>\n" % minutes
            )
            restart = ""
            instances = "IgnoreNew"
        else:
            trigger = "    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>\n"
            restart = (
                "    <RestartOnFailure>\n"
                "      <Interval>PT1M</Interval>\n"
                "      <Count>999</Count>\n"
                "    </RestartOnFailure>\n"
            )
            instances = "IgnoreNew"

        return (
            '<?xml version="1.0" encoding="UTF-16"?>\n'
            '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
            "  <RegistrationInfo>\n"
            "    <Description>%s</Description>\n"
            "    <URI>%s</URI>\n"
            "  </RegistrationInfo>\n"
            "  <Triggers>\n%s  </Triggers>\n"
            "  <Principals>\n"
            '    <Principal id="Author">\n'
            "      <LogonType>InteractiveToken</LogonType>\n"
            "      <RunLevel>LeastPrivilege</RunLevel>\n"
            "    </Principal>\n"
            "  </Principals>\n"
            "  <Settings>\n"
            "    <MultipleInstancesPolicy>%s</MultipleInstancesPolicy>\n"
            "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n"
            "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n"
            "    <AllowHardTerminate>true</AllowHardTerminate>\n"
            "    <StartWhenAvailable>true</StartWhenAvailable>\n"
            "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n"
            "    <IdleSettings>\n"
            "      <StopOnIdleEnd>false</StopOnIdleEnd>\n"
            "      <RestartOnIdle>false</RestartOnIdle>\n"
            "    </IdleSettings>\n"
            "    <AllowStartOnDemand>true</AllowStartOnDemand>\n"
            "    <Enabled>true</Enabled>\n"
            "    <Hidden>true</Hidden>\n"
            "    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n"
            "    <WakeToRun>false</WakeToRun>\n"
            "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n"
            "    <Priority>7</Priority>\n%s"
            "  </Settings>\n"
            '  <Actions Context="Author">\n'
            "    <Exec>\n"
            "      <Command>%s</Command>\n"
            "      <WorkingDirectory>%s</WorkingDirectory>\n"
            "    </Exec>\n"
            "  </Actions>\n"
            "</Task>\n"
            % (description, _xml_escape(self.task_name(manifest)), trigger,
               instances, restart, launcher, workdir)
        )

    # ---- lifecycle -----------------------------------------------------
    def install(self, manifest) -> Path:
        if manifest["mode"] == "interval" and int(manifest["interval_seconds"]) < 60:
            raise SupervisorError(
                "Windows Task Scheduler cannot repeat faster than 60s. "
                "Use mode 'service' with an in-process loop for this daemon."
            )
        self._write_launcher(manifest)
        xml_path = self.unit_path(manifest)
        # schtasks only accepts UTF-16 XML with a BOM.
        xml_path.write_text(self._render_xml(manifest), encoding="utf-16")
        self.run(["schtasks", "/Delete", "/TN", self.task_name(manifest), "/F"])
        self.run(["schtasks", "/Create", "/TN", self.task_name(manifest),
                  "/XML", str(xml_path), "/F"], check=True)
        if manifest["mode"] == "service":
            self.kick(manifest)
        return xml_path

    def uninstall(self, manifest) -> None:
        self.run(["schtasks", "/End", "/TN", self.task_name(manifest)])
        self.run(["schtasks", "/Delete", "/TN", self.task_name(manifest), "/F"])
        for path in (self.unit_path(manifest), self._launcher_path(manifest)):
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def start(self, manifest) -> None:
        self.run(["schtasks", "/Change", "/TN", self.task_name(manifest), "/ENABLE"],
                 check=True)
        if manifest["mode"] == "service":
            self.kick(manifest)

    def stop(self, manifest) -> None:
        self.run(["schtasks", "/End", "/TN", self.task_name(manifest)])
        self.run(["schtasks", "/Change", "/TN", self.task_name(manifest), "/DISABLE"])

    def kick(self, manifest) -> None:
        self.run(["schtasks", "/Run", "/TN", self.task_name(manifest)], check=True)

    # ---- introspection -------------------------------------------------
    def status(self, manifest) -> dict:
        proc = self.run(["schtasks", "/Query", "/TN", self.task_name(manifest),
                         "/FO", "LIST", "/V"])
        if proc.returncode != 0:
            return {"loaded": False, "running": False, "last_exit": None,
                    "detail": "task not registered"}
        text = proc.stdout
        status = self._field(text, "Status")
        last_result = self._field(text, "Last Result")
        try:
            last_exit = int(last_result) if last_result is not None else None
        except ValueError:
            last_exit = None
        scheduled = self._field(text, "Scheduled Task State") or ""
        return {
            "loaded": scheduled.strip().lower() != "disabled",
            "running": (status or "").strip().lower() == "running",
            "pid": None,
            "last_exit": last_exit,
            "detail": "%s / %s" % (scheduled.strip() or "unknown",
                                   (status or "unknown").strip()),
        }

    @staticmethod
    def _field(text: str, label: str):
        match = re.search(r"^%s:\s*(.+)$" % re.escape(label), text, re.M)
        return match.group(1).strip() if match else None
