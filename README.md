# 《入画三十秒》交互式时间循环装置 · VPS 生产版

单端口 Node.js 20+（TypeScript + Express + ws）服务，同时托管 Vite 前端、`/assets` 实拍视频、`/data` 持久化数据与 `/ws` 实时通信。零数据库、零外部依赖，`docker compose up -d --build` 一键上线并自动 HTTPS。

> **v1.1 变更**：`/door` 改为纯展示端（不需要麦克风、无拍手检测）；状态机**只能由 `/admin` 的 “PRESS SHUTTER · ENTER THE FRAME” 按钮（或空格键）启动**。
>
> **v1.2 变更**：全部界面改为英文（`<html lang="en">`，标题 *Thirty Seconds Into the Frame*），中文项目名“入画三十秒”仅作为小号印章式标志（`client/src/lib/brand.ts`）。视觉改为胶片冲印室风格。

---

## 目录结构

```
ruhua30s/
├── server/
│   ├── index.ts            # Express + ws 单端口服务、全局状态机（唯一真相源）
│   └── storage.ts          # ./data 持久化：config.json / latest-door.jpg / archive/
├── shared/
│   └── protocol.ts         # 前后端共享协议、阶段时长、剧情节点
├── client/
│   ├── index.html
│   └── src/
│       ├── main.ts         # 路由 + 全局防误触
│       ├── style.css
│       ├── lib/
│       │   ├── net.ts      # WebSocket：指数退避重连 + NTP 式时钟同步
│       │   ├── sfx.ts      # Web Audio 实时合成：快门/心跳/来电/警报/倒带
│       │   ├── media.ts    # MIME 检测、黑白胶片滤镜、默认暗房底片、素材探测
│       │   ├── film.ts     # Canvas：待机噪点/模拟底片/程序化倒卷
│       │   └── unlock.ts   # 启动遮罩：AudioContext/全屏/WakeLock(静音 audio 兜底)
│       └── pages/
│           ├── main.ts     # /main     Mac + 投影 + 外接摄像头
│           ├── door.ts     # /door     入口暗房屏（纯展示）
│           ├── station1.ts # /station1 西南侧联络终端
│           ├── station2.ts # /station2 西北侧紧急断路器
│           ├── admin.ts    # /admin    中控台
│           └── home.ts     # /         入口导航
├── scripts/ws-flow-test.mjs  # 无浏览器全流程联调测试
├── assets/                 # ← 放 base.mp4 / rewind.mp4（挂载目录）
├── data/                   # ← latest-door.jpg / config.json / archive/（挂载目录）
├── Dockerfile  docker-entrypoint.sh  docker-compose.yml  Caddyfile
├── .env.example  ecosystem.config.cjs
└── package.json  tsconfig*.json  vite.config.ts
```

## 页面与设备

| 路由 | 设备 | 需要的权限 |
| --- | --- | --- |
| `/main` | Mac + 投影仪 + 外接 USB 广角摄像头 | 摄像头（录像只存本地，**绝不上传**） |
| `/door` | 平板 1：入口暗房屏（纯展示） | 无（CCTV 阶段可选前置摄像头，拒绝也不影响） |
| `/station1` | 平板 2：西南侧联络终端 | 麦克风 |
| `/station2` | 平板 3：西北侧紧急断路器 | 无 |
| `/admin` | Chromebook / 手机中控台 | 无 |

每台平板首次打开会出现 “TAP TO START” 遮罩（135 胶卷暗盒标签样式）：一次性解锁音频、权限、全屏与防熄屏。`/main` 是配置面板：选择**外接摄像头**与**音频输出设备**后点击 “Unlock audio/video & go fullscreen”（运行中按 `S` 重新打开面板，`F` 全屏）。

## 一轮流程（服务端状态机）

`IDLE` →（admin 按快门）→ `ENTER_BUFFER` 4s（可在 admin 调 2~8s）→ `ACTIVE_30S` 30s → `FLASH_FREEZE` 2.5s → `REWIND` 3s → `REPLAY_TRUTH` 30s → `CCTV_REVEAL` 6s → `IDLE`

- 服务端每次切换广播 `{ state, phaseStartedAt, phaseDurationMs, serverTime, round }`，各端用 NTP 式往返测量（取最小 RTT 样本）校准时钟，同步误差通常 < 30ms。
- 拉闸防剧透：`t < 28.5s` 拉下 → 锁定 “FORCING POWER CUT...” 并震动，29.5s 才全局闪白；`t ≥ 28.5s` 拉下或到 30s → 立即闪白。
- 旁观者结局：`didSpeak === false && didPullBreaker === false` 时，回放最后 4 秒显示白字 “You kept to the rules and did not become the killer. But you also watched it end.”。
- `/door` 在 `ACTIVE_30S ~ REPLAY_TRUTH` 期间只显示调暗的底片与 “DARKROOM IN USE · SHOOTING IN PROGRESS · PLEASE WAIT”，不会发白光。

## 中控台 `/admin`

- 顶部巨大按钮 **PRESS SHUTTER · ENTER THE FRAME**：仅 `IDLE` 时可用，1.5s 防连击。**键盘空格键**同样触发（输入框聚焦时忽略、阻止页面滚动、忽略长按连发）。
- **EMERGENCY STOP · RESET TO IDLE**：3 秒内再点一次（“PRESS AGAIN TO CONFIRM STOP”）才生效（防误触）。
- RESET ENTRANCE PHOTO（重置入口照片为默认底片）、TEST MAIN FLASH（测试主屏闪白）、ENTRY BUFFER 入场缓冲（2~8 秒，写入 `data/config.json`）。
- 四端在线指示灯 + 最后心跳时间、当前阶段 + 毫秒秒表、本轮 `didSpeak / didPullBreaker / audioOffsetMs`、最新定格照、今日归档（`/api/archive`）。
- 可选口令：`.env` 设置 `ADMIN_TOKEN=xxx` 后访问 `https://域名/admin?token=xxx`（会记在浏览器里），非管理员连接无法开始/急停，归档照片也需要口令。

---

## 本地开发

```bash
npm install
npm run dev          # 后端 :3000（tsx watch）+ Vite :5173（自动代理 /ws /api /assets /data）
# 浏览器打开 http://localhost:5173/admin 、/main 、/door ...
```

- 生产构建：`npm run build`（前端 → `build/public`，后端 → `build/server`），然后 `npm start` 打开 http://localhost:3000 。
- 快速联调：`TIME_SCALE=0.1 npm start`（所有阶段 10 倍速），另开终端 `npm run test:flow` 跑完整三轮无浏览器测试（含“非 admin 的 START_SESSION 被拒绝”）。生产环境务必 `TIME_SCALE=1`。
- **注意**：摄像头 / 麦克风只在 HTTPS 或 `localhost` 下可用。局域网平板直连 `http://192.168.x.x` 会被浏览器拒绝授权，请用 VPS + Caddy 的 HTTPS 域名联调。

## VPS 一键上线（Docker + Caddy 自动 HTTPS）

1. **DNS**：把 `art.yourdomain.com` 的 A 记录指向 VPS 公网 IP（如走 Cloudflare，先用“仅 DNS / 灰云”让 Caddy 申请证书）。
2. **安装 Docker**（Ubuntu/Debian）：
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **上传代码并配置**：
   ```bash
   scp ruhua30s.zip root@VPS_IP:/opt/ && ssh root@VPS_IP
   cd /opt && unzip ruhua30s.zip -d ruhua30s && cd ruhua30s
   cp .env.example .env && nano .env      # 填 DOMAIN=art.yourdomain.com（可选 ADMIN_TOKEN、TZ）
   ```
4. **防火墙放行 80/443**（Let's Encrypt 需要 80 端口验证）：
   ```bash
   sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
   sudo ufw status            # 确认 80、443 为 ALLOW
   sudo ss -tlnp | grep -E ':80|:443'   # 确认没有其他程序（nginx/apache）占用
   ```
   云厂商（阿里云/腾讯云/AWS/GCP 等）还需在**控制台安全组**放行 TCP 80、443。
5. **启动**：
   ```bash
   docker compose up -d --build
   docker compose logs -f caddy      # 看到 certificate obtained successfully 即证书就绪
   curl https://art.yourdomain.com/api/health
   ```
6. 在各设备打开：`https://art.yourdomain.com/main`、`/door`、`/station1`、`/station2`、`/admin`。

更新代码：重新上传后 `docker compose up -d --build`。查看日志：`docker compose logs -f app`。

## 替换实拍视频（热更新，无需重建镜像）

宿主机目录 `/opt/ruhua30s/assets/` 已挂载到容器 `/app/assets/`：

```bash
# 在 Mac 上执行
scp ./base.mp4   root@VPS_IP:/opt/ruhua30s/assets/base.mp4
scp ./rewind.mp4 root@VPS_IP:/opt/ruhua30s/assets/rewind.mp4
```

- `base.mp4`：30 秒原始底片（建议 H.264 + AAC，1080p，`ffmpeg -i in.mov -c:v libx264 -crf 20 -preset slow -c:a aac -movflags +faststart base.mp4`）。
- `rewind.mp4`：3 秒倒带画面。
- 服务端以 `ETag + Cache-Control: no-cache` 提供，`/main` 每次回到 IDLE 会重新探测，**下一轮自动使用新文件**。缺失时自动降级为 Canvas 模拟底片（标出 06s / 15s / 28s 节点）与程序化倒卷画面，全部音效由 Web Audio 实时合成。
- 建议覆盖时先传成临时名再改名，避免播放中读到半个文件：`scp base.mp4 root@VPS_IP:/opt/ruhua30s/assets/base.tmp && ssh root@VPS_IP mv /opt/ruhua30s/assets/base.tmp /opt/ruhua30s/assets/base.mp4`。

## 导出观众照片与数据

```
/opt/ruhua30s/data/
├── latest-door.jpg            # 入口屏当前显示的最新定格照
├── config.json                # { "enterBufferSec": 4 }
└── archive/20261120-213140-111-r1.jpg   # 每位观众的定格照：日期-时间-毫秒-轮次
```

```bash
scp -r root@VPS_IP:/opt/ruhua30s/data/archive ./ruhua-archive     # 在 Mac 上导出全部
curl "https://art.yourdomain.com/api/archive"            # 今日列表（?date=20261120 指定日期，?all=1 全部）
```

## 不用 Docker：Node + PM2 裸机部署

```bash
# Node.js 20+
npm ci && npm run build
npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

服务监听 `0.0.0.0:3000`。浏览器调用摄像头/麦克风必须 HTTPS，请在宿主机装 Caddy 并使用：

```
art.yourdomain.com {
	reverse_proxy 127.0.0.1:3000
}
```

（Nginx 需配置 `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 120s;`。）状态机在内存中，**只能单实例运行**。

## 视觉与字体

整体采用胶片冲印室 / 暗房风格：安全灯红 `#b3241b`、纤维相纸米白、牛皮纸冲洗袋、片基琥珀色；
135 暗盒标签式启动页、冲洗袋/工单式表单（打字机字段 + 橡皮图章）、带齿孔/片边印字/DX 条码/帧号的胶片条、
接触印相与底片袋式归档（红色油性笔圈选）、DEV / STOP / FIX 药液计时器、套准十字裁切标记。
片边印字全部为虚构品牌（RUHUA SAFETY FILM / RH 3030），不使用任何真实商标。

所有界面文字为英文。主要文案对照：

| 位置 | 英文文案 |
| --- | --- |
| /door 待机字幕 | NODE TIME 00:30 · AN ANOMALOUS SHADOW COLLAPSED THE FRAME |
| /door ENTER_BUFFER | LIFT THE CURTAIN · STEP INTO THE PHOTOGRAPH |
| /door 拍摄中 | DARKROOM IN USE · SHOOTING IN PROGRESS · PLEASE WAIT |
| /station1 A 段 | ANOMALY DETECTED! HOLD THE BUTTON BELOW AND SHOUT TO STOP HIM — NOW! |
| /station1 B 段 | WARNING: OVEREXPOSURE IS BURNING THE NEGATIVE! RUN TO THE CENTRE OF THE ROOM AND SPREAD YOUR ARMS TO BLOCK THE BEAM ON THE WALL! |
| /station2 C 段 | NO TIME LEFT! RUN OVER AND PULL THE MAIN BREAKER DOWN — CUT THE TIMELINE! |
| /station2 锁定 | FORCING POWER CUT... |
| /main CCTV | New node negative synced to the entrance / Entrance live feed · next visitor / ENTRANCE FEED · NO SIGNAL / Please exit to the north |
| /admin 快门 | PRESS SHUTTER · ENTER THE FRAME |

字体全部自托管于 `client/src/fonts/`（子集化 woff2，合计约 93KB，`font-display: swap`，不引用 Google Fonts CDN）：

| 用途 | 字体 | 许可 |
| --- | --- | --- |
| 标识 / 大标题（超窄粗体） | Archivo（可变字体实例化 wdth 62/75） | SIL OFL 1.1 |
| 正文 | Archivo（wdth 100） | SIL OFL 1.1 |
| 工单打字机字段 | Courier Prime | SIL OFL 1.1 |
| 时间码 / 片边印字 | IBM Plex Mono | SIL OFL 1.1 |
| 编辑式斜体字幕 | Instrument Serif | SIL OFL 1.1 |
| 油性笔批注 | Permanent Marker | Apache 2.0 |
| “入画三十秒”印章标志（仅 5 个字） | ZCOOL XiaoWei | SIL OFL 1.1 |

重新生成字体子集：

```bash
pip install fonttools brotli
FONT_SRC=/path/to/ttf目录 python3 scripts/subset-fonts.py   # 所需文件见脚本头部注释
```

## 测试脚本

| 脚本 | 用途 |
| --- | --- |
| `node scripts/ws-flow-test.mjs` | 无浏览器全流程联调（`BASE=`） |
| `node scripts/edge-tests.mjs` | 边界：双中控、拉闸边界、录音窗口、15MB 负载、心跳（`SKIP_HEARTBEAT=1` 跳过 40s 心跳项） |
| `node scripts/browser-smoke.mjs` | 无头 Chrome：多视口、整轮截图、断线重连、迟到加入、摄像头拒绝、素材替换（`BASE= OUT= MATRIX=full|lite SUITES=`，需 devDependency puppeteer-core 与本机 Chrome） |

建议服务端以 `TIME_SCALE=0.2~0.5` 运行测试，测试后恢复 `TIME_SCALE=1`。

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/health` | `{ ok: true, state, clients: {main,door,station1,station2,admin}, ... }` |
| `GET /api/archive` | 今日归档列表（`?date=YYYYMMDD` / `?all=1`；设置 ADMIN_TOKEN 时需 `?token=`） |
| `GET /assets/*` | 挂载的实拍视频（支持 Range） |
| `GET /data/*` | 持久化目录（latest-door.jpg、config.json、archive/） |
| `WS /ws` | 实时通信，`maxPayload` 15MB，服务端每 20s Ping，未回 Pong 的连接被终止 |

## 展厅注意事项

- **iPad**：iPadOS Safari 支持网页全屏；**iPhone 不支持网页全屏 API**，请用“分享 → 添加到主屏幕”以全屏 Web App 打开。建议同时开启“引导式访问”并把“自动锁定”设为“永不”。不支持 WakeLock 的旧 iPad 会自动使用静音循环音频兜底。
- `/station1` 在 iOS 上打开麦克风后，系统可能降低扬声器音量（通话模式），铃声偏小时请调高平板音量。
- `/door` 前置摄像头是可选的：第一次进入 CCTV 阶段时可能弹出授权框，可在 Safari“网站设置 → 相机 → 允许”以免重复询问；拒绝时 `/main` 右侧显示 “ENTRANCE FEED · NO SIGNAL”。
- `/main` 推荐 Chrome（支持选择音频输出设备 `setSinkId`）。首次需授予摄像头权限，配置会记在浏览器中。
- 所有页面已禁用双击缩放、长按选中、下拉刷新（`/admin` 保留纵向滚动）。
