import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadWindowState, trackWindowState } from './window-state';

// 由 scripts/build-electron.js 通过 esbuild --define 在编译期注入
declare const __UPSTREAM_VERSION__: string;
declare const __UPSTREAM_COMMIT__: string;

// 允许把用户数据目录指到别处：冒烟测试用它隔离测试配置，避免污染真实用户的
// 画板数据与窗口状态。必须在任何 getPath 使用之前、app ready 之前调用。
if (process.env.DRAWNIX_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DRAWNIX_USER_DATA));
}

// 开发模式下的渲染层地址。默认指向上游 `npm start`（纯 Web 版）；
// 想调桌面适配层时用 `npm run dev:renderer` 起 7201，并通过该环境变量切换。
const DEV_SERVER_URL = process.env.DRAWNIX_DEV_URL || 'http://localhost:7200';
// 未打包运行时默认走 dev server；测试/调试可以用这个开关强制加载内置渲染层，
// 从而在不打安装包的情况下验证"安装版行为"（npm run smoke 就依赖它）。
const FORCE_BUNDLE = process.env.DRAWNIX_USE_BUNDLE === '1';
const isDev = !app.isPackaged && !FORCE_BUNDLE;
const APP_ORIGIN = 'app://bundle';

// 必须在 app ready 之前注册；secure: true 是 IndexedDB / Clipboard 正常工作的前提
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// 打包后 app.getAppPath() = .../resources/app.asar，readFile 可直接穿透 asar
const WEB_ROOT = path.join(app.getAppPath(), 'dist/apps/web');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.drawnix': 'application/vnd.drawnix+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

const mimeFor = (filePath: string) =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

let mainWindow: BrowserWindow | null = null;
let rendererReady = false;
let pendingOpen: { path: string; content: string } | null = null;

// 静态资源服务：不使用 file://，统一走 app:// 并做目录穿越防护
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';

    const filePath = path.normalize(path.join(WEB_ROOT, pathname));
    const rootPrefix = path.normalize(WEB_ROOT + path.sep);
    if (!filePath.startsWith(rootPrefix)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: {
          'content-type': mimeFor(filePath),
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function findDrawnixPath(argv: string[]) {
  return (
    argv
      .slice(1)
      .find((arg) => arg.toLowerCase().endsWith('.drawnix') && existsSync(arg)) ?? null
  );
}

async function openFileInWindow(filePath: string) {
  const content = await readFile(filePath, 'utf-8');
  const payload = { path: filePath, content };
  // 渲染层尚未挂载时先缓存，等它调用 app:renderer-ready 时取走
  if (mainWindow && rendererReady) {
    mainWindow.webContents.send('app:open-file', payload);
  } else {
    pendingOpen = payload;
  }
}

async function menuOpenDrawnixFile() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Drawnix 文件',
    properties: ['openFile'],
    filters: [{ name: 'Drawnix 图稿', extensions: ['drawnix', 'json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return;
  await openFileInWindow(result.filePaths[0]);
}

// 窗口是 show: false + ready-to-show 才显示的，加载失败时永远不会显示，
// 必须显式提示并提供重试，否则应用会表现为“启动了但没有任何窗口”
async function loadWithRetry(win: BrowserWindow, url: string): Promise<boolean> {
  for (;;) {
    if (win.isDestroyed()) return false;
    try {
      await win.loadURL(url);
      return true;
    } catch (error) {
      if (win.isDestroyed()) return false;
      if (!win.isVisible()) win.show();
      const reason = error instanceof Error ? error.message : String(error);
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        title: '启动失败',
        message: 'Drawnix 界面加载失败',
        detail: `${url}\n${reason}\n\n开发模式请确认 Drawnix Web 开发服务器 http://localhost:7200 已启动；安装版请确认安装目录中的 dist/apps/web 完整。`,
        buttons: ['退出', '重试'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return false;
    }
  }
}

async function createWindow() {
  // 恢复上次退出时的窗口状态（全屏 / 最大化 / 尺寸与位置）
  const windowState = loadWindowState();
  const win = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    x: windowState.bounds.x,
    y: windowState.bounds.y,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    fullscreen: windowState.isFullScreen,
    title: 'Drawnix',
    backgroundColor: '#ffffff',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = win;

  if (windowState.isMaximized && !windowState.isFullScreen) {
    win.maximize();
  }
  trackWindowState(win, windowState);

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  // 页面刷新后需要重新握手，避免向旧渲染进程发事件
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  const url = isDev ? DEV_SERVER_URL : `${APP_ORIGIN}/index.html`;
  if (!(await loadWithRetry(win, url))) {
    if (!win.isDestroyed()) win.destroy();
    return;
  }
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 外链一律交给系统浏览器；禁止应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止页面被导航离开（例如误点链接跳走）
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_SERVER_URL) : url.startsWith(APP_ORIGIN);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle(
    'dialog:open-file',
    async (
      _event,
      options?: {
        description?: string;
        extensions?: string[];
        multiple?: boolean;
      }
    ) => {
      if (!mainWindow) return [];
      const extensions =
        options?.extensions && options.extensions.length
          ? options.extensions
          : ['drawnix', 'json', 'png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp', 'ico', 'avif'];
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: options?.description || '文件', extensions }],
      });
      if (result.canceled) return [];

      return Promise.all(
        result.filePaths.map(async (filePath) => {
          const data = await readFile(filePath);
          return {
            path: filePath,
            name: path.basename(filePath),
            type: mimeFor(filePath),
            data: new Uint8Array(data),
          };
        })
      );
    }
  );

  // 已有路径直接覆盖（Ctrl+S / 保存）
  ipcMain.handle('file:write', async (_event, payload: { path: string; data: Uint8Array }) => {
    await writeFile(payload.path, Buffer.from(payload.data));
    return payload.path;
  });

  // 另存为 / 导出图片
  ipcMain.handle(
    'file:save-as',
    async (
      _event,
      payload: {
        defaultPath?: string;
        description?: string;
        extension: string;
        data: Uint8Array;
      }
    ) => {
      if (!mainWindow) return null;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存',
        defaultPath: payload.defaultPath,
        filters: [{ name: payload.description || '文件', extensions: [payload.extension] }],
      });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, Buffer.from(payload.data));
      return result.filePath;
    }
  );

  // 渲染层挂载完成后握手，并取走启动时待打开的文件
  ipcMain.handle('app:renderer-ready', () => {
    rendererReady = true;
    const value = pendingOpen;
    pendingOpen = null;
    return value;
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // 导出图片（PNG/SVG）走的是渲染层的 <a download>，Chromium 会把它交给下载管理器。
  // 这里统一接管为原生"另存为"对话框，避免文件静默落到系统的"下载"目录。
  // 这条路径不需要改动上游的 download() 实现，属于桌面壳的职责。
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      title: '保存',
      defaultPath: item.getFilename(),
    });
  });

  // 剪贴板写图片需要该权限；其余权限一律拒绝
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read');
  });
}

// 关于窗口必须是父窗口模态：不传父窗口时它是非模态的，用户可以点回主界面再次触发菜单，
// 叠出多个"关于"对话框。
let aboutDialogOpen = false;

function showAboutDialog() {
  if (aboutDialogOpen || !mainWindow) return;
  aboutDialogOpen = true;
  void dialog
    .showMessageBox(mainWindow, {
      type: 'info',
      title: '关于 Drawnix',
      message: `Drawnix ${app.getVersion()}`,
      detail:
        `开源白板工具（MIT License）\n` +
        `渲染层基于上游 ${__UPSTREAM_VERSION__}（${__UPSTREAM_COMMIT__}）\n` +
        'https://github.com/plait-board/drawnix',
      noLink: true,
    })
    .finally(() => {
      aboutDialogOpen = false;
    });
}

// 最小原生菜单
// 刻意不注册"编辑"菜单（undo/redo/cut/copy/paste/selectAll）：Electron 原生 role 会抢占
// Ctrl+Z / Ctrl+A / Ctrl+C 等快捷键，导致画布内 Plait 的处理逻辑收不到 keydown。
// 这些操作已经由画布内工具栏与内置 hotkey 覆盖。
function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => void menuOpenDrawnixFile() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'togglefullscreen', label: '全屏' },
        ...(isDev
          ? ([
              { type: 'separator' },
              { role: 'reload', label: '重新加载' },
              { role: 'toggleDevTools', label: '开发者工具' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'GitHub 仓库',
          click: () => shell.openExternal('https://github.com/plait-board/drawnix'),
        },
        {
          label: '关于 Drawnix',
          click: () => showAboutDialog(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 单实例：第二次双击文件时复用已有窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const filePath = findDrawnixPath(argv);
    if (filePath) void openFileInWindow(filePath);
  });

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('com.drawnix.desktop');
      registerAppProtocol();
      registerIpc();
      buildMenu();
      await createWindow();

      const startupFile = findDrawnixPath(process.argv);
      if (startupFile) await openFileInWindow(startupFile);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((error: unknown) => {
      // 启动链路上任何未捕获异常都要让用户看到，而不是留一个没有任何窗口的进程
      dialog.showErrorBox(
        'Drawnix 启动失败',
        error instanceof Error ? error.message : String(error)
      );
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
