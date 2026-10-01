// Agent Monitor as a desktop app: runs the monitor server inside the app, shows it in its own window,
// and lives in the tray — so it no longer depends on a terminal or on VS Code staying open.
const { app, BaseWindow, BrowserWindow, WebContentsView, Tray, Menu, shell, dialog, nativeImage, nativeTheme, ipcMain, Notification, globalShortcut, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const PORT = Number(process.env.PORT) || 4777
const URL = `http://127.0.0.1:${PORT}/`
// the monitor's code: next to this folder while developing, in the app's resources once installed
const CODE = app.isPackaged ? path.join(process.resourcesPath, 'monitor') : path.join(__dirname, '..')
const ICON = path.join(__dirname, 'icon.png')
const MAC = process.platform === 'darwin'
const RELEASES = 'https://github.com/elopstudio/claude-agent-monitor/releases/latest'

/* ── settings: where the monitor keeps config.json, boards/ and its agent list ── */
// read before startServer sets it for the server
const GIVEN_HOME = process.env.MONITOR_HOME || ''
// `npm run try`: a test app beside the installed one — no notifications, global shortcut or hook installs of its own
const TRY = process.env.MONITOR_TRY === '1'
const NAME = TRY ? 'Agent Monitor (테스트)' : 'Agent Monitor'
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} } }
function writeSettings(s) { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)) }
function dataDir() {
  // a MONITOR_HOME given to the app wins, as it does for npm start (and keeps a test run away from the real folder)
  if (GIVEN_HOME) return GIVEN_HOME
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

// A question for the user. On macOS a message box with no window runs modally on the main thread, and the
// monitor server lives on that thread: approvals would stop until it is answered. There it goes on the window, as a sheet.
function ask(opts) {
  if (!MAC) return dialog.showMessageBox(opts)
  showWindow()
  return dialog.showMessageBox(win, opts)
}

// raised whenever the hooks gain something: a "later" to an older update does not hold back a newer one
const HOOKS_REV = 3   // 2: the team hook for leaders (UserPromptSubmit); 3: the inbox waits a week, not a day
async function offerHooks(always) {
  if (TRY && !always) return   // the hooks belong to the installed app
  const state = hookState()
  if (state === 'ok' && !always) return
  const settings = readSettings()
  // hooks from an older version: offered once, even to someone who once said no to installing them
  const outdated = state === 'outdated'
  if (!always && (outdated ? settings.hooksUpdateDeclined === HOOKS_REV : settings.hooksDeclined)) return
  const r = await ask({
    type: 'question', buttons: ['설치', '나중에'], defaultId: 0, cancelId: 1,
    message: always ? 'Claude Code hook을 이 앱 기준으로 다시 설치할까요?' : outdated ? '모니터 hook을 새 버전으로 갱신할까요?' : 'Claude Code에 모니터 hook을 설치할까요?',
    detail: '승인·질문에 답하기, 권한 모드 표시, 에이전트에게 메시지 보내기, 리더에게 팀원 알려 주기에 필요합니다.\n' + CLAUDE_SETTINGS + ' 의 모니터 항목만 추가·교체하고, 다른 설정은 그대로 둡니다 (백업: settings.json.before-agent-monitor).\n' + (findNode() ? 'hook은 이 PC의 Node.js로 실행됩니다.' : 'Node.js가 없어서 hook은 이 앱으로 실행됩니다.'),
  })
  if (quitting) return   // a box closed by quitting is not an answer
  // read again: the box may have been open while the zoom or the window's place changed
  if (r.response !== 0) { if (!always) writeSettings({ ...readSettings(), ...(outdated ? { hooksUpdateDeclined: HOOKS_REV } : { hooksDeclined: true }) }); return }
  try { installHooks(); await ask({ type: 'info', message: 'hook을 설치했습니다.', detail: '실행 중인 Claude Code 세션에도 곧바로 적용됩니다.' }) }
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
nativeTheme.on('updated', () => { if (win && !MAC) { try { win.setTitleBarOverlay(overlay()) } catch {} } })
// no system title bar: Windows draws minimise / maximise / close over the strip, macOS its traffic lights on the left
const titleBar = () => (MAC ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } } : { titleBarStyle: 'hidden', titleBarOverlay: overlay() })
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
ipcMain.handle('monitor-app', (_e, action) => {
  if (action === 'settings') { showSettings(); return pageState() }
  // the usage in the strip opens the page's account dialog
  if (action === 'account') { if (page) page.webContents.executeJavaScript("document.getElementById('acct-btn')?.click()").catch(() => {}); return pageState() }
  if (action !== 'state') appAction(String(action))
  return pageState()
})
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
// the window opens where it was and as big as it was, maximised if it was — unless that place is on no screen now
// (a monitor unplugged since), when it opens at the default size on the main one
function savedBounds() {
  const b = readSettings().bounds
  if (!b || !(b.width >= 720 && b.height >= 480) || ![b.x, b.y].every(Number.isFinite)) return null
  const a = screen.getDisplayMatching(b).workArea
  const onScreen = b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 8 && b.y < a.y + a.height - 80
  return onScreen ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
}
let keepTimer = null
function keepBounds() {
  clearTimeout(keepTimer)
  keepTimer = null
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  // the normal bounds even when maximised, so un-maximising after a restart goes back to the right size
  writeSettings({ ...readSettings(), bounds: win.getNormalBounds(), maximized: win.isMaximized() })
}
const keepSoon = () => { clearTimeout(keepTimer); keepTimer = setTimeout(keepBounds, 600) }
function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return }
  const dark = nativeTheme.shouldUseDarkColors
  const at = savedBounds()
  win = new BaseWindow({
    width: 1440, height: 920, ...(at || {}), minWidth: 720, minHeight: 480, title: 'Agent Monitor', icon: ICON,
    backgroundColor: dark ? '#0f1116' : '#f2f3f7',
    ...titleBar(),
  })
  if (at && readSettings().maximized) win.maximize()
  const safe = { contextIsolation: true, sandbox: true }
  strip = new WebContentsView({ webPreferences: { ...safe, preload: path.join(__dirname, 'preload.cjs') } })
  page = new WebContentsView({ webPreferences: safe })
  page.setBackgroundColor(dark ? '#0f1116' : '#f2f3f7')
  win.contentView.addChildView(page)
  win.contentView.addChildView(strip)
  strip.webContents.loadFile(path.join(__dirname, 'strip.html'), { query: { platform: process.platform } })
  strip.webContents.on('did-finish-load', () => { if (strip) strip.webContents.send('monitor-app-usage', usage) })
  page.webContents.loadURL(URL + '?app=1&v=' + encodeURIComponent(app.getVersion()) + (TRY ? '&try=1' : ''))
  layout()
  win.on('resize', layout)
  win.on('maximize', layout)
  win.on('unmaximize', layout)
  for (const e of ['resize', 'move', 'maximize', 'unmaximize']) win.on(e, keepSoon)
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
  win.on('close', (e) => { keepBounds(); if (quitting) return; if (readSettings().closeToTray === false) { quit(); return } e.preventDefault(); win.hide() })
  win.on('closed', () => { win = page = strip = null })
  win.on('focus', () => { try { win.flashFrame(false) } catch {} })
  paintBadge()
}
// the page's about dialog, from the settings or the tray
function showAbout() {
  showWindow()
  if (page) page.webContents.executeJavaScript("document.getElementById('about-btn')?.click()").catch(() => {})
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Agent Monitor 열기', click: showWindow },
    { label: '설정…', click: showSettings },
    { label: '프로그램 정보', click: showAbout },
    ...(update.status === 'ready' ? [{ label: '업데이트 ' + update.version + ' 설치하고 다시 시작', click: installUpdate }] : []),
    ...(update.status === 'available' ? [{ label: '업데이트 ' + update.version + ' 받으러 가기', click: installUpdate }] : []),
    { type: 'separator' },
    { label: ownServer ? '종료 (모니터 에이전트도 멈춤)' : '종료', click: quit },
  ])
}

/* ── attention: requests waiting, agents that look stuck, limits running out ── */
// The app reads the same state the page does, so it can badge the taskbar and the tray and send desktop
// notifications while the window is hidden. The page leaves notifications to the app (?app=1).
const ORANGE = [0x1f, 0x8c, 0xf5]   // BGR of the "waiting" colour
function dot(size, r, cx, cy, into) {
  const buf = into || Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
    if (d > r + 0.5) continue
    const i = (y * size + x) * 4, edge = d > r - 1.2   // a light rim keeps the dot readable on the icon
    buf[i] = edge ? 0xff : ORANGE[0]; buf[i + 1] = edge ? 0xff : ORANGE[1]; buf[i + 2] = edge ? 0xff : ORANGE[2]; buf[i + 3] = 0xff
  }
  return buf
}
let trayPlain = null, trayDot = null, overlayDot = null, waitingCount = 0, usage = null
const usageLine = () => { const l = usage?.limits || [], s = l.find((x) => x.kind === 'session'), w = l.find((x) => x.kind === 'weekly_all'); return [s && '세션 ' + Math.round(s.percent) + '%', w && '주간 ' + Math.round(w.percent) + '%'].filter(Boolean).join(' · ') }
function paintBadge() {
  if (!trayPlain) {
    trayPlain = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })
    trayDot = nativeImage.createFromBitmap(dot(16, 4.5, 11, 11, Buffer.from(trayPlain.toBitmap())), { width: 16, height: 16 })
    overlayDot = nativeImage.createFromBitmap(dot(16, 7, 8, 8), { width: 16, height: 16 })
  }
  const n = waitingCount
  if (tray) { tray.setImage(n ? trayDot : trayPlain); tray.setToolTip([NAME, usageLine(), n ? '답을 기다리는 요청 ' + n + '건' : ''].filter(Boolean).join('\n')) }
  if (MAC) { if (app.dock) app.dock.setBadge(n ? String(n) : '') }
  else if (win) { try { win.setOverlayIcon(n ? overlayDot : null, n ? '요청 ' + n + '건' : '') } catch (e) { console.error('overlay icon:', e.message) } }
}
const shown = new Set()   // a notification that is garbage-collected no longer answers its click
function notify(title, body, onClick) {
  if (TRY || !Notification.isSupported()) return   // the installed app already says it
  const n = new Notification({ title, body, icon: ICON, silent: false })
  shown.add(n)
  n.on('click', () => { shown.delete(n); showWindow(); if (onClick) onClick() })
  n.on('close', () => shown.delete(n))
  n.show()
}
const focused = () => !!(win && win.isVisible() && win.isFocused())
const usageLevel = (x) => (x.percent >= 95 || /exceed|critical|block/.test(String(x.severity || '')) ? 2 : x.percent >= 80 || x.severity === 'warning' ? 1 : 0)
const LIMIT_NAMES = { session: '현재 세션 (5시간)', weekly_all: '주간 · 전체 모델', weekly_scoped: '주간 · ' }
const limitName = (x) => x.kind === 'weekly_scoped' ? LIMIT_NAMES.weekly_scoped + (x.model || '') : LIMIT_NAMES[x.kind] || x.kind
const who = (a) => a.nickKo || a.nick || a.session || '에이전트'
let seenAsks = null, seenStalls = null
function watch(data) {
  const approvals = data.approvals || [], inEditor = data.inEditor || []
  const count = approvals.length + inEditor.length
  const u = data.usage || null
  const usageChanged = JSON.stringify(u) !== JSON.stringify(usage)
  if (usageChanged) { usage = u; if (strip) strip.webContents.send('monitor-app-usage', usage) }
  if (count !== waitingCount || usageChanged) { waitingCount = count; paintBadge() }
  // a request that has just arrived: flash the taskbar and say who is asking (not on the first look)
  const fresh = seenAsks ? approvals.filter((a) => !seenAsks.has(a.id)) : []
  seenAsks = new Set(approvals.map((a) => a.id))
  if (fresh.length && !focused()) {
    if (MAC) { if (app.dock) app.dock.bounce('informational') }
    else if (win) { try { win.flashFrame(true) } catch {} }
    for (const a of fresh.slice(0, 3)) notify((a.questions ? '질문' : a.plan ? '계획 승인' : '승인 요청') + ' · ' + who(a), [a.tool, a.what].filter(Boolean).join(' — ') || '답을 기다립니다')
  }
  // an agent that starts to look stuck: once, until it moves again
  const sessions = (data.projects || []).flatMap((p) => p.sessions || [])
  const stalled = sessions.filter((x) => x.stalledFor)
  if (seenStalls && !focused()) for (const x of stalled.filter((x) => !seenStalls.has(x.name))) notify(who(x) + ' 멈춘 듯합니다', Math.round(x.stalledFor / 60000) + '분째 아무 활동이 없습니다')
  seenStalls = new Set(stalled.map((x) => x.name))
  // limits: once past 80 % and again past 95 %, remembered until that limit resets
  const limits = data.usage?.limits || []
  if (limits.length) {
    const cur = readSettings(), told = cur.usageTold || {}, next = {}
    let changed = false
    for (const x of limits) {
      const k = x.kind + '|' + (x.model || '') + '|' + String(x.resetsAt || '').slice(0, 16), lv = usageLevel(x)
      next[k] = Math.max(lv, told[k] || 0)
      if (lv > (told[k] || 0)) {
        changed = true
        const at = Date.parse(x.resetsAt), left = at - Date.now()
        const when = left > 0 ? (left < 3600e3 ? Math.round(left / 60000) + '분' : left < 86400e3 ? Math.round(left / 3600e3) + '시간' : Math.round(left / 86400e3) + '일') + ' 후 초기화' : ''
        notify('Claude 사용량 ' + Math.round(x.percent) + '% — ' + limitName(x), when)
      }
    }
    if (changed || Object.keys(next).length !== Object.keys(told).length) writeSettings({ ...readSettings(), usageTold: next })
  }
}
async function watchLoop() {
  try {
    const r = await fetch(URL + 'api/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (r.ok) watch(await r.json())
  } catch {}
  setTimeout(watchLoop, 2000)
}

/* ── a global shortcut: bring the window up from anywhere, and back down ── */
// Ctrl+Alt ones: VS Code and the browsers hardly use them. Until one is picked, the first one no other program has.
const HOTKEYS = ['Control+Alt+J', 'Control+Alt+M', 'Control+Alt+Space', 'Control+Alt+K', 'off']
let hotkeyOk = true, hotkeyNow = HOTKEYS[0]
const picked = () => { const k = readSettings().hotkey; return HOTKEYS.includes(k) ? k : null }
function hotkey() { return hotkeyNow }
function toggleWindow() {
  if (focused()) { win.hide(); return }
  showWindow()
  // the keys go to the page, so the number keys answer the first request straight away
  if (page) page.webContents.focus()
}
function registerHotkey() {
  globalShortcut.unregisterAll()
  if (TRY) { hotkeyOk = true; hotkeyNow = 'off'; return }   // the installed app has the key
  const k = picked()
  if (k) { hotkeyNow = k; hotkeyOk = k === 'off' || globalShortcut.register(k, toggleWindow); return }   // false: another program has it
  hotkeyOk = false
  for (const c of HOTKEYS.filter((x) => x !== 'off')) if (globalShortcut.register(c, toggleWindow)) { hotkeyNow = c; hotkeyOk = true; return }
  hotkeyNow = HOTKEYS[0]
}

/* ── updates from GitHub Releases ── */
// An installed app checks at start and every six hours, downloads in the background and installs on the next
// restart (or at once from the tray or the settings). While developing there is nothing to update.
let updater = null
const update = { status: app.isPackaged ? 'idle' : 'dev', version: null, percent: 0 }
function setUpdate(status, extra) {
  Object.assign(update, { status }, extra || {})
  if (tray) tray.setContextMenu(trayMenu())
  if (settingsWin) settingsWin.webContents.send('monitor-settings-changed')
}
function checkUpdates() { if (updater) updater.checkForUpdates().catch(() => setUpdate('error')) }
function setupUpdates() {
  if (!app.isPackaged) return
  try { updater = require('electron-updater').autoUpdater } catch { return }
  // the macOS build is not signed with a Developer ID, and macOS applies an update only to a signed app:
  // there the app says a new version is out and opens the release page
  updater.autoDownload = !MAC
  updater.autoInstallOnAppQuit = true
  updater.on('checking-for-update', () => setUpdate('checking'))
  updater.on('update-available', (i) => {
    if (!MAC) { setUpdate('downloading', { version: i.version, percent: 0 }); return }
    const fresh = update.version !== i.version
    setUpdate('available', { version: i.version })
    if (fresh) notify('Agent Monitor ' + i.version + ' 나옴', '누르면 받는 곳을 엽니다.', () => shell.openExternal(RELEASES))
  })
  updater.on('update-not-available', () => setUpdate('latest'))
  updater.on('download-progress', (p) => { update.percent = Math.round(p.percent || 0); if (settingsWin) settingsWin.webContents.send('monitor-settings-changed') })
  updater.on('update-downloaded', (i) => { setUpdate('ready', { version: i.version }); notify('Agent Monitor ' + i.version + ' 받음', '트레이 메뉴나 설정에서 다시 시작하면 바로 적용됩니다. 앱을 끌 때도 적용됩니다.') })
  // no release published yet is not a failure
  updater.on('error', (e) => setUpdate(/404|No published versions|Unable to find latest/i.test(String(e && e.message)) ? 'none' : 'error'))
  checkUpdates()
  setInterval(checkUpdates, 6 * 3600e3).unref()
}
function installUpdate() {
  if (update.status === 'available') { shell.openExternal(RELEASES); return }
  if (!updater || update.status !== 'ready') return
  quitting = true
  if (ownServer && typeof globalThis.agentMonitorShutdown === 'function') globalThis.agentMonitorShutdown()
  updater.quitAndInstall(true, true)
}

/* ── settings window: start at login, close to tray, data folder, hooks, about ── */
let settingsWin = null
function showSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 620, height: 800, resizable: false, minimizable: false, maximizable: false, title: 'Agent Monitor 설정', icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1116' : '#f2f3f7', autoHideMenuBar: true,
    ...titleBar(),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'settings-preload.cjs') },
  })
  settingsWin.loadFile(path.join(__dirname, 'settings.html'), { query: { platform: process.platform } })
  settingsWin.on('closed', () => { settingsWin = null })
}
ipcMain.handle('monitor-settings', async (_e, action, key, value) => {
  const cur = readSettings()
  if (action === 'set' && key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: !!value, ...LOGIN })
  if (action === 'set' && key === 'closeToTray') writeSettings({ ...cur, closeToTray: !!value })
  if (action === 'set' && key === 'hotkey' && HOTKEYS.includes(value)) { writeSettings({ ...cur, hotkey: value }); registerHotkey() }
  if (action === 'checkUpdates') checkUpdates()
  if (action === 'installUpdate') installUpdate()
  if (action === 'openData') shell.openPath(dataDir())
  if (action === 'openBrowser') shell.openExternal(URL)
  if (action === 'about') showAbout()
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
    hotkey: hotkey(), hotkeys: HOTKEYS, hotkeyOk, update: { ...update }, platform: process.platform,
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
    // run from the disk image or Downloads, the hooks would point at a copy that goes away: offer to move it first
    if (MAC && app.isPackaged && !app.isInApplicationsFolder() && !readSettings().moveDeclined) {
      const r = await ask({ type: 'question', buttons: ['응용 프로그램으로 옮기기', '그대로 쓰기'], defaultId: 0, cancelId: 1, message: 'Agent Monitor를 응용 프로그램 폴더로 옮길까요?', detail: 'Claude Code hook이 이 앱의 위치를 기억합니다. 디스크 이미지나 다운로드 폴더에서 그대로 쓰면, 그 사본이 없어질 때 hook도 멈춥니다.' })
      // a box closed by quitting is not a yes
      if (quitting) return
      if (r.response === 0) { try { if (app.moveToApplicationsFolder()) return } catch (e) { dialog.showErrorBox('Agent Monitor', '옮기지 못했습니다.\n\n' + (e && e.message || e)) } }
      else writeSettings({ ...readSettings(), moveDeclined: true })
    }
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }))
    tray.setToolTip(NAME)
    tray.setContextMenu(trayMenu())
    tray.on('click', showWindow)
    // started at login: stay in the tray until opened (macOS says so itself; Windows passes --hidden)
    let atLogin = process.argv.includes('--hidden')
    if (MAC) { try { atLogin = atLogin || app.getLoginItemSettings().wasOpenedAtLogin } catch {} }
    if (!atLogin) showWindow()
    // a PC where the monitor's hooks are not registered yet: offer to register them
    offerHooks(false)
    paintBadge()
    watchLoop()
    registerHotkey()
    setupUpdates()
  })
  app.on('window-all-closed', () => { /* the tray keeps the app alive */ })
  // the Dock icon brings the window back
  app.on('activate', () => { if (tray) showWindow() })
  // Cmd+Q and the Dock's Quit come here without going through quit(): stop the agents the same way
  app.on('before-quit', () => {
    if (!quitting && ownServer && typeof globalThis.agentMonitorShutdown === 'function') globalThis.agentMonitorShutdown()
    quitting = true
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
}
