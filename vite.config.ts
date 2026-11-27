import { defineConfig } from 'vite';

// Built assets go in /static so they do not collide with the server /assets path.
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
