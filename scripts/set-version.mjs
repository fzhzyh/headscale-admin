#!/usr/bin/env node
/**
 * 把版本号从 git tag 同步到三个 package.json。
 *
 * ## 为什么需要这个脚本
 * 版本号原先散在三处（server/src 里硬编码 + 三个 package.json），
 * 发版时最容易漏改代码里那份，导致「设置页显示 0.1.0，实际发布 v1.0.0」。
 * 现在唯一真源是 **git tag**，其它全部派生：
 *
 *     git tag v1.0.0  →  set-version.mjs  →  package.json × 3
 *                                          →  构建进镜像 → 运行期读取
 *
 * ## 用法
 *   node scripts/set-version.mjs              # 从当前 HEAD 的 tag 取版本
 *   node scripts/set-version.mjs 1.2.3        # 显式指定
 *   node scripts/set-version.mjs --check      # 只检查是否一致（CI 用，不写文件）
 *
 * 退出码：0 一致/已写入；1 不一致（--check 模式）；2 无法确定版本。
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['package.json', 'server/package.json', 'web/package.json'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicit = args.find((a) => /^\d+\.\d+\.\d+/.test(a));

/** 从 git 取版本：优先 HEAD 精确 tag，退而取最近 tag + 距离 */
function versionFromGit() {
  const sh = (cmd) => {
    try {
      return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };

  // 1) HEAD 正好打了 tag
  const exact = sh('git describe --tags --exact-match');
  if (exact) return { version: exact.replace(/^v/, ''), source: `git tag ${exact}` };

  // 2) 最近 tag + 提交距离（开发态版本，不用于正式发布）
  const near = sh('git describe --tags --long');
  if (near) {
    const m = near.match(/^v?(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/);
    if (m) {
      return {
        version: `${m[1]}-dev.${m[2]}+${m[3]}`,
        source: `git describe ${near}（开发态，非正式版本）`,
      };
    }
  }

  // 3) 无 tag
  return { version: null, source: '仓库没有任何 tag' };
}

function readVersion(file) {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), 'utf8')).version;
  } catch {
    return null;
  }
}

function writeVersion(file, version) {
  const path = join(ROOT, file);
  const raw = readFileSync(path, 'utf8');
  // 只替换顶层 version 字段，保持文件格式不变（不用 JSON.stringify 重排）
  const next = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (next === raw && readVersion(file) !== version) {
    throw new Error(`${file} 里没找到可替换的 version 字段`);
  }
  writeFileSync(path, next);
}

// ---------------------------------------------------------------- main
let target;
let source;
if (explicit) {
  target = explicit;
  source = '命令行指定';
} else {
  const g = versionFromGit();
  target = g.version;
  source = g.source;
}

if (!target) {
  console.error(`✗ 无法确定版本：${source}`);
  console.error('  ⇒ 先打 tag：git tag v1.0.0 && git push origin v1.0.0');
  console.error('  ⇒ 或显式指定：node scripts/set-version.mjs 1.0.0');
  process.exit(2);
}

console.log(`版本来源：${source}`);
console.log(`目标版本：${target}`);

const current = FILES.map((f) => ({ file: f, version: readVersion(f) }));
const mismatched = current.filter((c) => c.version !== target);

if (checkOnly) {
  console.log('\n当前各文件版本：');
  for (const c of current) {
    const ok = c.version === target;
    console.log(`  ${ok ? '✓' : '✗'} ${c.file.padEnd(20)} ${c.version ?? '(读取失败)'}`);
  }
  if (mismatched.length > 0) {
    console.error(`\n✗ ${mismatched.length} 个文件的版本与 ${target} 不一致`);
    console.error('  ⇒ 运行 node scripts/set-version.mjs 同步');
    process.exit(1);
  }
  console.log('\n✓ 全部一致');
  process.exit(0);
}

for (const c of current) {
  if (c.version === target) {
    console.log(`  = ${c.file} 已是 ${target}`);
  } else {
    writeVersion(c.file, target);
    console.log(`  ✓ ${c.file} ${c.version ?? '?'} → ${target}`);
  }
}
console.log('\n✓ 版本已同步');
