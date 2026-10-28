/**
 * 版本号单一真源。
 *
 * ## 为什么不再硬编码
 * 原先 `PANEL_VERSION = '0.1.0'` 写死在 system.ts 里，而 package.json 另有
 * 一份版本、git tag 又是第三份。发版时最容易忘改代码里那份，于是
 * 「设置页显示 0.1.0，实际发布 v1.0.0」——这种不一致排查起来很费时，
 * 且会让运维无法确认线上跑的是哪个版本。
 *
 * ## 现在的链路
 *   git tag vX.Y.Z  →  scripts/set-version.mjs  →  三个 package.json
 *                                                  ↓
 *                                          这里读取 package.json
 *
 * 构建时 package.json 被 COPY 进镜像，所以运行期读到的是构建那一刻的版本，
 * 与 tag 一致。Dockerfile 里也注入了 `PANEL_VERSION` 环境变量做兜底
 * （镜像可能被重新打包、package.json 被替换）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 兜底版本：package.json 读不到时用它，绝不返回 undefined */
const FALLBACK = '0.0.0-dev';

function readPackageVersion(): string | null {
  // dist/version.js 与 src/version.ts 都在 server/ 下，向上两级是仓库根
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'package.json'), // 容器内 /app/package.json
    join(here, '..', 'package.json'), // server/package.json
    join(here, '..', '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      // 只认根包的版本（name 为 headscale-admin），避免误读子包
      if (pkg.version && (pkg.name === 'headscale-admin' || pkg.name === '@headscale-admin/server')) {
        return pkg.version;
      }
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

export const PANEL_VERSION: string =
  process.env.PANEL_VERSION?.trim() || readPackageVersion() || FALLBACK;

/** 面板面向的 Headscale 版本（与面板版本解耦，升级 headscale 时才改） */
export const TARGET_HEADSCALE = 'v0.29.x';
