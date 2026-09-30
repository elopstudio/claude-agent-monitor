// The settings window's bridge: read and change the app's own settings, nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('monitorSettings', {
  get: () => ipcRenderer.invoke('monitor-settings', 'get'),
  set: (key, value) => ipcRenderer.invoke('monitor-settings', 'set', key, value),
  do: (action) => ipcRenderer.invoke('monitor-settings', action),
  // the app says when something changed on its own (an update being downloaded, say)
  onChange: (fn) => ipcRenderer.on('monitor-settings-changed', () => fn()),
})
