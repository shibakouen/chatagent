# Research

Full sourced findings: vault `Research/Agent Connectors/Agent_Connectors_Research_2026-11-04.json`.

## Stack

- Plain Node ESM channel servers (Node 22.5+ for `node:sqlite`), no build step, no Bun. Pinned deps: `@modelcontextprotocol/sdk` 1.32.2, `@slack/socket-mode` 3.1.1, `@slack/web-api` 8.3.0; Baileys `7.0.0-rc14` only with `setup --with whatsapp`.
- Runtime copied to `~/.chatagent/runtime` so plugin updates never move the paths agents use (`${CLAUDE_PLUGIN_ROOT}` changes on update).
- Supervisor: daemon-agent's `daemonctl` vendored in `plugins/chatagent/vendor/daemonctl` (launchd, systemd user, Task Scheduler).

## Claude Code channels (the core mechanism)

- MCP server declares `experimental['claude/channel']`; pushes `notifications/claude/channel` `{content, meta}`; meta keys must be identifiers.
- Permission relay: declare `claude/channel/permission`; receive `notifications/claude/channel/permission_request` `{request_id, tool_name, description, input_preview}`; answer `notifications/claude/channel/permission` `{request_id, behavior}`.
- Custom channels load only through `--dangerously-load-development-channels server:<name>` in an interactive session; ignored with `-p` and the Agent SDK. Only Anthropic's plugins are on the `--channels` allowlist.
- Flags are hidden from `claude --help` but present in 2.1.318 (strings in the binary).
- Official channel plugins: discord, telegram, imessage, fakechat (all Bun). State dirs: `DISCORD_STATE_DIR`, `TELEGRAM_STATE_DIR`, `IMESSAGE_STATE_DIR`.

## Known constraints

- Startup prompts on a new agent folder: folder trust (defaults to "No, exit", needs Down then Enter) and the development-channel warning (Enter). `chatagent start` answers both.
- The chat prompt appears before channel servers finish connecting; `start` waits for fresh heartbeats.
- tmux sessions inherit the tmux server's env; `CLAUDE_CONFIG_DIR` must be passed explicitly (an expired default profile showed "Login expired").
- Slack: one socket connection per app token; history API 1 req/min and 15 messages for distributed non-Marketplace apps created after 2025-05-29.
- WhatsApp personal-number automation breaks WhatsApp's terms; newer chats use `@lid` ids.
- The user's global allow list can pre-approve Bash/Edit/Write/Read, in which case nothing relays for those tools.
