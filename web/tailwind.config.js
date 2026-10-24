/** Tailwind 配置 —— 与 Ant Design 的职责边界在这里划定。
 *
 *  边界约定：
 *    - Ant Design：复杂交互组件（表格/表单/树/弹窗/日期选择）+ 它自带的 reset
 *    - Tailwind  ：页面骨架、布局、配色、间距、动画、自定义视觉
 *
 *  preflight 必须关闭：Tailwind 的 reset 会重置 button/input 等元素样式，
 *  与 antd v5 的 CSS-in-JS 样式打架（典型症状是 antd 按钮失去背景色）。
 *  antd 自带完整 reset，我们只需要 utilities。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    // 关闭 reset，避免与 antd 冲突
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // 主色调：科技蓝。与 antd token 的 colorPrimary 保持同源
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
        },
        // 中性色（控制台底色）
        ink: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
        // 状态色
        ok: '#10b981',
        warn: '#f59e0b',
        danger: '#ef4444',
        idle: '#94a3b8',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['SF Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-hover': '0 4px 12px -2px rgb(37 99 235 / 0.12), 0 2px 6px -2px rgb(15 23 42 / 0.08)',
        glow: '0 0 0 3px rgb(59 130 246 / 0.12)',
      },
      keyframes: {
        // 微交互：卡片浮起、状态点脉冲、内容淡入
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.85)', opacity: '0.7' },
          '70%': { transform: 'scale(1.6)', opacity: '0' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
        'fade-in': 'fade-in 0.2s ease-out',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in-right': 'slide-in-right 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
      },
      transitionTimingFunction: {
        // 统一缓动，让全站动效手感一致
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
