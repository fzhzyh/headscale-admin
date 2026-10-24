/**
 * AI 辅助生成 ACL 规则。
 *
 * 设计取舍：
 *   1. **不用大模型自由发挥生成 JSON**——那会产出语法正确但语义荒谬的策略
 *      （比如把生产库暴露给全网的 `*:*`）。这里走「模型出结构化意图 → 面板
 *      用确定性代码拼策略」的路线：模型只负责把自然语言翻译成一个受约束的
 *      意图对象（源、目的、端口、协议），拼装与校验全部由本地代码完成。
 *   2. **生成结果一律经过本地校验**才返回，前端填进编辑器后还要再走一次
 *      上游校验。"生成"绝不等于"生效"。
 *   3. 未配置模型服务时返回明确的 501 与配置指引，而不是静默失败或伪造结果。
 *
 * 模型调用走 OpenAI 兼容的 /chat/completions（大多数自建与云服务都兼容），
 * 配置项在「系统设置」的 ai.* 分组。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { parsePolicy } from '../acl/model.ts';
import { validatePolicy } from '../acl/validate.ts';

/** 模型应返回的受约束意图结构 */
const IntentSchema = z.object({
  rules: z
    .array(
      z.object({
        /** 源：user@ / group:x / tag:x / autogroup:* / CIDR / host 名 */
        src: z.array(z.string()).min(1),
        /** 目的别名（不含端口） */
        dst: z.array(z.string()).min(1),
        /** 端口表达式：443 / 8000-8100 / 80,443 / * */
        ports: z.string().min(1),
        proto: z.string().optional(),
      }),
    )
    .min(1),
  /** 需要顺带声明的分组（可选） */
  groups: z.record(z.string(), z.array(z.string())).optional(),
  /** 需要顺带声明的主机（可选） */
  hosts: z.record(z.string(), z.string()).optional(),
  /** 需要顺带声明的标签归属（可选） */
  tagOwners: z.record(z.string(), z.array(z.string())).optional(),
  explanation: z.string().optional(),
});

type Intent = z.infer<typeof IntentSchema>;

const SYSTEM_PROMPT = `你是 Headscale（Tailscale 自建控制面）ACL 策略助手。把用户的自然语言访问需求翻译成结构化意图。

严格要求：
1. 只输出一个 JSON 对象，不要 markdown 代码块，不要解释文字。
2. JSON 结构：
   {"rules":[{"src":["..."],"dst":["..."],"ports":"443","proto":"tcp"}],
    "groups":{"group:name":["user@"]},
    "hosts":{"name":"CIDR"},
    "tagOwners":{"tag:name":["user@"]},
    "explanation":"一句话中文说明"}
3. 源与目的只能使用这些形式：*、user@（用户名后跟@）、group:名称、tag:名称、
   autogroup:member、autogroup:tagged、autogroup:self（仅目的）、
   autogroup:internet（仅目的）、CIDR（如 10.0.0.0/8）、hosts 中定义过的名称。
4. 目的**不能带端口**，端口统一写在 ports 字段。
5. proto 只能是 tcp/udp/icmp/icmpv6/sctp 或省略（默认 tcp）；绝不能用 *。
6. 注意：已打标签的设备会脱离用户归属，user@ 规则不会命中它们，必须用 tag: 或 autogroup:tagged。
7. 如果用户描述里出现未定义的分组或主机名，请在 groups / hosts 中一并补上定义。
8. 绝不生成 src 或 dst 为 "*" 且 ports 为 "*" 的规则，除非用户明确要求「全部放行」。
9. explanation 用简体中文，说明你做了什么以及有什么风险。`;

/** 调用 OpenAI 兼容的 chat completions 接口 */
async function callModel(prompt: string): Promise<{ text: string; model: string }> {
  const baseUrl = (getSetting('ai.baseUrl') ?? '').replace(/\/+$/, '');
  const apiKey = getSetting('ai.apiKey') ?? '';
  const model = getSetting('ai.model') ?? '';

  if (!baseUrl || !model) {
    const err = new Error('未配置模型服务') as Error & { code?: string; hint?: string };
    err.code = 'AI_NOT_CONFIGURED';
    err.hint = '请在「系统设置 → AI 辅助」中填写 OpenAI 兼容的 Base URL、API Key 与模型名。';
    throw err;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`模型服务返回 ${res.status}：${body.slice(0, 300)}`) as Error & { code?: string };
    err.code = 'AI_UPSTREAM_ERROR';
    throw err;
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) {
    const err = new Error('模型返回了空内容') as Error & { code?: string };
    err.code = 'AI_EMPTY_RESPONSE';
    throw err;
  }
  return { text, model };
}

/** 从模型输出里稳妥地取出 JSON（容忍 ```json 包裹等常见噪声） */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // 兜底：截取第一个 { 到最后一个 }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('模型输出不是合法 JSON');
  }
}

/** 把意图对象拼装成完整的策略对象（确定性代码，不让模型直接写策略） */
function intentToPolicy(intent: Intent, base: Record<string, unknown>): Record<string, unknown> {
  const policy: Record<string, unknown> = { ...base };

  if (intent.groups && Object.keys(intent.groups).length) {
    policy.groups = { ...((policy.groups as Record<string, string[]>) ?? {}), ...intent.groups };
  }
  if (intent.hosts && Object.keys(intent.hosts).length) {
    policy.hosts = { ...((policy.hosts as Record<string, string>) ?? {}), ...intent.hosts };
  }
  if (intent.tagOwners && Object.keys(intent.tagOwners).length) {
    policy.tagOwners = { ...((policy.tagOwners as Record<string, string[]>) ?? {}), ...intent.tagOwners };
  }

  const rules = intent.rules.map((r) => ({
    action: 'accept' as const,
    proto: r.proto && r.proto !== '*' ? r.proto : 'tcp',
    src: r.src,
    // dst 统一拼成 别名:端口
    dst: r.dst.map((d) => `${d}:${r.ports}`),
  }));

  // acls 键的存在与否 = 全局语义，这里显式累加到已有规则之后
  const existing = (policy.acls as unknown[]) ?? [];
  policy.acls = [...existing, ...rules];
  return policy;
}

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 返回默认策略骨架，供「从零生成」使用。
   * 注意不带 acls 键 —— 让模型产出的规则成为第一批规则，
   * 而不是在已有规则上叠加导致语义混淆。
   */
  app.post('/api/acl/ai-draft', { preHandler: requirePermission('acl:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z
      .object({
        prompt: z.string().min(4, '请把需求描述得更具体一些').max(2000),
        /** 当前草稿内容：用于保留用户已有的 hosts/groups/tagOwners 等声明 */
        currentContent: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    let raw: { text: string; model: string };
    try {
      raw = await callModel(parsed.data.prompt);
    } catch (err) {
      const e = err as Error & { code?: string; hint?: string };
      const code = e.code ?? 'AI_FAILED';
      audit({
        userId: ctx.user.id,
        username: ctx.user.username,
        ip: req.ip,
        action: 'acl.aiDraft',
        result: 'error',
        detail: { code, message: e.message, prompt: parsed.data.prompt },
      });
      const httpStatus = code === 'AI_NOT_CONFIGURED' ? 501 : 502;
      return reply.code(httpStatus).send({
        error: code,
        message: e.message,
        ...(e.hint ? { hint: e.hint } : {}),
      });
    }

    // ---- 解析模型输出 ----
    let intentRaw: unknown;
    try {
      intentRaw = extractJson(raw.text);
    } catch {
      return reply.code(502).send({
        error: 'AI_BAD_OUTPUT',
        message: '模型没有返回可解析的 JSON，请换个说法重试或降低需求复杂度',
        raw: raw.text.slice(0, 800),
      });
    }

    const intentParsed = IntentSchema.safeParse(intentRaw);
    if (!intentParsed.success) {
      return reply.code(502).send({
        error: 'AI_INTENT_INVALID',
        message: `模型输出的意图结构不符合预期：${intentParsed.error.issues[0]?.message ?? ''}`,
        raw: intentRaw,
      });
    }

    // ---- 拼装策略：保留用户草稿里已有的非 acls 声明 ----
    let base: Record<string, unknown> = {};
    if (parsed.data.currentContent?.trim()) {
      const p = parsePolicy(parsed.data.currentContent);
      if (p.ok) {
        base = { ...(p.policy as unknown as Record<string, unknown>) };
        // 生成结果是「新增规则」，但要先看用户是否想整体替换
        delete base.acls;
      }
    }

    const policyObj = intentToPolicy(intentParsed.data, base);
    const content = JSON.stringify(policyObj, null, 2);

    // ---- 生成结果必须过本地校验，不给用户埋雷 ----
    const reparse = parsePolicy(content);
    let validation: { ok: boolean; issues: unknown[] } = { ok: false, issues: [] };
    if (reparse.ok) {
      const v = validatePolicy(reparse.policy, content);
      validation = { ok: v.ok, issues: v.issues };
    } else {
      validation = { ok: false, issues: [{ severity: 'error', path: '(根)', message: reparse.error }] };
    }

    const errorCount = (validation.issues as { severity: string }[]).filter((i) => i.severity === 'error').length;

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'acl.aiDraft',
      result: validation.ok ? 'ok' : 'error',
      detail: {
        model: raw.model,
        prompt: parsed.data.prompt,
        ruleCount: intentParsed.data.rules.length,
        validationErrors: errorCount,
      },
    });

    // 自身校验未通过时明确标注，前端会提示用户修正后再应用
    const explanation = [
      intentParsed.data.explanation ?? '已按描述生成规则。',
      validation.ok ? '生成内容已通过本地校验。' : `注意：生成内容有 ${errorCount} 处校验错误，请修正后再应用。`,
    ].join(' ');

    return reply.send({
      content,
      explanation,
      model: raw.model,
      validation,
      intent: intentParsed.data,
    });
  });

  /** 探测模型服务连通性（系统设置页用） */
  app.post('/api/acl/ai-test', { preHandler: requirePermission('settings:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    try {
      await callModel('只回复：ok');
      return reply.send({ ok: true, message: '模型服务连通正常' });
    } catch (err) {
      const e = err as Error & { code?: string; hint?: string };
      return reply.send({
        ok: false,
        message: e.message,
        ...(e.hint ? { hint: e.hint } : {}),
        error: e.code ?? 'AI_FAILED',
      });
    }
  });
}
