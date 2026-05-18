const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen, powerMonitor } = require("electron");
const path = require("path");

const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 720;
const PANEL_MARGIN = 8;

function panelBounds() {
  // On macOS the tray lives in the top-right menu bar — anchor the panel
  // directly below the tray icon so it feels like it drops from there.
  if (process.platform === "darwin" && tray) {
    const tb = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
    const wa = display.workArea;
    const rawX = Math.round(tb.x + tb.width / 2 - PANEL_WIDTH / 2);
    const x = Math.max(wa.x + PANEL_MARGIN, Math.min(rawX, wa.x + wa.width - PANEL_WIDTH - PANEL_MARGIN));
    const y = Math.round(tb.y + tb.height + 4);
    return { width: PANEL_WIDTH, height: PANEL_HEIGHT, x, y };
  }
  // Windows / Linux: bottom-right of the work area, near the system tray.
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    x: workArea.x + workArea.width - PANEL_WIDTH - PANEL_MARGIN,
    y: workArea.y + workArea.height - PANEL_HEIGHT - PANEL_MARGIN
  };
}

let mainWindow = null;
let tray = null;
let timerState = { running: false, elapsed: 0, project: "" };
let isQuitting = false;

const ROOT = path.join(__dirname, "..");

function wasLaunchedHidden() {
  // Set when launched by the OS as a login item, or by a manual --hidden flag.
  if (process.argv.includes("--hidden")) return true;
  if (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAsHidden) return true;
  return false;
}

function createWindow() {
  const bounds = panelBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    backgroundColor: "#0b1212",
    icon: path.join(ROOT, process.platform === "win32" ? "app-icon.ico" : "app-icon.png"),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(ROOT, "index.html"));

  // Popover behaviour: clicking outside the panel hides it, like EarTrumpet.
  mainWindow.on("blur", () => {
    if (!isQuitting && mainWindow && !mainWindow.webContents.isDevToolsFocused()) {
      mainWindow.hide();
    }
  });

  // Open external links in the OS browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Closing the window hides it; the app keeps running in the tray.
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function trayIconImage(running) {
  const file = running ? "tray-icon-running.png" : "tray-icon.png";
  const img = nativeImage.createFromPath(path.join(ROOT, file));
  if (process.platform === "darwin") img.setTemplateImage(false);
  return img;
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function buildTrayMenu() {
  const statusLabel = timerState.running
    ? `▶  ${timerState.project || "Tracking"} — ${formatElapsed(timerState.elapsed)}`
    : "Not tracking";

  const loginItem = app.getLoginItemSettings();

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "Open Time Tracker", click: showWindow },
    {
      label: timerState.running ? "Stop timer" : "Start timer",
      click: () => mainWindow?.webContents.send("tray:toggle-timer")
    },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: loginItem.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: true,
          args: ["--hidden"]
        });
        updateTray();
      }
    },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
  ]);
}

let lastIconRunning = null;
function updateTray() {
  if (!tray) return;
  const tooltip = timerState.running
    ? `Time Tracker · ${timerState.project || "Tracking"} ${formatElapsed(timerState.elapsed)}`
    : "Time Tracker — not tracking";
  tray.setToolTip(tooltip);
  // Swap icon when running state flips. Avoid re-creating the image every tick.
  if (timerState.running !== lastIconRunning) {
    tray.setImage(trayIconImage(timerState.running));
    lastIconRunning = timerState.running;
  }
  // On macOS, the running elapsed time can be shown directly in the menu bar title.
  if (process.platform === "darwin") {
    tray.setTitle(timerState.running ? ` ${formatElapsed(timerState.elapsed)}` : "");
  }
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(trayIconImage(false));
  lastIconRunning = false;
  tray.setToolTip("Time Tracker");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (process.platform === "darwin") return; // macOS opens the menu on click
    toggleWindow();
  });
  tray.on("double-click", showWindow);
}

function showWindow() {
  if (!mainWindow) return;
  // Re-anchor on every show so DPI / monitor changes don't strand the panel.
  mainWindow.setBounds(panelBounds());
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
}

ipcMain.on("renderer:timer-update", (_e, state) => {
  if (state && typeof state === "object") {
    timerState = {
      running: !!state.running,
      elapsed: Number(state.elapsed) || 0,
      project: typeof state.project === "string" ? state.project : ""
    };
    updateTray();
  }
});

// Single-instance lock so launching again brings the existing window forward.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // Native OS sleep/wake events. On suspend we tell the renderer the
    // timestamp the OS started sleeping so it can stop the running timer
    // with an accurate end time. On resume we re-render to pick up any
    // server-side state that drifted while we were asleep.
    powerMonitor.on("suspend", () => {
      const at = Date.now();
      mainWindow?.webContents.send("system:suspend", { at });
    });
    powerMonitor.on("resume", () => {
      mainWindow?.webContents.send("system:resume", { at: Date.now() });
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  app.on("before-quit", () => { isQuitting = true; });

  // Don't auto-quit when the last window closes — we live in the tray.
  app.on("window-all-closed", () => {});
}
