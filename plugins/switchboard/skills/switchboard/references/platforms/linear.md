# Linear (worked example of a non-chat app)

## read and act: the official MCP server

```
claude mcp add --transport http linear https://mcp.linear.app/mcp
```

OAuth in the browser, scoped to what the person can already see. Tools cover issues,
projects, comments, cycles, documents. Verify with one call (list issues assigned to "me").

For an always-on agent, allow the read tools the standing orders need and leave the
write tools on ask, so each change is approved from the control chat:

```
--allow-tool mcp__linear__list_issues --allow-tool mcp__linear__get_issue --allow-tool mcp__linear__list_comments
```

## live: a watcher on the GraphQL API

The MCP server cannot push. A watcher polls the API and posts changes to the inbox.

1. The person creates a personal API key: Linear → Settings → Security & access →
   Personal API keys. Read-only access is enough for a watcher.
2. Store it for watchers: `python3 ~/.switchboard/runtime/vendor/daemonctl/daemonctl.py secret set LINEAR_API_KEY <key>`
3. Create the watcher (issues assigned to the person, newest changes first):

```
switchboard watch <agent> linear \
  --url https://api.linear.app/graphql --method POST \
  --headers '{"Authorization": "${LINEAR_API_KEY}"}' \
  --body '{"query": "{ viewer { assignedIssues(first: 50, orderBy: updatedAt) { nodes { id identifier title url updatedAt state { name } priority } } } }"}' \
  --items-path data.viewer.assignedIssues.nodes \
  --version-field updatedAt --url-field url \
  --title "{identifier} {title} ({state_name})" --every 120
```

Linear's API key goes in the `Authorization` header as is, with no `Bearer` prefix.
Run the printed `run-once` command: the first pass records a baseline and posts
nothing; change an issue and the next pass posts one event. Then add `--install`.

4. Standing orders in the agent's `--instructions` say what to do with each event, for
   example "when an issue assigned to me moves to In Review, read its comments and send
   me a two-line summary with notify_owner".

Webhooks are the push alternative (Linear → Settings → API → Webhooks) but need the
inbox exposed through a tunnel; polling every 2 minutes is simpler and enough.
