// Registers the monitor's hooks in Claude Code's settings (see main.cjs). Kept apart from Electron so it can be tested with plain node.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

// lang: the app's language at the moment ('ko' or 'en'), for the one message a person may see
module.exports = function hookSetup({ hooksDir, execPath, settingsPath = path.join(os.homedir(), '.claude', 'settings.json'), node, lang = () => 'en' }) {
const UNREADABLE = { ko: ' 파일을 읽을 수 없습니다', en: ' could not be read' }
const CLAUDE_SETTINGS = settingsPath
const HOOKS = hooksDir
const cmdText = (h) => [h.command, ...(h.args || [])].join(' ')
const ours = (h) => /[\\/]hooks[\\/](bridge|inbox)\.mjs/.test(cmdText(h))
const WIN = process.platform === 'win32'
let macNode = null
function findNode() {
  if (node !== undefined) return node
  if (WIN) { try { return execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l)) || '' } catch { return '' } }
  // macOS: an app started from the Finder gets a bare PATH, so ask the login shell (nvm, fnm, …) before the usual
  // places. A login shell takes a moment, so the answer is kept while it still points at a file.
  if (macNode !== null && (!macNode || fs.existsSync(macNode))) return macNode
  macNode = ''
  try {
    const found = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v node'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\n/).pop()
    if (found && path.isAbsolute(found) && fs.existsSync(found)) macNode = found
  } catch {}
  if (!macNode) macNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p)) || ''
  return macNode
}
function hookCmd(script, extra) {
  const file = path.join(HOOKS, script)
  const node = findNode()
  if (node) return { type: 'command', command: node, args: [file], ...extra }
  if (WIN) {
    const q = (p) => "'" + p.replace(/'/g, "''") + "'"
    return { type: 'command', shell: 'powershell', command: "$env:ELECTRON_RUN_AS_NODE='1'; & " + q(execPath) + ' ' + q(file), ...extra }
  }
  const q = (p) => "'" + p.replace(/'/g, "'\\''") + "'"
  return { type: 'command', command: 'ELECTRON_RUN_AS_NODE=1 ' + q(execPath) + ' ' + q(file), ...extra }
}
// seconds. 1800 at first, then a day; either left a session resting longer than that unreachable from the page.
// A week costs one small waiting process per resting session.
const INBOX_TIMEOUT = 7 * 86400
function hookEntries() {
  return {
    PermissionRequest: [{ matcher: '*', hooks: [hookCmd('bridge.mjs', { timeout: 90 })] }],
    PostToolUse: [{ matcher: '*', hooks: [hookCmd('bridge.mjs', { async: true, timeout: 10 })] }],
    Notification: [{ hooks: [hookCmd('bridge.mjs', { async: true, timeout: 10 })] }],
    // a project's leader is told who its team is (only when that changed); everyone else gets nothing added
    UserPromptSubmit: [{ hooks: [hookCmd('bridge.mjs', { timeout: 10 })] }],
    // the inbox waits up to a week, so a session resting for days can still be woken by a message from the page
    Stop: [{ hooks: [hookCmd('bridge.mjs', { async: true, timeout: 10 })] }, { hooks: [hookCmd('inbox.mjs', { asyncRewake: true, timeout: INBOX_TIMEOUT })] }],
  }
}
function readClaudeSettings() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) } catch (e) { return e.code === 'ENOENT' ? {} : null }
}
// 'ok' when every event has one of our hooks and its script exists; 'outdated' when the message hook still has the
// old half-hour timeout or the team hook for leaders (added later) is not there yet; otherwise 'missing'
const LATER = ['UserPromptSubmit']
function hookState() {
  const cfg = readClaudeSettings()
  if (!cfg) return 'unreadable'
  let stale = false
  for (const event of Object.keys(hookEntries())) {
    const mine = (cfg.hooks?.[event] || []).flatMap((m) => m.hooks || []).filter(ours)
    if (!mine.length && LATER.includes(event)) { stale = true; continue }
    if (!mine.length) return 'missing'
    // the script is the last argument of an exec-form hook, or the quoted path inside a shell command
    const h = mine[0]
    const quoted = String(h.command || '').match(/['"]([^'"]*[\\/]hooks[\\/](?:bridge|inbox)\.mjs)['"]/)
    const script = Array.isArray(h.args) && h.args.length ? h.args[h.args.length - 1] : quoted ? quoted[1] : ''
    if (!script || !fs.existsSync(script)) return 'missing'
  }
  const inbox = (cfg.hooks?.Stop || []).flatMap((m) => m.hooks || []).find((h) => /[\\/]hooks[\\/]inbox\.mjs/.test(cmdText(h)))
  if (!inbox) return 'missing'
  if (stale || !(Number(inbox.timeout) >= INBOX_TIMEOUT)) return 'outdated'
  return 'ok'
}
// replaces the monitor's own entries and leaves every other setting and hook as it was (a backup is kept)
function installHooks() {
  const cfg = readClaudeSettings()
  if (!cfg) throw new Error(CLAUDE_SETTINGS + (UNREADABLE[lang()] || UNREADABLE.en))
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true })
  if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + '.before-agent-monitor')
  cfg.hooks = cfg.hooks || {}
  for (const [event, entries] of Object.entries(hookEntries())) {
    const kept = (cfg.hooks[event] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !ours(h)) })).filter((m) => m.hooks.length)
    cfg.hooks[event] = [...kept, ...entries]
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n')
}
  return { hookState, installHooks, findNode, CLAUDE_SETTINGS }
}
