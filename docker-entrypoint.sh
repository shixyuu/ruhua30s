#!/bin/sh
# 宿主机挂载的 ./data ./assets 可能属于 root：启动时修正权限，然后降权为 node 用户运行
set -e
mkdir -p "$DATA_DIR/archive" "$ASSETS_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
