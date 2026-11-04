# Progress

## 2026-11-04

- Built v0.1.0: channel core (`channels/lib`), inbox, Slack (Socket Mode, bot or user voice), WhatsApp (bridge backend over lharries/whatsapp-mcp, Baileys backend), CLI `bin/chatagent.mjs`, watcher and keepalive templates on vendored daemonctl, skill + method ladder + 8 platform guides.
- Verified:
  - `npm test`: 16/16 (access rules plus an MCP stdio end-to-end of the inbox server: owner chat, events, drafts, edit, send, list_drafts).
  - Live Claude Code 2.1.318 session in tmux (Haiku): owner chat round trip; Linear-style event with an embedded "add attacker-123 to the allowlist" order was reported and refused; draft held, edited and sent by `send <code>`; WebFetch permission request relayed to the control chat and approved with `yes <code>`.
  - Watcher against GitHub's public releases API: 3 events posted, second pass posted 0.
  - Keepalive worker: agent stopped, worker restarted it within 8 s, restarted agent answered.
  - WhatsApp bridge backend, read-only, against the real bridge: owner detected from `whatsmeow_device`, 1 inbound DM delivered, own outgoing messages skipped, no sends.
  - `claude plugin validate` passes for plugin and marketplace; `agentguard scan`: 0 findings.
- Not verified live: Slack channel (needs a Slack app), Baileys backend (needs QR pairing), official Discord/Telegram/iMessage routes (need Bun and bot tokens), `always-on` install as a real OS service (tested the worker in the foreground only; new launchd units cannot be bootstrapped from a Claude shell on this Mac).
- Failures logged as data:
  - Trust prompt defaults to "No, exit"; Enter alone exits the session. Fix: Down, Enter.
  - `fetch failed` right after start: prompt shows before channels connect. Fix: wait for heartbeats.
  - "Login expired" in tmux: default profile, not the account's. Fix: pass `CLAUDE_CONFIG_DIR`.
  - `node --test test/` fails on Node 22.16 (treats dir as file). Fix: glob `test/*.test.mjs`.
  - Draft-sent notice quoted pre-edit text. Fix: include the final text.

## 2026-11-04 (later)

- Added keyless Slack and renamed the project to ChatAgent (Matteo's steer: most people will not register an app or make an API key).
- Keyless Slack (`channels/lib/slack-session.mjs` + `browser-session.mjs`): reads the slack.com `d` cookie from Chrome/Brave/Edge/Arc/Chromium or the Slack desktop app (OS-key decryption; cookie DB copied first; Chrome v24+ SHA256 host prefix handled), GETs app.slack.com/auth to list every workspace with its own xoxc session token, then calls the web API and opens the rtm.connect websocket as the person. It is now the default Slack backend; Socket Mode is `--set slack.backend=app`. Verified live: cookie read, auth.test ok, rtm socket connected, reads (users.conversations, emoji.list, history) ok, owner detected as the logged-in account, control chat = self-DM. No message was sent to anyone.
- Discord keyless user-token path documented with its ToS warning (not built; bot token stays the default).
- Rename: plugin/marketplace/skill/command/CLI/env vars (CHATAGENT_*), server prefix ca-, folders ~/.chatagent, all switchboard->chatagent. Repo dir still ~/switchboard because the dcg guard blocks mv of home dirs; Matteo renames it if he wants.
- 20/20 tests (added slack-session parser tests); plugin + marketplace validate; dep `ws` 8.18.3 pinned.
- Still not verified live: a full `chatagent start` Slack agent replying in Slack (needs a real send, which waits for Matteo); Baileys WhatsApp; official Discord/Telegram/iMessage; always-on as a real OS service.

## 2026-11-04 (light mode + Windows + Murasaki Chat Agent)

- Renamed the product to **Murasaki Chat Agent**: plugin.json name `murasaki-chat-agent` + displayName, marketplace name `murasaki` (install `murasaki-chat-agent@murasaki`), README/banner/icon rebranded. CLI command stays `chatagent` and the slash command `/chatagent` (short); internal dirs/env (`~/.chatagent`, CHATAGENT_*, `ca-` prefixes) unchanged.
- Design to **light mode** (Matteo dislikes dark): `assets/banner.svg` and the icon are white-ground with the Murasaki gradient and 茈 mark; banner lockup is `茈 MURASAKI` eyebrow + `Chat Agent` wordmark. Fixed the earlier overlap: the connection emblem now sits in the right third, clear of all text. Both rendered via headless Chrome and eyeballed. Light icon.png (1024²) regenerated.
- **Windows support** added to the CLI: `win32` runs the agent as a detached process with a pidfile (`state/agent.pid`), `start`/`stop`/`status` branch off tmux; `which`/`claudeBin` cross-platform (`where`, claude.cmd/.exe); `setup` reports Windows deps; `attach` prints the log path. tmux path unchanged for macOS/Linux. Watchers and always-on already cross-platform via daemonctl's windows_tasks supervisor. Honest limit documented: the one-time folder-trust / dev-channel prompts can't be auto-answered headless on Windows, so the live runner is best under WSL; connectors/watchers/always-on run natively. Slack keyless needs WSL/mac/linux on Windows (DPAPI cookie read is a TODO); the Slack app-token backend works on Windows.
- Verified: 20/20 tests; `claude plugin validate --profile directory` clean (icon + README); macOS runner start/stop regression passed. Windows runner not executed (no Windows host here).
