import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickWorkspace } from '../channels/lib/slack-session.mjs'

// The auth page embeds a JSON blob of every workspace. This mirrors the parser
// inside listWorkspaces without hitting the network.
function parseTeams(html) {
  const m = /incomingConfig\s*=\s*JSON\.stringify\((\{[\s\S]*?\})\);/.exec(html)
  if (!m) return null
  const teams = JSON.parse(m[1]).teams || {}
  return Object.values(teams).map(t => ({ id: t.id, name: t.name, domain: t.domain, token: t.token, user_id: t.user_id })).filter(t => t.token && t.domain)
}

const SAMPLE = `<script>sessionStorage.incomingConfig = JSON.stringify({"teams":{"T01":{"id":"T01","name":"Acme","url":"https://acme.slack.com/","domain":"acme","token":"xoxc-1","user_id":"U1"},"T02":{"id":"T02","name":"Beta Co","url":"https://beta.slack.com/","domain":"beta","token":"xoxc-2","user_id":"U2"}}});
location = "https://app.slack.com/client";</script>`

test('parses every workspace with its own token from the auth page', () => {
  const list = parseTeams(SAMPLE)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map(t => t.domain).sort(), ['acme', 'beta'])
  assert.equal(list.find(t => t.domain === 'acme').token, 'xoxc-1')
})

test('drops teams without a token', () => {
  const html = SAMPLE.replace('"token":"xoxc-2"', '"token":""')
  const list = parseTeams(html)
  assert.equal(list.length, 1)
  assert.equal(list[0].domain, 'acme')
})

test('returns null when the page has no config (expired login)', () => {
  assert.equal(parseTeams('<html>Sign in to Slack</html>'), null)
})

test('pickWorkspace matches by domain, name or id, and defaults to the first', () => {
  const list = parseTeams(SAMPLE)
  assert.equal(pickWorkspace(list, 'beta').id, 'T02')
  assert.equal(pickWorkspace(list, 'Acme').id, 'T01')
  assert.equal(pickWorkspace(list, 'T02').id, 'T02')
  assert.equal(pickWorkspace(list).domain, 'acme')
  assert.throws(() => pickWorkspace(list, 'nope'))
})
