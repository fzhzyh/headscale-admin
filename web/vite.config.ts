import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 开发时把 API 与 WebSocket 代理到后端，避免跨域与 Cookie 问题
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 生产由后端托管静态资源，关闭 sourcemap 减小体积
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 手动分包：antd / 图表 / 拓扑各自独立，首屏不必加载全部
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          charts: ['recharts'],
          flow: ['@xyflow/react'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
