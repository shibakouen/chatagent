# Telegram

Use Anthropic's official channel plugin: `--official telegram` (Bun, long polling, no webhook).

1. The person talks to @BotFather, sends `/newbot`, picks a name, copies the token.
2. `/plugin install telegram@claude-plugins-official` in a normal session.
3. Write `TELEGRAM_BOT_TOKEN=...` into `<agent>/state/telegram/.env` (mode 600);
   chatagent points `TELEGRAM_STATE_DIR` there.
4. `chatagent new <agent> --official telegram ...`, `chatagent start <agent>`.
5. DM the bot, get the pairing code, approve it inside the session with
   `/telegram:access pair <code>`, then `/telegram:access policy allowlist`.

Same note as Discord: no draft approval in the official plugin.
