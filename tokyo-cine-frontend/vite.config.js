import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 模块：Vite 开发服务器配置
// 职责：为前端开发环境提供 React + Tailwind 支持，并将 /api 请求代理到 Go 后端，避免 CORS 问题。
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      // 将前端发起的 /api/* 请求转发到 http://localhost:8080
      // 这样前端代码只需使用相对路径 /api/...，同时不会触发浏览器的跨域限制。
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})