# Drawnix Windows 桌面版

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把开源白板工具 [Drawnix](https://github.com/plait-board/drawnix) 封装成 Windows 10/11 x64 桌面客户端：双击安装、离线可用、`.drawnix` 文件双击即开，无需浏览器。

> 渲染层直接复用 Drawnix 官方构建产物，本项目只提供 Electron 桌面壳与桌面能力适配（原生打开/保存对话框、导出落盘、外链交给系统浏览器）。

![screenshot](docs/screenshot.png)

## 下载

前往 [Releases](https://github.com/andloo/drawnix-windows-desktop/releases/latest) 下载：

| 文件 | 说明 |
| --- | --- |
| `Drawnix-<version>-x64-Setup.exe` | 安装版：可选安装目录，创建桌面/开始菜单快捷方式，注册 `.drawnix` 文件关联 |

系统要求：Windows 10 1809+ / Windows 11，x64。

> 当前安装包**未做代码签名**，首次运行时 Windows SmartScreen 会提示"未知发布者"，选择「更多信息 → 仍要运行」即可。

## 功能

- 思维导图、流程图、自由画笔、形状/箭头/文本、图片插入
- 无限画布：缩放、滚动、主题切换
- Mermaid 语法转流程图、Markdown 转思维导图（全部本地打包，离线可用）
- 撤销/重做/复制/粘贴，导出 PNG / SVG，复制选区为图片
- 原生文件操作：打开、保存（Ctrl+S）、另存为（Ctrl+Shift+S）、导出时弹原生保存对话框
- 保存结果提示：成功显示文件路径，失败显示原因
- 自动保存到本地（IndexedDB），崩溃/重启后可恢复
- 单实例运行 + 文件关联：双击 `.drawnix` 直接打开，重复启动复用已有窗口
- 记住窗口状态：全屏 / 最大化 / 尺寸与位置在下次启动时恢复（`%APPDATA%\drawnix-desktop\window-state.json`）
- 外链一律交给系统默认浏览器，应用内不打开新窗口

## 使用

1. 运行 `Drawnix-<version>-x64-Setup.exe` 完成安装。
2. 从开始菜单或桌面启动 **Drawnix**。
3. 首次启动会显示引导提示；直接开始绘制即可，内容会自动保存在本地。
4. 需要留存文件时使用「应用菜单 → 另存为」，或按 `Ctrl+Shift+S`；之后 `Ctrl+S` 直接覆盖当前文件。

数据位置：

- 画板自动保存：`%APPDATA%\drawnix-desktop\`（IndexedDB，卸载默认保留）
- 手动保存的文件：你选择的任意路径，扩展名 `.drawnix`（JSON 格式，可跨平台导入 Web 版）

应用不发起任何外部网络请求（已移除统计脚本与 SEO 资源）。

## 从源码构建

环境要求：Node.js 20+、npm、Windows x64、一份 Drawnix 上游仓库。

### 准备上游

渲染层由上游源码直接构建，**不修改上游任何文件**。上游仓库按以下顺序查找：

1. `upstream.config.json` 里配置的 `path`
2. `upstream/drawnix`（推荐：git submodule，版本随主仓库锁定）

```bash
# 推荐：submodule，版本可复现
git submodule add https://github.com/plait-board/drawnix.git upstream/drawnix
git submodule update --init --recursive   # 克隆本仓库后的一条命令
```

想让上游放在别处（例如与本仓库并列，便于同时阅读源码）时，把 `upstream.config.json`
的 `path` 指向该目录即可。

```json
{ "repo": "https://github.com/plait-board/drawnix", "path": "../drawnix" }
```

### 构建

```bash
# 1. 安装桌面壳依赖（Electron 二进制下载慢时可设置镜像）
npm ci
# PowerShell: $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 2. 构建渲染层（首次会自动在上游仓库执行 npm ci，约 1~2 分钟）
npm run build:renderer
# 产物：dist/apps/web

# 3. 打包 Windows 安装包
npm run dist:win
# 产物：release/Drawnix-<version>-x64-Setup.exe
```

`dist/apps/web` 是构建产物，不进版本库。上游依赖装好之后单次构建约 2 秒，因此日常开发直接 `npm run dist:win` 即可。

重新生成图标（可选）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1
```

### 开发模式

```bash
npm run electron:build
npx electron .                      # 默认加载上游 dev server（纯 Web 版，无桌面文件能力）
```

要调试桌面适配层本身（原生打开/保存/导出），用带 shim 的 dev server：

```bash
# 终端 1
npm run dev:renderer                # http://localhost:7201
# 终端 2
DRAWNIX_DEV_URL=http://localhost:7201 npm run electron:dev
```

想在不打安装包的情况下验证"安装版行为"（加载内置 `dist/apps/web`）：

```bash
DRAWNIX_USE_BUNDLE=1 npx electron .
```

### 脚本职责

| 命令 | 作用 |
| --- | --- |
| `npm run upstream:sync -- --tag v0.4.2` | 切换上游版本并写入 `upstream.lock.json` |
| `npm run upstream:check` | 检查上游当前 commit 是否与锁文件一致 |
| `npm run build:renderer` | 用 `desktop/vite.desktop.config.mjs` 从上游源码构建渲染层 |
| `npm run verify:renderer` | 校验产物是否真的包含桌面适配层 |
| `npm run typecheck` | 只对 `desktop/` 适配层做类型检查（忽略上游既有诊断） |
| `npm run smoke` | 启动真实 Electron 做冒烟断言；加 `-- --packaged` 直接冒烟 `release/win-unpacked` 里的成品 |
| `npm run dist:win` | 构建渲染层 → 编译主进程 → 打 NSIS 安装包 |
| `npm run dist:win:reuse` | 跳过渲染层构建，直接用现有 `dist/apps/web` 打包 |

`build:renderer` 采用「构建到暂存目录 → 校验 → 备份 → 原子替换」，任一步失败都会保留原有 `dist/apps/web`，不会出现"打包出一个失去桌面能力的安装包"。

### 版本号

版本号分两层，互不干扰：

| 层 | 来源 | 出现在哪里 |
| --- | --- | --- |
| 应用版本 | `package.json` 的 `version` | 安装包文件名 `Drawnix-<version>-x64-Setup.exe`、"关于 Drawnix"、`app.getVersion()` |
| 上游版本 | `upstream.lock.json` 的 `upstream.describe` / `commit` | 编译期由 `scripts/build-electron.js` 注入主进程，"关于 Drawnix" 里显示 |

发版时只改应用版本：

```bash
npm version patch --no-git-tag-version   # 0.0.4 → 0.0.5，同步 package.json 与 package-lock.json
npm run dist:win
```

上游版本不需要手工维护 —— `npm run upstream:sync` 会写进 `upstream.lock.json`，下一次 `electron:build` 自动带进安装包。

## 同步上游 Drawnix 更新

本项目**不修改上游任何源码**。渲染层 = 上游源码 + `desktop/` 适配层，在构建期合成（见「架构说明」）。
所以"同步上游"本质上是三步：**换 commit → 重新构建 → 验证**。

### 0. 一次性准备

上游仓库位置按以下顺序确定：

1. `upstream.config.json` 里的 `path`
2. `upstream/drawnix`（git submodule，推荐）

```bash
# 推荐：submodule，上游 commit 由主仓库 gitlink 锁定，clone --recursive 即可复现
git submodule add https://github.com/plait-board/drawnix.git upstream/drawnix
git commit -m "chore: 添加上游 submodule"
```

上游依赖只需装一次（`build:renderer` 检测到缺失会自动 `npm ci`，约 1~2 分钟）：

```bash
cd upstream/drawnix && npm ci && cd -
```

### 1. 先看上游改了什么

```bash
cd upstream/drawnix
git fetch --tags
git log --oneline v0.4.1-32..v0.4.2          # 换了哪些提交
git diff --stat v0.4.1-32..v0.4.2 -- \
  packages/drawnix/src/data \
  packages/drawnix/src/plugins \
  packages/drawnix/src/components/toolbar \
  packages/drawnix/src/components/toast \
  apps/web
```

重点看这 5 个"接口面"，桌面适配层依赖它们：

| 文件 | 为什么要看 |
| --- | --- |
| `packages/drawnix/src/data/filesystem.ts` | 是否还从 `browser-fs-access` 导入（alias 的前提） |
| `packages/drawnix/src/data/json.ts` | `saveJSON` / `loadFromJSON` 的签名与 `fileHandle` 语义 |
| `apps/web/src/app/app.tsx` | 与 `desktop/entry/app.tsx` 的差异，手工合并 |
| `components/toast/toast.scss` | `--toast-*` 主题变量是否改名 |
| `packages/drawnix/src/drawnix.tsx` | `DrawnixProps` 是否变化（`afterInit`、`appState` 等） |

### 2. 切版本

```bash
npm run upstream:sync -- --tag v0.4.2      # 或 --commit <sha> / --branch master
npm run upstream:check                     # 确认锁文件与上游一致
```

脚本会：校验上游工作区干净 → `git fetch --tags` → `checkout` → 写 `upstream.lock.json`（commit / describe / 时间）。

### 3. 重新构建

```bash
npm run build:renderer
```

内部流程：构建到临时目录 → 清理托管平台文件 → 校验适配层 → 备份旧产物 → 原子替换 `dist/apps/web`。
**任何一步失败都会保留原有产物**，不会出现"打出一个失去桌面能力的包"。

若上游 `package-lock.json` 有变化，先在上游目录执行 `npm ci` 再构建。

### 4. 校验 + 冒烟

```bash
npm run typecheck        # desktop/ 适配层类型检查（上游既有诊断会被忽略）
npm run verify:renderer  # L1 结构 + L2 语义：CSP、入口资源、桥接标记
npm run smoke            # 真实 Electron 跑 10 项断言
```

`smoke` 覆盖：画布渲染、桥接注入、原生写入落盘、工具栏挂载、无 CSP 报错、无外部请求、
Ctrl+S 直接覆盖原文件、保存提示出现、提示配色跟随主题。

### 5. 打包并提交锁文件

```bash
npm run dist:win
git add upstream.lock.json
git commit -m "chore: 上游升级到 v0.4.2"
```

### 出问题时怎么办

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `verify:renderer` 报「文件能力 shim（browser-fs-access alias）」缺失 | 上游不再从 `browser-fs-access` 导入，或改了模块路径 | 看 `data/filesystem.ts` 的新导入来源，改 `desktop/vite.desktop.config.mjs` 的 alias |
| `build:renderer` 报「与 upstream.lock.json 不一致」 | 上游被切到了别的 commit | `npm run upstream:sync` 对齐，或加 `--allow-upstream-drift` 临时构建 |
| 构建报找不到模块 / 依赖报错 | 上游依赖没装或版本过期 | `cd 上游目录 && npm ci` |
| `smoke` 报「保存提示配色跟随主题」失败 | 上游 toast 主题变量改名 | 改 `desktop/shims/toast.ts` 顶部的 `--toast-*` 变量名 |
| `smoke` 报「Ctrl+S 直接覆盖原文件」失败 | 上游改了 `appState.fileHandle` 机制 | 检查 `desktop/entry/app.tsx` 里补写 `fileHandle` 的逻辑 |
| `typecheck` 报 `desktop/` 下的错误 | 上游改了 `DrawnixProps` 等公共类型 | 按报错调整 `desktop/` 里的调用 |
| 界面样式整体错乱 | 上游改了 `apps/web/src/styles.scss` 或类名 | 检查 `desktop/entry/main.tsx` 的样式引入与 `entry/index.html` 的 CSP |

### 回滚

```bash
git checkout HEAD~1 -- upstream.lock.json
npm run upstream:sync -- --commit <上一个可用的 sha>
npm run build:renderer
```

### 关于 `patches/`

`upstream.lock.json` 里的 `patches` 目前是空数组 —— 所有桌面能力都通过构建期注入实现，**不需要补丁**。
只有当上游彻底重构了文件能力模块、alias 无法生效时，才考虑在 `patches/` 放一个最小补丁，
并在 `upstream-sync.js` 里按顺序 `git apply --3way`（任一失败即中止，绝不静默降级）。

## 目录结构

```
.
├── electron/
│   ├── main.ts                 # 主进程：窗口、app:// 协议、IPC、菜单、单实例、文件关联
│   ├── preload.ts              # contextBridge 白名单 API
│   └── tsconfig.json
├── desktop/                    # ★ 桌面适配层，唯一需要长期维护的渲染层代码
│   ├── entry/
│   │   ├── index.html          # 桌面入口：CSP、无统计脚本
│   │   ├── main.tsx            # React 挂载
│   │   └── app.tsx             # fork 自上游 app.tsx + 桌面握手
│   ├── shims/
│   │   ├── bridge.ts           # window.drawnixDesktop 类型与访问器
│   │   ├── fs-desktop.ts       # 替换 browser-fs-access 的原生文件能力
│   │   └── toast.ts            # 保存成功/失败提示
│   ├── vite.desktop.config.mjs # 构建配置：alias + 入口 + 产物目录
│   └── tsconfig.json
├── scripts/
│   ├── upstream.js             # 上游定位、版本锁定、产物校验的公共逻辑
│   ├── upstream-sync.js        # 切换上游版本
│   ├── build-renderer.js       # 构建渲染层（暂存 → 校验 → 原子替换）
│   ├── verify-renderer.js      # 产物校验
│   └── smoke.js                # Electron 冒烟断言
├── upstream.config.json        # 上游仓库位置
├── upstream.lock.json          # 上游 commit / 构建指纹
├── dist/apps/web/              # 构建产物（由 build:renderer 生成）
├── electron-builder.yml        # NSIS x64 打包配置
└── package.json
```

## 架构说明

```
Drawnix.exe (NSIS 安装包)
└── 主进程 (Electron / Node)
    ├── app://bundle 自定义安全协议 → 提供 dist/apps/web 静态资源
    ├── 原生 dialog + fs：打开/保存/另存为/导出
    ├── 单实例 & .drawnix 文件关联（argv 解析 + 渲染层握手）
    └── IPC（contextBridge 白名单）
        └── 渲染进程：Drawnix SPA（React 19 + Plait）
            └── IndexedDB 自动保存
```

关键设计：

- **不使用 `file://` 加载页面**：`file://` 的 null origin 会导致 IndexedDB、剪贴板 API 失效，且 `<base href="/">` 的绝对路径会断链。因此注册 `app://`（`standard: true, secure: true`）承载页面。
- **进程隔离**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，渲染层只能调用 preload 暴露的白名单方法。
- **原生文件能力靠构建期注入**：上游所有本地文件操作都收口在 `packages/drawnix/src/data/filesystem.ts`，而它只从 `browser-fs-access` 导入 `fileOpen` / `fileSave` / `supported` 三个符号。构建时用 Vite `resolve.alias` 把这个模块整体换成 `desktop/shims/fs-desktop.ts`，即可让打开、保存、另存为、导出图片、插入图片全部走原生 `dialog` + `fs`，**上游源码一行都不用改**。打开时把文件绝对路径挂到 `File.handle` 上，上游会把它存进 `appState.fileHandle`，保存时再原样传回，因此"Ctrl+S 覆盖当前文件"无需任何补丁。
- **导出下载同样不改上游**：图片导出走渲染层的 `<a download>`，主进程用 `session.on('will-download')` 接管为原生另存为对话框。
- **安全策略**：CSP 白名单、协议处理器做目录穿越校验、外链统一 `shell.openExternal`、剪贴板写权限单独放行。

## 已知限制

- 安装包未签名，SmartScreen 会提示未知发布者。
- 暂不支持自动更新（可参考 `electron-builder` + `electron-updater` 扩展）。
- 仅提供 x64 构建；ARM64 需自行增加 `--arm64` 目标。
- 渲染层由上游源码构建，构建机需要能访问上游仓库并完成一次 `npm ci`（约 1~2 分钟）。`dist/apps/web` 不进版本库，首次构建前必须先执行 `npm run build:renderer`。

## 许可与致谢

本项目采用 [MIT License](LICENSE) 开源。

- 本项目基于 [Drawnix](https://github.com/plait-board/drawnix)（MIT License）构建，遵循 MIT License 分发。
- 绘图框架：[Plait](https://github.com/worktile/plait)（MIT）；富文本：[Slate](https://github.com/ianstormtaylor/slate)（MIT）。
- 桌面封装：Electron、electron-builder。

原始版权归 Drawnix / Plait 作者所有；本项目仅做桌面端适配与打包。
