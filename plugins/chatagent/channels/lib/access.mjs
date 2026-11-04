// Who may talk to the agent, and which outbound messages wait for the owner.
//
// access.json
//   owner      { user_id, chat_id, label }   the one person whose control chat gives instructions
//   policy     "owner" | "allowlist" | "all"  which other senders reach the agent at all
//   allow      [user_id]                      used when policy is "allowlist"
//   auto_send  false | true                   true lets replies to non-owners go out without approval
//   auto_send_to [chat_id]                    per-chat exceptions to approval
//   pending    { code: { user_id, chat_id, label, expires } }   pairing requests
//
// drafts.json
//   { code: { chat_id, text, thread_ts, files, label, created } }
//
// The file is re-read on every event, so the chatagent CLI can change it while
// the server runs.

import { join } from 'node:path'
import { randomInt } from 'node:crypto'
import { readJson, writeJson } from './agent.mjs'

// Same alphabet Claude Code uses for permission request ids: a to z without "l".
const ALPHABET = 'abcdefghijkmnopqrstuvwxyz'
export const CODE_RE = '[a-km-z]{5}'

export function newCode(taken = {}) {
  for (;;) {
    let c = ''
    for (let i = 0; i < 5; i++) c += ALPHABET[randomInt(ALPHABET.length)]
    if (!taken[c]) return c
  }
}

export const DEFAULT_ACCESS = {
  owner: null,
  policy: 'owner',
  allow: [],
  auto_send: false,
  auto_send_to: [],
  pending: {},
}

export class Access {
  constructor(stateDir) {
    this.path = join(stateDir, 'access.json')
    this.draftsPath = join(stateDir, 'drafts.json')
  }

  load() {
    return { ...DEFAULT_ACCESS, ...readJson(this.path, {}) }
  }

  save(a) {
    writeJson(this.path, a, 0o600)
  }

  // Preset the owner when the platform already knows who it is, e.g. the
  // WhatsApp account holder or the Slack user whose token is in use.
  ensureOwner(owner) {
    const a = this.load()
    if (a.owner && a.owner.user_id === owner.user_id && a.owner.chat_id === owner.chat_id) return a
    if (a.owner && a.owner.user_id !== owner.user_id) return a // never overwrite a different owner silently
    a.owner = { ...a.owner, ...owner }
    this.save(a)
    return a
  }

  isOwnerControl(a, msg) {
    return Boolean(a.owner && msg.user_id === a.owner.user_id && msg.chat_id === a.owner.chat_id)
  }

  // Returns the pairing code to show the sender, or null when pairing is closed.
  requestPairing(msg) {
    const a = this.load()
    if (a.owner) return null
    const now = Date.now()
    for (const [c, p] of Object.entries(a.pending)) if (p.expires < now) delete a.pending[c]
    const existing = Object.entries(a.pending).find(([, p]) => p.user_id === msg.user_id)
    if (existing) return { code: existing[0], resend: true }
    if (Object.keys(a.pending).length >= 3) return null
    const code = newCode(a.pending)
    a.pending[code] = { user_id: msg.user_id, chat_id: msg.chat_id, label: msg.user || msg.user_id, expires: now + 10 * 60 * 1000 }
    this.save(a)
    return { code, resend: false }
  }

  // Called by the CLI: `chatagent pair <agent> <code>`.
  pair(code) {
    const a = this.load()
    const p = a.pending[code]
    if (!p) throw new Error(`no pending pairing with code ${code} (codes expire after 10 minutes)`)
    if (p.expires < Date.now()) throw new Error(`pairing code ${code} has expired; message the agent again for a new one`)
    a.owner = { user_id: p.user_id, chat_id: p.chat_id, label: p.label }
    a.pending = {}
    this.save(a)
    return a.owner
  }

  allowsSender(a, msg) {
    if (this.isOwnerControl(a, msg)) return true
    if (a.policy === 'all') return true
    if (a.policy === 'allowlist') return a.allow.includes(msg.user_id) || a.allow.includes(msg.chat_id)
    return false
  }

  needsApproval(a, chatId) {
    if (a.owner && chatId === a.owner.chat_id) return false
    if (a.auto_send === true) return false
    return !a.auto_send_to.includes(chatId)
  }

  drafts() {
    return readJson(this.draftsPath, {})
  }

  addDraft(d) {
    const all = this.drafts()
    const code = newCode(all)
    all[code] = { ...d, created: new Date().toISOString() }
    writeJson(this.draftsPath, all, 0o600)
    return code
  }

  takeDraft(code) {
    const all = this.drafts()
    const d = all[code]
    if (!d) return null
    delete all[code]
    writeJson(this.draftsPath, all, 0o600)
    return d
  }

  updateDraft(code, text) {
    const all = this.drafts()
    if (!all[code]) return null
    all[code].text = text
    writeJson(this.draftsPath, all, 0o600)
    return all[code]
  }
}

// Owner commands typed in the control chat. Everything else is a normal message.
export function parseOwnerCommand(text) {
  const t = (text || '').trim()
  let m = new RegExp(`^(send|drop)\\s+(${CODE_RE})$`, 'i').exec(t)
  if (m) return { kind: m[1].toLowerCase(), code: m[2].toLowerCase() }
  m = new RegExp(`^edit\\s+(${CODE_RE})\\s+([\\s\\S]+)$`, 'i').exec(t)
  if (m) return { kind: 'edit', code: m[1].toLowerCase(), text: m[2].trim() }
  m = new RegExp(`^(y|yes|n|no)\\s+(${CODE_RE})$`, 'i').exec(t)
  if (m) return { kind: 'permission', code: m[2].toLowerCase(), behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny' }
  return null
}
