# Discord

Use Anthropic's official channel plugin: `--official discord`. It runs on Bun.

1. Bun: `brew install oven-sh/bun/bun` (or the platform package manager).
2. The person creates the bot: discord.com/developers/applications → New Application →
   Bot → enable **Message Content Intent** (without it messages arrive empty) → Reset
   Token and copy it.
3. OAuth2 → URL Generator → scope `bot`, permissions View Channels, Send Messages,
   Send Messages in Threads, Read Message History, Attach Files, Add Reactions →
   open the URL and add the bot to a server they share with it.
4. In a normal Claude Code session: `/plugin install discord@claude-plugins-official`
   (add the marketplace first if missing: `/plugin marketplace add anthropics/claude-plugins-official`).
5. Token: switchboard runs the plugin with `DISCORD_STATE_DIR=<agent>/state/discord`, so
   write `DISCORD_BOT_TOKEN=...` into `<agent>/state/discord/.env` (mode 600).
6. `switchboard new <agent> --official discord ...` then `switchboard start <agent>`.
7. DM the bot; it answers with a pairing code; approve it from inside the session
   (`switchboard attach <agent>`, then `/discord:access pair <code>`), then
   `/discord:access policy allowlist`.

## Traps

- User tokens and self-bots break Discord's terms. Always a bot account.
- At 100+ servers the bot needs verification and the intent needs approval.
- The official plugin has no draft approval: replies go out directly. If the agent
  speaks for the owner to other people, keep it to the owner's DMs or add the
  instruction "ask the owner with notify_owner before replying to anyone else".
