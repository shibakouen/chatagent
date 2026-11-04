"""daemon_runtime.py — the contract every daemon-agent worker runs on.

Standard library only. Python 3.8+. macOS, Linux and Windows.

A worker is a Python file that ends with one of:

    from daemon_runtime import run_once
    run_once(main)          # supervisor re-invokes on a schedule

    from daemon_runtime import serve
    serve(main, interval=5) # one long-lived process, own loop

`main(ctx)` receives a Ctx and may raise. Anything it raises is logged,
counted, and turned into a non-zero exit so the supervisor sees a failure.

Everything a worker needs lives on ctx:

    ctx.log.info("msg", key=value)     structured JSONL
    ctx.state                          dict, persisted atomically after main()
    ctx.secret("SLACK_TOKEN")          env -> secrets.env -> OS keychain
    ctx.seen(key)                      bounded dedup set, survives restarts
    ctx.fetch(url, ...)                urllib with retries and backoff
    ctx.stopping                       True once SIGTERM arrived (serve mode)
"""

from __future__ import annotations

import errno
import json
import os
import platform
import random
import signal
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
IS_WINDOWS = platform.system() == "Windows"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_KEEP = 3
DEDUP_MAX = 5000


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

def home() -> Path:
    """Root of all daemon-agent state. Override with DAEMON_AGENT_HOME."""
    override = os.environ.get("DAEMON_AGENT_HOME")
    root = Path(override).expanduser() if override else Path.home() / ".daemon-agent"
    return root


def daemons_dir() -> Path:
    return home() / "daemons"


def daemon_dir(slug: str) -> Path:
    return daemons_dir() / slug


def registry_path() -> Path:
    return home() / "registry.json"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# atomic io
# --------------------------------------------------------------------------

def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp-%d" % os.getpid())
    tmp.write_text(text, encoding="utf-8")
    os.replace(str(tmp), str(path))


def atomic_write_json(path: Path, obj) -> None:
    atomic_write_text(path, json.dumps(obj, indent=2, ensure_ascii=False, default=str))


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {} if default is None else default


# --------------------------------------------------------------------------
# single instance lock
# --------------------------------------------------------------------------

class AlreadyRunning(RuntimeError):
    pass


class SingleInstanceLock:
    """Advisory exclusive lock on a file. Prevents a slow run overlapping the next.

    POSIX uses fcntl.flock, Windows uses msvcrt.locking. Both are released when
    the process dies, so a crashed daemon never wedges its own lock.
    """

    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(str(self.path), "a+")
        try:
            if IS_WINDOWS:
                import msvcrt

                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError) as exc:
            self._fh.close()
            self._fh = None
            if getattr(exc, "errno", None) in (errno.EACCES, errno.EAGAIN, errno.EDEADLK, 13, 36):
                raise AlreadyRunning("another run of this daemon holds the lock")
            raise
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(str(os.getpid()))
        self._fh.flush()
        return self

    def __exit__(self, *exc):
        if self._fh is None:
            return False
        try:
            if IS_WINDOWS:
                import msvcrt

                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self._fh.close()
        self._fh = None
        return False


# --------------------------------------------------------------------------
# structured logging
# --------------------------------------------------------------------------

class Log:
    """Size-rotated JSONL. One object per line so `daemonctl logs` can filter."""

    def __init__(self, path: Path, slug: str, echo: bool = False):
        self.path = path
        self.slug = slug
        self.echo = echo
        path.parent.mkdir(parents=True, exist_ok=True)

    def _rotate_if_needed(self) -> None:
        try:
            if self.path.stat().st_size < LOG_MAX_BYTES:
                return
        except FileNotFoundError:
            return
        for i in range(LOG_KEEP - 1, 0, -1):
            older = self.path.with_name(self.path.name + ".%d" % i)
            newer = self.path.with_name(self.path.name + ".%d" % (i + 1))
            if older.exists():
                os.replace(str(older), str(newer))
        os.replace(str(self.path), str(self.path.with_name(self.path.name + ".1")))

    def emit(self, level: str, msg: str, **fields) -> None:
        self._rotate_if_needed()
        record = {"ts": utcnow(), "level": level, "daemon": self.slug, "msg": msg}
        for key, value in fields.items():
            if key not in record:
                record[key] = value
        line = json.dumps(record, ensure_ascii=False, default=str)
        with open(str(self.path), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        if self.echo:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()

    def debug(self, msg: str, **f): self.emit("debug", msg, **f)

    def info(self, msg: str, **f): self.emit("info", msg, **f)

    def warn(self, msg: str, **f): self.emit("warn", msg, **f)

    def error(self, msg: str, **f): self.emit("error", msg, **f)


# --------------------------------------------------------------------------
# secrets
# --------------------------------------------------------------------------

def _secrets_env_file() -> Path:
    return home() / "secrets.env"


def _read_secrets_file() -> dict:
    path = _secrets_env_file()
    out = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return out
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def _keychain_lookup(name: str):
    """Best-effort OS keychain read. Returns None when unavailable."""
    system = platform.system()
    try:
        if system == "Darwin":
            proc = subprocess.run(
                ["security", "find-generic-password", "-s", "daemon-agent",
                 "-a", name, "-w"],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.strip()
        elif system == "Linux":
            proc = subprocess.run(
                ["secret-tool", "lookup", "service", "daemon-agent", "account", name],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return None


class MissingSecret(RuntimeError):
    pass


def get_secret(name: str, required: bool = True, default=None):
    """env var -> ~/.daemon-agent/secrets.env -> OS keychain."""
    value = os.environ.get(name)
    if value:
        return value
    value = _read_secrets_file().get(name)
    if value:
        return value
    value = _keychain_lookup(name)
    if value:
        return value
    if required and default is None:
        raise MissingSecret(
            "secret %r not found. Add it with: daemonctl secret set %s <value>" % (name, name)
        )
    return default


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class HttpError(RuntimeError):
    def __init__(self, status, body, url):
        super().__init__("HTTP %s for %s: %s" % (status, url, str(body)[:400]))
        self.status = status
        self.body = body
        self.url = url


def fetch(url, method="GET", headers=None, data=None, json_body=None,
          timeout=30, retries=3, backoff=1.5, parse_json=True, log=None):
    """urllib with retry on 429/5xx and network errors. Honours Retry-After."""
    headers = dict(headers or {})
    body = None
    if json_body is not None:
        body = json.dumps(json_body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    elif isinstance(data, dict):
        body = urllib.parse.urlencode(data).encode("utf-8")
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif isinstance(data, (bytes, bytearray)):
        body = bytes(data)
    elif isinstance(data, str):
        body = data.encode("utf-8")
    headers.setdefault("User-Agent", "daemon-agent/1.0")

    last_exc = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                text = raw.decode("utf-8", "replace")
                if parse_json and text.strip():
                    try:
                        return json.loads(text)
                    except ValueError:
                        return text
                return text
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            retryable = exc.code == 429 or 500 <= exc.code < 600
            if not retryable or attempt == retries:
                raise HttpError(exc.code, raw, url)
            wait = float(exc.headers.get("Retry-After") or 0) or (backoff ** attempt)
            last_exc = exc
        except (urllib.error.URLError, OSError) as exc:
            if attempt == retries:
                raise
            wait = backoff ** attempt
            last_exc = exc
        wait = min(wait, 60) + random.uniform(0, 0.5)
        if log:
            log.warn("http retry", url=url, attempt=attempt, wait=round(wait, 2),
                     error=str(last_exc)[:200])
        time.sleep(wait)
    raise last_exc  # unreachable in practice


# --------------------------------------------------------------------------
# context
# --------------------------------------------------------------------------

class Ctx:
    def __init__(self, slug: str, echo: bool = False):
        self.slug = slug
        self.dir = daemon_dir(slug)
        self.manifest = read_json(self.dir / "manifest.json", {})
        self.config = self.manifest.get("config", {}) or {}
        self.log = Log(self.dir / "logs" / "daemon.log", slug, echo=echo)
        self._state_path = self.dir / "state.json"
        self.state = read_json(self._state_path, {})
        self.state.setdefault("_dedup", [])
        self.stopping = False
        self.started = time.time()

    # ---- state ----------------------------------------------------------
    def save_state(self) -> None:
        dedup = self.state.get("_dedup") or []
        if len(dedup) > DEDUP_MAX:
            self.state["_dedup"] = dedup[-DEDUP_MAX:]
        atomic_write_json(self._state_path, self.state)

    def seen(self, key: str) -> bool:
        """True if this key was already processed. Records it either way."""
        key = str(key)
        dedup = self.state.setdefault("_dedup", [])
        if key in dedup:
            return True
        dedup.append(key)
        return False

    # ---- helpers --------------------------------------------------------
    def secret(self, name: str, required: bool = True, default=None):
        return get_secret(name, required=required, default=default)

    def fetch(self, url, **kw):
        kw.setdefault("log", self.log)
        return fetch(url, **kw)

    def path(self, value: str) -> Path:
        """Expand a user-supplied path from config (~ and env vars)."""
        return Path(os.path.expandvars(str(value))).expanduser()

    def sleep(self, seconds: float) -> None:
        """Interruptible sleep. Returns early once SIGTERM has arrived."""
        deadline = time.time() + seconds
        while not self.stopping and time.time() < deadline:
            time.sleep(min(0.25, max(0.0, deadline - time.time())))


# --------------------------------------------------------------------------
# heartbeat
# --------------------------------------------------------------------------

def _write_heartbeat(slug: str, **fields) -> None:
    path = daemon_dir(slug) / "heartbeat.json"
    beat = read_json(path, {})
    beat.update(fields)
    beat["schema"] = SCHEMA_VERSION
    beat["pid"] = os.getpid()
    beat["host"] = platform.node()
    atomic_write_json(path, beat)


def _bump(slug: str, key: str) -> int:
    path = daemon_dir(slug) / "heartbeat.json"
    beat = read_json(path, {})
    value = int(beat.get(key, 0)) + 1
    return value


# --------------------------------------------------------------------------
# entrypoints
# --------------------------------------------------------------------------

def _slug_from_argv_or_cwd() -> str:
    for i, arg in enumerate(sys.argv):
        if arg == "--slug" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    env = os.environ.get("DAEMON_SLUG")
    if env:
        return env
    return Path(sys.argv[0]).resolve().parent.name


def _install_signal_handlers(ctx: Ctx) -> None:
    def handler(signum, frame):
        ctx.stopping = True
        ctx.log.info("stop signal received", signal=int(signum))

    for name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass


def run_once(main, slug=None, echo=None) -> None:
    """Entrypoint for interval daemons. The supervisor re-invokes on schedule."""
    slug = slug or _slug_from_argv_or_cwd()
    echo = ("--echo" in sys.argv) if echo is None else echo
    ctx = Ctx(slug, echo=echo)
    _install_signal_handlers(ctx)
    started = time.time()
    _write_heartbeat(slug, last_run_start=utcnow(), runs=_bump(slug, "runs"))
    ctx.log.info("run start", mode="interval")
    try:
        with SingleInstanceLock(ctx.dir / "run.lock"):
            result = main(ctx)
    except AlreadyRunning:
        ctx.log.warn("skipped: previous run still going")
        _write_heartbeat(slug, last_run_end=utcnow(), last_skip=utcnow())
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001 - the supervisor needs the exit code
        ctx.log.error("run failed", error=str(exc), type=type(exc).__name__,
                      traceback=traceback.format_exc(limit=8))
        try:
            ctx.save_state()
        except Exception:
            pass
        _write_heartbeat(slug, last_run_end=utcnow(), last_error=utcnow(),
                         last_error_message=str(exc)[:500],
                         failures=_bump(slug, "failures"))
        sys.exit(1)
    ctx.save_state()
    duration = round(time.time() - started, 3)
    _write_heartbeat(slug, last_run_end=utcnow(), last_success=utcnow(),
                     last_duration_s=duration, last_error_message=None)
    ctx.log.info("run ok", duration_s=duration,
                 result=result if isinstance(result, (dict, int, str)) else None)
    sys.exit(0)


def serve(main, interval=None, slug=None, echo=None) -> None:
    """Entrypoint for long-lived daemons.

    If `interval` is set, main(ctx) is called in a loop with that gap and each
    pass heartbeats. If it is None, main(ctx) is expected to block until
    ctx.stopping and heartbeat itself via ctx_beat().
    """
    slug = slug or _slug_from_argv_or_cwd()
    echo = ("--echo" in sys.argv) if echo is None else echo
    ctx = Ctx(slug, echo=echo)
    _install_signal_handlers(ctx)
    ctx.beat = lambda **f: _write_heartbeat(slug, last_success=utcnow(), **f)  # type: ignore[attr-defined]
    ctx.log.info("service start", mode="service", interval=interval)
    _write_heartbeat(slug, service_start=utcnow(), runs=_bump(slug, "runs"))
    try:
        with SingleInstanceLock(ctx.dir / "run.lock"):
            if interval is None:
                main(ctx)
            else:
                consecutive_failures = 0
                while not ctx.stopping:
                    cycle = time.time()
                    try:
                        main(ctx)
                        consecutive_failures = 0
                        ctx.save_state()
                        _write_heartbeat(
                            slug, last_success=utcnow(),
                            last_duration_s=round(time.time() - cycle, 3),
                            last_error_message=None,
                        )
                    except Exception as exc:  # noqa: BLE001
                        consecutive_failures += 1
                        ctx.log.error("cycle failed", error=str(exc),
                                      type=type(exc).__name__,
                                      consecutive_failures=consecutive_failures,
                                      traceback=traceback.format_exc(limit=8))
                        _write_heartbeat(slug, last_error=utcnow(),
                                         last_error_message=str(exc)[:500],
                                         failures=_bump(slug, "failures"))
                        if consecutive_failures >= 10:
                            ctx.log.error("giving up after 10 consecutive failures")
                            sys.exit(1)
                    backoff = min(interval * (2 ** min(consecutive_failures, 5)), 900) \
                        if consecutive_failures else interval
                    ctx.sleep(backoff)
    except AlreadyRunning:
        ctx.log.warn("another instance is already serving")
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        ctx.log.error("service crashed", error=str(exc), type=type(exc).__name__,
                      traceback=traceback.format_exc(limit=8))
        _write_heartbeat(slug, last_error=utcnow(), last_error_message=str(exc)[:500],
                         failures=_bump(slug, "failures"))
        sys.exit(1)
    ctx.save_state()
    ctx.log.info("service stopped cleanly")
    _write_heartbeat(slug, service_stop=utcnow())
    sys.exit(0)
