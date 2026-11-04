# iMessage (macOS only)

Use Anthropic's official channel plugin: `--official imessage` (Bun).

- It reads `~/Library/Messages/chat.db` directly and sends with AppleScript through
  Messages.app, so it needs **Full Disk Access** for the terminal that runs the agent
  (for an always-on agent, that is the tmux server's parent: grant it to the terminal
  app or to `tmux` itself) and an **Automation** permission for Messages on first send.
- Messages to yourself pass the gate; other senders need the plugin's allowlist.
- It appends "Sent by Claude" to outbound messages unless `IMESSAGE_APPEND_SIGNATURE=false`.
- SMS is off unless `IMESSAGE_ALLOW_SMS=true`.
- No tapbacks, edits or thread replies through AppleScript.

Read-only alternative with no plugin: query `chat.db` with sqlite3 (needs Full Disk
Access) from a watcher, posting new messages to the inbox.
