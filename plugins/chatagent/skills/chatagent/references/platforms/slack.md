# Slack

Two backends. Default is keyless.

## session (default, no setup)

Uses the Slack login already in the person's browser or the Slack desktop app.
No Slack app, no bot, no API key. The agent reads and posts as the person's own
account, so the owner is that account and their self-DM ("Message yourself") is
the control chat.

```
chatagent new <agent> --channel slack --set slack.workspace=<domain or name>
```

- `workspace` picks which of the person's workspaces to use (their domain like
  `acme`, the name like `Acme`, or the team id). Omit it and the first one is used.
- It reads the `d` cookie from Chrome by default. `--set slack.sources='["slack-app","brave"]'`
  chooses which browsers or the Slack app to read, in order. Supported: chrome,
  brave, edge, arc, chromium, slack-app.
- The first read on macOS may show one "allow access" keychain prompt per browser.
  That is the OS asking the person to let the plugin read that browser's cookie.
- Override the browser read with secrets if needed: `SLACK_D_COOKIE`,
  `SLACK_XOXC_TOKEN`, `SLACK_WORKSPACE_DOMAIN`.

Listening: `--set slack.listen='["dm","mention"]'`. `dm` and `my_dms` both mean
your DMs; `mention` means messages that @mention you; `channels` with
`--set slack.watch_channels='["C0123"]'` watches those channels. Replies to anyone
other than you wait for your approval (the core's draft rule).

Nothing is written to disk: the cookie and session token stay in the browser's
store and in memory. If Slack rejects the session, the person signs into Slack in
the browser again; no plugin change is needed.

## app (a real bot)

Use when the person wants a separate bot identity rather than acting as themselves,
or an admin requires an installed app. Socket Mode, so still no public URL.

```
chatagent new <agent> --channel slack --set slack.backend=app
chatagent slack-manifest <agent>   # prints the manifest and the exact clicks
```

Then create the app from the manifest, and store `SLACK_APP_TOKEN` (xapp-),
`SLACK_BOT_TOKEN` (xoxb-), and `SLACK_USER_TOKEN` (xoxp-) if posting as the user.
Pair the first DM with `chatagent pair <agent> <code>`.

## Traps

- **session**: one browser login drives it; if the person logs out of Slack in
  that browser, the agent's session ends too.
- **app**: one socket per app token; two sessions on one token split events. The
  history API is limited to 1 request a minute for non-Marketplace apps created
  after 2025-05-29; realtime events are not limited.
- Either way, posting as the person's own account (session, or app with
  `post_as=user`) means messages are indistinguishable from them. Keep approval on.
