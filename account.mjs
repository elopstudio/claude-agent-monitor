// The Claude account this machine is signed in with: who it is, how much of the plan's limits is used,
// and signing out or in as someone else (through `claude auth`, so Claude Code keeps its own credentials).
//
// The email and the token are read from Claude Code's files when the page asks, and kept in memory only:
// nothing here writes them to disk or logs them. The usage numbers come from the endpoint Claude Code's
// /usage uses. It turns callers away (429) when asked often, so it is asked every five minutes, and less often
// after a refusal; in between, and when it cannot be reached, the newest numbers known are shown with their time.
// The last numbers Anthropic sent are kept in .runtime/usage.json so a restart does not lose them: percentages,
// reset times and when they were checked, tied to the account only by a one-way hash of its id.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_TTL = 60 * 1000             // the page may ask every few seconds; the files are read at most once a minute
const USAGE_EVERY = 5 * 60 * 1000       // Anthropic is asked at most this often in the background
const FRESH_EVERY = 60 * 1000           // and at most this often when the dialog's Refresh is pressed
const BACKOFF_MAX = 30 * 60 * 1000      // after refusals, the wait doubles up to this

export function createAccount({ claudeExecutable, dataDir }) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const stateFile = process.env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json')
  const credFile = path.join(configDir, '.credentials.json')
  const readJson = async (f) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')) } catch { return null } }
  let usageMemo = null   // { key, at, value } — the last answer given, live or not
  let lastLive = null    // { key, value } — the last numbers Anthropic actually sent
  let askedAt = 0, blockedUntil = 0, backoff = USAGE_EVERY
  const KEEP_FILE = dataDir ? path.join(dataDir, '.runtime', 'usage.json') : null
  // the last numbers survive a restart; only numbers and times are written, and the account as a hash
  try { const k = KEEP_FILE && JSON.parse(fs.readFileSync(KEEP_FILE, 'utf8')); if (k?.key && k.value?.limits) lastLive = { key: k.key, value: k.value } } catch {}
  function keepLive() {
    if (!KEEP_FILE) return
    try {
      fs.mkdirSync(path.dirname(KEEP_FILE), { recursive: true })
      if (!lastLive) { fs.rmSync(KEEP_FILE, { force: true }); return }
      const { source, at, limits, extra } = lastLive.value
      fs.writeFileSync(KEEP_FILE, JSON.stringify({ key: lastLive.key, value: { source, at, limits, extra } }))
    } catch {}
  }
  let refreshing = null, triedAt = 0
  let busy = null        // 'login' | 'logout' while `claude auth` runs

  // the limits as a list the page can draw as it is: newer answers have `limits`, older ones only the named windows
  function limitsOf(u) {
    if (Array.isArray(u?.limits)) {
      return u.limits.filter((x) => x && typeof x.percent === 'number').map((x) => ({
        kind: String(x.kind || ''), model: x.scope?.model?.display_name || null, percent: x.percent,
        resetsAt: x.resets_at || null, severity: x.severity || 'normal', active: !!x.is_active,
      }))
    }
    const named = [['five_hour', 'session'], ['seven_day', 'weekly_all'], ['seven_day_opus', 'weekly_scoped', 'Opus'], ['seven_day_sonnet', 'weekly_scoped', 'Sonnet']]
    return named.filter(([k]) => typeof u?.[k]?.utilization === 'number')
      .map(([k, kind, model]) => ({ kind, model: model || null, percent: u[k].utilization, resetsAt: u[k].resets_at || null, severity: 'normal', active: false }))
  }
  function extraOf(u) {
    const s = u?.spend, e = u?.extra_usage
    if (s && s.enabled) {
      const money = (m) => m && typeof m.amount_minor === 'number' ? { amount: m.amount_minor / 10 ** (m.exponent ?? 2), currency: m.currency || 'USD' } : null
      return { used: money(s.used), limit: money(s.limit), percent: typeof s.percent === 'number' ? s.percent : null }
    }
    if (e && e.is_enabled) return { used: e.used_credits != null ? { amount: e.used_credits, currency: e.currency || 'USD' } : null, limit: e.monthly_limit != null ? { amount: e.monthly_limit, currency: e.currency || 'USD' } : null, percent: e.utilization ?? null }
    return null
  }

  async function usage(oauth, state, fresh) {
    const cached = state?.cachedUsageUtilization
    // whose numbers: the account (a hash of its id), so a renewed token keeps them and another sign-in does not see them
    const who = state?.oauthAccount?.accountUuid || oauth?.accessToken || ''
    const key = who ? crypto.createHash('sha256').update('agent-monitor:' + who).digest('hex').slice(0, 16) : 'none'
    if (lastLive && lastLive.key !== key) { lastLive = null; keepLive(); usageMemo = null; askedAt = 0; blockedUntil = 0; backoff = USAGE_EVERY }
    const now = Date.now()
    const keep = (value) => { usageMemo = { key, at: now, value }; return value }
    // not asking now: the newest numbers known — this monitor's own last answer, or what Claude Code saved
    const known = (why) => {
      const mine = lastLive?.value, cc = cached?.utilization ? { at: cached.fetchedAtMs || 0, limits: limitsOf(cached.utilization), extra: extraOf(cached.utilization) } : null
      const best = mine && (!cc || mine.at >= cc.at) ? { ...mine, source: 'stale' } : cc ? { ...cc, source: 'cache' } : { source: 'none', at: null, limits: [], extra: null }
      // a limit whose reset time has passed since then started again from zero; its new number is not known yet
      const limits = (best.limits || []).map((x) => (x.resetsAt && Date.parse(x.resetsAt) <= now ? { ...x, percent: 0, resetsAt: null, sinceReset: true } : x))
      return keep({ ...best, limits, why, nextAt: Math.max(blockedUntil, askedAt + USAGE_EVERY) })
    }
    // a test app (`npm run try`) never asks, so it cannot add to the requests Anthropic counts; it shows what it was given
    if (process.env.MONITOR_USAGE === 'off') return known('off')
    if (!oauth?.accessToken) return known('noToken')
    // an expired token is Claude Code's to refresh; this only reads it
    if (oauth.expiresAt && oauth.expiresAt < now + 30 * 1000) return known('expired')
    const due = now >= blockedUntil && now - askedAt >= (fresh ? FRESH_EVERY : USAGE_EVERY)
    if (!due) return usageMemo?.key === key && usageMemo.value.source === 'live' && now - usageMemo.value.at < USAGE_EVERY ? usageMemo.value : known(usageMemo?.value?.why || null)
    askedAt = now
    try {
      const r = await fetch(USAGE_URL, { headers: { authorization: 'Bearer ' + oauth.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000) })
      if (r.status === 429) {
        // turned away for asking too often: wait longer each time, as long as it says if that is longer
        backoff = Math.min(backoff * 2, BACKOFF_MAX)
        blockedUntil = now + Math.max(backoff, (Number(r.headers.get('retry-after')) || 0) * 1000)
        return known('http429')
      }
      if (!r.ok) { blockedUntil = now + USAGE_EVERY; return known('http' + r.status) }
      const u = await r.json()
      backoff = USAGE_EVERY; blockedUntil = 0
      const value = { source: 'live', at: now, limits: limitsOf(u), extra: extraOf(u), why: null, nextAt: now + USAGE_EVERY }
      lastLive = { key, value }
      keepLive()
      return keep(value)
    } catch {
      blockedUntil = now + USAGE_EVERY
      return known('offline')
    }
  }

  // for the page's header and the app's alerts: the numbers only, never whose they are; asked again in the background
  function usageNow() {
    if (Date.now() - triedAt >= USAGE_TTL && !refreshing) { triedAt = Date.now(); refreshing = info(false).catch(() => null).finally(() => { refreshing = null }) }
    const v = usageMemo?.value
    return v && v.limits.length ? { source: v.source, at: v.at, limits: v.limits } : null
  }

  async function info(fresh) {
    const [state, cred] = await Promise.all([readJson(stateFile), readJson(credFile)])
    const oauth = cred?.claudeAiOauth || null
    const a = state?.oauthAccount || null
    const loggedIn = !!(a && (oauth?.accessToken || process.platform === 'darwin'))   // on macOS the token is in the keychain
    if (busy === 'login' && loggedIn) busy = null   // signed in: done, even where the window it ran in cannot be watched
    return {
      loggedIn, busy,
      email: a?.emailAddress || null, name: a?.displayName || a?.fullName || null, org: a?.organizationName || null,
      plan: oauth?.subscriptionType || null, tier: oauth?.rateLimitTier || a?.userRateLimitTier || null,
      usage: loggedIn ? await usage(oauth, state, fresh) : null,
    }
  }

  // `claude auth logout` quietly; `claude auth login` in a window of its own, since it opens a browser and may ask for a code
  function run(args) {
    return new Promise((resolve) => execFile(claudeExecutable(), args, { windowsHide: true, timeout: 30 * 1000 }, (err) => resolve(!err)))
  }
  // claude needs a real terminal to open the browser and take the code. On Windows a detached child has no console
  // at all, so `start /wait` opens one (the hidden cmd lives until that window is closed); on macOS it runs in Terminal
  function openLogin() {
    const exe = claudeExecutable()
    let child, until = 0
    if (process.platform === 'win32') {
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "Claude Code - sign in" /wait "${exe}" auth login`],
        { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    } else if (process.platform === 'darwin') {
      const cmd = "'" + exe.replace(/'/g, "'\\''") + "' auth login"
      child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/(["\\])/g, '\\$1')}"`, '-e', 'tell application "Terminal" to activate'], { stdio: 'ignore' })
      until = 10 * 60 * 1000   // osascript returns at once; the wait message stays up while the sign-in may still be going on
    } else {
      child = spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore' })
    }
    busy = 'login'
    const done = () => { if (busy === 'login') busy = null; usageMemo = null }
    child.on('exit', () => (until ? setTimeout(done, until) : done()))
    child.on('error', done)
    child.unref()
  }

  async function handle(url) {
    if (busy) return [409, { busy }]
    if (url.pathname === '/api/account/logout') {
      busy = 'logout'
      const ok = await run(['auth', 'logout'])
      busy = null; usageMemo = null; lastLive = null; keepLive()
      return [ok ? 200 : 500, {}]
    }
    if (url.pathname === '/api/account/login') { openLogin(); return [200, {}] }
    if (url.pathname === '/api/account/switch') {
      busy = 'logout'
      await run(['auth', 'logout'])
      busy = null
      openLogin()
      return [200, {}]
    }
    return [404, {}]
  }

  return { info, handle, usageNow }
}
