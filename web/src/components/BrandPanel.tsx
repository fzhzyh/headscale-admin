/**
 * 登录页品牌区：纯 CSS/SVG 绘制的网络拓扑装饰。
 * 不引入图片资源，保持首屏轻量。
 */
export default function BrandPanel(): React.ReactElement {
  return (
    <div className="relative hidden w-[46%] max-w-[620px] overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 lg:flex xl:w-[52%]">
      {/* 网格底纹 */}
      <div
        className="absolute inset-0 opacity-[0.14]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.55) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.55) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />
      {/* 光晕 */}
      <div className="absolute -right-24 -top-24 h-[420px] w-[420px] rounded-full bg-brand-400/25 blur-3xl" />
      <div className="absolute -bottom-32 -left-20 h-[380px] w-[380px] rounded-full bg-brand-300/20 blur-3xl" />

      {/* 拓扑装饰：节点 + 连线 */}
      <svg viewBox="0 0 520 520" className="absolute inset-0 h-full w-full opacity-[0.55]" aria-hidden>
        <defs>
          <linearGradient id="ln" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#bfdbfe" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#93c5fd" stopOpacity="0.25" />
          </linearGradient>
        </defs>
        <g stroke="url(#ln)" strokeWidth="1.2" fill="none">
          <path d="M118 372 L190 286" />
          <path d="M190 286 L318 214" />
          <path d="M318 214 L412 146" />
          <path d="M318 214 L246 384" />
          <path d="M190 286 L142 176" />
          <path d="M142 176 L318 214" />
          <path d="M246 384 L106 448" />
          <path d="M412 146 L462 262" />
          <path d="M462 262 L246 384" />
        </g>
        <g fill="#e0f2fe">
          {[
            [118, 372, 5],
            [190, 286, 8],
            [318, 214, 11],
            [412, 146, 5],
            [246, 384, 6],
            [142, 176, 4.5],
            [106, 448, 4],
            [462, 262, 5.5],
          ].map(([cx, cy, r], i) => (
            <g key={i}>
              <circle cx={cx} cy={cy} r={r} opacity="0.95" />
              <circle cx={cx} cy={cy} r={Number(r) + 6} opacity="0.16" />
            </g>
          ))}
        </g>
      </svg>

      {/* 文案 */}
      <div className="relative z-10 flex flex-col justify-between p-12 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-[15px] font-bold backdrop-blur-sm">
            HS
          </div>
          <div className="text-[15px] font-semibold tracking-wide">headscale-admin</div>
        </div>

        <div className="max-w-[400px]">
          <h2 className="mb-4 text-[30px] font-semibold leading-[1.25] tracking-tight">
            一个入口
            <br />
            管好整张网络
          </h2>
          <p className="text-[13.5px] leading-relaxed text-brand-100">
            设备与路由、ACL 策略、DNS 记录、访问审计、内置 OIDC 认证——应用、系统、网络三层统一运维。
          </p>

          <div className="mt-8 grid grid-cols-2 gap-4 text-[12.5px]">
            {[
              ['设备 / 路由', '在线状态 · 子网路由审批'],
              ['ACL 策略', '可视化编辑 · 版本回溯'],
              ['监控统计', '在线时长 · 状态曲线'],
              ['统一认证', 'RBAC · 2FA · OIDC'],
            ].map(([t, d]) => (
              <div key={t} className="rounded-lg border border-white/15 bg-white/[0.07] px-3 py-2.5 backdrop-blur-sm">
                <div className="font-medium text-white">{t}</div>
                <div className="mt-0.5 text-brand-200">{d}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="text-[11.5px] text-brand-200/80">
          兼容 Headscale v0.29.x · 最低 Tailscale 客户端 v1.80.0
        </div>
      </div>
    </div>
  );
}
