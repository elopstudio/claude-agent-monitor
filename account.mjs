// The Claude account this machine is signed in with: who it is, how much of the plan's limits is used,
// and signing out or in as someone else (through `claude auth`, so Claude Code keeps its own credentials).
//
// The email and the token are read from Claude Code's files when the page asks, and kept in memory only:
// nothing here writes them to disk or logs them. The usage numbers come from the endpoint Claude Code's
// /usage uses; when that cannot be reached, the last numbers Claude Code cached are shown instead.

import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_TTL = 60 * 1000   // the page may ask every few seconds; the server is asked at most once a minute

export function createAccount({ claudeExecutable }) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const stateFile = process.env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json')
  const credFile = path.join(configDir, '.credentials.json')
  const readJson = async (f) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')) } catch { return null } }
  let usageMemo = null   // { key, at, value }
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
    const fromCache = (why) => cached?.utilization
      ? { source: 'cache', at: cached.fetchedAtMs || null, limits: limitsOf(cached.utilization), extra: extraOf(cached.utilization), why }
      : { source: 'none', at: null, limits: [], extra: null, why }
    if (!oauth?.accessToken) return fromCache('noToken')
    // an expired token is Claude Code's to refresh; this only reads it
    if (oauth.expiresAt && oauth.expiresAt < Date.now() + 30 * 1000) return fromCache('expired')
    const key = oauth.accessToken.slice(-12)   // a new sign-in must not see the last account's numbers
    if (!fresh && usageMemo && usageMemo.key === key && Date.now() - usageMemo.at < USAGE_TTL) return usageMemo.value
    try {
      const r = await fetch(USAGE_URL, { headers: { authorization: 'Bearer ' + oauth.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) return fromCache('http' + r.status)
      const u = await r.json()
      const value = { source: 'live', at: Date.now(), limits: limitsOf(u), extra: extraOf(u), why: null }
      usageMemo = { key, at: Date.now(), value }
      return value
    } catch {
      return fromCache('offline')
    }
  }

  async function info(fresh) {
    const [state, cred] = await Promise.all([readJson(stateFile), readJson(credFile)])
    const oauth = cred?.claudeAiOauth || null
    const a = state?.oauthAccount || null
    const loggedIn = !!(a && (oauth?.accessToken || process.platform === 'darwin'))   // on macOS the token is in the keychain
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
  function openLogin() {
    const child = spawn(claudeExecutable(), ['auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: false })
    busy = 'login'
    const done = () => { if (busy === 'login') busy = null; usageMemo = null }
    child.on('exit', done)
    child.on('error', done)
    child.unref()
  }

  async function handle(url) {
    if (busy) return [409, { busy }]
    if (url.pathname === '/api/account/logout') {
      busy = 'logout'
      const ok = await run(['auth', 'logout'])
      busy = null; usageMemo = null
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

  return { info, handle }
}
