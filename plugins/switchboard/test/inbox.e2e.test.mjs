// Drives the real inbox channel server over MCP stdio, the way Claude Code does,
// with no Claude session involved: inbound chat and events become channel
// notifications, replies to other chats become drafts, and the owner's
// "send <code>" releases them.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18000 + Math.floor(Math.random() * 1000)
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const dir = mkdtempSync(join(tmpdir(), 'sb-e2e-'))
const notes = []
let client

const http = (method, path, body, token = TOKEN) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-switchboard-token': token },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json() }))

const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = pred()
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('timed out')
}

before(async () => {
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: 't', channels: { inbox: { inbox_port: PORT } } }))
  writeFileSync(join(dir, 'secrets.env'), `INBOX_TOKEN=${TOKEN}\n`)
  client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
    n => { notes.push(n.params) },
  )
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'channels', 'inbox.mjs')],
    env: { ...process.env, SWITCHBOARD_AGENT_DIR: dir, SWITCHBOARD_CHANNEL: 'inbox' },
  }))
  await waitFor(async () => (await http('GET', '/health').catch(() => null))?.status === 200)
  for (let i = 0; i < 50; i++) {
    const r = await http('GET', '/health').catch(() => null)
    if (r?.status === 200) break
    await new Promise(res => setTimeout(res, 100))
  }
})

after(async () => { await client?.close() })

test('declares the channel and permission capabilities', () => {
  const caps = client.getServerCapabilities()
  assert.ok(caps.experimental['claude/channel'])
  assert.ok(caps.experimental['claude/channel/permission'])
  assert.match(client.getInstructions(), /from_owner/)
})

test('rejects requests without the token', async () => {
  assert.equal((await http('POST', '/chat', { text: 'x' }, 'wrong')).status, 401)
})

test('owner chat arrives as an owner message', async () => {
  await http('POST', '/chat', { text: 'hello agent' })
  const n = await waitFor(() => notes.find(x => x.content === 'hello agent'))
  assert.equal(n.meta.from_owner, 'true')
  assert.equal(n.meta.chat_id, 'owner')
})

test('events arrive as information, never as the owner', async () => {
  await http('POST', '/event', { source: 'linear', title: 'LAM-1 assigned', text: 'body' })
  const n = await waitFor(() => notes.find(x => x.meta.event === 'linear'))
  assert.equal(n.meta.from_owner, 'false')
  assert.equal(n.meta.chat_id, 'events')
  assert.match(n.content, /LAM-1 assigned/)
})

test('reply to the owner sends straight away', async () => {
  const r = await client.callTool({ name: 'reply', arguments: { chat_id: 'owner', text: 'pong' } })
  assert.match(r.content[0].text, /^sent/)
  const out = (await http('GET', '/outbox')).body.messages
  assert.ok(out.find(m => m.chat_id === 'owner' && m.text === 'pong'))
})

test('reply to someone else is held, then released by the owner', async () => {
  const r = await client.callTool({ name: 'reply', arguments: { chat_id: 'team', text: 'ship it' } })
  const code = /draft ([a-km-z]{5})/.exec(r.content[0].text)[1]
  let out = (await http('GET', '/outbox')).body.messages
  assert.equal(out.some(m => m.chat_id === 'team'), false)
  assert.ok(out.find(m => m.chat_id === 'owner' && m.text.includes(`send ${code}`)))

  await http('POST', '/chat', { text: `edit ${code} ship it today` })
  await http('POST', '/chat', { text: `send ${code}` })
  await waitFor(async () => true)
  out = await waitFor(async () => {
    const m = (await http('GET', '/outbox')).body.messages
    return m.some(x => x.chat_id === 'team') ? m : null
  })
  const sent = (await http('GET', '/outbox')).body.messages.find(m => m.chat_id === 'team')
  assert.equal(sent.text, 'ship it today')
  const evt = await waitFor(() => notes.find(x => x.meta.event === 'draft_sent'))
  assert.match(evt.content, /ship it today/)
  // Owner commands are handled by the server and never reach the agent as chat.
  assert.equal(notes.some(x => x.content === `send ${code}`), false)
})

test('list_drafts is empty after sending', async () => {
  const r = await client.callTool({ name: 'list_drafts', arguments: {} })
  assert.equal(r.content[0].text, 'no drafts waiting')
})
