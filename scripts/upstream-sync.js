#!/usr/bin/env node
/**
 * 切换上游 Drawnix 版本，并把版本与补丁清单写进 upstream.lock.json。
 *
 *   npm run upstream:sync -- --tag v0.4.2          # 切到某个 tag
 *   npm run upstream:sync -- --commit abc1234      # 切到某个 commit
 *   npm run upstream:sync -- --branch master       # 跟随分支（不推荐用于发布）
 *   npm run upstream:sync -- --check               # 只检查锁文件、补丁是否一致
 *   npm run upstream:sync -- --without-patches     # 排障：回滚补丁后不再应用
 *
 * 上游是独立仓库（submodule 或 upstream.config.json 指定的目录），本脚本只
 * checkout + 应用 patches/ 下的补丁，不改上游源码。切版本前会先按锁文件逆序
 * 回滚上次的补丁，让工作区回到干净状态；补丁打不上会立即中止并打印冲突位置，
 * 绝不静默降级 —— 否则会构建出一个缺少修复的安装包。
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const {
  fail,
  resolveUpstream,
  gitHead,
  gitDescribe,
  gitDirtyFiles,
  listPatches,
  resolvePatches,
  applyPatches,
  revertPatches,
  comparePatches,
  isPatchApplied,
  readLock,
  writeLock,
} = require('./upstream');

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const tag = readArg('--tag');
const commit = readArg('--commit');
const branch = readArg('--branch');
const checkOnly = args.includes('--check');
const skipFetch = args.includes('--no-fetch');
const withoutPatches = args.includes('--without-patches');

const upstream = resolveUpstream();
console.log(`[upstream-sync] 上游仓库：${upstream}`);

const git = (gitArgs, options = {}) =>
  execFileSync('git', ['-C', upstream, ...gitArgs], {
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });

const lock = readLock();
const lockedCommit = lock.upstream && lock.upstream.commit;
const recordedPatches = resolvePatches(lock.patches || []);
const diskPatches = listPatches();
const head = gitHead(upstream);
const describe = gitDescribe(upstream);

if (checkOnly) {
  if (!lockedCommit) {
    fail('upstream.lock.json 里没有记录上游 commit，请先执行 npm run upstream:sync');
  }
  if (lockedCommit !== head) {
    fail(
      `上游已漂移：当前 ${head.slice(0, 7)}（${describe}），` +
        `锁文件记录 ${lockedCommit.slice(0, 7)}。执行 npm run upstream:sync 对齐。`
    );
  }

  const issues = comparePatches(diskPatches, recordedPatches);
  if (issues.length > 0) {
    fail(
      `补丁与锁文件不一致：\n${issues.map((issue) => `  - ${issue}`).join('\n')}\n` +
        '执行 npm run upstream:sync 应用并记录。'
    );
  }

  const missing = recordedPatches.filter((patch) => !isPatchApplied(upstream, patch.file));
  if (missing.length > 0) {
    fail(
      `以下补丁未应用到上游工作区：\n${missing
        .map((patch) => `  - ${patch.name}`)
        .join('\n')}\n执行 npm run upstream:sync 应用。`
    );
  }

  console.log(
    `[upstream-sync] 一致：${describe}（${head.slice(0, 7)}），补丁 ${recordedPatches.length} 个`
  );
  process.exit(0);
}

// 1) 先把上次的补丁回滚掉。上游工作区必须是干净的，否则 checkout 会被挡住，
//    脏检查也会把"补丁造成的改动"误判成手工修改。
if (recordedPatches.length > 0) {
  try {
    revertPatches(upstream, recordedPatches);
  } catch (error) {
    fail(error.message);
  }
  // 回滚完必须回到干净状态；仍有改动说明补丁文件被改过、或上游被手工动过。
  // 只看已跟踪文件：未跟踪文件（构建残留等）不影响补丁状态。
  const leftover = gitDirtyFiles(upstream).filter((line) => !line.startsWith('??'));
  if (leftover.length > 0) {
    console.error('[upstream-sync] 回滚补丁后上游仍有未提交改动：');
    for (const line of leftover.slice(0, 10)) console.error(`  ${line}`);
    fail('请在上游目录执行 git checkout -- . 恢复到干净状态后重试。');
  }
}

// 2) 回滚后仍然脏 = 有人直接改过上游，此时不允许切换版本
if (tag || commit || branch) {
  const dirty = gitDirtyFiles(upstream);
  if (dirty.length > 0) {
    console.error('[upstream-sync] 上游工作区有未提交改动：');
    for (const line of dirty.slice(0, 10)) console.error(`  ${line}`);
    fail('上游仓库必须是干净的（本项目的设计前提是"从不修改上游"）。');
  }

  if (!skipFetch) {
    console.log('[upstream-sync] git fetch --tags …');
    try {
      git(['fetch', '--tags', '--prune', 'origin']);
    } catch {
      console.warn('[upstream-sync] fetch 失败，尝试使用本地已有的引用');
    }
  }

  const target = tag || commit || branch;
  console.log(`[upstream-sync] checkout ${target}`);
  try {
    git(['checkout', target]);
  } catch {
    fail(`切换到 ${target} 失败，请确认该引用存在`);
  }
}

const nextHead = gitHead(upstream);
const nextDescribe = gitDescribe(upstream);

if (!nextHead) {
  fail('无法读取上游 HEAD，确认它是一个 git 仓库');
}

// 3) 应用 patches/ 下的全部补丁（按文件名排序）。任一份失败即中止，
//    此时上游可能处于"部分补丁已应用"的状态，重新执行本脚本会先回滚再重试。
let appliedPatches = [];
if (withoutPatches) {
  if (diskPatches.length > 0) {
    console.warn('[upstream-sync] --without-patches：跳过补丁，上游保持原样');
  }
} else if (diskPatches.length > 0) {
  try {
    applyPatches(upstream, diskPatches);
  } catch (error) {
    fail(error.message);
  }
  appliedPatches = diskPatches.map(({ name, sha256 }) => ({ name, sha256 }));
}

const previous = lockedCommit ? lockedCommit.slice(0, 7) : '（未记录）';
writeLock({
  upstream: {
    repo: lock.upstream && lock.upstream.repo,
    commit: nextHead,
    describe: nextDescribe,
    syncedAt: new Date().toISOString(),
  },
  patches: appliedPatches,
});

console.log(
  `[upstream-sync] ${previous} → ${nextHead.slice(0, 7)}（${nextDescribe}），` +
    `补丁 ${appliedPatches.length} 个`
);

// 上游依赖清单变化时提醒重装，避免用旧 node_modules 构建出诡异产物
const lockfile = `${upstream}/package-lock.json`;
if (fs.existsSync(lockfile)) {
  const changed = (() => {
    try {
      return execFileSync('git', ['-C', upstream, 'diff', '--name-only', `${previous}..${nextHead}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  })();
  if (changed.includes('package-lock.json')) {
    console.log('[upstream-sync] 上游依赖有变化，建议执行：(cd 上游目录 && npm ci)');
  }
}

console.log('\n[upstream-sync] 下一步：');
console.log('  npm run build:renderer   # 重新构建渲染层');
console.log('  npm run verify:renderer  # 校验适配层');
console.log('  npm run smoke            # 启动冒烟（需已安装 electron）');
