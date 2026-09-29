// Agent Monitor as a desktop app: runs the monitor server inside the app, shows it in its own window,
// and lives in the tray — so it no longer depends on a terminal or on VS Code staying open.
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const PORT = Number(process.env.PORT) || 4777
const URL = `http://127.0.0.1:${PORT}/`
// the monitor's code: next to this folder while developing, in the app's resources once installed
const CODE = app.isPackaged ? path.join(process.resourcesPath, 'monitor') : path.join(__dirname, '..')
const ICON = path.join(__dirname, 'icon.png')

/* ── settings: where the monitor keeps config.json, boards/ and its agent list ── */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } }
function writeSettings(s) { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)) }
function dataDir() {
  const s = readSettings()
  if (s.dataDir && fs.existsSync(s.dataDir)) return s.dataDir
  // while developing, the repository itself; installed, a folder in the home directory
  return app.isPackaged ? path.join(app.getPath('home'), '.claude-agent-monitor') : CODE
}

/* ── the server ── */
// another monitor may already be answering on the port (npm start in a terminal): use it instead of starting one
function answering() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
let ownServer = false
async function startServer() {
  if (await answering()) return
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  process.env.MONITOR_HOME = dir
  process.env.PORT = String(PORT)
  await import(pathToFileURL(path.join(CODE, 'server.mjs')).href)
  ownServer = true
  for (let i = 0; i < 40 && !(await answering()); i++) await new Promise((r) => setTimeout(r, 150))
}

/* ── window and tray ── */
let win = null, tray = null, quitting = false
function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return }
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 720, minHeight: 480, title: 'Agent Monitor', icon: ICON,
    backgroundColor: '#0f1116', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  win.loadURL(URL)
  // links in replies open in the real browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) } })
  // closing the window keeps the monitor running in the tray
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide() } })
  win.on('closed', () => { win = null })
}
function trayMenu() {
  const login = app.getLoginItemSettings().openAtLogin
  return Menu.buildFromTemplate([
    { label: 'Agent Monitor 열기', click: showWindow },
    { label: '브라우저에서 열기', click: () => shell.openExternal(URL) },
    { type: 'separator' },
    { label: '로그인할 때 자동 시작', type: 'checkbox', checked: login, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); tray.setContextMenu(trayMenu()) } },
    { label: '데이터 폴더 열기', click: () => shell.openPath(dataDir()) },
    {
      label: '데이터 폴더 바꾸기…', enabled: ownServer, click: async () => {
        const r = await dialog.showOpenDialog({ title: '데이터 폴더 (config.json, boards/)', defaultPath: dataDir(), properties: ['openDirectory', 'createDirectory'] })
        if (r.canceled || !r.filePaths[0]) return
        writeSettings({ ...readSettings(), dataDir: r.filePaths[0] })
        const ok = await dialog.showMessageBox({ type: 'info', buttons: ['다시 시작', '나중에'], message: '데이터 폴더를 바꿨습니다.', detail: '앱을 다시 시작하면 새 폴더를 씁니다.' })
        if (ok.response === 0) { app.relaunch(); quit() }
      },
    },
    { type: 'separator' },
    { label: ownServer ? '종료 (모니터 에이전트도 멈춤)' : '종료', click: quit },
  ])
}
function quit() {
  quitting = true
  if (ownServer && typeof globalThis.agentMonitorShutdown === 'function') globalThis.agentMonitorShutdown()
  app.quit()
}

/* ── lifecycle ── */
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    try { await startServer() } catch (e) {
      dialog.showErrorBox('Agent Monitor', '모니터 서버를 시작하지 못했습니다.\n\n' + (e && e.message || e))
      app.quit()
      return
    }
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }))
    tray.setToolTip('Agent Monitor')
    tray.setContextMenu(trayMenu())
    tray.on('click', showWindow)
    // started at login: stay in the tray until opened
    if (!process.argv.includes('--hidden')) showWindow()
  })
  app.on('window-all-closed', () => { /* the tray keeps the app alive */ })
  app.on('before-quit', () => { quitting = true })
}
