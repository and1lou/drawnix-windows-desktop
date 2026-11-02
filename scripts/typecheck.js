#!/usr/bin/env node
/**
 * 只对 desktop/ 适配层做类型检查。
 *
 * 为什么不直接 `tsc -p desktop/tsconfig.json`：
 * 桌面层引用上游源码，tsc 会连带检查整个上游（上游自己用 esbuild 构建、不做类型
 * 检查，因此存在一批 scss 声明与 CSS 自定义属性相关的既有报错）。这里只把落在
 * desktop/ 目录下的诊断视为失败，上游既有问题忽略。
 *
 * 为什么不直接用 desktop/tsconfig.json 里的 paths：
 * 上游位置可能是 upstream.config.json 指定的目录，也可能是 upstream/drawnix，
 * tsconfig 里只能写死一种相对路径，换布局就整片 "Cannot find module 'react'"。
 * 因此运行时按 resolveUpstream() 的真实结果生成一份临时 tsconfig（paths 解析成
 * 相对仓库根的路径），两种布局都能检查。desktop/tsconfig.json 只负责给编辑器用。
 *
 *   npm run typecheck
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { REPO_ROOT, resolveUpstream, fail } = require('./upstream');

const upstream = resolveUpstream();
const tsc = path.join(upstream, 'node_modules', 'typescript', 'bin', 'tsc');
const TSCONFIG = path.join(REPO_ROOT, 'desktop', 'tsconfig.json');
const CACHE_DIR = path.join(REPO_ROOT, '.cache');
const GENERATED = path.join(CACHE_DIR, 'tsconfig.desktop.generated.json');

/** tsconfig 里 paths 的语义，指向哪里由上游实际位置决定 */
const PATH_TARGETS = {
  '@drawnix/drawnix': (u) => path.join(u, 'packages', 'drawnix', 'src', 'index.ts'),
  '@plait-board/react-board': (u) => path.join(u, 'packages', 'react-board', 'src', 'index.ts'),
  '@plait-board/react-text': (u) => path.join(u, 'packages', 'react-text', 'src', 'index.ts'),
  '@plait/core': (u) => path.join(u, 'node_modules', '@plait', 'core', 'types', 'plait-core.d.ts'),
  react: (u) => path.join(u, 'node_modules', '@types', 'react', 'index.d.ts'),
  'react/jsx-runtime': (u) => path.join(u, 'node_modules', '@types', 'react', 'jsx-runtime.d.ts'),
  'react-dom/client': (u) => path.join(u, 'node_modules', '@types', 'react-dom', 'client.d.ts'),
  localforage: (u) => path.join(u, 'node_modules', 'localforage', 'typings', 'localforage.d.ts'),
  'browser-fs-access': () => path.join(REPO_ROOT, 'desktop', 'shims', 'fs-desktop.ts'),
};

/** tsc 在 Windows 上两种分隔符都能吃，统一成正斜杠便于阅读与跨平台 */
const toPosix = (value) => value.split(path.sep).join('/');

function generateTsconfig() {
  const base = JSON.parse(fs.readFileSync(TSCONFIG, 'utf8'));
  const paths = {};
  for (const [name, target] of Object.entries(PATH_TARGETS)) {
    const absolute = target(upstream);
    if (!fs.existsSync(absolute)) {
      fail(
        `类型检查所需的文件不存在：${absolute}\n` +
          `（${name}）上游依赖可能没装全，先执行：cd "${upstream}" && npm ci`
      );
    }
    // 临时配置放在 .cache/ 下，baseUrl 用 ".." 指回仓库根；
    // paths 的值是相对 baseUrl（仓库根）解析的，不能再加 "../"
    paths[name] = [toPosix(path.relative(REPO_ROOT, absolute))];
  }

  const generated = {
    ...base,
    compilerOptions: {
      ...(base.compilerOptions || {}),
      baseUrl: '..',
      paths,
    },
    include: ['../desktop/entry/**/*', '../desktop/shims/**/*'],
  };

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(GENERATED, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
}

generateTsconfig();

const result = spawnSync(
  process.execPath,
  [tsc, '-p', GENERATED, '--noEmit', '--pretty', 'false'],
  { cwd: REPO_ROOT, encoding: 'utf8' }
);

fs.rmSync(GENERATED, { force: true });

if (result.error) {
  fail(`无法运行 tsc：${result.error.message}`);
}

const lines = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const ours = lines.filter((line) => line.startsWith('desktop/') || line.startsWith('desktop\\'));
const upstreamIssues = lines.filter((line) => line.startsWith('..'));

if (ours.length > 0) {
  for (const line of ours) console.error(`[typecheck] ${line}`);
  fail(`desktop/ 适配层存在 ${ours.length} 处类型错误`);
}

console.log('[typecheck] desktop/ 适配层类型检查通过');
if (upstreamIssues.length > 0) {
  console.log(`[typecheck] 已忽略上游既有诊断 ${upstreamIssues.length} 条`);
}
