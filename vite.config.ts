import { defineConfig } from 'vite';

// 注意：后端 /assets 路径用于托管实拍视频，所以 Vite 构建产物放在 /static 目录下，避免冲突。
const backend = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  root: 'client',
  publicDir: false,
  build: {
    outDir: '../build/public',
    emptyOutDir: true,
    assetsDir: 'static',
    target: 'es2019',
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
      '/api': backend,
      '/assets': backend,
      '/data': backend,
    },
  },
});
