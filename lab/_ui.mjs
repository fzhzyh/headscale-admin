/**
 * 前端测试共享工具
 *
 * 抽出来的原因：四个 .mjs 脚本各自复制了一遍「读 endpoints.env + 填表登录」，
 * 而**登录失败时的表现极难诊断**——脚本继续往下跑，然后在一堆 DOM 断言上
 * 依次超时，最后报「等待 .ant-tabs-tab 超时」，完全看不出真正原因是登录没成。
 * 实测踩过：登录接口有 20 次/5 分钟的总尝试限流，多个套件连跑就撞 429。
 *
 * 这里统一处理：
 *   · 读 container/endpoints.env + container/lab.env
 *   · 登录并在失败时区分「口令错」「被限流 429」「其他」
 *   · 失败直接抛出带原因的错误，让编排器一眼看到根因
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读 endpoints.env + lab.env（后者只补缺失的键） */
export function loadEndpoints() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ep = { PANEL_URL: 'http://100.64.0.3:8080' };

  const read = (path, target) => {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      if (!(k in target)) target[k] = t.slice(i + 1).trim();
    }
  };

  for (const base of [join(here, '..'), here, process.cwd()]) {
    const f = join(base, 'container', 'endpoints.env');
    if (existsSync(f)) {
      read(f, ep);
      const labEnv = join(base, 'container', 'lab.env');
      if (existsSync(labEnv)) read(labEnv, ep);
      break;
    }
  }
  return ep;
}

/**
 * 在页面上完成登录。失败时抛出**可诊断**的错误。
 * @returns {Promise<void>}
 */
export async function loginUI(page, base, user, pass) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('input').first().fill(user);
  await page.locator('input[type=password]').fill(pass);
  await page.locator('button:has-text("登")').click();

  let ok = true;
  await page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {
    ok = false;
  });
  if (ok) {
    await page.waitForLoadState('networkidle').catch(() => {});
    return;
  }

  // 没跳转：直接打一次登录接口，把真实状态码捞出来
  let status = 0;
  let body = '';
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    status = res.status;
    body = (await res.text()).slice(0, 300);
  } catch (e) {
    throw new Error(`登录失败且无法探测接口：${e instanceof Error ? e.message : String(e)}`);
  }

  if (status === 429) {
    const retry = (() => {
      try {
        return JSON.parse(body).retryAfterSec;
      } catch {
        return undefined;
      }
    })();
    throw new Error(
      `登录被限流（HTTP 429）。这是**测试编排**问题，不是产品缺陷：\n` +
        `  登录接口默认 20 次/5 分钟（总尝试数，不只失败次数），多个套件连续登录会撞上。\n` +
        `  当前 retryAfterSec=${retry ?? '未知'}。\n` +
        `  处理：等窗口过去，或确认联调环境已放宽（container/up.sh 里 LOGIN_RATE_MAX）。`,
    );
  }
  if (status === 401) {
    throw new Error(`登录失败：口令错误（HTTP 401）。检查 container/lab.env 的 PANEL_ADMIN_SECRET`);
  }
  throw new Error(`登录未跳转，接口返回 HTTP ${status}：${body}`);
}
