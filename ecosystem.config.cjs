/**
 * PM2 裸机部署（不使用 Docker 时）
 *   npm ci && npm run build
 *   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
 * 注意：状态机在内存中，必须单实例（fork 模式，instances: 1）。
 */
module.exports = {
  apps: [
    {
      name: 'ruhua30s',
      script: 'build/server/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      kill_timeout: 4000,
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3000,
        TZ: 'America/Toronto',
        ASSETS_DIR: './assets',
        DATA_DIR: './data',
        TIME_SCALE: 1,
        // ADMIN_TOKEN: 'change-me',
      },
    },
  ],
};
