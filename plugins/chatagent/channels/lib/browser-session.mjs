// Read a login cookie from a browser (or Electron app) the person is already
// signed in to, so an agent can use that session without any API key.
//
// Supported: Chrome, Brave, Edge, Arc, Chromium and the Slack desktop app on
// macOS (cookie key from the login keychain) and Linux (the "peanuts" v10 key,
// or v11 through libsecret's secret-tool). Windows DPAPI is not supported yet.
//
// The cookie database is copied before reading, so a running browser is fine.
// Nothing is written anywhere; values are returned to the caller only.

import { existsSync, copyFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir, platform } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pbkdf2Sync, createDecipheriv, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const MAC = join(homedir(), 'Library', 'Application Support')
const LINUX = join(homedir(), '.config')

// name, cookie-store roots (profiles live under them), keychain service
export const SOURCES = platform() === 'darwin'
  ? [
      { name: 'chrome', root: join(MAC, 'Google', 'Chrome'), keychain: 'Chrome Safe Storage' },
      { name: 'brave', root: join(MAC, 'BraveSoftware', 'Brave-Browser'), keychain: 'Brave Safe Storage' },
      { name: 'edge', root: join(MAC, 'Microsoft Edge'), keychain: 'Microsoft Edge Safe Storage' },
      { name: 'arc', root: join(MAC, 'Arc', 'User Data'), keychain: 'Arc Safe Storage' },
      { name: 'chromium', root: join(MAC, 'Chromium'), keychain: 'Chromium Safe Storage' },
      { name: 'slack-app', root: join(MAC, 'Slack'), keychain: 'Slack Safe Storage', flat: true },
    ]
  : [
      { name: 'chrome', root: join(LINUX, 'google-chrome'), app: 'chrome' },
      { name: 'chromium', root: join(LINUX, 'chromium'), app: 'chromium' },
      { name: 'brave', root: join(LINUX, 'BraveSoftware', 'Brave-Browser'), app: 'brave' },
      { name: 'edge', root: join(LINUX, 'microsoft-edge'), app: 'chromium' },
      { name: 'slack-app', root: join(LINUX, 'Slack'), app: 'Slack', flat: true },
    ]

function cookieDbs(src) {
  if (!existsSync(src.root)) return []
  if (src.flat) return [join(src.root, 'Cookies'), join(src.root, 'Network', 'Cookies')].filter(existsSync).map(p => ({ profile: 'app', path: p }))
  const out = []
  for (const d of readdirSync(src.root)) {
    if (d !== 'Default' && !/^Profile \d+$/.test(d)) continue
    for (const p of [join(src.root, d, 'Cookies'), join(src.root, d, 'Network', 'Cookies')]) {
      if (existsSync(p)) out.push({ profile: d, path: p })
    }
  }
  return out
}

const keyCache = new Map()

function keyFor(src, version) {
  const id = `${src.name}:${version}`
  if (keyCache.has(id)) return keyCache.get(id)
  let password
  if (platform() === 'darwin') {
    // May show a one-time "allow access" dialog the first time a source is read.
    password = execFileSync('security', ['find-generic-password', '-w', '-s', src.keychain], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } else if (version === 'v11') {
    password = execFileSync('secret-tool', ['lookup', 'application', src.app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } else {
    password = 'peanuts'
  }
  const key = pbkdf2Sync(password, 'saltysalt', platform() === 'darwin' ? 1003 : 1, 16, 'sha1')
  keyCache.set(id, key)
  return key
}

function decrypt(src, enc, hostKey, dbVersion) {
  const buf = Buffer.from(enc)
  const version = buf.subarray(0, 3).toString()
  if (version !== 'v10' && version !== 'v11') return buf.toString('utf8')
  const d = createDecipheriv('aes-128-cbc', keyFor(src, version), Buffer.alloc(16, ' '))
  let out = Buffer.concat([d.update(buf.subarray(3)), d.final()])
  // Chrome 130+ (cookie DB version 24+) prefixes the value with SHA256(host_key).
  if (dbVersion >= 24 || out.subarray(0, 32).equals(createHash('sha256').update(hostKey).digest())) out = out.subarray(32)
  return out.toString('utf8')
}

// Every matching cookie across every installed source, newest first.
export function findCookies({ domain, name, sources }) {
  if (platform() === 'win32') throw new Error('reading browser cookies on Windows is not supported yet; paste the cookie instead')
  const found = []
  const tmp = mkdtempSync(join(tmpdir(), 'chatagent-cookies-'))
  try {
    for (const src of SOURCES) {
      if (sources && !sources.includes(src.name)) continue
      for (const db of cookieDbs(src)) {
        const copy = join(tmp, `${src.name}-${db.profile.replace(/\W/g, '_')}.db`)
        try {
          copyFileSync(db.path, copy)
          const conn = new DatabaseSync(copy, { readOnly: true })
          const dbVersion = Number(conn.prepare("select value from meta where key = 'version'").get()?.value || 0)
          const rows = conn.prepare('select host_key, name, value, encrypted_value, last_access_utc / 1000000 as last_access from cookies where name = ? and (host_key = ? or host_key like ?)').all(name, domain, `%.${domain.replace(/^\./, '')}`)
          for (const r of rows) {
            try {
              const value = r.value || decrypt(src, r.encrypted_value, r.host_key, dbVersion)
              if (value) found.push({ source: src.name, profile: db.profile, host: r.host_key, value, lastAccess: Number(r.last_access) })
            } catch (err) {
              found.push({ source: src.name, profile: db.profile, host: r.host_key, error: String(err.message || err) })
            }
          }
          conn.close()
        } catch (err) {
          found.push({ source: src.name, profile: db.profile, error: `could not read cookie store: ${err.message || err}` })
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return found.sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0))
}
