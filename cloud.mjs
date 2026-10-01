// This PC linked to an Agent Monitor account on cam.elopstudio.com, so the Agent Monitor mobile app can reach it.
// Linking works the way `tailscale up` links a machine: the monitor makes an Ed25519 key pair and asks for a short
// code, the person approves the code in the browser (signed in with GitHub or Google, within the PCs their plan
// allows), and the monitor collects its device id. Each request to the server is signed with the private key.
//
// While linked, the monitor keeps a WebSocket to the server's relay (wss://…/api/relay/pc). The app's calls come
// through it and are answered by this monitor's own API on 127.0.0.1, as the page's are — but only the calls in
// RELAYED below, and never with the local token: the relay adds it here and takes it out of every answer. Content
// passes through the server (TLS) without being stored there. Unlinking closes the relay.
//
// Kept in <data>/cloud.json: the server, the device id and the private key — nothing about the person. Their name
// and plan are asked for when the page wants them and kept in memory only. The key never leaves this file.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CAM_URL = (process.env.CAM_URL || 'https://cam.elopstudio.com').replace(/\/+$/, '')
const CHECK_EVERY = 60 * 1000          // the page may ask every few seconds; the server is asked at most once a minute
const HEARTBEAT = 10 * 60 * 1000       // and every ten minutes in the background, so the account shows when this PC was last on
const TIMEOUT = 10 * 1000
const RELAY_RETRY_MAX = 60 * 1000      // a lost relay is tried again after 1 s, doubling up to this
const MAX_RELAYED_BODY = 20 * 1024 * 1024

// what the app may ask of this monitor: everything the page does, except the Claude sign-in (it opens a window on the
// PC) and this file's own linking (it stays on the PC). Streams are the page's server-sent events.
const RELAYED = (p) => p.startsWith('/api/') && !p.startsWith('/api/account/') && !p.startsWith('/api/cloud')
const STREAMS = new Set(['/api/events', '/api/live', '/api/agent-stream'])
const TOKEN_IN_QUERY = new Set(['/api/dirs', '/api/account', '/api/upload-file', '/api/agent-stream', '/api/live'])

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const signedMessage = (method, pathAndQuery, time, raw) => ['cam-device-v1', method, pathAndQuery, time, sha256(raw)].join('\n')

// local: { port, token() } — where this monitor's own API is, and its current token
export function createCloud({ dataDir, version, notifyPages = () => {}, local = null }) {
  const file = path.join(dataDir, 'cloud.json')
  let saved = load()      // { server, deviceId, key } — linked
  let enrolling = null    // { server, key, deviceCode, code, url, expiresAt, interval, timer } — waiting for the person
  let status = null       // { at, value | null, error | null } — the server's last answer about this PC
  let note = null         // what happened last, for the page: linked | denied | expired | removed | unlinkedHere
  let checking = null

  function load() {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (o.server && o.device_id && o.key) return { server: o.server, deviceId: o.device_id, key: crypto.createPrivateKey(o.key), linkedAt: o.linked_at }
    } catch {}
    return null
  }
  function save(s) {
    const tmp = file + '.' + process.pid + '.tmp'
    const key = s.key.export({ format: 'pem', type: 'pkcs8' })
    fs.mkdirSync(dataDir, { recursive: true })
    s.linkedAt = s.linkedAt || new Date().toISOString()
    fs.writeFileSync(tmp, JSON.stringify({ server: s.server, device_id: s.deviceId, key, linked_at: s.linkedAt }, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  function forget() { saved = null; status = null; relayStop(); try { fs.unlinkSync(file) } catch {} }

  const sign = (s, method, p, raw = '') => {
    const time = String(Math.floor(Date.now() / 1000))
    return { time, sig: crypto.sign(null, Buffer.from(signedMessage(method, p, time, Buffer.from(raw))), s.key).toString('base64') }
  }

  // one request to the server, signed with `key` when given; → { status, body } or { status: 0 } when unreachable
  async function call(server, method, p, body, { key, deviceId } = {}) {
    const raw = body ? JSON.stringify(body) : ''
    const headers = { 'x-cam': '1', ...(raw ? { 'content-type': 'application/json' } : {}) }
    if (key) {
      const { time, sig } = sign({ key }, method, p, raw)
      headers['x-cam-time'] = time
      headers['x-cam-sig'] = sig
      if (deviceId) headers['x-cam-device'] = deviceId
    }
    try {
      const r = await fetch(server + p, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(TIMEOUT) })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    } catch { return { status: 0, body: {} } }
  }

  // ── linking ─────────────────────────────────────────

  async function link() {
    if (saved) return [409, { error: 'linked' }]
    if (enrolling && enrolling.expiresAt > Date.now()) return [200, pendingView()]
    stopEnrolling()
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')   // a new key for every link
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64')
    // not the hostname: it often carries a person's name. The account page can rename it.
    const name = { win32: 'Windows PC', darwin: 'Mac', linux: 'Linux PC' }[process.platform] || 'PC'
    const r = await call(CAM_URL, 'POST', '/api/devices/enroll', { public_key: pub, name, platform: process.platform, app_version: version }, { key: privateKey })
    if (r.status !== 200) return [r.status ? 502 : 504, { error: r.body.error || 'offline' }]
    const b = r.body
    enrolling = {
      server: CAM_URL, key: privateKey, deviceCode: b.device_code, code: b.user_code, url: b.verification_uri_complete,
      expiresAt: Date.now() + b.expires_in * 1000, interval: Math.max(2, b.interval || 3) * 1000, timer: null,
    }
    note = null
    schedule()
    return [200, pendingView()]
  }

  function schedule() {
    const e = enrolling
    if (!e) return
    e.timer = setTimeout(() => poll(e), e.interval)
    e.timer.unref?.()
  }
  async function poll(e) {
    if (enrolling !== e) return
    if (Date.now() > e.expiresAt) { stopEnrolling(); note = 'expired'; notifyPages(); return }
    const r = await call(e.server, 'POST', '/api/devices/token', { device_code: e.deviceCode })
    if (enrolling !== e) return   // cancelled meanwhile
    if (r.status === 200 && r.body.device_id) {
      saved = { server: e.server, deviceId: r.body.device_id, key: e.key }
      save(saved)
      enrolling = null; status = null; note = 'linked'
      relayStart()
      check(true).finally(notifyPages)
      return
    }
    const err = r.body.error
    if (err === 'access_denied' || err === 'expired_token') { stopEnrolling(); note = err === 'access_denied' ? 'denied' : 'expired'; notifyPages(); return }
    if (err === 'slow_down') e.interval += 2000
    schedule()   // pending, or the server could not be reached: ask again
  }
  function stopEnrolling() { if (enrolling?.timer) clearTimeout(enrolling.timer); enrolling = null }
  const pendingView = () => enrolling && { code: enrolling.code, url: enrolling.url, expiresAt: enrolling.expiresAt }

  // unlinking from here: the server is told, then the key is deleted. If it cannot be reached the key is deleted anyway,
  // and the PC stays on the account until it is removed there.
  async function unlink() {
    if (!saved) return [200, { told: false }]
    const s = saved
    const r = await call(s.server, 'DELETE', '/api/device', null, { key: s.key, deviceId: s.deviceId })
    forget()
    note = 'unlinkedHere'
    notifyPages()
    return [200, { told: r.status === 200 || r.status === 401 }]
  }

  // ── what the account says about this PC ─────────────

  function check(fresh) {
    if (!saved) return Promise.resolve(null)
    if (!fresh && status && Date.now() - status.at < CHECK_EVERY) return Promise.resolve(status)
    if (checking) return checking
    const s = saved
    checking = (async () => {
      const r = await call(s.server, 'GET', '/api/device?version=' + encodeURIComponent(version || ''), null, { key: s.key, deviceId: s.deviceId })
      if (saved !== s) return null
      if (r.status === 401 && (r.body.error === 'device_revoked' || r.body.error === 'no_such_device')) {
        // removed on the account page: this key is of no more use
        forget(); note = 'removed'; notifyPages()
        return null
      }
      status = r.status === 200 ? { at: Date.now(), value: r.body, error: null } : { at: Date.now(), value: status?.value || null, error: r.status ? r.body.error || 'http' + r.status : 'offline' }
      return status
    })().finally(() => { checking = null })
    return checking
  }

  const beat = setInterval(() => { if (saved) check(true).catch(() => {}) }, HEARTBEAT)
  beat.unref?.()
  if (saved) check(true).catch(() => {})

  // ── the relay: the mobile app's calls ────────────────

  // Node 22 and the desktop app have a WebSocket client; older Node (npm start on 18/20) cannot keep the relay
  const canRelay = typeof globalThis.WebSocket === 'function' && !!local
  let relay = null        // { ws, streams: Map(id → AbortController) }
  let relayState = 'off'  // off | connecting | on | unsupported
  let relayRetry = 1000, relayTimer = null, relayWanted = false

  function relayStart() {
    relayWanted = !!saved
    if (!saved) return
    if (!canRelay) { relayState = 'unsupported'; return }
    if (relay) return
    const s = saved
    const { time, sig } = sign(s, 'GET', '/api/relay/pc')
    const url = s.server.replace(/^http/, 'ws') + `/api/relay/pc?device=${encodeURIComponent(s.deviceId)}&time=${time}&sig=${encodeURIComponent(sig)}`
    const ws = new WebSocket(url)
    relay = { ws, streams: new Map() }
    relayState = 'connecting'
    ws.onopen = () => { relayState = 'on'; relayRetry = 1000; notifyPages() }
    ws.onmessage = (ev) => { onRelay(ws, ev.data).catch(() => {}) }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      if (relay?.ws !== ws) return
      for (const ac of relay.streams.values()) ac.abort()
      relay = null
      relayState = 'off'
      notifyPages()
      if (ev.code === 4001) check(true).catch(() => {})   // removed: the check finds out and forgets the key
      if (relayWanted && saved) {
        clearTimeout(relayTimer)
        relayTimer = setTimeout(relayStart, relayRetry)
        relayTimer.unref?.()
        relayRetry = Math.min(relayRetry * 2, RELAY_RETRY_MAX)
      }
    }
  }
  function relayStop() {
    relayWanted = false
    clearTimeout(relayTimer)
    if (relay) { const ws = relay.ws; for (const ac of relay.streams.values()) ac.abort(); relay = null; try { ws.close() } catch {} }
    relayState = 'off'
  }

  const out = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)) }
  // the local URL of a relayed path, with the token where the page would put it
  function localUrl(p) {
    const u = new URL(p, `http://127.0.0.1:${local.port}`)
    if (TOKEN_IN_QUERY.has(u.pathname)) u.searchParams.set('token', local.token())
    return u
  }

  async function onRelay(ws, raw) {
    let f
    try { f = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) } catch { return }
    if (f.t === 'end') { relay?.streams.get(f.id)?.abort(); relay?.streams.delete(f.id); return }
    const p = typeof f.path === 'string' ? f.path : ''
    const pathname = p.split('?')[0]
    if (f.t === 'req') {
      if (!RELAYED(pathname) || STREAMS.has(pathname)) return out(ws, { t: 'res', id: f.id, status: 403, body: { error: 'not_relayed' } })
      const method = f.method === 'POST' ? 'POST' : 'GET'
      const headers = {}
      let body
      if (method === 'POST') {
        headers['x-monitor-token'] = local.token()
        if (typeof f.b64 === 'string') { body = Buffer.from(f.b64, 'base64'); headers['content-type'] = 'application/octet-stream' }
        else { body = JSON.stringify(f.body ?? {}); headers['content-type'] = 'application/json' }
      }
      try {
        const r = await fetch(localUrl(p), { method, headers, body, signal: AbortSignal.timeout(5 * 60 * 1000) })
        const type = r.headers.get('content-type') || ''
        if (type.includes('application/json')) {
          const j = await r.json().catch(() => ({}))
          if (j && typeof j === 'object') delete j.token   // /api/state carries the local token for the page; never for the app
          out(ws, { t: 'res', id: f.id, status: r.status, body: j })
        } else {
          const buf = Buffer.from(await r.arrayBuffer())
          if (buf.length > MAX_RELAYED_BODY) return out(ws, { t: 'res', id: f.id, status: 413, body: { error: 'too_large' } })
          out(ws, { t: 'res', id: f.id, status: r.status, b64: buf.toString('base64'), type })
        }
      } catch { out(ws, { t: 'res', id: f.id, status: 502, body: { error: 'monitor_unreachable' } }) }
      return
    }
    if (f.t === 'sub') {
      if (!STREAMS.has(pathname)) return out(ws, { t: 'end', id: f.id, error: 'not_a_stream' })
      const ac = new AbortController()
      relay?.streams.set(f.id, ac)
      try {
        const r = await fetch(localUrl(p), { signal: ac.signal })
        if (!r.ok || !r.body) return out(ws, { t: 'end', id: f.id, error: 'http' + r.status })
        // server-sent events, one frame each: blocks end with a blank line; ":" lines are pings
        const dec = new TextDecoder()
        let buf = ''
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2)
            let event = 'message'
            const data = []
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
            }
            if (data.length) out(ws, { t: 'ev', id: f.id, event, data: data.join('\n') })
          }
        }
        out(ws, { t: 'end', id: f.id })
      } catch { if (!ac.signal.aborted) out(ws, { t: 'end', id: f.id, error: 'monitor_unreachable' }) }
      finally { relay?.streams.delete(f.id) }
    }
  }

  if (saved) setTimeout(relayStart, 1000).unref?.()   // once the local server listens

  // a request is waiting on this PC: the server tells the phone (live if the app is open, a push if not).
  // Only who and which tool go: { kind, agent: { name, agentId?, managed }, title, tool } — no command, no question text.
  function notify(n) {
    if (!relay || relayState !== 'on' || !n?.agent?.name) return
    out(relay.ws, { t: 'notify', kind: n.kind, agent: n.agent, title: String(n.title || '').slice(0, 40), tool: String(n.tool || '').slice(0, 40) })
  }

  // for the page (behind the monitor's token)
  async function info(fresh) {
    if (saved) await check(fresh)
    const v = status?.value
    return {
      server: saved?.server || CAM_URL,
      linked: !!saved,
      account: v ? { name: v.user.name, plan: v.plan.name, used: v.used, limit: v.plan.device_limit, device: v.device.name } : null,
      checkedAt: status?.at || null, error: status?.error || null,
      relay: saved ? relayState : null,
      pending: pendingView(), note,
    }
  }

  async function handle(url) {
    if (url.pathname === '/api/cloud/link') return link()
    if (url.pathname === '/api/cloud/cancel') { stopEnrolling(); note = null; return [200, {}] }
    if (url.pathname === '/api/cloud/unlink') return unlink()
    return [404, {}]
  }

  return { info, handle, notify, stop: () => { clearInterval(beat); stopEnrolling(); relayStop() } }
}
