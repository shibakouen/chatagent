# daemonctl (vendored)

This is daemon-agent's daemonctl and worker runtime, vendored so chatagent installs on any machine without a second plugin. It turns a Python worker into a launchd, systemd user or Task Scheduler service with heartbeats, health checks, logs and clean removal. chatagent uses it for watchers and the always-on keepalive. Keep it in sync with the daemon-agent plugin rather than editing it here.
