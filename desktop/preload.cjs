// The page's bridge to the app window: navigation and zoom for the buttons in its custom header.
// Only these calls are exposed; the page gets no other access to Electron or the system.
const { contextBridge, ipcRenderer } = require('electron')

const call = (action) => ipcRenderer.invoke('monitor-app', action)
contextBridge.exposeInMainWorld('monitorApp', {
  back: () => call('back'),
  forward: () => call('forward'),
  reload: () => call('reload'),
  zoomIn: () => call('zoom-in'),
  zoomOut: () => call('zoom-out'),
  zoomReset: () => call('zoom-reset'),
  state: () => call('state'),
  settings: () => call('settings'),
  account: () => call('account'),
  // the app reports zoom and history changes (keyboard shortcuts included)
  onChange: (fn) => ipcRenderer.on('monitor-app-state', (_e, s) => fn(s)),
  // the plan's limits, as the monitor last heard them
  onUsage: (fn) => ipcRenderer.on('monitor-app-usage', (_e, u) => fn(u)),
})
