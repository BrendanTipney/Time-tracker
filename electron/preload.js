const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  sendTimerUpdate: (state) => ipcRenderer.send("renderer:timer-update", state),
  onToggleTimer: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("tray:toggle-timer", handler);
    return () => ipcRenderer.removeListener("tray:toggle-timer", handler);
  },
  onSystemSuspend: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("system:suspend", handler);
    return () => ipcRenderer.removeListener("system:suspend", handler);
  },
  onSystemResume: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("system:resume", handler);
    return () => ipcRenderer.removeListener("system:resume", handler);
  },
  isElectron: true
});
