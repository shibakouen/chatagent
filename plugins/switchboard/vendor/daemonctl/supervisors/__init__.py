"""OS supervisors: launchd (macOS), systemd --user (Linux), schtasks (Windows)."""

from .base import Supervisor, SupervisorError, detect, python_executable  # noqa: F401
