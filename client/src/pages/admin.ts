/**
 * /admin — mobile-first single-hand operator desk & Instax instant print station (v3)
 * - Top trigger: huge PRESS SHUTTER · START (Space shortcut) + compact SKIP PHASE & 2-tap RESET TO IDLE
 * - Instax Express Print Card: caches latest clean borderless JPEG as File for synchronous navigator.share({ files })
 *   with automatic download fallback
 * - Live Acoustic & Optical Calibration: live mic meter + noiseFloor threshold line, devProgress bar (0–150%,
 *   marking 85–100% golden zone & >100% burn zone), Noise Floor & Develop Speed sliders, Photogram Negative vs Positive toggle
 * - New Roll (2-tap, keeps ./data/archive/ intact), 5 phase duration steppers, device heartbeat lamps & roll archive
 */
import { Net } from '../lib/net';
import type { ContactSheetInfo, PrintMode, Role } from '../../../shared/protocol';
import { CONFIG_BOUNDS } from '../../../shared/protocol';
import { TITLE_EN } from '../lib/brand';
import { triggerDownload } from '../lib/media';
import { escapeHtml } from '../lib/unlock';

const ROLE_LABEL: Record<Exclude<Role, 'admin'>, string> = {
  main: 'Projector',
  door: 'Contact',
  station1: 'Mic Gauge',
  station2: 'Fix Fader',
};

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

export default function admin(app: HTMLElement): void {
  document.title = `Control desk · ${TITLE_EN}`;
  document.body.classList.add('scrollable');
  app.style.position = 'static';

  const params = new URLSearchParams(location.search);
  const qTok = params.get('token');
  if (qTok) localStorage.setItem('ruhua.admin.token', qTok);
  const token = qTok || localStorage.getItem('ruhua.admin.token') || undefined;
  const tq = token ? `token=${encodeURIComponent(token)}` : '';

  app.innerHTML = `
  <div class="admin-v3">
    <header class="desk-top">
      <span class="ttl">RH-30 · LIVE DARKROOM DESK</span>
      <span class="roll-pill" id="topRoll">ROLL 01</span>
      <span class="conn off" id="conn">OFFLINE</span>
    </header>

    <main class="desk-v3">
      <!-- 1. Trigger & Live Phase -->
      <section class="card trigger-card">
        <button class="shutter-v3" id="shutter" type="button" disabled>
          <span class="s-meta"><span id="shutterRoll">ROLL 01 · NEXT FR 01A</span><span class="kbd">SPACE</span></span>
          <span class="s-main">PRESS SHUTTER · START</span>
          <span class="s-hint" id="shutterHint">Connecting…</span>
        </button>

        <div class="phase-strip">
          <div>
            <div class="p-name" id="phase">IDLE</div>
            <div class="p-sub" id="roundMeta">ROUND 000 · STANDBY</div>
          </div>
          <div class="p-time mono" id="phaseClock">0.0 S</div>
        </div>

        <div class="quick-row">
          <button class="btn-act" id="skipPhase" type="button" disabled>SKIP PHASE →</button>
          <button class="btn-act danger" id="reset" type="button">RESET TO IDLE</button>
          <button class="btn-act" id="testFlash" type="button">TEST FLASH</button>
        </div>
      </section>

      <!-- 2. Instax Express Print Card -->
      <section class="card instax-card">
        <div class="card-h">
          <span>INSTAX EXPRESS PRINT</span>
          <span class="mono" id="latestSlug">NO PRINT YET</span>
        </div>
        <div class="instax-pv">
          <img id="latest" alt="Latest archival print" class="hidden" />
          <div class="instax-empty" id="latestNone">No print fixed yet. Trigger a round to capture a clean borderless Instax print.</div>
        </div>
        <button class="btn-instax" id="shareInstax" type="button" disabled>SAVE / SHARE FOR INSTAX</button>
      </section>

      <!-- 3. Live Acoustic & Optical Calibration -->
      <section class="card cal-card">
        <div class="card-h">
          <span>ACOUSTIC &amp; OPTICAL CALIBRATION</span>
          <span class="mono" id="devReadout">DEV 0% · MIC 0%</span>
        </div>

        <div class="meter-row">
          <div class="meter-lbl"><span>MIC ENERGY (/station1)</span><span class="mono" id="micPct">0%</span></div>
          <div class="bar-track">
            <div class="bar-fill mic" id="micBar"></div>
            <div class="thresh-line" id="floorLine" title="Noise Floor"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-lbl"><span>DEVELOP PROGRESS (85–100% GOLDEN · &gt;100% BURN)</span><span class="mono" id="devPct">0%</span></div>
          <div class="bar-track dev-track">
            <div class="zone-gold"></div>
            <div class="zone-burn"></div>
            <div class="bar-fill dev" id="devBar"></div>
          </div>
        </div>

        <div class="sliders">
          <label class="slider-ctl">
            <div class="sl-head"><span>Noise Floor</span><span class="mono" id="floorVal">0.08</span></div>
            <input id="floorRange" type="range" min="${CONFIG_BOUNDS.noiseFloor.min}" max="${CONFIG_BOUNDS.noiseFloor.max}" step="0.01" value="0.08" />
          </label>
          <label class="slider-ctl">
            <div class="sl-head"><span>Develop Speed</span><span class="mono" id="speedVal">0.18</span></div>
            <input id="speedRange" type="range" min="${CONFIG_BOUNDS.devSpeed.min}" max="${CONFIG_BOUNDS.devSpeed.max}" step="0.01" value="0.18" />
          </label>
        </div>

        <div class="mode-toggle" role="group" aria-label="Optical Print Mode">
          <button type="button" id="modeNeg" class="active">PHOTOGRAM NEGATIVE</button>
          <button type="button" id="modePos">POSITIVE PRINT</button>
        </div>
        <button class="btn-act btn-pulse" id="testDev" type="button" disabled>TEST DEVELOP PULSE (SOLO CAL)</button>
      </section>

      <!-- 4. Phase Durations & Roll Management -->
      <section class="card timing-card">
        <div class="card-h">
          <span>PHASE TIMINGS &amp; ROLL</span>
          <button class="btn-mini amber" id="newRoll" type="button">NEW ROLL (CLEAR SHEET)</button>
        </div>
        <div class="steppers">
          ${stepperHtml('enterBufferSec', 'ENTER BUFFER', '2–10s', 5)}
          ${stepperHtml('safelightSec', 'SAFELIGHT', '0–10s', 5)}
          ${stepperHtml('exposureSec', 'EXPOSURE', '8–30s', 15)}
          ${stepperHtml('maxDevelopSec', 'MAX DEVELOP', '15–45s', 25)}
          ${stepperHtml('revealSec', 'REVEAL', '6–25s', 12)}
        </div>
      </section>

      <!-- 5. Device Heartbeats & Current Roll Archive -->
      <section class="card devices-card">
        <div class="card-h">
          <span>TERMINALS</span>
          <span class="mono" id="onlineCount">0 / 4</span>
        </div>
        <div class="lights-v3" id="lights"></div>
      </section>

      <section class="card archive-card">
        <div class="card-h">
          <span id="archTitle">ROLL 01 ARCHIVE</span>
          <span class="mono" id="totalDisk">0 TOTAL</span>
        </div>
        <div class="archive-v3" id="archive"></div>
      </section>
    </main>
  </div>
  <div class="toast" id="toast"></div>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const topRoll = $<HTMLSpanElement>('#topRoll');
  const conn = $<HTMLSpanElement>('#conn');
  const shutterBtn = $<HTMLButtonElement>('#shutter');
  const shutterRoll = $<HTMLSpanElement>('#shutterRoll');
  const shutterHint = $<HTMLSpanElement>('#shutterHint');
  const phaseEl = $<HTMLDivElement>('#phase');
  const roundMeta = $<HTMLDivElement>('#roundMeta');
  const phaseClock = $<HTMLDivElement>('#phaseClock');
  const skipBtn = $<HTMLButtonElement>('#skipPhase');
  const resetBtn = $<HTMLButtonElement>('#reset');
  const testFlashBtn = $<HTMLButtonElement>('#testFlash');
  const latestImg = $<HTMLImageElement>('#latest');
  const latestNone = $<HTMLDivElement>('#latestNone');
  const latestSlug = $<HTMLSpanElement>('#latestSlug');
  const shareBtn = $<HTMLButtonElement>('#shareInstax');
  const devReadout = $<HTMLSpanElement>('#devReadout');
  const micPct = $<HTMLSpanElement>('#micPct');
  const micBar = $<HTMLDivElement>('#micBar');
  const floorLine = $<HTMLDivElement>('#floorLine');
  const devPctEl = $<HTMLSpanElement>('#devPct');
  const devBar = $<HTMLDivElement>('#devBar');
  const floorRange = $<HTMLInputElement>('#floorRange');
  const floorVal = $<HTMLSpanElement>('#floorVal');
  const speedRange = $<HTMLInputElement>('#speedRange');
  const speedVal = $<HTMLSpanElement>('#speedVal');
  const modeNegBtn = $<HTMLButtonElement>('#modeNeg');
  const modePosBtn = $<HTMLButtonElement>('#modePos');
  const testDevBtn = $<HTMLButtonElement>('#testDev');
  const newRollBtn = $<HTMLButtonElement>('#newRoll');
  const lights = $<HTMLDivElement>('#lights');
  const onlineCount = $<HTMLSpanElement>('#onlineCount');
  const archTitle = $<HTMLSpanElement>('#archTitle');
  const totalDisk = $<HTMLSpanElement>('#totalDisk');
  const archive = $<HTMLDivElement>('#archive');
  const toastEl = document.getElementById('toast')!;

  const net = new Net('admin', token);
  (window as any).__net = net;

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2400);
  };

  // ---------------- shutter + keyboard Space ----------------
  let lastShutter = 0;
  function fireShutter(): void {
    if (net.phase !== 'IDLE' || !net.connected) return;
    const now = Date.now();
    if (now - lastShutter < 1500) return;
    lastShutter = now;
    shutterBtn.disabled = true;
    navigator.vibrate?.(30);
    net.send({ type: 'START_SESSION', token });
  }
  shutterBtn.addEventListener('click', fireShutter);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    if (e.repeat) return;
    fireShutter();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') e.preventDefault();
  });

  skipBtn.addEventListener('click', () => {
    if (net.phase === 'IDLE' || !net.connected) return;
    net.send({ type: 'admin', action: 'skipPhase', token });
  });

  testFlashBtn.addEventListener('click', () => net.send({ type: 'admin', action: 'testFlash', token }));

  // ---------------- two-tap RESET TO IDLE ----------------
  let resetTimer = 0;
  function disarmReset(): void {
    clearTimeout(resetTimer);
    resetBtn.classList.remove('armed');
    resetBtn.textContent = 'RESET TO IDLE';
  }
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.classList.contains('armed')) {
      resetBtn.classList.add('armed');
      resetBtn.textContent = 'CONFIRM RESET?';
      resetTimer = window.setTimeout(disarmReset, 3000);
      return;
    }
    disarmReset();
    net.send({ type: 'admin', action: 'reset', token });
  });

  // ---------------- two-tap NEW ROLL ----------------
  let rollTimer = 0;
  function disarmRoll(): void {
    clearTimeout(rollTimer);
    newRollBtn.classList.remove('armed');
    newRollBtn.textContent = 'NEW ROLL (CLEAR SHEET)';
  }
  newRollBtn.addEventListener('click', () => {
    if (!newRollBtn.classList.contains('armed')) {
      const nextR = (net.config?.rollNumber ?? 1) + 1;
      newRollBtn.classList.add('armed');
      newRollBtn.textContent = `CONFIRM ROLL ${pad2(nextR)}?`;
      rollTimer = window.setTimeout(disarmRoll, 3000);
      return;
    }
    disarmRoll();
    net.send({ type: 'admin', action: 'newRoll', token });
  });

  // ---------------- Instax Share / Download (pre-cached File for synchronous gesture) ----------------
  let cachedUrl = '';
  let cachedFileName = 'RH30-print.jpg';
  let cachedFile: File | null = null;

  async function cacheLatestForInstax(url: string, filename: string): Promise<void> {
    cachedUrl = url;
    cachedFileName = filename;
    cachedFile = null;
    shareBtn.disabled = !url;
    if (!url) return;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      const blob = await resp.blob();
      if (cachedUrl === url) {
        cachedFile = new File([blob], filename, { type: 'image/jpeg' });
      }
    } catch {
      cachedFile = null;
    }
  }

  shareBtn.addEventListener('click', async () => {
    if (!cachedUrl) return;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (cachedFile && typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [cachedFile] }))) {
      try {
        await nav.share({ files: [cachedFile], title: cachedFileName });
        return;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        /* fall back to direct download */
      }
    }
    triggerDownload(cachedUrl, cachedFileName);
    toast(`Downloading ${cachedFileName}`);
  });

  // ---------------- Sliders, Mode Toggle & Phase Steppers ----------------
  let cfgSendTimer = 0;
  function sendConfigPatch(patch: Record<string, unknown>, immediate = false): void {
    clearTimeout(cfgSendTimer);
    const run = () => net.send({ type: 'admin', action: 'setConfig', config: patch as any, token });
    if (immediate) run();
    else cfgSendTimer = window.setTimeout(run, 80);
  }

  floorRange.addEventListener('input', () => {
    const v = Number(floorRange.value);
    floorVal.textContent = v.toFixed(2);
    floorLine.style.left = `${Math.round(v * 100)}%`;
    sendConfigPatch({ noiseFloor: v });
  });
  speedRange.addEventListener('input', () => {
    const v = Number(speedRange.value);
    speedVal.textContent = v.toFixed(2);
    sendConfigPatch({ devSpeed: v });
  });

  function setPrintMode(mode: PrintMode): void {
    modeNegBtn.classList.toggle('active', mode === 'photogram_negative');
    modePosBtn.classList.toggle('active', mode === 'positive_print');
    sendConfigPatch({ printMode: mode }, true);
  }
  modeNegBtn.addEventListener('click', () => setPrintMode('photogram_negative'));
  modePosBtn.addEventListener('click', () => setPrintMode('positive_print'));
  testDevBtn.addEventListener('click', () => {
    if (net.phase === 'DEVELOPING' && net.connected) {
      net.send({ type: 'admin', action: 'testDevelop', token });
    }
  });

  app.querySelectorAll<HTMLButtonElement>('[data-step-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.stepKey as keyof typeof CONFIG_BOUNDS;
      const delta = Number(btn.dataset.stepDelta || 0);
      const cur = Number((net.config as any)?.[key] ?? CONFIG_BOUNDS[key].min);
      const b = CONFIG_BOUNDS[key];
      const next = Math.min(b.max, Math.max(b.min, Math.round(cur + delta)));
      if (next !== cur) sendConfigPatch({ [key]: next }, true);
    });
  });

  net.on('config', (m) => {
    const c = m.config;
    topRoll.textContent = `ROLL ${pad2(c.rollNumber)}`;
    floorRange.value = String(c.noiseFloor);
    floorVal.textContent = c.noiseFloor.toFixed(2);
    floorLine.style.left = `${Math.round(c.noiseFloor * 100)}%`;
    speedRange.value = String(c.devSpeed);
    speedVal.textContent = c.devSpeed.toFixed(2);
    modeNegBtn.classList.toggle('active', c.printMode === 'photogram_negative');
    modePosBtn.classList.toggle('active', c.printMode === 'positive_print');

    for (const key of ['enterBufferSec', 'safelightSec', 'exposureSec', 'maxDevelopSec', 'revealSec'] as const) {
      const el = app.querySelector(`[data-step-val="${key}"]`);
      if (el) el.textContent = String(c[key]);
    }
    renderArchive(net.contactSheet);
  });

  // ---------------- Live mic & dev meters ----------------
  net.on('dev', (m) => {
    const mic = Math.round(Math.max(0, Math.min(1, m.audioLevel)) * 100);
    const dev = Math.round(Math.max(0, m.devProgress) * 100);
    micPct.textContent = `${mic}%`;
    micBar.style.width = `${mic}%`;
    devPctEl.textContent = `${dev}%`;
    devBar.style.width = `${Math.min(100, (dev / 150) * 100)}%`;
    devBar.classList.toggle('gold', dev >= 85 && dev <= 100);
    devBar.classList.toggle('burn', dev > 100);
    devReadout.textContent = `DEV ${dev}% · MIC ${mic}%`;
  });

  // ---------------- Online lamps ----------------
  net.on('clients', (m) => {
    lights.innerHTML = '';
    let on = 0;
    for (const c of m.clients) {
      if (c.role === 'admin') continue;
      if (c.online) on++;
      const d = document.createElement('div');
      d.className = 'light' + (c.online ? ' on' : '');
      d.innerHTML = `<div class="bulb"></div><div class="nm"><span></span><span class="r"></span></div>`;
      (d.querySelector('.nm span') as HTMLElement).textContent = `${ROLE_LABEL[c.role as keyof typeof ROLE_LABEL]}${c.count > 1 ? ` ×${c.count}` : ''}`;
      (d.querySelector('.nm .r') as HTMLElement).textContent = c.online ? 'ON' : 'OFF';
      lights.appendChild(d);
    }
    onlineCount.textContent = `${on} / 4`;
  });

  net.on('ack', (m) => toast(`${m.ok ? '✓' : '✗'} ${m.message || m.what}`));
  net.on('open', () => {
    toast('Connected');
    conn.textContent = 'ONLINE';
    conn.classList.remove('off');
    void loadDiskTotal();
  });
  net.on('close', () => {
    toast('Reconnecting…');
    conn.textContent = 'OFFLINE';
    conn.classList.add('off');
    lights.querySelectorAll('.light').forEach((l) => l.classList.remove('on'));
  });

  // ---------------- Archive & Latest Proof ----------------
  function renderArchive(sheet?: ContactSheetInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? 1;
    const frames = sheet?.frames ?? [];
    archTitle.textContent = `ROLL ${pad2(rollNo)} ARCHIVE (${frames.length})`;
    if (net.phase === 'IDLE') {
      shutterRoll.textContent = `ROLL ${pad2(rollNo)} · NEXT FR ${pad2(frames.length + 1)}A`;
    }

    if (frames.length === 0) {
      archive.innerHTML = `<div class="arch-empty">Roll ${pad2(rollNo)} is empty.</div>`;
      return;
    }

    const latestFrame = frames[frames.length - 1];
    const dlName = `RH30-R${pad2(rollNo)}-${latestFrame.frameNo}.jpg`;
    latestImg.src = latestFrame.url;
    latestImg.classList.remove('hidden');
    latestNone.classList.add('hidden');
    latestSlug.textContent = `R${pad2(rollNo)} · ${latestFrame.frameNo}${latestFrame.devPercent != null ? ` · DEV ${latestFrame.devPercent}%` : ''}`;
    void cacheLatestForInstax(latestFrame.url, dlName);

    const reversed = [...frames].reverse();
    archive.innerHTML = reversed
      .map((f, idx) => {
        const fn = `RH30-R${pad2(rollNo)}-${f.frameNo}.jpg`;
        return `<div class="arch-item${idx === 0 ? ' latest' : ''}">
          <a href="${escapeHtml(f.url)}" download="${escapeHtml(fn)}" title="Download ${escapeHtml(fn)}">
            <img src="${escapeHtml(f.url)}" loading="lazy" alt="${escapeHtml(f.frameNo)}" />
          </a>
          <div class="arch-fn"><span>${escapeHtml(f.frameNo)}</span><span>${f.devPercent != null ? `${f.devPercent}%` : ''}</span></div>
        </div>`;
      })
      .join('');
  }

  net.on('contact-sheet', (m) => {
    renderArchive(m.sheet);
    void loadDiskTotal();
  });

  net.on('door-photo', (m) => {
    if (!m.photo.url && (net.contactSheet?.frames?.length ?? 0) === 0) {
      latestImg.classList.add('hidden');
      latestImg.removeAttribute('src');
      latestNone.classList.remove('hidden');
      latestSlug.textContent = 'NO PRINT YET';
      void cacheLatestForInstax('', 'RH30-print.jpg');
    } else if (m.photo.url && (net.contactSheet?.frames?.length ?? 0) === 0) {
      const rollNo = net.config?.rollNumber ?? 1;
      latestImg.src = m.photo.url;
      latestImg.classList.remove('hidden');
      latestNone.classList.add('hidden');
      latestSlug.textContent = `ROLL ${pad2(rollNo)} · LATEST`;
      void cacheLatestForInstax(m.photo.url, `RH30-R${pad2(rollNo)}-latest.jpg`);
    }
  });

  async function loadDiskTotal(): Promise<void> {
    try {
      const r = await fetch(`/api/archive?all=1${tq ? '&' + tq : ''}`, { cache: 'no-store' });
      const j = await r.json();
      if (j.ok) totalDisk.textContent = `${j.count} TOTAL ON DISK`;
    } catch {
      /* ignore */
    }
  }

  // ---------------- Tick ----------------
  function tick(): void {
    const st = net.state;
    if (st) {
      const p = st.state;
      phaseEl.textContent = p;
      const r = st.round;
      roundMeta.textContent = `ROUND ${String(r.id).padStart(3, '0')} · ROLL ${pad2(r.rollNumber)} · ${pad2(r.frameNumber)}A`;
      if (p !== 'IDLE') shutterRoll.textContent = `ROLL ${pad2(r.rollNumber)} · FR ${pad2(r.frameNumber)}A`;

      const el = net.elapsedMs() / 1000;
      const dur = st.phaseDurationMs / 1000;
      if (dur > 0) {
        const rem = Math.max(0, dur - el);
        phaseClock.textContent = `${rem.toFixed(1)} S LEFT`;
      } else {
        phaseClock.textContent = `${el.toFixed(1)} S`;
      }

      const canStart = p === 'IDLE' && net.connected;
      shutterBtn.disabled = !canStart || Date.now() - lastShutter < 1500;
      shutterHint.textContent = canStart ? 'Standby · tap or press SPACE' : net.connected ? `Running · ${p}` : 'Offline';
      skipBtn.disabled = p === 'IDLE' || !net.connected;
      testDevBtn.disabled = p !== 'DEVELOPING' || !net.connected;
    }
    requestAnimationFrame(tick);
  }

  net.connect();
  renderArchive(null);
  void loadDiskTotal();
  requestAnimationFrame(tick);
}

function stepperHtml(key: string, label: string, rangeTxt: string, defVal: number): string {
  return `<div class="step-row">
    <div class="step-meta"><span>${label}</span><small>${rangeTxt}</small></div>
    <div class="step-ctl">
      <button type="button" data-step-key="${key}" data-step-delta="-1" aria-label="Decrease ${label}">−</button>
      <span class="mono" data-step-val="${key}">${defVal}</span>
      <button type="button" data-step-key="${key}" data-step-delta="1" aria-label="Increase ${label}">+</button>
    </div>
  </div>`;
}
