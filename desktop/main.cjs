// Agent Monitor as a desktop app: runs the monitor server inside the app, shows it in its own window,
// and lives in the tray — so it no longer depends on a terminal or on VS Code staying open.
const { app, BaseWindow, BrowserWindow, WebContentsView, Tray, Menu, shell, dialog, nativeImage, nativeTheme, ipcMain } = require('electron')
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

/* ── Claude Code hooks: approvals, modes, messages ── */
// The monitor learns about permission prompts, modes and idle sessions through hooks registered in
// ~/.claude/settings.json. The app registers them itself, pointing at the scripts it ships, so a new PC
// needs nothing but Claude Code: with Node.js on the PATH the hooks run on it directly; without, this
// app's own executable runs them as Node (ELECTRON_RUN_AS_NODE).
const setup = require('./hooks-setup.cjs')({ hooksDir: path.join(CODE, 'hooks'), execPath: process.execPath })
const { hookState, installHooks, findNode, CLAUDE_SETTINGS } = setup

async function offerHooks(always) {
  const state = hookState()
  if (state === 'ok' && !always) return
  const settings = readSettings()
  if (!always && settings.hooksDeclined) return
  const r = await dialog.showMessageBox({
    type: 'question', buttons: ['설치', '나중에'], defaultId: 0, cancelId: 1,
    message: always ? 'Claude Code hook을 이 앱 기준으로 다시 설치할까요?' : 'Claude Code에 모니터 hook을 설치할까요?',
    detail: '승인·질문에 답하기, 권한 모드 표시, 에이전트에게 메시지 보내기에 필요합니다.\n' + CLAUDE_SETTINGS + ' 의 모니터 항목만 추가·교체하고, 다른 설정은 그대로 둡니다 (백업: settings.json.before-agent-monitor).\n' + (findNode() ? 'hook은 이 PC의 Node.js로 실행됩니다.' : 'Node.js가 없어서 hook은 이 앱으로 실행됩니다.'),
  })
  if (r.response !== 0) { if (!always) writeSettings({ ...settings, hooksDeclined: true }); return }
  try { installHooks(); await dialog.showMessageBox({ type: 'info', message: 'hook을 설치했습니다.', detail: '실행 중인 Claude Code 세션에도 곧바로 적용됩니다.' }) }
  catch (e) { dialog.showErrorBox('Agent Monitor', 'hook을 설치하지 못했습니다.\n\n' + (e && e.message || e)) }
  if (tray) tray.setContextMenu(trayMenu())
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
// The window is two views: a 36 px title strip (strip.html) on the window buttons' line, and the monitor page
// under it. Zoom, reload and history apply to the page only, so the strip keeps its size like the buttons do.
const STRIP = 36
const DARK = { color: '#171b22', symbolColor: '#e8eaef', height: STRIP }, LIGHT = { color: '#ffffff', symbolColor: '#171a21', height: STRIP }
const overlay = () => (nativeTheme.shouldUseDarkColors ? DARK : LIGHT)
nativeTheme.on('updated', () => { if (win) { try { win.setTitleBarOverlay(overlay()) } catch {} } })
const LOGIN = { args: ['--hidden'] }   // started at login: stay in the tray
const zoom = () => { const z = Number(readSettings().zoom); return z >= 0.5 && z <= 2 ? z : 1 }
let win = null, page = null, strip = null
function pageState() {
  if (!page) return { zoom: 1, canBack: false, canForward: false }
  const wc = page.webContents, h = wc.navigationHistory
  return { zoom: wc.getZoomFactor(), canBack: h.canGoBack(), canForward: h.canGoForward() }
}
function report() { if (strip) strip.webContents.send('monitor-app-state', pageState()) }
function appAction(action) {
  if (!page) return
  const wc = page.webContents, h = wc.navigationHistory
  if (action === 'back' && h.canGoBack()) h.goBack()
  else if (action === 'forward' && h.canGoForward()) h.goForward()
  else if (action === 'reload') wc.reloadIgnoringCache()
  else if (action.startsWith('zoom')) {
    const steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
    const cur = wc.getZoomFactor()
    let next = 1
    if (action === 'zoom-in') next = steps.find((x) => x > cur + 0.001) || 2
    if (action === 'zoom-out') next = [...steps].reverse().find((x) => x < cur - 0.001) || 0.5
    wc.setZoomFactor(next)
    writeSettings({ ...readSettings(), zoom: next })
  }
  setTimeout(report, 50)
}
ipcMain.handle('monitor-app', (_e, action) => { if (action === 'settings') { showSettings(); return pageState() } if (action !== 'state') appAction(String(action)); return pageState() })
function layout() {
  if (!win) return
  const { width, height } = win.getContentBounds()
  strip.setBounds({ x: 0, y: 0, width, height: STRIP })
  page.setBounds({ x: 0, y: STRIP, width, height: Math.max(0, height - STRIP) })
}
// the usual shortcuts, in either view: zoom, reload, back / forward
function shortcuts(wc) {
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return
    const k = i.key, mod = i.control || i.meta
    const act = mod && (k === '=' || k === '+') ? 'zoom-in' : mod && k === '-' ? 'zoom-out' : mod && k === '0' ? 'zoom-reset'
      : k === 'F5' || (mod && k.toLowerCase() === 'r') ? 'reload' : i.alt && k === 'ArrowLeft' ? 'back' : i.alt && k === 'ArrowRight' ? 'forward' : null
    if (act) { e.preventDefault(); appAction(act) }
  })
}
let tray = null, quitting = false
function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return }
  const dark = nativeTheme.shouldUseDarkColors
  win = new BaseWindow({
    width: 1440, height: 920, minWidth: 720, minHeight: 480, title: 'Agent Monitor', icon: ICON,
    backgroundColor: dark ? '#0f1116' : '#f2f3f7',
    // no Windows title bar: Windows draws minimise / maximise / close over the strip, in its colours
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
  })
  const safe = { contextIsolation: true, sandbox: true }
  strip = new WebContentsView({ webPreferences: { ...safe, preload: path.join(__dirname, 'preload.cjs') } })
  page = new WebContentsView({ webPreferences: safe })
  page.setBackgroundColor(dark ? '#0f1116' : '#f2f3f7')
  win.contentView.addChildView(page)
  win.contentView.addChildView(strip)
  strip.webContents.loadFile(path.join(__dirname, 'strip.html'))
  page.webContents.loadURL(URL)
  layout()
  win.on('resize', layout)
  win.on('maximize', layout)
  win.on('unmaximize', layout)
  const wc = page.webContents
  wc.on('did-finish-load', () => { wc.setZoomFactor(zoom()); report() })
  wc.on('did-navigate-in-page', report)
  // Ctrl + mouse wheel: the same steps as the buttons, and remembered
  wc.on('zoom-changed', (_e, direction) => appAction(direction === 'in' ? 'zoom-in' : 'zoom-out'))
  shortcuts(wc)
  shortcuts(strip.webContents)
  // links in replies open in the real browser, not inside the app
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(URL)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) } })
  // closing the window keeps the monitor running in the tray
  win.on('close', (e) => { if (quitting) return; if (readSettings().closeToTray === false) { quit(); return } e.preventDefault(); win.hide() })
  win.on('closed', () => { win = page = strip = null })
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Agent Monitor 열기', click: showWindow },
    { label: '설정…', click: showSettings },
    { type: 'separator' },
    { label: ownServer ? '종료 (모니터 에이전트도 멈춤)' : '종료', click: quit },
  ])
}

/* ── settings window: start at login, close to tray, data folder, hooks, about ── */
let settingsWin = null
function showSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 620, height: 640, resizable: false, minimizable: false, maximizable: false, title: 'Agent Monitor 설정', icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1116' : '#f2f3f7', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'settings-preload.cjs') },
  })
  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}
ipcMain.handle('monitor-settings', async (_e, action, key, value) => {
  const cur = readSettings()
  if (action === 'set' && key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: !!value, ...LOGIN })
  if (action === 'set' && key === 'closeToTray') writeSettings({ ...cur, closeToTray: !!value })
  if (action === 'openData') shell.openPath(dataDir())
  if (action === 'openBrowser') shell.openExternal(URL)
  if (action === 'installHooks') {
    try { installHooks() } catch (e) { dialog.showErrorBox('Agent Monitor', 'hook을 설치하지 못했습니다.\n\n' + (e && e.message || e)) }
  }
  if (action === 'pickData') {
    const r = await dialog.showOpenDialog(settingsWin, { title: '데이터 폴더 (config.json, boards/)', defaultPath: dataDir(), properties: ['openDirectory', 'createDirectory'] })
    if (!r.canceled && r.filePaths[0]) {
      writeSettings({ ...readSettings(), dataDir: r.filePaths[0] })
      const ok = await dialog.showMessageBox(settingsWin, { type: 'info', buttons: ['다시 시작', '나중에'], message: '데이터 폴더를 바꿨습니다.', detail: '앱을 다시 시작하면 새 폴더를 씁니다.' })
      if (ok.response === 0) { app.relaunch(); quit() }
    }
  }
  const s2 = readSettings()
  return {
    openAtLogin: app.getLoginItemSettings(LOGIN).openAtLogin, closeToTray: s2.closeToTray !== false,
    dataDir: dataDir(), ownServer, hooks: hookState(), node: !!findNode(), version: app.getVersion(), url: URL,
  }
})
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
    // a PC where the monitor's hooks are not registered yet: offer to register them
    offerHooks(false)
  })
  app.on('window-all-closed', () => { /* the tray keeps the app alive */ })
  app.on('before-quit', () => { quitting = true })
}
