// Registers the monitor's hooks in Claude Code's settings (see main.cjs). Kept apart from Electron so it can be tested with plain node.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

module.exports = function hookSetup({ hooksDir, execPath, settingsPath = path.join(os.homedir(), '.claude', 'settings.json'), node }) {
const CLAUDE_SETTINGS = settingsPath
const HOOKS = hooksDir
const cmdText = (h) => [h.command, ...(h.args || [])].join(' ')
const ours = (h) => /[\\/]hooks[\\/](bridge|inbox)\.mjs/.test(cmdText(h))
function findNode() {
  if (node !== undefined) return node
  try { return execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l)) || '' } catch { return '' }
}
function hookCmd(script, extra) {
  const file = path.join(HOOKS, script)
  const node = findNode()
  if (node) return { type: 'command', command: node, args: [file], ...extra }
  const q = (p) => "'" + p.replace(/'/g, "''") + "'"
  return { type: 'command', shell: 'powershell', command: "$env:ELECTRON_RUN_AS_NODE='1'; & " + q(execPath) + ' ' + q(file), ...extra }
}
function hookEntries() {
  return {
    PermissionRequest: [{ matcher: '*', hooks: [hookCmd('bridge.mjs', { timeout: 90 })] }],
    PostToolUse: [{ matcher: '*', hooks: [hookCmd('bridge.mjs', { async: true, timeout: 10 })] }],
    Notification: [{ hooks: [hookCmd('bridge.mjs', { async: true, timeout: 10 })] }],
    Stop: [{ hooks: [hookCmd('bridge.mjs', { async: true, timeout: 10 })] }, { hooks: [hookCmd('inbox.mjs', { asyncRewake: true, timeout: 1800 })] }],
  }
}
function readClaudeSettings() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) } catch (e) { return e.code === 'ENOENT' ? {} : null }
}
// 'ok' when every event has one of our hooks and its script exists; otherwise 'missing'
function hookState() {
  const cfg = readClaudeSettings()
  if (!cfg) return 'unreadable'
  for (const event of Object.keys(hookEntries())) {
    const mine = (cfg.hooks?.[event] || []).flatMap((m) => m.hooks || []).filter(ours)
    if (!mine.length) return 'missing'
    // the script is the last argument of an exec-form hook, or the quoted path inside a shell command
    const h = mine[0]
    const quoted = String(h.command || '').match(/['"]([^'"]*[\\/]hooks[\\/](?:bridge|inbox)\.mjs)['"]/)
    const script = Array.isArray(h.args) && h.args.length ? h.args[h.args.length - 1] : quoted ? quoted[1] : ''
    if (!script || !fs.existsSync(script)) return 'missing'
  }
  return 'ok'
}
// replaces the monitor's own entries and leaves every other setting and hook as it was (a backup is kept)
function installHooks() {
  const cfg = readClaudeSettings()
  if (!cfg) throw new Error(CLAUDE_SETTINGS + ' could not be read')
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
