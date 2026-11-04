# Slack

Bundled channel: `--channel slack`. Socket Mode, so no public URL or tunnel.

## Pick the shape

| Request | Config |
|---|---|
| "an agent I can DM in Slack" | default: bot, `listen ["dm"]` |
| "answer when someone @mentions it" | `--set slack.listen='["dm","mention"]'`, invite the bot to the channels |
| "watch these channels" | `--set slack.listen='["dm","channels"]' --set slack.watch_channels='["C0123"]'` |
| "constant access to MY Slack and respond for me" | `--set slack.listen='["dm","my_dms"]' --set slack.post_as=user` plus a user token. Approval stays on. Confirm the person wants replies in their own name. |

## Setup

1. `switchboard slack-manifest <agent>` prints a manifest with Socket Mode on and the
   scopes the chosen shape needs, plus the clicks.
2. The person: api.slack.com/apps → Create New App → From a manifest → workspace → paste.
3. Basic Information → App-Level Tokens → Generate with `connections:write` → `SLACK_APP_TOKEN` (xapp-).
4. Install to Workspace → OAuth & Permissions → Bot User OAuth Token → `SLACK_BOT_TOKEN` (xoxb-).
   With `post_as=user` or `my_dms`, also the User OAuth Token → `SLACK_USER_TOKEN` (xoxp-).
5. `switchboard secret <agent> SLACK_APP_TOKEN` and the others (each prompts).
6. `switchboard start <agent>`. Without a user token, DM the bot, get a pairing code,
   run `switchboard pair <agent> <code>`. With a user token the owner is known already.

## Traps

- **One connection per app token.** Two sessions on the same xapp token each get a
  random share of events. One agent per Slack app.
- **History is rate limited.** Since 2025-05-29, `conversations.history` and
  `conversations.replies` for distributed non-Marketplace apps are limited to 1 request
  a minute and 15 messages. Realtime events over the socket are not affected. Internal
  apps built by the workspace itself keep the higher limits.
- **The bot only sees channels it was invited to** (`/invite @bot`).
- **Messages tab must be enabled** for people to DM the bot (the manifest does this).
- Workspaces on Enterprise Grid may require admin approval to install the app.
- Posting as the user uses their token: anything the agent sends is indistinguishable
  from them. Keep `approval owner` unless they insist.
