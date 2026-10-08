/**
 * 二次构建：MV3 的 service worker 与 content script 必须是单文件、无动态导入。
 * Vite 的 HTML 入口不覆盖它们，因此用 esbuild 单独打一遍到 dist 根目录。
 *
 * 顺序：vite build（产出 dist + sidepanel） -> esbuild（产出 background.js / content.js）
 */

import { build } from 'esbuild';
import { rm, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');

const targets = [
  { in: 'src/background/service-worker.ts', out: 'background.js' },
  { in: 'src/content/index.ts', out: 'content.js' },
];

async function runVite() {
  // 直接用当前 node 跑 vite 的 JS 入口，避开 .cmd shim + shell:true。
  // 后者在 Node 20+ 会触发 DEP0190（带 args 且 shell:true 已废弃），
  // 且 Windows 下 .cmd 不经 shell 还会抛 EINVAL，跨平台都不稳。
  const viteJs = resolve(root, 'node_modules/vite/bin/vite.js');
  const res = spawnSync(process.execPath, [viteJs, 'build'], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`vite build 失败，退出码 ${res.status}`);
}

async function runEsbuild() {
  await mkdir(dist, { recursive: true });
  for (const t of targets) {
    await build({
      entryPoints: [resolve(root, t.in)],
      outfile: resolve(dist, t.out),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome114',
      minify: false,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'info',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }
}

async function summary() {
  const files = ['manifest.json', 'background.js', 'content.js', 'src/sidepanel/index.html'];
  const lines = [];
  for (const f of files) {
    const p = resolve(dist, f);
    if (!existsSync(p)) {
      lines.push(`  ✗ ${f}  缺失`);
      continue;
    }
    const s = await stat(p);
    lines.push(`  ✓ ${f}  ${(s.size / 1024).toFixed(1)} KB`);
  }

  // 校验 manifest 里引用的文件确实存在
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  const declared = [
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? []),
    manifest.side_panel?.default_path,
  ].filter(Boolean);
  const missing = declared.filter((f) => !existsSync(resolve(dist, f)));

  return { lines, missing };
}

async function main() {
  const skipVite = process.argv.includes('--skip-vite');
  await rm(dist, { recursive: true, force: true });

  if (!skipVite) {
    console.log('\n[1/2] vite build（sidepanel UI）…\n');
    await runVite();
  }
  console.log('\n[2/2] esbuild（service worker + content script）…\n');
  await runEsbuild();

  const { lines, missing } = await summary();
  console.log('\n构建产物（dist/）：');
  console.log(lines.join('\n'));

  if (missing.length > 0) {
    console.error(`\n✗ manifest 引用了不存在的文件：${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('\n✓ 构建完成。在 chrome://extensions 开启开发者模式，选择「加载已解压的扩展程序」→ 指向 dist 目录。\n');
}

main().catch((err) => {
  console.error('\n构建失败：', err.message);
  process.exit(1);
});
