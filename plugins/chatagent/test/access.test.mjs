import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Access, parseOwnerCommand, newCode } from '../channels/lib/access.mjs'

const fresh = () => new Access(mkdtempSync(join(tmpdir(), 'sb-access-')))

test('codes are five letters without l', () => {
  for (let i = 0; i < 500; i++) assert.match(newCode(), /^[a-km-z]{5}$/)
})

test('owner commands parse, everything else does not', () => {
  assert.deepEqual(parseOwnerCommand('send abcde'), { kind: 'send', code: 'abcde' })
  assert.deepEqual(parseOwnerCommand('  DROP abcde '), { kind: 'drop', code: 'abcde' })
  assert.deepEqual(parseOwnerCommand('edit abcde new words\nsecond line'), { kind: 'edit', code: 'abcde', text: 'new words\nsecond line' })
  assert.deepEqual(parseOwnerCommand('yes qwert'), { kind: 'permission', code: 'qwert', behavior: 'allow' })
  assert.deepEqual(parseOwnerCommand('n qwert'), { kind: 'permission', code: 'qwert', behavior: 'deny' })
  assert.equal(parseOwnerCommand('send abcdl'), null) // l is never in a code
  assert.equal(parseOwnerCommand('please send abcde'), null)
  assert.equal(parseOwnerCommand('hello'), null)
})

test('pairing makes the requester the owner, once', () => {
  const acc = fresh()
  const msg = { user_id: 'U1', chat_id: 'D1', user: 'Ana' }
  const p = acc.requestPairing(msg)
  assert.equal(p.resend, false)
  assert.equal(acc.requestPairing(msg).code, p.code) // same person gets the same code back
  const owner = acc.pair(p.code)
  assert.equal(owner.user_id, 'U1')
  assert.equal(acc.requestPairing({ user_id: 'U2', chat_id: 'D2' }), null) // closed after pairing
  assert.throws(() => acc.pair(p.code))
})

test('pending pairings are capped at three', () => {
  const acc = fresh()
  for (let i = 0; i < 3; i++) assert.ok(acc.requestPairing({ user_id: `U${i}`, chat_id: `D${i}` }))
  assert.equal(acc.requestPairing({ user_id: 'U9', chat_id: 'D9' }), null)
})

test('only the owner in the control chat counts as the owner', () => {
  const acc = fresh()
  acc.ensureOwner({ user_id: 'U1', chat_id: 'D1' })
  const a = acc.load()
  assert.equal(acc.isOwnerControl(a, { user_id: 'U1', chat_id: 'D1' }), true)
  assert.equal(acc.isOwnerControl(a, { user_id: 'U1', chat_id: 'C-general' }), false)
  assert.equal(acc.isOwnerControl(a, { user_id: 'U2', chat_id: 'D1' }), false)
})

test('ensureOwner never replaces a different owner', () => {
  const acc = fresh()
  acc.ensureOwner({ user_id: 'U1', chat_id: 'D1' })
  acc.ensureOwner({ user_id: 'U2', chat_id: 'D2' })
  assert.equal(acc.load().owner.user_id, 'U1')
})

test('sender policy', () => {
  const acc = fresh()
  acc.ensureOwner({ user_id: 'U1', chat_id: 'D1' })
  let a = acc.load()
  const stranger = { user_id: 'U2', chat_id: 'D2' }
  assert.equal(acc.allowsSender(a, stranger), false)
  acc.save({ ...a, policy: 'allowlist', allow: ['U2'] })
  a = acc.load()
  assert.equal(acc.allowsSender(a, stranger), true)
  assert.equal(acc.allowsSender(a, { user_id: 'U3', chat_id: 'D3' }), false)
  acc.save({ ...a, policy: 'all' })
  assert.equal(acc.allowsSender(acc.load(), { user_id: 'U3', chat_id: 'D3' }), true)
})

test('replies to anyone but the owner need approval unless auto send is on', () => {
  const acc = fresh()
  acc.ensureOwner({ user_id: 'U1', chat_id: 'D1' })
  let a = acc.load()
  assert.equal(acc.needsApproval(a, 'D1'), false)
  assert.equal(acc.needsApproval(a, 'D2'), true)
  acc.save({ ...a, auto_send_to: ['D2'] })
  a = acc.load()
  assert.equal(acc.needsApproval(a, 'D2'), false)
  assert.equal(acc.needsApproval(a, 'D3'), true)
  acc.save({ ...a, auto_send: true })
  assert.equal(acc.needsApproval(acc.load(), 'D3'), false)
})

test('drafts can be edited, taken once, and dropped', () => {
  const acc = fresh()
  const code = acc.addDraft({ chat_id: 'D2', text: 'hi', label: 'Bo' })
  assert.equal(acc.updateDraft(code, 'hello').text, 'hello')
  assert.equal(acc.takeDraft(code).text, 'hello')
  assert.equal(acc.takeDraft(code), null)
})
