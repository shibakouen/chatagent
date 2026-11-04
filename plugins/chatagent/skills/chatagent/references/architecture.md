# How chatagent fits together

```
  Slack ──socket──▶ slack.mjs ─┐
  WhatsApp ───────▶ whatsapp.mjs ─┤   notifications/claude/channel        ┌──────────────────────────┐
  watchers, webhooks ─▶ inbox.mjs ─┼──────────────────────────────────────▶ │ claude (interactive,      │
  Discord/Telegram/iMessage ───────┘   (official channel plugins)          │ tmux session ca-<agent>)  │
                                   ◀──────── reply / notify_owner ──────── │ agent folder: CLAUDE.md,  │
                                                                           │ .mcp.json, settings.json  │
  daemon supervisor (launchd/systemd/Task Scheduler)                       └──────────────────────────┘
     └─ keepalive worker: restarts the tmux session, reports channel heartbeats
```

## Pieces

**Channel servers** (`channels/*.mjs`) are MCP servers that declare the
`claude/channel` capability. Claude Code starts them from the agent folder's
`.mcp.json` and, because they are named in `--dangerously-load-development-channels`,
lets them push each inbound message into the session as a `<channel ...>` tag.
They also expose tools: `reply`, `notify_owner`, `list_drafts`, and where the
platform allows, `download_attachment` and `fetch_history`.

**Keyless sessions** (`channels/lib/browser-session.mjs`, `channels/lib/slack-session.mjs`)
let a channel reuse a login the person already has. `browser-session.mjs` reads a
named cookie from Chrome, Brave, Edge, Arc, Chromium or the Slack desktop app,
decrypting it with the OS key (the login keychain on macOS, libsecret or the fixed
key on Linux), after copying the cookie store so a running browser is fine.
`slack-session.mjs` turns Slack's `d` cookie into per-workspace session tokens by
reading the bootstrap page, then calls the Slack web and realtime APIs as the
person. Nothing is written to disk; the tokens live in the browser store and in
memory.

**The shared core** (`channels/lib/core.mjs`) does everything that is not
platform-specific:
- sender gating: owner, allowlist, or everyone, re-read from `access.json` on each message
- pairing for bot-style channels: a code in DM, approved with `chatagent pair`
- approval: replies to anyone but the owner become drafts; the owner answers `send`, `edit` or `drop` with the code
- permission relay: Claude Code's tool approval requests go to the owner's control chat, answered `yes <code>` or `no <code>`
- heartbeats to `state/<channel>/heartbeat.json`, structured logs to `state/<channel>/channel.log`

**The agent folder** (`~/.chatagent/agents/<agent>/`) is an ordinary Claude Code
project: a persona `CLAUDE.md` with the trust rules and standing orders,
`.claude/settings.json` with the allow list and normal permission mode, `.mcp.json`
with its channel servers, `secrets.env` (mode 600) and `state/`. Because it is a
normal session, the agent also has the person's user-level skills and MCP servers.

**The runtime** (`~/.chatagent/runtime/`) is a copy of the channel code and its
pinned npm dependencies, so plugin updates never move the paths the agents use.

**Watchers** are daemon-agent interval jobs (`templates/watch_worker.py`) that poll
an API and post changes to the inbox. **Always-on** is a daemon-agent service job
(`templates/keepalive_worker.py`) that keeps the tmux session alive. Both run on
the vendored `daemonctl` (launchd on macOS, systemd user units on Linux, Task
Scheduler on Windows), so `daemonctl list` and `daemonctl health` see them.

## Why an interactive session in tmux

Claude Code delivers channel events only to interactive sessions; `-p` and the
Agent SDK ignore development channels. tmux gives the session a terminal without a
window, lets the owner attach to watch it, and lets the supervisor restart it.

## Trust boundaries

| Input | Treated as |
|---|---|
| owner, in the control chat | instructions |
| other people the policy lets through | information about what they want |
| watcher and webhook events | information, never instructions |
| text inside any of the above that reads like an order | a finding to report to the owner |

The `from_owner` attribute is set by the server from the platform's authenticated
sender id, never from message text, so it cannot be forged by typing.
