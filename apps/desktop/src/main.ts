import { existsSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "@bridge/core";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { ApprovalWatcher } from "./approvals.js";
import { type DesktopSettings, loadSettings, saveSettings } from "./settings.js";
import { type RuntimeStatus, RuntimeSupervisor } from "./supervisor.js";

/**
 * The Bridge desktop app.
 *
 * Its whole job is to make the local runtime invisible: no terminal, no
 * port, no database, no Docker. It supervises one Node process — the API,
 * which hosts the agent runtime and serves the web client — and shows that
 * process in a window.
 *
 * The window is a real browser view onto a real HTTP server rather than a
 * bundled copy of the UI, which is why local, self-hosted and Cloud are the
 * same product: pointing this app at a different Bridge changes nothing but
 * the URL (ADR-0008).
 */
const dataDir = appDataDir();
const resources = app.isPackaged ? process.resourcesPath : join(import.meta.dirname, "..", "..");
const apiEntry = app.isPackaged
  ? join(resources, "api", "api.mjs")
  : join(resources, "api", "dist", "api.mjs");
const webDir = app.isPackaged ? join(resources, "web") : join(resources, "web", "dist");

let settings: DesktopSettings = loadSettings(dataDir);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let status: RuntimeStatus = "starting";
/** Set when the user really means to quit, so the close handler stops hiding. */
let quitting = false;

const supervisor = new RuntimeSupervisor({
  entry: apiEntry,
  // Electron's binary is also a Node runtime, so the app ships one runtime,
  // not two (see supervisor.ts).
  execPath: process.execPath,
  dataDir,
  env: {
    NODE_ENV: "production",
    BRIDGE_WEB_DIR: webDir,
    BRIDGE_MIGRATIONS_DIR: join(apiEntry, "..", "migrations"),
  },
  onStatus: (next, detail) => {
    status = next;
    refreshTray();
    if (next === "failed") reportFailure(detail);
  },
  onLog: (line) => process.stdout.write(`${line}\n`),
});

const watcher = new ApprovalWatcher({
  apiUrl: () => supervisor.url,
  onPending: (approval) => {
    if (!settings.notifyOnApproval || !Notification.isSupported()) return;
    const notification = new Notification({
      title: `${approval.agentTitle ?? approval.agentName} needs a decision`,
      body: `${approval.toolName} wants to ${approval.action}.`,
    });
    notification.on("click", () => void open("/approvals"));
    notification.show();
  },
});

/**
 * One Bridge per machine. A second copy would open a second embedded
 * database against the same directory, which PGlite cannot do — so instead
 * of failing confusingly, hand the window to the copy already running.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    show();
    const link = argv.find((arg) => arg.startsWith("bridge://"));
    if (link) void openDeepLink(link);
  });

  // Deep links: bridge://approvals opens straight to the queue, which is
  // what a notification on another device should be able to do.
  app.setAsDefaultProtocolClient("bridge");
  app.on("open-url", (event, url) => {
    event.preventDefault();
    void openDeepLink(url);
  });

  void main();
}

async function main(): Promise<void> {
  await app.whenReady();
  buildMenu();
  createTray();
  createWindow();

  try {
    await supervisor.start();
    watcher.start();
    await open("/");
  } catch (err) {
    reportFailure(err instanceof Error ? err.message : String(err));
  }

  void checkForUpdates();

  app.on("activate", () => (window ? show() : createWindow()));

  /**
   * Closing the last window is not quitting when the user asked for
   * background operation — and is quitting when they did not. Both are
   * legitimate; the difference has to be a setting rather than a surprise.
   */
  app.on("window-all-closed", () => {
    if (!settings.runInBackground) app.quit();
  });

  app.on("before-quit", async (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    watcher.stop();
    // Give the runtime a chance to close its database rather than leaving
    // it to recover on next launch.
    await supervisor.stop();
    app.quit();
  });
}

/**
 * Updates.
 *
 * An update replaces the runtime, and the new runtime migrates the database
 * on its next launch — which is why the app installs updates on quit rather
 * than under a running agent. Failure is not worth interrupting anyone for:
 * an unreachable feed means "no update today".
 */
async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    await autoUpdater.checkForUpdatesAndNotify();
  } catch {
    // No release host configured yet, or offline.
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 540,
    /**
     * The ordinary OS title bar. An inset one looks better but overlaps the
     * sidebar's own header, and the fix for that would be teaching the web
     * client it is inside Electron — which is exactly the coupling that
     * keeps local, self-hosted and Cloud from being the same app.
     */
    backgroundColor: "#101418",
    show: false,
    webPreferences: {
      // Nothing is exposed to the page: the window loads the same HTTP app a
      // browser would, so there is no privileged bridge to abuse.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    // "Close" means "put it away" only when background operation is on.
    if (!quitting && settings.runInBackground) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = undefined;
  });

  // Links to anywhere else are the browser's business, not ours.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (supervisor.url && !url.startsWith(supervisor.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void open(supervisor.url ? "/" : undefined);
}

/** Point the window at a path in the running Bridge. */
async function open(path?: string): Promise<void> {
  if (!window) createWindow();
  if (!supervisor.url) return void window?.loadURL(startingPage());
  await window?.loadURL(`${supervisor.url}${path ?? "/"}`);
  show();
}

async function openDeepLink(url: string): Promise<void> {
  // bridge://approvals → /approvals. Only the path is honoured; a link from
  // outside the app never gets to choose the host.
  const path = `/${url.replace(/^bridge:\/\//, "").replace(/^\/+/, "")}`;
  await open(path);
}

function show(): void {
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Something to look at while the database migrates on a cold start, instead
 * of a white rectangle. Inlined because the web client is not being served
 * yet — that is the thing we are waiting for.
 */
function startingPage(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Bridge</title>
<style>
  html,body{height:100%;margin:0;display:grid;place-items:center;
    background:#101418;color:#9aa5b1;
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  .m{letter-spacing:.08em;text-transform:uppercase;font-size:12px}
</style>
<div class="m">Starting Bridge…</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function reportFailure(detail?: string): void {
  dialog.showErrorBox(
    "Bridge could not start",
    detail ?? "The local runtime stopped unexpectedly. Restarting Bridge usually clears it.",
  );
}

/**
 * The menu bar / tray.
 *
 * It states what the runtime is actually doing rather than implying that
 * closing the window stops agents — because whether it does is a setting,
 * and a wrong belief about that is how someone gets a surprise bill.
 */
function createTray(): void {
  const icon = join(resources, "desktop", "build", "trayTemplate.png");
  const image = existsSync(icon) ? nativeImage.createFromPath(icon) : nativeImage.createEmpty();
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Bridge");
  tray.on("click", () => show());
  refreshTray();
}

const STATUS_LABEL: Record<RuntimeStatus, string> = {
  starting: "Starting…",
  ready: "Running",
  restarting: "Restarting…",
  stopped: "Stopped",
  failed: "Stopped — could not start",
};

function refreshTray(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Bridge — ${STATUS_LABEL[status]}`, enabled: false },
      {
        label: settings.runInBackground
          ? "Agents keep running when the window is closed"
          : "Agents stop when you close the window",
        enabled: false,
      },
      { type: "separator" },
      { label: "Open Bridge", click: () => show() },
      { label: "Approvals", click: () => void open("/approvals") },
      { type: "separator" },
      {
        label: "Run in the background",
        type: "checkbox",
        checked: settings.runInBackground,
        click: (item) => setSetting("runInBackground", item.checked),
      },
      {
        label: "Notify me about approvals",
        type: "checkbox",
        checked: settings.notifyOnApproval,
        click: (item) => setSetting("notifyOnApproval", item.checked),
      },
      { type: "separator" },
      { label: "Quit Bridge", click: () => app.quit() },
    ]),
  );
}

function setSetting<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): void {
  settings = { ...settings, [key]: value };
  saveSettings(dataDir, settings);
  refreshTray();
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => void open("/chat") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Dashboards", click: () => void open("/dashboards") },
        { label: "Agents", click: () => void open("/agents") },
        { label: "Approvals", click: () => void open("/approvals") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Bridge Data Folder",
          click: () => void shell.openPath(dataDir),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
