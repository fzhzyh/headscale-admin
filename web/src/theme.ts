import type { ThemeConfig } from 'antd';

/** Ant Design 主题令牌 —— 与 tailwind.config.js 的 brand 色板同源，保证两套体系视觉统一 */
export const BRAND = {
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
};

export const antdTheme: ThemeConfig = {
  token: {
    // 主色：科技蓝
    colorPrimary: BRAND[600],
    colorInfo: BRAND[600],
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',

    // 圆角与我们的卡片保持一致（12px）
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,

    // 字体与正文色
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif",
    fontSize: 14,
    colorText: '#1e293b',
    colorTextSecondary: '#475569',
    colorTextTertiary: '#64748b',
    colorBorder: '#e2e8f0',
    colorBorderSecondary: '#f1f5f9',

    // 控件高度略紧凑，控制台信息密度更高
    controlHeight: 34,
    controlHeightLG: 40,
    controlHeightSM: 28,

    // 去掉 antd 默认的强阴影，改用我们的 card 阴影
    boxShadow: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
    boxShadowSecondary: '0 4px 12px -2px rgb(37 99 235 / 0.12)',
  },
  components: {
    Layout: {
      headerBg: 'rgba(255, 255, 255, 0.85)',
      siderBg: '#ffffff',
      bodyBg: 'transparent',
      headerHeight: 56,
      headerPadding: '0 20px',
    },
    Menu: {
      itemSelectedBg: BRAND[50],
      itemSelectedColor: BRAND[700],
      itemHoverBg: BRAND[50],
      itemBorderRadius: 8,
      itemHeight: 40,
      itemMarginInline: 8,
      iconSize: 16,
    },
    Table: {
      headerBg: '#f8fafc',
      headerColor: '#475569',
      headerSplitColor: 'transparent',
      rowHoverBg: BRAND[50],
      borderColor: '#f1f5f9',
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
    },
    Card: {
      paddingLG: 20,
    },
    Statistic: {
      contentFontSize: 26,
      titleFontSize: 13,
    },
    Tag: {
      defaultBg: '#f1f5f9',
      defaultColor: '#475569',
    },
    Descriptions: {
      labelBg: '#f8fafc',
      titleMarginBottom: 12,
    },
    Modal: {
      borderRadiusLG: 12,
    },
    Button: {
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Tabs: {
      horizontalItemGutter: 22,
    },
  },
};
