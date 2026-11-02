#!/usr/bin/env node
/**
 * 从上游源码构建桌面版渲染层。
 *
 * 流程：定位上游 → 检查依赖 → 校验版本锁定 → vite 构建到暂存目录
 *      → 清理托管文件 → 校验适配层 → 原子替换 dist/apps/web → 写锁文件
 *
 * 之所以先构建到暂存目录再替换，是为了让"构建失败"永远不会破坏当前可打包的
 * 渲染层 —— 旧版 sync-web.js 的暂存/回滚思路保留了下来。
 *
 * 参数：
 *   --force                  跳过产物校验（不推荐）
 *   --no-install             上游缺少依赖时直接报错，不自动 npm ci
 *   --allow-upstream-drift   上游 commit 与 upstream.lock.json 不一致时仍然构建
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  REPO_ROOT,
  DIST_WEB,
  fail,
  resolveUpstream,
  gitHead,
  gitDescribe,
  readLock,
  writeLock,
  cleanHostingFiles,
  removeTree,
  verifyRenderer,
  reportVerify,
} = require('./upstream');

const args = process.argv.slice(2);
const force = args.includes('--force');
const noInstall = args.includes('--no-install');
const allowDrift = args.includes('--allow-upstream-drift');

// 暂存与备份目录都带时间戳：Windows 上 rename 到"已存在的目录"会直接 EPERM，
// 用唯一名字可以保证上一次残留（杀毒软件占用、删除保护等）不会挡住这次构建。
const DIST_ROOT = path.join(REPO_ROOT, 'dist');
const STAMP = Date.now();
const STAGING = path.join(DIST_ROOT, `.renderer-staging-${STAMP}`);
const BACKUP = path.join(DIST_ROOT, `.renderer-backup-${STAMP}`);
const CONFIG = path.join(REPO_ROOT, 'desktop', 'vite.desktop.config.mjs');

const step = (message) => console.log(`\n[build-renderer] ${message}`);

const upstream = resolveUpstream();
step(`上游仓库：${upstream}`);

if (!fs.existsSync(CONFIG)) {
  fail(`构建配置不存在：${CONFIG}`);
}

// 0) 尽力清理历史残留（失败只警告，不影响本次构建）
if (fs.existsSync(DIST_ROOT)) {
  for (const name of fs.readdirSync(DIST_ROOT)) {
    if (name.startsWith('.renderer-staging-') || name.startsWith('.renderer-backup-')) {
      removeTree(path.join(DIST_ROOT, name));
    }
  }
}

// 1) 依赖：上游没装过依赖时自动安装一次（约 1~2 分钟）
const viteBin = path.join(upstream, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  if (noInstall) {
    fail(`上游缺少依赖，请先在 ${upstream} 执行 npm ci（或去掉 --no-install）`);
  }
  step('上游缺少依赖，执行 npm ci …');
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: upstream,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

// 2) 版本锁定：产物必须可追溯到某个确定的上游 commit
const head = gitHead(upstream);
const describe = gitDescribe(upstream);
const lock = readLock();
const lockedCommit = lock.upstream && lock.upstream.commit;

if (lockedCommit && head && lockedCommit !== head && !allowDrift) {
  fail(
    `上游当前 commit ${head.slice(0, 7)}（${describe}）与 upstream.lock.json 记录的 ` +
      `${lockedCommit.slice(0, 7)} 不一致。\n` +
      '请执行 npm run upstream:sync 更新锁定，或加 --allow-upstream-drift 临时构建。'
  );
}

step(`构建 ${describe || head} → ${path.relative(REPO_ROOT, STAGING)}`);

// 3) 构建到暂存目录
removeTree(STAGING);
fs.mkdirSync(path.dirname(STAGING), { recursive: true });

try {
  execFileSync(process.execPath, [viteBin, 'build', '--config', CONFIG], {
    cwd: upstream,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DRAWNIX_UPSTREAM: upstream,
      DRAWNIX_OUT_DIR: STAGING,
    },
  });
} catch (error) {
  removeTree(STAGING);
  fail(`渲染层构建失败：${error.message}`);
}

// 4) 托管平台文件对桌面端无意义，顺手清掉
cleanHostingFiles(STAGING);

// 5) 校验：确认适配层真的被编译进去了
if (!force) {
  const errors = verifyRenderer(STAGING);
  if (!reportVerify(STAGING, errors)) {
    removeTree(STAGING);
    fail('产物校验失败，已保留现有 dist/apps/web 未改动。');
  }
} else {
  console.warn('[build-renderer] --force：跳过产物校验');
}

// 6) 原子替换
// 首次构建时 dist/apps 还不存在，rename 到不存在的父目录会 ENOENT，先补上父目录。
fs.mkdirSync(path.dirname(DIST_WEB), { recursive: true });
removeTree(BACKUP);
const hadTarget = fs.existsSync(DIST_WEB);
if (hadTarget) {
  try {
    fs.renameSync(DIST_WEB, BACKUP);
  } catch (error) {
    removeTree(STAGING);
    fail(`备份现有产物失败，未做任何修改：${error.message}`);
  }
}

try {
  fs.renameSync(STAGING, DIST_WEB);
} catch (error) {
  if (hadTarget) {
    try {
      fs.renameSync(BACKUP, DIST_WEB);
    } catch (rollbackError) {
      fail(`替换失败且回滚失败，请手工恢复 ${BACKUP} → ${DIST_WEB}：${rollbackError.message}`);
    }
    fail(`替换产物失败，已回滚：${error.message}`);
  }
  fail(`替换产物失败：${error.message}`);
}

removeTree(BACKUP);

// 7) 记录本次构建
writeLock({
  upstream: {
    ...(lock.upstream || {}),
    commit: head,
    describe,
    syncedAt: new Date().toISOString(),
  },
  build: {
    at: new Date().toISOString(),
    node: process.version,
    verified: !force,
    renderer: path.relative(REPO_ROOT, DIST_WEB).split(path.sep).join('/'),
  },
});

step(`完成：${path.relative(REPO_ROOT, DIST_WEB)}（上游 ${describe || head}）`);
console.log('[build-renderer] 下一步：npm run electron:build && npm run dist:win');
