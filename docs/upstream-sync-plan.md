# Drawnix 上游更新同步：现状诊断与改造方案

> 分析对象：`drawnix/`（上游 plait-board/drawnix，HEAD `b138ff8`，`v0.4.1-32-gb138ff8`）与 `drawnix-windows-desktop/`（自研 Electron 桌面壳，v0.0.3）。  
> 本文只做诊断与方案设计，**不包含任何代码改动**。
>
> **状态：方案 B 已落地。** 本文保留为设计依据与决策记录；落地后的目录结构与脚本用法见 `README.md` 的「从源码构建」「目录结构」两节。与本文的唯一差异：构建配置落在 `desktop/vite.desktop.config.mjs`（零第三方 import，因此可以放在桌面仓库里由上游 vite 直接加载）。补丁流程已实现为 `patches/*.patch` + `upstream-sync` 的 `git apply --check`（不用 `--3way`：宁可因上游改动而失败，也不做模糊合并）。

---

## 一、结论速览

| 问题                | 结论                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| 上游更新后要不要复杂改代码？    | **当前状态下不是"复杂"，而是"做不到"**：桌面适配层的源码已丢失，只存在于压缩后的构建产物里，无法重放、无法重打补丁、无法调试                                                   |
| 现在的同步脚本能用吗？       | **不能**。`scripts/sync-web.js` 里的上游路径是硬编码相对路径，在当前目录结构下指向一个不存在的目录，脚本会走"沿用旧产物"分支静默退出 —— 也就是说，**即使你重新构建了上游，打包出来的仍然是旧渲染层** |
| 改造后能不能做到"不碰上游代码"？ | 可以。把适配层从"改上游源码"改成"构建期注入（alias + 独立 entry）"后，理想情况**补丁面降到 0～2 个文件**，上游更新 = 更新 submodule + 重新构建 + 跑冒烟测试                 |
| 工作量               | 一次性改造约 1～2 人日；之后每次上游更新约 30～60 分钟（主要是跑冒烟测试）                                                                           |

---

## 二、现状：数据是怎么流动的

### 2.1 两个仓库的真实关系

```
drawnix/                       ← 上游 monorepo（nx + vite + react19 + plait）
├── apps/web/                  ← 真正的 Web 应用壳（app.tsx 只有 115 行）
│   ├── index.html
│   └── src/app/app.tsx        ← 挂载 <Drawnix />，localforage 自动保存
├── packages/drawnix/          ← 白板主体库（drawnix.tsx / data/json.ts / data/filesystem.ts ...）
├── packages/react-board/      ← @plait-board/react-board（本地源码）
└── packages/react-text/

drawnix-windows-desktop/       ← 你的仓库
├── electron/{main,preload}.ts ← 桌面壳（381 + 32 行，这部分是干净的、可维护的）
├── scripts/sync-web.js        ← 把上游构建产物同步进来
├── scripts/check-web-build.js ← 用字符串 grep 校验产物
└── dist/apps/web/             ← 5.0MB 预构建渲染层，**已提交进 git（56 个文件）**
```

关键事实：**`drawnix/` 是一个干净的上游克隆**（`git status` 无改动，remote 指向 `plait-board/drawnix`）。桌面适配补丁**不在任何源码里**，它只存在于 `dist/apps/web/assets/index-aZeQeLj0.js` 这个 1.07MB 的压缩产物中。

### 2.2 适配层被编译进了产物里（反查证据）

从压缩产物里能反查出补丁做了什么，这些函数名都是压缩后仍可辨识的：

| 产物中的符号                                                    | 含义                                                               | 对应上游源码位置                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `MF = () => window.drawnixDesktop ?? null`                | 桥接访问器                                                            | `packages/drawnix/src/data/filesystem.ts`（新增） |
| `PF`                                                      | `openFiles` → 返回带 `handle = 路径` 的 `File`                         | 同上                                            |
| `FF`                                                      | `writeFile` 直接覆盖已有路径                                             | 同上                                            |
| `IF`                                                      | `saveFileAs` → 原生另存为对话框                                          | 同上                                            |
| `TI`                                                      | `download()`：桌面端改走 `IF`，Web 端保留 `<a download>`                   | `packages/drawnix/src/utils/common.ts`        |
| `HF` / `VF`                                               | `saveJSON` / `saveAsJSON` 改走桥接                                   | `packages/drawnix/src/data/json.ts`           |
| `iG` / `aG`                                               | 保存成功/失败 toast（`toast.save.success` / `failed` / `failed.locked`） | `app-menu-items.tsx`、`with-hotkey.ts`         |
| `uK` 组件的 `initialFileHandle` prop                         | 打开文件后把路径注入 `appState.fileHandle`                                 | `drawnix.tsx`                                 |
| `app.tsx` 里的 `onOpenFile` 订阅 + `ready()` 握手 + `key` 自增重挂载 | 双击 `.drawnix` 打开                                                 | `apps/web/src/app/app.tsx`                    |

### 2.3 补丁面清单（12 个文件）

| #     | 文件                                                  | 改动性质                                     | 上游改动频率        |
| ----- | --------------------------------------------------- | ---------------------------------------- | ------------- |
| 1     | `apps/web/index.html`                               | 加 CSP、删 umami 统计与 SEO meta               | 低             |
| 2     | `apps/web/src/app/app.tsx`                          | 握手 + onOpenFile + 路径 state + 重挂载 key     | **高**         |
| 3     | `packages/drawnix/src/drawnix.tsx`                  | 新增 `initialFileHandle` prop 并注入 appState | 中             |
| 4     | `packages/drawnix/src/data/filesystem.ts`           | 桥接替换 `browser-fs-access`                 | 中             |
| 5     | `packages/drawnix/src/data/json.ts`                 | `fileHandle` 语义从 FSA handle 改为路径字符串      | **高**         |
| 6     | `packages/drawnix/src/utils/common.ts`              | `download()` 改走原生另存为                     | 低             |
| 7     | `components/toolbar/app-toolbar/app-menu-items.tsx` | 保存后 toast + catch 错误                     | **高**         |
| 8     | `plugins/with-hotkey.ts`                            | Ctrl+S / Ctrl+Shift+S 同上                 | **高**         |
| 9     | `i18n/types.ts`                                     | 新增 3 个 key 的类型                           | 低             |
| 10-12 | `i18n/translations/{zh,en,ru,ar,vi}.ts`             | 各新增 3 条文案                                | 低（但 5 个文件都要动） |

其中 4 个是高频变动文件。上游任何一个 PR 动了保存/打开流程，手工重打补丁就会冲突，而且**冲突时没有原始补丁文件可供参考** —— 这是当前最大的风险。

### 2.4 五个具体缺陷

**P0-1　适配层源码丢失。**  
`dist/` 里只有压缩产物，没有 `.patch`、没有 fork 分支、没有 overlay 源码。想重新生成"带桌面能力的渲染层"，只能靠反读压缩代码重写一遍。这是"上游更新"这件事当前不可执行的根本原因。

**P0-2　`sync:web` 的上游路径已失效，且失效时静默通过。**

```js
const source = path.resolve(__dirname, '../../dist/apps/web');
// 实际解析为：C:\Users\hahal\Downloads\test\dist\apps\web  ← 不存在
```

`electron/tsconfig.json` 里 `"extends": "../../tsconfig.base.json"` 也指向 `test/tsconfig.base.json`（不存在）—— 两处都说明这个仓库原本是放在 `drawnix/desktop/` 下开发的，被挪成兄弟目录后就断了。

更糟的是脚本的容错分支：

```js
if (!fs.existsSync(source)) {
  if (fs.existsSync(target + '/index.html')) {
    console.log('[sync-web] 未找到上游产物，沿用现有 dist/apps/web');
    process.exit(0);          // ← 退出码 0，CI 也发现不了
  }
}
```

**结果：你以为同步了，其实一直在用 2025 年的旧构建打包。**

**P1-3　5MB 压缩产物进 git。**  
56 个文件、5.0MB，diff 完全不可读，代码评审无从下手，每次更新仓库体积翻倍增长。而且产物与"它来自哪个上游 commit"之间没有任何可追溯的元数据。

**P1-4　校验靠 grep 字符串，且校验的是产物而不是源头。**  
`check-web-build.js` 在压缩产物里找 `window.drawnixDesktop`、`openFiles`、`saveFileAs`、`toast.save.success`。这类检查有三个问题：上游某天自己引入同名标识符会误判通过；改名/压缩策略变化会误判失败；它只能证明"产物里有这些字"，不能证明"打开/保存真的能用"。

**P2-5　版本号与上游无关联。**  
`0.0.3` 完全看不出对应的上游版本，用户报 bug 时无法定位是哪个上游版本的问题。

---

## 三、三个候选方案

| 维度      | A. 补丁序列（submodule + patch）             | B. 构建期注入（alias + 独立 entry）**推荐**                                                     | C. 纯上游产物 + 运行时注入                  |
| ------- | -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| 思路      | 上游源码打 `patches/*.patch`，脚本 `git apply` | 不改上游任何一行；用 Vite `resolve.alias` 把 `browser-fs-access` 换成桌面实现，用自建 entry 替换 `apps/web` | 直接用官方构建产物，靠 preload/主进程注入能力       |
| 补丁面     | 12 个文件                                 | **0～2 个文件**                                                                          | 0                                 |
| 上游更新冲突  | 高（4 个高频文件）                             | 极低                                                                                   | 无                                 |
| 桌面能力完整度 | 完整                                     | 完整（可补齐）                                                                              | 可能缺"双击打开 / Ctrl+S 覆盖路径"           |
| 技术风险    | 低（但维护累）                                | 中（需要一次构建链路验证）                                                                        | **高**（依赖 Chromium FSA API 行为，不可控） |
| 一次性成本   | 中（需先重建补丁）                              | 中高                                                                                   | 低                                 |
| 长期成本    | 每次更新 1～3 小时                            | 每次更新 30～60 分钟                                                                        | 低，但能力退化                           |

方案 C 值得单独说明：上游用的是 `browser-fs-access`，在 Electron 里会落到 Chromium 的 `showOpenFilePicker` / `showSaveFilePicker`，而 Chromium 在 Windows 上弹出的**就是系统原生对话框**；导出图片的 `<a download>` 也可以在主进程用 `session.on('will-download')` 拦截并接管为另存为对话框。理论上"零补丁"也能得到接近原生的体验。但它把能力完整性押在 Chromium 的行为上（权限弹窗、`sandbox: true` 下的 FSA 可用性、user-gesture 限制），且双击打开文件仍需把内容注入 localforage 再重载页面，属于"能跑但不好维护"。**建议作为方案 B 的降级预案，或先用半天做可行性验证。**

---

## 四、推荐方案：构建期注入（方案 B）

### 4.1 核心思路

> 把"改上游源码"变成"在上游源码外面套一层构建配置"。

上游 `packages/drawnix/src/data/filesystem.ts` 的全部文件能力都来自一个模块：

```ts
import { fileOpen as _fileOpen, fileSave as _fileSave, supported } from 'browser-fs-access';
```

而这个模块的导出面极窄，只有 `fileOpen` / `fileSave` / `supported`（`supported` 在上游只被 re-export，没有任何调用点）。所以：

**用 Vite alias 把 `browser-fs-access` 整体换成一个桌面实现，上游源码一行都不用改。**

```ts
// 设计示意（不落地）
resolve: {
  alias: {
    'browser-fs-access': path.resolve(__dirname, 'shims/fs-desktop.ts'),
  },
}
```

`shims/fs-desktop.ts` 需要实现三个导出，签名与 `browser-fs-access` 对齐：

| 导出                                                                    | 桌面实现                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fileOpen({description, extensions, mimeTypes, multiple})`            | 走 IPC 原生打开对话框，返回 `File` 对象，并把**文件路径挂到 `file.handle`** —— 上游 `loadFromJSON` 正好读 `file.handle` 写进 `appState.fileHandle`，天然兼容 |
| `fileSave(blob, {fileName, description, extensions}, existingHandle)` | 有 handle（即路径字符串）→ 直接 `writeFile`；无 handle → 弹原生另存为 → 返回路径                                                                  |
| `supported`                                                           | 返回 `true`（桌面端永远支持"原生文件"）                                                                                                   |

这一招直接消掉了原补丁的 #4、#5、#6 三个文件：

- `filesystem.ts` 不用改（它只是薄封装，会透传到我们的 shim）；
- `json.ts` 不用改（`fileSave(blob, opts, fileHandle)` 的第三个参数原样透传，语义从 FSA handle 变成路径字符串，但上游全程只当不透明令牌用）；
- `common.ts` 的 `download()` 不用改 —— 桌面端可以继续用 `<a download>`，**在主进程用 `will-download` 拦截并改写为另存为**，完全不碰渲染层。

剩下真正需要"桌面定制"的只有两处，而它们都在**上游的 `apps/web` 壳层**，本来就应该由你自己维护：

| 需要定制的点           | 原补丁做法            | 方案 B 做法                                          |
| ---------------- | ---------------- | ------------------------------------------------ |
| 双击 `.drawnix` 打开 | 改上游 `app.tsx`    | **自己写 `entry/app.tsx`**（从上游 115 行的版本 fork，加握手逻辑） |
| CSP / 去统计脚本      | 改上游 `index.html` | **自己写 `entry/index.html`**                       |

于是补丁面 = **0**（理想）/ **2**（若必须保留"保存成功 toast"，则在 `app-menu-items.tsx` + `with-hotkey.ts` 上各留一个几行的 patch，或接受用主进程 `Notification` 替代）。

### 4.2 目标目录结构

```
drawnix-desktop/                     # 你的仓库（改名可选）
├── upstream/
│   └── drawnix/                     # git submodule，锁定到 tag，永不修改
├── desktop/                         # ★ 你唯一需要长期维护的渲染层代码
│   ├── entry/
│   │   ├── index.html               # CSP、无 umami、无 SEO meta
│   │   ├── main.tsx                 # createRoot
│   │   └── app.tsx                  # fork 自上游 app.tsx + 桌面握手
│   ├── shims/
│   │   ├── fs-desktop.ts            # 替代 browser-fs-access
│   │   └── bridge.ts                # window.drawnixDesktop 类型与访问器
│   ├── vite.desktop.config.ts       # root/alias/outDir 全在这里
│   └── tsconfig.json
├── patches/                         # 仅当方案 B 仍需 1～2 个补丁时存在
│   └── 0001-save-toast.patch
├── electron/                        # 不变（main.ts / preload.ts 已经写得不错）
├── scripts/
│   ├── upstream-sync.js             # 更新 submodule + 应用补丁 + 记录 lock
│   ├── build-renderer.js            # 调上游 vite 构建到 dist/apps/web
│   ├── verify-renderer.js           # 结构化校验 + 冒烟测试
│   └── make-icons.ps1
├── upstream.lock.json               # ★ 上游版本与构建指纹
├── electron-builder.yml
└── package.json
```

### 4.3 关键脚本职责

**`scripts/upstream-sync.js`**

1. `git -C upstream/drawnix fetch --tags`
2. 切到目标 tag（或 `origin/master`）
3. 若 `patches/` 非空：逐个 `git apply --3way --check`，**任一失败立即中止并打印冲突文件与上下文**（不允许静默降级 —— 这正是当前 P0-2 的病根）
4. 把 `commit / tag / 日期` 写入 `upstream.lock.json`

**`scripts/build-renderer.js`**

1. `npm ci`（在 `upstream/drawnix`，可用 `node_modules` 缓存，约 1～2 分钟）
2. `npx vite build --config <绝对路径>/desktop/vite.desktop.config.ts`  
   —— 注意 `root` 指向 `upstream/drawnix/apps/web`，`outDir` 直接指向本仓库 `dist/apps/web`，`emptyOutDir: true`
3. 构建完立刻写指纹到 `upstream.lock.json`

**`scripts/verify-renderer.js`**（取代 `check-web-build.js`）  
分三层，缺一层就不算过：

| 层级    | 检查内容                                                                            | 目的                    |
| ----- | ------------------------------------------------------------------------------- | --------------------- |
| L1 结构 | `index.html` 有 CSP、有 `<base href="/">`、引用的每个 `/assets/*` 文件都存在、`assets` 下 js 非空 | 防止同步到半成品              |
| L2 语义 | 产物中必须出现 `drawnixDesktop`；**且必须不出现** `https://cloud.umami.is`                    | 防"退化成纯 Web 版"、防统计脚本回流 |
| L3 冒烟 | 起 Electron 用 Playwright 跑 6 条真实用例（见 §4.6）                                       | 证明"真的能用"，而不是"字在里面"    |

L3 是这次改造最值钱的部分：现在的 grep 只能证明"字符串在"，证明不了"保存到原路径不弹框"。

**`upstream.lock.json`（建议结构）**

```json
{
  "upstream": {
    "repo": "https://github.com/plait-board/drawnix",
    "commit": "b138ff867943ddff6c4c79560e10ab6ee3b5600e",
    "describe": "v0.4.1-32-gb138ff8",
    "syncedAt": "2026-10-26T07:20:00Z"
  },
  "patches": [],
  "build": {
    "node": "20.x",
    "rendererHash": "sha256:...",
    "verifiedAt": "2026-10-26T07:31:00Z",
    "smoke": "pass"
  }
}
```

### 4.4 版本号策略

不要试图把上游版本塞进 semver 的 prerelease 位（`0.4.1-32` 会让 NSIS/updater 的排序混乱）。建议：

- **应用版本独立演进**：`1.0.x`，只反映你自己的发布次数；
- **上游版本进"关于"对话框和 `upstream.lock.json`**：`Drawnix 1.0.7（上游 v0.4.1-32）`；
- Release 说明里固定写一行 `Upstream: plait-board/drawnix@b138ff8`。

### 4.5 dist 产物怎么办

**建议：从 git 移除，改为 CI 产物。**

| 保留方式                      | 优点                     | 缺点                        |
| ------------------------- | ---------------------- | ------------------------- |
| 继续提交进 git（现状）             | 克隆即可打包                 | 5MB 二进制 diff、评审不可读、体积持续膨胀 |
| **Release 附件 + 下载脚本**（推荐） | 仓库干净；仍可离线打包（下载一次后本地缓存） | 需要一次网络下载                  |
| CI 每次重建                   | 最干净                    | 打包耗时 +2 分钟，依赖上游 `npm ci`  |

保留"克隆即可打包"这个便利性是有价值的，建议折中：`npm run dist:win` 前先 `ensure:renderer` —— 本地有缓存就用缓存，没有就从 GitHub Release 拉取对应版本的 `renderer-<upstream>.zip` 并校验 sha256。

### 4.6 冒烟测试清单（L3，必须自动化）


| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | 启动 | 窗口出现，`#root` 内渲染出 `.drawnix` 容器，控制台无 CSP 报错 |
| 2 | 画一个矩形 → Ctrl+S | 弹出**原生**另存为；保存后文件存在且是合法 JSON（`type === 'drawnix'`） |
| 3 | 再按 Ctrl+S | **不弹框**，直接覆盖同一路径（mtime 变化） |
| 4 | Ctrl+Shift+S | 弹框，保存到新路径 |
| 5 | 双击 `.drawnix` / 单实例二次启动 | 复用已有窗口并载入内容 |
| 6 | 导出 PNG / SVG | 弹原生保存对话框，文件可被图片查看器打开 |
| 7 | 插入图片（mod+u） | 走原生打开对话框 |
| 8 | 网络 | 整个会话没有任何外部请求（`session.webRequest` 计数为 0） |

第 8 条可以直接在 `main.ts` 里加断言式日志，比 grep 更可靠。

### 4.7 日常更新 SOP（改造完成后）

```bash
git submodule update --init                    # 首次
npm run upstream:sync -- --tag v0.4.2          # 更新 + 应用补丁（失败会明确报冲突文件）
npm run build:renderer                         # 构建渲染层（约 1～2 分钟）
npm run verify:renderer                        # L1+L2+L3 冒烟
npm run dist:win                               # 打包
```

只有一种情况需要人工介入：`upstream:sync` 报补丁冲突。而方案 B 下补丁只有 0～2 个、且都是小文件，冲突处理通常 10 分钟内完成。**如果哪天上游重构了 `browser-fs-access` 的调用方式（比如不再经过 `data/filesystem.ts`），L2 校验会立刻失败并明确指出"桥接未生效"**，而不是像现在这样悄悄退化。

---

## 五、落地步骤（建议按此顺序）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0. 抢救（0.5 天） | 把 `dist/apps/web` 压缩产物反查出的补丁逻辑，整理成 `desktop/shims/fs-desktop.ts` 的初版（对照 §2.2 的符号表逐条还原） | 能描述出每个桥接方法的行为 |
| 1. 骨架（0.5 天） | 加 submodule；写 `desktop/entry/*`、`vite.desktop.config.ts`；跑通一次"从上游源码构建出可用渲染层" | 构建产物能启动，画布可用 |
| 2. 打通（0.5 天） | 接 alias、打通打开/保存/另存为/导出；对照 §4.6 逐条过用例 | 1～8 条全绿 |
| 3. 收口（0.5 天） | 写 `upstream.lock.json`、`verify-renderer.js`（L1+L2+L3）、`upstream-sync.js`；`dist/` 移出版本库 | 换一个上游 tag 重跑 SOP 一次成功 |
| 4. 可选 | `electron-updater` 自动更新（独立课题，与本文正交） | — |

---

## 六、风险与回滚

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 上游重构了 `data/filesystem.ts`，不再经过 `browser-fs-access` | alias 失效，桥接不生效 | L2 校验（必须有 `drawnixDesktop`）会立即失败并中止打包；此时退化为"加 1 个补丁" |
| `sandbox: true` + `contextIsolation` 下 preload 的 IPC 行为差异 | 打开/保存失败 | 已有 `main.ts` 的 IPC 白名单，无需改动；冒烟用例 2/3 覆盖 |
| `will-download` 接管导出的时机（`setSavePath` 必须在 `will-download` 同步阶段调用） | 导出可能静默存到 Downloads | 冒烟用例 6 覆盖 |
| 上游 `npm ci` 依赖体积大 / 私有 registry | 构建慢或失败 | `node_modules` 缓存 + `npm ci --prefer-offline`；实在不行退到方案 C |
| 打包产物体积 | 无变化 | 与现状一致（asar 内仍是同一套静态资源） |

**回滚**：改造期间保留现有 `dist/apps/web` 与 `sync-web.js` 不动，新链路以 `dist:win:next` 独立脚本先跑通，验证通过后再切换默认脚本、再删除旧产物。任何一步失败都能回到"用旧产物打包"的状态。

---

## 七、一句话回答最初的问题

> **现在**：上游更新后你无法同步 —— 适配层只剩压缩产物，且同步脚本因为路径失效一直在静默跳过。
> **改造后**：适配层从"改上游源码"变成"构建期注入"，上游更新 = 更新 submodule + 重新构建 + 跑冒烟，**不需要改任何上游代码**；只有在极端情况下（上游改了文件能力模块的接入方式）才需要补 1 个小补丁，而且校验会主动告诉你。
