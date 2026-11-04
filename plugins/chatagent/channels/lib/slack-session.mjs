// Keyless Slack: use the session the person is already logged into in their
// browser or the Slack desktop app. No Slack app, no bot, no API key.
//
// How it works:
//   1. Read the `d` cookie for slack.com from the browser (browser-session.mjs).
//   2. GET app.slack.com/auth?app=client with that cookie. Slack returns a
//      bootstrap page listing every workspace the person is signed into, each
//      with its own session token (xoxc-), domain and user id.
//   3. Call the web API at <domain>.slack.com/api/<method> with the xoxc token
//      in the body and the d cookie in the header. Open the realtime socket
//      with rtm.connect, which streams message events over a websocket.
//
// This is the same session the person's own Slack client uses. Messages the
// agent posts come from the person's account, so a channel built on it keeps
// the owner-only and approval rules in the core. The tokens live only in the
// browser's cookie store and in memory here; nothing is written to disk.

import { findCookies } from './browser-session.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export function readDCookie(sources) {
  const hits = findCookies({ domain: 'slack.com', name: 'd', sources })
  const good = hits.find(h => h.value && h.value.startsWith('xoxd-'))
  if (good) return { cookie: good.value, source: `${good.source} (${good.profile})` }
  if (hits.length) throw new Error(`found a slack.com cookie in ${hits[0].source} but could not read it: ${hits[0].error || 'unexpected format'}. Sign into Slack in that browser, or pass the token another way.`)
  throw new Error('no Slack login found in any browser or the Slack app. Sign into Slack in Chrome (or set SLACK_D_COOKIE / SLACK_XOXC_TOKEN), then try again.')
}

// Every workspace the person is signed into, each with a usable session token.
export async function listWorkspaces(cookie) {
  const res = await fetch('https://app.slack.com/auth?app=client', {
    headers: { cookie: `d=${cookie}`, 'user-agent': UA },
    redirect: 'follow',
  })
  const html = await res.text()
  const m = /incomingConfig\s*=\s*JSON\.stringify\((\{[\s\S]*?\})\);/.exec(html)
  if (!m) throw new Error('could not read the workspace list from Slack; the login may have expired. Open Slack in the browser and sign in again.')
  const teams = JSON.parse(m[1]).teams || {}
  return Object.values(teams).map(t => ({
    id: t.id, name: t.name, domain: t.domain, url: t.url, token: t.token, user_id: t.user_id,
  })).filter(t => t.token && t.domain)
}

export function pickWorkspace(list, wanted) {
  if (!list.length) throw new Error('this Slack login has no workspaces')
  if (!wanted) return list[0]
  const w = String(wanted).toLowerCase()
  const hit = list.find(t => t.domain.toLowerCase() === w || t.name.toLowerCase() === w || t.id === wanted)
  if (!hit) throw new Error(`no workspace "${wanted}" in this login. Available: ${list.map(t => t.domain).join(', ')}`)
  return hit
}

// A thin client for one workspace, authenticated by the session token + cookie.
export function sessionClient({ cookie, token, domain }) {
  const call = async (method, params = {}, { formData } = {}) => {
    const headers = { cookie: `d=${cookie}`, 'user-agent': UA }
    let body
    if (formData) {
      formData.append('token', token)
      body = formData
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'
      body = new URLSearchParams(flatten({ token, ...params }))
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://${domain}.slack.com/api/${method}`, { method: 'POST', headers, body })
      if (res.status === 429) {
        await sleep(1000 * Number(res.headers.get('retry-after') || 2))
        continue
      }
      const json = await res.json()
      if (!json.ok && json.error === 'ratelimited') { await sleep(2000); continue }
      return json
    }
    throw new Error(`${method}: rate limited after retries`)
  }
  return { call, cookie, token, domain, ua: UA }
}

function flatten(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
  return out
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
export { UA }
