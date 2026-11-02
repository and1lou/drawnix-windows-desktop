#!/usr/bin/env node
/**
 * 切换上游 Drawnix 版本，并把版本写进 upstream.lock.json。
 *
 *   npm run upstream:sync -- --tag v0.4.2      # 切到某个 tag
 *   npm run upstream:sync -- --commit abc1234  # 切到某个 commit
 *   npm run upstream:sync -- --branch master   # 跟随分支（不推荐用于发布）
 *   npm run upstream:sync -- --check           # 只检查是否与锁文件一致
 *
 * 上游是独立仓库（submodule 或 upstream.config.json 指定的目录），这里只做
 * checkout，不改它的任何文件。
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const {
  fail,
  resolveUpstream,
  gitHead,
  gitDescribe,
  gitDirtyFiles,
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

const upstream = resolveUpstream();
console.log(`[upstream-sync] 上游仓库：${upstream}`);

const git = (gitArgs, options = {}) =>
  execFileSync('git', ['-C', upstream, ...gitArgs], {
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });

const lock = readLock();
const lockedCommit = lock.upstream && lock.upstream.commit;
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
  console.log(`[upstream-sync] 一致：${describe}（${head.slice(0, 7)}）`);
  process.exit(0);
}

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

const previous = lockedCommit ? lockedCommit.slice(0, 7) : '（未记录）';
writeLock({
  upstream: {
    repo: lock.upstream && lock.upstream.repo,
    commit: nextHead,
    describe: nextDescribe,
    syncedAt: new Date().toISOString(),
  },
});

console.log(`[upstream-sync] ${previous} → ${nextHead.slice(0, 7)}（${nextDescribe}）`);

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
