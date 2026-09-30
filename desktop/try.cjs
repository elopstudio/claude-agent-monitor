// `npm run try`: this checkout's app beside the installed one, to see changes before they are released.
// It has its own port (4799), profile and data folder, so the installed app, its hooks and its agents are left alone.
// The data folder starts as a copy of the installed app's names, looks, tab order, boards and last usage numbers —
// never its agent list, which only one app may run. Notifications, the global shortcut, hook installs and usage
// requests are off in it (they are the installed app's), and the page and the tray say it is the test app.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const home = path.join(os.tmpdir(), 'agent-monitor-try')
const data = path.join(home, 'data')
const profile = path.join(home, 'profile')

// the installed app's data folder: where its settings say, else the default
const appData = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support')
let real = path.join(os.homedir(), '.claude-agent-monitor')
try {
  const s = JSON.parse(fs.readFileSync(path.join(appData, 'Agent Monitor', 'settings.json'), 'utf8'))
  if (s.dataDir && fs.existsSync(s.dataDir)) real = s.dataDir
} catch {}

fs.mkdirSync(path.join(data, '.runtime'), { recursive: true })
for (const f of ['config.json', path.join('.runtime', 'usage.json')]) {
  try { fs.copyFileSync(path.join(real, f), path.join(data, f)) } catch {}
}
try { fs.cpSync(path.join(real, 'boards'), path.join(data, 'boards'), { recursive: true }) } catch {}

const electron = require('electron')   // the path of the Electron binary
const child = spawn(electron, ['.', '--user-data-dir=' + profile], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, PORT: '4799', MONITOR_HOME: data, MONITOR_LINK: path.join(home, 'link.json'), MONITOR_TRY: '1', MONITOR_USAGE: 'off' },
})
console.log('test app on http://127.0.0.1:4799/ — data copied from ' + real)
child.on('exit', (code) => process.exit(code ?? 0))
