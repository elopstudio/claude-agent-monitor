// This PC linked to an Agent Monitor account on cam.elopstudio.com, the way `tailscale up` links a machine:
// the monitor makes an Ed25519 key pair and asks for a short code, the person approves the code in the browser
// (signed in with GitHub or Google, within the PCs their plan allows), and the monitor collects its device id.
// From then on each request to the server is signed with the private key; there is no password or token to lose.
//
// Kept in <data>/cloud.json: the server, the device id, the private key and whether the summary is shared — nothing
// about the person. Their name and plan are asked for when the page wants them and kept in memory only. The key never
// leaves this file.
//
// While linked (and unless turned off) the monitor sends a summary every minute it changes, at least every five: per
// project its name and how many agents are working, waiting and resting, and how many requests wait for a click.
// Counts only: no session names, prompts, conversations, commands or files. The account page shows it.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CAM_URL = (process.env.CAM_URL || 'https://cam.elopstudio.com').replace(/\/+$/, '')
const CHECK_EVERY = 60 * 1000          // the page may ask every few seconds; the server is asked at most once a minute
const HEARTBEAT = 10 * 60 * 1000       // and every ten minutes in the background, so the account shows when this PC was last on
const TIMEOUT = 10 * 1000
const SUMMARY_EVERY = 60 * 1000        // the summary is looked at this often and sent when it changed…
const SUMMARY_AT_LEAST = 5 * 60 * 1000 // …or when it has not been sent for this long

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const signedMessage = (method, pathAndQuery, time, raw) => ['cam-device-v1', method, pathAndQuery, time, sha256(raw)].join('\n')

// summary(): the counts to share, { projects: [{ name, working, waiting, resting }], approvals, asking }
export function createCloud({ dataDir, version, notifyPages = () => {}, summary = null }) {
  const file = path.join(dataDir, 'cloud.json')
  let saved = load()      // { server, deviceId, key, share } — linked
  let enrolling = null    // { server, key, deviceCode, code, url, expiresAt, interval, timer } — waiting for the person
  let status = null       // { at, value | null, error | null } — the server's last answer about this PC
  let note = null         // what happened last, for the page: linked | denied | expired | removed | unlinkedHere
  let checking = null

  function load() {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (o.server && o.device_id && o.key) return { server: o.server, deviceId: o.device_id, key: crypto.createPrivateKey(o.key), share: o.share_status !== false, linkedAt: o.linked_at }
    } catch {}
    return null
  }
  function save(s) {
    const tmp = file + '.' + process.pid + '.tmp'
    const key = s.key.export({ format: 'pem', type: 'pkcs8' })
    fs.mkdirSync(dataDir, { recursive: true })
    s.linkedAt = s.linkedAt || new Date().toISOString()
    fs.writeFileSync(tmp, JSON.stringify({ server: s.server, device_id: s.deviceId, key, share_status: s.share !== false, linked_at: s.linkedAt }, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  function forget() { saved = null; status = null; lastSent = null; try { fs.unlinkSync(file) } catch {} }

  // one request to the server, signed with `key` when given; → { status, body } or { status: 0 } when unreachable
  async function call(server, method, p, body, { key, deviceId } = {}) {
    const raw = body ? JSON.stringify(body) : ''
    const headers = { 'x-cam': '1', ...(raw ? { 'content-type': 'application/json' } : {}) }
    if (key) {
      const time = String(Math.floor(Date.now() / 1000))
      headers['x-cam-time'] = time
      headers['x-cam-sig'] = crypto.sign(null, Buffer.from(signedMessage(method, p, time, Buffer.from(raw))), key).toString('base64')
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
      saved = { server: e.server, deviceId: r.body.device_id, key: e.key, share: true }
      lastSent = null
      setTimeout(() => sendSummary(true), 1000).unref?.()
      save(saved)
      enrolling = null; status = null; note = 'linked'
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

  // ── the summary for the account page ─────────────────

  let lastSent = null     // { json, at } — what was sent last, so an unchanged summary is not sent every minute
  let sending = false
  async function sendSummary(force) {
    if (!saved || !summary || sending) return
    const s = saved
    sending = true
    try {
      const body = s.share ? await summary() : { projects: [], approvals: 0, asking: 0 }   // off: what was there is emptied once
      const json = JSON.stringify(body)
      if (!force && lastSent && lastSent.json === json && Date.now() - lastSent.at < SUMMARY_AT_LEAST) return
      if (!force && !s.share && lastSent && lastSent.json === json) return   // off and already emptied
      const r = await call(s.server, 'PUT', '/api/device/status', body, { key: s.key, deviceId: s.deviceId })
      if (saved !== s) return
      if (r.status === 200) lastSent = { json, at: Date.now() }
      else if (r.status === 401 && (r.body.error === 'device_revoked' || r.body.error === 'no_such_device')) { forget(); note = 'removed'; notifyPages() }
    } catch {} finally { sending = false }
  }
  const tick = setInterval(() => { sendSummary(false) }, SUMMARY_EVERY)
  tick.unref?.()
  if (saved) setTimeout(() => sendSummary(false), 5000).unref?.()   // after start, once the state has been read

  function setShare(on) {
    if (!saved) return [409, { error: 'not_linked' }]
    saved.share = on
    save(saved)
    sendSummary(true)
    notifyPages()
    return [200, { share: on }]
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
      share: saved ? saved.share !== false : null, sharedAt: saved && lastSent ? lastSent.at : null,
      pending: pendingView(), note,
    }
  }

  async function handle(url) {
    if (url.pathname === '/api/cloud/link') return link()
    if (url.pathname === '/api/cloud/cancel') { stopEnrolling(); note = null; return [200, {}] }
    if (url.pathname === '/api/cloud/unlink') return unlink()
    if (url.pathname === '/api/cloud/share-on') return setShare(true)
    if (url.pathname === '/api/cloud/share-off') return setShare(false)
    return [404, {}]
  }

  return { info, handle, stop: () => { clearInterval(beat); clearInterval(tick); stopEnrolling() } }
}
