/**
 * /main — Mac + projector + wide-angle USB camera (v3 Live Darkroom Engine)
 * - 100% live optical photogram synthesis: zero pre-recorded video files, zero fake film borders/sprockets.
 * - ENTER_BUFFER: deep safelight red + large countdown
 * - SAFELIGHT_COMPOSE: pure #9A0A0A safelight + corner SAFELIGHT · COMPOSE + remaining sec
 * - EXPOSURE: bright warm enlarger beam #F6F2E8 + 1 Hz mechanical timer + 18 FPS dual-buffer sampling
 * - DEVELOPING: chemical bath sound + live developing print driven by server devProgress
 * - FIXED_REVEAL: crisp shutter + 120ms gentle flash, silence, frozen frame, clean borderless JPEG upload + last 4s EXIT NORTH ↑
 */
import { Net, mountNetDot } from '../lib/net';
import {
  audioCtx,
  devBathAudio,
  enlargerTimer,
  relayClick,
  safelightClick,
  setAudioSink,
  shutter,
  stopAllLoops,
  unlockAudio,
} from '../lib/sfx';
import {
  DarkroomEngine,
  drawExposureBeam,
  drawIdleDarkroom,
  drawSafelightField,
  setupCanvas,
} from '../lib/darkroom';
import { keepAwake, requestFullscreen, withTimeout } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { Phase, PrintMode } from '../../../shared/protocol';

const LS_CAM = 'ruhua.main.camera';
const LS_SINK = 'ruhua.main.sink';
const SAMPLE_INTERVAL_MS = 55; // ~18 FPS live exposure sampling

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

export default async function mainPage(app: HTMLElement): Promise<void> {
  document.title = `Enlarger Projector · ${TITLE_EN}`;
  app.innerHTML = `
    <canvas class="layer" id="fx"></canvas>
    <div class="main-countdown hidden" id="countdownBox"><span id="countdown">5</span></div>
    <div class="main-corner hidden" id="safelightHud">SAFELIGHT · COMPOSE · <span id="safelightSec">5</span>S</div>
    <div class="main-corner hidden" id="revealHud"></div>
    <div class="main-exit" id="exitSign">EXIT NORTH ↑</div>
    <div class="flash" id="flash"></div>
    <video id="cam" class="hidden" muted playsinline autoplay></video>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const fx = $<HTMLCanvasElement>('#fx');
  const g = setupCanvas(fx);
  const countdownBox = $<HTMLDivElement>('#countdownBox');
  const countdown = $<HTMLSpanElement>('#countdown');
  const safelightHud = $<HTMLDivElement>('#safelightHud');
  const safelightSecEl = $<HTMLSpanElement>('#safelightSec');
  const revealHud = $<HTMLDivElement>('#revealHud');
  const exitSign = $<HTMLDivElement>('#exitSign');
  const flashEl = $<HTMLDivElement>('#flash');
  const camV = $<HTMLVideoElement>('#cam');

  const engine = new DarkroomEngine();
  const net = new Net('main');
  (window as any).__net = net;
  mountNetDot(net);

  // ====================================================================
  // camera & audio sink
  // ====================================================================
  let camStream: MediaStream | null = null;
  let camId = localStorage.getItem(LS_CAM) || '';
  let sinkId = localStorage.getItem(LS_SINK) || '';

  async function openCamera(deviceId: string): Promise<MediaStream | null> {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      camV.srcObject = camStream;
      await camV.play().catch(() => {});
    } catch (err) {
      console.warn('camera failed to open', err);
      camStream = null;
    }
    return camStream;
  }

  function camLive(): boolean {
    return !!camStream && camStream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  async function ensureCamera(): Promise<void> {
    if (!camLive()) await openCamera(camId);
  }

  // ====================================================================
  // gentle flash
  // ====================================================================
  function flash(ms = 120, peakOpacity = 0.45): void {
    flashEl.style.opacity = String(peakOpacity);
    flashEl.classList.add('on');
    window.setTimeout(() => {
      flashEl.classList.remove('on');
      flashEl.style.opacity = '';
    }, ms);
  }
  net.on('flash', () => {
    shutter();
    flash(150, 0.85);
  });

  // ====================================================================
  // exposure sampler & developing state
  // ====================================================================
  let sampleTimer: number | null = null;
  let liveDevProgress = 0;
  let frozenDevProgress = 0;
  let activePrintMode: PrintMode = 'photogram_negative';
  let freezeUploadedRound = -1;

  function stopSampler(): void {
    if (sampleTimer !== null) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
  }

  function startSampler(): void {
    stopSampler();
    engine.beginExposure();
    const sampleOnce = () => {
      if (net.phase !== 'EXPOSURE') return stopSampler();
      const totalSec = net.config?.exposureSec ?? 15;
      const elapsedSec = net.storySec();
      engine.sampleExposureFrame(camLive() ? camV : null, elapsedSec, totalSec);
    };
    sampleOnce();
    sampleTimer = window.setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
  }

  net.on('dev', (m) => {
    liveDevProgress = m.devProgress;
    if (net.phase === 'DEVELOPING') {
      devBathAudio.update(liveDevProgress);
    }
  });

  // ====================================================================
  // phase changes
  // ====================================================================
  let curPhase: Phase | null = null;
  let curRound = -1;

  function hideOverlays(): void {
    countdownBox.classList.add('hidden');
    safelightHud.classList.add('hidden');
    revealHud.classList.add('hidden');
    exitSign.classList.remove('show');
  }

  async function onPhase(phase: Phase, fresh: boolean): Promise<void> {
    const st = net.state!;
    const roundId = st.round.id;
    activePrintMode = st.round.printMode ?? net.config?.printMode ?? 'photogram_negative';
    hideOverlays();
    stopSampler();

    switch (phase) {
      case 'IDLE':
        stopAllLoops();
        break;

      case 'ENTER_BUFFER':
        stopAllLoops();
        liveDevProgress = 0;
        countdownBox.classList.remove('hidden');
        await ensureCamera();
        break;

      case 'SAFELIGHT_COMPOSE':
        stopAllLoops();
        if (fresh) safelightClick();
        safelightHud.classList.remove('hidden');
        await ensureCamera();
        break;

      case 'EXPOSURE':
        stopAllLoops();
        if (fresh) relayClick(true);
        enlargerTimer.start(0.85, 0.1);
        await ensureCamera();
        if (net.phase === 'EXPOSURE') startSampler();
        break;

      case 'DEVELOPING':
        enlargerTimer.stop();
        if (fresh) relayClick(false);
        engine.finalizeLatent();
        liveDevProgress = st.round.devProgress ?? 0;
        devBathAudio.start();
        devBathAudio.update(liveDevProgress);
        break;

      case 'FIXED_REVEAL': {
        stopAllLoops();
        engine.finalizeLatent();
        frozenDevProgress = st.round.finalDevProgress ?? st.round.devProgress ?? liveDevProgress;
        if (fresh) {
          shutter();
          flash(120, 0.45);
        }
        // Render & freeze exact final print and upload clean borderless JPEG
        const jpegData = engine.exportCleanJpeg(frozenDevProgress, activePrintMode);
        if (freezeUploadedRound !== roundId) {
          freezeUploadedRound = roundId;
          net.send({ type: 'freeze', data: jpegData });
        }
        const devPct = Math.round(frozenDevProgress * 100);
        revealHud.textContent = `ROLL ${pad2(st.round.rollNumber)} · FR ${pad2(st.round.frameNumber)}A · DEV ${devPct}% · FIXED`;
        revealHud.classList.remove('hidden');
        break;
      }
    }
  }

  net.on('state', (m) => {
    activePrintMode = m.round.printMode ?? net.config?.printMode ?? activePrintMode;
    const fresh = m.state !== curPhase || m.round.id !== curRound;
    if (!fresh) return;
    curPhase = m.state;
    curRound = m.round.id;
    void onPhase(m.state, true);
  });

  // ====================================================================
  // render loop
  // ====================================================================
  function frame(): void {
    const phase = net.phase;
    switch (phase) {
      case 'IDLE':
        drawIdleDarkroom(g, net.now());
        break;

      case 'ENTER_BUFFER': {
        drawIdleDarkroom(g, net.now());
        const remain = Math.max(1, Math.ceil(net.remainingMs() / 1000 / net.timeScale));
        countdown.textContent = String(remain);
        break;
      }

      case 'SAFELIGHT_COMPOSE': {
        drawSafelightField(g);
        const remain = Math.max(1, Math.ceil(net.remainingMs() / 1000 / net.timeScale));
        safelightSecEl.textContent = String(remain);
        break;
      }

      case 'EXPOSURE':
        drawExposureBeam(g);
        break;

      case 'DEVELOPING':
        engine.renderPrint(g, g.canvas.width, g.canvas.height, liveDevProgress, activePrintMode, 0.93);
        break;

      case 'FIXED_REVEAL': {
        engine.renderPrint(g, g.canvas.width, g.canvas.height, frozenDevProgress, activePrintMode, 1.0);
        const remainStorySec = net.remainingMs() / 1000 / net.timeScale;
        exitSign.classList.toggle('show', remainStorySec <= 4.0);
        break;
      }
    }
    requestAnimationFrame(frame);
  }

  // ====================================================================
  // setup panel (S reopens, F fullscreen)
  // ====================================================================
  await setupPanel();
  net.connect();
  requestAnimationFrame(frame);

  window.addEventListener('keydown', (e) => {
    if (e.key === 's' || e.key === 'S') void setupPanel();
    if (e.key === 'f' || e.key === 'F') void requestFullscreen();
  });

  function setupPanel(): Promise<void> {
    return new Promise((resolve) => {
      document.querySelector('.setup')?.remove();
      const el = document.createElement('div');
      el.className = 'setup';
      el.innerHTML = `
        <div class="ticket">
          <div class="head">
            <h2><small>RH-30 · LIVE ENLARGER · /main</small>Main projector setup</h2>
            <span class="mono">S = SETUP · F = FULLSCREEN</span>
          </div>
          <div class="fields">
            <label><span class="no">01 / CAMERA</span>External USB wide-angle camera<select id="camSel"></select></label>
            <label><span class="no">02 / AUDIO OUT</span>Audio output device<select id="sinkSel"></select></label>
            <div class="hint" id="camHint">Camera stream stays strictly local for live photogram accumulation.</div>
          </div>
          <div class="fields">
            <div class="pv"><video id="pv" muted playsinline autoplay></video><span class="mono">LIVE CAMERA PREVIEW</span></div>
            <div class="row">
              <button id="refresh" type="button">Refresh devices</button>
              <button class="primary" id="go" type="button">UNLOCK &amp; GO FULLSCREEN</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(el);
      const camSel = el.querySelector('#camSel') as HTMLSelectElement;
      const sinkSel = el.querySelector('#sinkSel') as HTMLSelectElement;
      const pv = el.querySelector('#pv') as HTMLVideoElement;
      const hint = el.querySelector('#camHint') as HTMLDivElement;

      async function fill(): Promise<void> {
        try {
          let devs = await navigator.mediaDevices.enumerateDevices();
          if (!devs.some((d) => d.kind === 'videoinput' && d.label)) {
            const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
            tmp?.getTracks().forEach((t) => t.stop());
            devs = await navigator.mediaDevices.enumerateDevices();
          }
          const cams = devs.filter((d) => d.kind === 'videoinput');
          camSel.innerHTML = '';
          cams.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || `Camera ${i + 1}`;
            camSel.appendChild(o);
          });
          if (!cams.length) camSel.innerHTML = '<option value="">(no camera detected — procedural simulation active)</option>';
          const saved = cams.find((d) => d.deviceId === camId);
          const external = cams.find((d) => !/facetime|built-?in|integrated|\u5185\u5efa/i.test(d.label));
          camSel.value = (saved || external || cams[0])?.deviceId || '';

          const sinks = devs.filter((d) => d.kind === 'audiooutput');
          sinkSel.innerHTML = '';
          const canSink = typeof (audioCtx() as any).setSinkId === 'function' || 'setSinkId' in HTMLMediaElement.prototype;
          if (!canSink || !sinks.length) {
            sinkSel.innerHTML = '<option value="">System default output</option>';
          } else {
            sinks.forEach((d, i) => {
              const o = document.createElement('option');
              o.value = d.deviceId;
              o.textContent = d.label || `Output ${i + 1}`;
              sinkSel.appendChild(o);
            });
            if (sinks.some((d) => d.deviceId === sinkId)) sinkSel.value = sinkId;
          }
          await preview();
        } catch (err) {
          hint.textContent = `Device enumeration failed: ${(err as Error).message} (HTTPS required)`;
        }
      }

      async function preview(): Promise<void> {
        camId = camSel.value;
        const s = await openCamera(camId);
        pv.srcObject = s;
        pv.play().catch(() => {});
      }

      camSel.addEventListener('change', () => void preview());
      (el.querySelector('#refresh') as HTMLButtonElement).addEventListener('click', () => void fill());
      (el.querySelector('#go') as HTMLButtonElement).addEventListener('click', async () => {
        const fsP = requestFullscreen();
        const auP = unlockAudio();
        void keepAwake();
        camId = camSel.value;
        sinkId = sinkSel.value;
        localStorage.setItem(LS_CAM, camId);
        localStorage.setItem(LS_SINK, sinkId);
        await Promise.allSettled([withTimeout(fsP), withTimeout(auP)]);
        if (sinkId) await withTimeout(setAudioSink(sinkId));
        if (!camLive()) await withTimeout(openCamera(camId), 1500);
        pv.srcObject = null;
        el.remove();
        resolve();
      });
      void fill();
    });
  }
}
