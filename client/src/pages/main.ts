/**
 * /main — Mac + projector + wide-angle USB camera (v3.2 Color Darkroom & Physical Dodging Engine)
 * - CALIBRATING: pure high-contrast TL/TR/BR/BL target inside easelMargin (no camera echo)
 * - CAPTURE_CLEAN (0.8s): shadow-lifted color photo + 4-frame warped camClean baseline
 * - OBSERVE (8s): safelight red monochrome projection + `01 OBSERVE` timeline
 * - EXPOSE (30s): shadow-lifted color photo + 7 FPS homography dodge integration (or Mouse Dodge Simulator)
 * - DEVELOP (25s): RA-4 subtractive color darkroom developing model driven by /station1 acoustic energy
 * - REVEAL (12s): side-by-side ORIGINAL vs ALTERED PRINT + clean Instax color JPEG upload
 */
import { Net, mountNetDot, triggerFlashPulse } from '../lib/net';
import {
  audioCtx,
  devBathAudio,
  enlargerTimer,
  lightLeakBurst,
  relayClick,
  safelightClick,
  setAudioSink,
  shutter,
  stopAllLoops,
  stopBathThud,
  unlockAudio,
} from '../lib/sfx';
import {
  DarkroomEngine,
  computeEaselRect,
  drawCalibrationTarget,
  drawIdleDarkroom,
  setupCanvas,
} from '../lib/darkroom';
import { keepAwake, requestFullscreen, withTimeout } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { outcomeFullLabel } from '../../../shared/protocol';
import type { Phase } from '../../../shared/protocol';

const LS_CAM = 'ruhua.main.camera';
const LS_SINK = 'ruhua.main.sink';
const EXPOSE_SAMPLE_MS = 140; // ~7 FPS camera dodge integration
const CLEAN_SAMPLE_MS = 150;

export default async function mainPage(app: HTMLElement): Promise<void> {
  document.title = `Enlarger Projector · ${TITLE_EN}`;
  app.innerHTML = `
    <canvas class="layer" id="fx"></canvas>
    <footer class="main-timeline hidden" id="timelineBar" aria-hidden="true">
      <div class="tl-steps">
        <div class="tl-seg" id="segObserve"><span>01 OBSERVE</span><div class="tl-fill"></div></div>
        <div class="tl-seg" id="segExpose"><span>02 EXPOSE</span><div class="tl-fill" id="expFill"></div></div>
        <div class="tl-seg" id="segDevelop"><span>03 DEVELOP</span><div class="tl-fill" id="devFill"></div></div>
        <div class="tl-seg" id="segFixed"><span>04 FIXED</span><div class="tl-fill"></div></div>
      </div>
      <div class="tl-prompt" id="tlPrompt">FIND WHAT YOU WANT TO SOFTEN OR ERASE</div>
    </footer>
    <video id="cam" class="hidden" muted playsinline autoplay></video>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const fx = $<HTMLCanvasElement>('#fx');
  const g = setupCanvas(fx);
  const timelineBar = $<HTMLElement>('#timelineBar');
  const segObserve = $<HTMLDivElement>('#segObserve');
  const segExpose = $<HTMLDivElement>('#segExpose');
  const segDevelop = $<HTMLDivElement>('#segDevelop');
  const segFixed = $<HTMLDivElement>('#segFixed');
  const expFill = $<HTMLDivElement>('#expFill');
  const devFill = $<HTMLDivElement>('#devFill');
  const tlPrompt = $<HTMLDivElement>('#tlPrompt');
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
          width: { ideal: 1280 },
          height: { ideal: 720 },
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

  // Remote calibration snapshot request from /admin
  net.on('REQUEST_SNAPSHOT', async () => {
    await ensureCamera();
    const margin = net.config?.easelMargin ?? 6;
    const imageData = engine.grabCameraSnapshot(camLive() ? camV : null, margin);
    net.send({ type: 'SNAPSHOT_DATA', imageData });
  });

  net.on('FLASH_PULSE', () => {
    try {
      shutter();
    } catch {
      /* ignore */
    }
  });

  // ====================================================================
  // Home Mouse Dodge Simulator (paint directly on /main during EXPOSE)
  // ====================================================================
  let mouseDown = false;
  let lastPaintAt = 0;

  function canvasClientToEaselNorm(clientX: number, clientY: number): { nx: number; ny: number } | null {
    const cr = fx.getBoundingClientRect();
    const scale = Math.min(cr.width / fx.width, cr.height / fx.height);
    const drawW = fx.width * scale;
    const drawH = fx.height * scale;
    const offX = cr.left + (cr.width - drawW) / 2;
    const offY = cr.top + (cr.height - drawH) / 2;

    const cx = (clientX - offX) / scale;
    const cy = (clientY - offY) / scale;
    const { w, h } = engine.getSourceSize();
    const er = computeEaselRect(fx.width, fx.height, net.config?.easelMargin ?? 6, w, h);
    if (cx < er.x || cx > er.x + er.w || cy < er.y || cy > er.y + er.h) return null;
    return { nx: (cx - er.x) / er.w, ny: (cy - er.y) / er.h };
  }

  fx.addEventListener('pointerdown', (e) => {
    if (net.phase !== 'EXPOSE' || !net.config?.mouseSimulator) return;
    mouseDown = true;
    lastPaintAt = performance.now();
    const pt = canvasClientToEaselNorm(e.clientX, e.clientY);
    if (pt) engine.applyMouseDodge(pt.nx, pt.ny, 0.06);
  });
  fx.addEventListener('pointermove', (e) => {
    if (!mouseDown || net.phase !== 'EXPOSE' || !net.config?.mouseSimulator) return;
    const now = performance.now();
    const dt = Math.min(0.15, Math.max(0.016, (now - lastPaintAt) / 1000));
    lastPaintAt = now;
    const pt = canvasClientToEaselNorm(e.clientX, e.clientY);
    if (pt) engine.applyMouseDodge(pt.nx, pt.ny, dt);
  });
  window.addEventListener('pointerup', () => {
    mouseDown = false;
  });

  // ====================================================================
  // exposure / clean sampling & developing state
  // ====================================================================
  let sampleTimer: number | null = null;
  let lastSampleAt = 0;
  let liveDevProgress = 0;
  let frozenDevProgress = 0;
  let freezeUploadedRound = -1;
  let exposeFastTickStarted = false;
  let devWarnTickStarted = false;

  function stopSampler(): void {
    if (sampleTimer !== null) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
  }

  function startCleanSampler(): void {
    stopSampler();
    if (net.config?.mouseSimulator) return;
    const run = () => {
      if (net.phase !== 'CAPTURE_CLEAN') return stopSampler();
      engine.sampleCleanFrame(camLive() ? camV : null, net.calibration?.hInv ?? null);
    };
    run();
    sampleTimer = window.setInterval(run, CLEAN_SAMPLE_MS);
  }

  function startExposeSampler(): void {
    stopSampler();
    if (net.config?.mouseSimulator) return;
    lastSampleAt = performance.now();
    const run = () => {
      if (net.phase !== 'EXPOSE') return stopSampler();
      const now = performance.now();
      const dtSec = Math.max(0.05, (now - lastSampleAt) / 1000 / net.timeScale);
      lastSampleAt = now;
      engine.sampleExposeFrame(
        camLive() ? camV : null,
        dtSec,
        net.calibration?.hInv ?? null,
        net.config?.diffSensitivity ?? 0.12,
      );
    };
    sampleTimer = window.setInterval(run, EXPOSE_SAMPLE_MS);
  }

  net.on('dev', (m) => {
    liveDevProgress = m.devProgress;
    if (net.phase === 'DEVELOP') devBathAudio.update(liveDevProgress);
  });

  // ====================================================================
  // phase changes
  // ====================================================================
  let curPhase: Phase | null = null;
  let curRound = -1;

  function setActiveSegment(seg: HTMLDivElement | null, stateCls = ''): void {
    for (const s of [segObserve, segExpose, segDevelop, segFixed]) {
      s.classList.remove('active', 'done', 'gold', 'burn');
    }
    const order = [segObserve, segExpose, segDevelop, segFixed];
    const idx = seg ? order.indexOf(seg) : -1;
    order.forEach((s, i) => {
      if (idx > i) s.classList.add('done');
      if (idx === i) {
        s.classList.add('active');
        if (stateCls) s.classList.add(stateCls);
      }
    });
  }

  async function onPhase(phase: Phase, fresh: boolean, prevPhase: Phase | null): Promise<void> {
    const st = net.state!;
    const roundId = st.round.id;
    stopSampler();
    exposeFastTickStarted = false;
    devWarnTickStarted = false;

    if (prevPhase === 'CAPTURE_CLEAN') engine.finalizeClean();
    if (prevPhase === 'EXPOSE') engine.finalizeDodgeMap();

    switch (phase) {
      case 'IDLE':
      case 'CALIBRATING':
        stopAllLoops();
        timelineBar.classList.add('hidden');
        if (phase === 'CALIBRATING') await ensureCamera();
        break;

      case 'CAPTURE_CLEAN':
        stopAllLoops();
        liveDevProgress = 0;
        timelineBar.classList.add('hidden');
        engine.beginRound();
        await engine.loadSource(st.round.sourceUrl, st.round.sampleIndex || 1);
        await ensureCamera();
        if (net.phase === 'CAPTURE_CLEAN') startCleanSampler();
        break;

      case 'OBSERVE':
        stopAllLoops();
        if (fresh) safelightClick();
        timelineBar.classList.remove('hidden');
        setActiveSegment(segObserve);
        tlPrompt.className = 'tl-prompt';
        tlPrompt.textContent = 'FIND WHAT YOU WANT TO SOFTEN OR ERASE';
        break;

      case 'EXPOSE':
        stopAllLoops();
        if (fresh) relayClick(true);
        enlargerTimer.start(0.85, 0.1, 1.0);
        timelineBar.classList.remove('hidden');
        setActiveSegment(segExpose);
        tlPrompt.className = 'tl-prompt';
        tlPrompt.textContent = net.config?.mouseSimulator
          ? 'SIMULATOR ACTIVE · PAINT ON PHOTO TO DODGE'
          : 'BLOCK LIGHT WITH BOARDS, HANDS OR FILMS TO DODGE';
        await ensureCamera();
        if (net.phase === 'EXPOSE') startExposeSampler();
        break;

      case 'DEVELOP':
        enlargerTimer.stop();
        if (fresh) relayClick(false);
        engine.finalizeDodgeMap();
        liveDevProgress = st.round.devProgress ?? 0;
        timelineBar.classList.remove('hidden');
        devBathAudio.start();
        devBathAudio.update(liveDevProgress);
        break;

      case 'LIGHT_LEAK':
        stopAllLoops();
        engine.finalizeDodgeMap();
        frozenDevProgress = st.round.finalDevProgress ?? st.round.devProgress ?? liveDevProgress;
        if (fresh) lightLeakBurst();
        timelineBar.classList.remove('hidden');
        setActiveSegment(segDevelop, 'burn');
        tlPrompt.className = 'tl-prompt burn';
        tlPrompt.textContent = 'UNFIXED · LIGHT LEAK — IMAGE DESTROYED';
        break;

      case 'REVEAL': {
        stopAllLoops();
        engine.finalizeDodgeMap();
        frozenDevProgress = st.round.finalDevProgress ?? st.round.devProgress ?? liveDevProgress;
        const outcome = st.round.outcome ?? (prevPhase === 'LIGHT_LEAK' ? 'UNFIXED_LIGHT_LEAK' : 'FIXED_OPTIMAL');
        const isLeak = outcome === 'UNFIXED_LIGHT_LEAK' || prevPhase === 'LIGHT_LEAK';
        if (fresh && !isLeak) {
          if (outcome === 'FIXED_OPTIMAL') {
            shutter();
            triggerFlashPulse(0.45, 70, 120);
          } else {
            stopBathThud();
            triggerFlashPulse(0.22, 50, 90);
          }
        }
        const jpegData = engine.exportCleanInstaxPrint(frozenDevProgress, isLeak);
        if (freezeUploadedRound !== roundId) {
          freezeUploadedRound = roundId;
          net.send({ type: 'freeze', data: jpegData });
        }
        timelineBar.classList.remove('hidden');
        setActiveSegment(segFixed);
        tlPrompt.className = 'tl-prompt';
        tlPrompt.textContent = '04 FIXED · CHEMICAL PRINT ARCHIVED';
        break;
      }
    }
  }

  net.on('state', (m) => {
    const fresh = m.state !== curPhase || m.round.id !== curRound;
    if (!fresh) return;
    const prev = curPhase;
    curPhase = m.state;
    curRound = m.round.id;
    void onPhase(m.state, true, prev);
  });

  // ====================================================================
  // render loop
  // ====================================================================
  function frame(): void {
    const phase = net.phase;
    const st = net.state;
    const margin = net.config?.easelMargin ?? 6;

    switch (phase) {
      case 'IDLE':
        drawIdleDarkroom(g, net.now());
        break;

      case 'CALIBRATING':
        drawCalibrationTarget(g, margin);
        break;

      case 'CAPTURE_CLEAN':
        engine.drawExpose(g, margin);
        break;

      case 'OBSERVE':
        engine.drawObserve(g, margin);
        break;

      case 'EXPOSE': {
        engine.drawExpose(g, margin);
        const total = Math.max(1, net.config?.exposeSec ?? 30);
        const elapsed = net.storySec();
        expFill.style.width = `${Math.min(100, (elapsed / total) * 100).toFixed(1)}%`;
        const remainSec = Math.max(0, total - elapsed);
        if (!exposeFastTickStarted && remainSec <= 5.0 && remainSec > 0) {
          exposeFastTickStarted = true;
          enlargerTimer.start(0.85, 0.05, 0.5);
        }
        break;
      }

      case 'DEVELOP': {
        engine.drawDevelop(g, liveDevProgress, margin);
        const remainSec = Math.max(0, net.remainingMs() / 1000 / net.timeScale);
        devFill.style.width = `${Math.min(100, (liveDevProgress / 1.2) * 100).toFixed(1)}%`;

        if (remainSec > 0 && remainSec <= 6) {
          setActiveSegment(segDevelop, 'burn');
          tlPrompt.className = 'tl-prompt burn';
          tlPrompt.textContent = `LIGHT LEAK IN ${Math.ceil(remainSec)}s — PULL FIX NOW →`;
        } else if (liveDevProgress > 1.0) {
          setActiveSegment(segDevelop, 'burn');
          tlPrompt.className = 'tl-prompt burn';
          tlPrompt.textContent = 'BURNING — PULL FIX NOW →';
        } else if (liveDevProgress >= 0.75) {
          setActiveSegment(segDevelop, 'gold');
          tlPrompt.className = 'tl-prompt gold';
          tlPrompt.textContent = 'OPTIMAL — PULL FIX LEVER AT RIGHT NOW →';
        } else if (liveDevProgress >= 0.25) {
          setActiveSegment(segDevelop);
          tlPrompt.className = 'tl-prompt';
          tlPrompt.textContent = 'KEEP DEVELOPING · PREPARE RIGHT LEVER';
        } else {
          setActiveSegment(segDevelop);
          tlPrompt.className = 'tl-prompt';
          tlPrompt.textContent = 'MAKE NOISE AT LEFT TO DEVELOP';
        }

        if (!devWarnTickStarted && remainSec > 0 && remainSec <= 5.0) {
          devWarnTickStarted = true;
          enlargerTimer.start(0.32, 0.06, 0.5);
        }
        break;
      }

      case 'LIGHT_LEAK':
        engine.drawLightLeak(g, net.storySec(), frozenDevProgress, margin);
        break;

      case 'REVEAL': {
        const outcome = st?.round.outcome ?? 'FIXED_OPTIMAL';
        const isLeak = outcome === 'UNFIXED_LIGHT_LEAK';
        engine.drawSideBySideReveal(g, frozenDevProgress, outcomeFullLabel(outcome), isLeak);
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
            <h2><small>RH-30 · COLOR ENLARGER · /main</small>Main projector setup</h2>
            <span class="mono">S = SETUP · F = FULLSCREEN</span>
          </div>
          <div class="fields">
            <label><span class="no">01 / CAMERA</span>External USB wide-angle camera<select id="camSel"></select></label>
            <label><span class="no">02 / AUDIO OUT</span>Audio output device<select id="sinkSel"></select></label>
            <div class="hint" id="camHint">Camera stream stays strictly local for optical dodging &amp; remote homography calibration.</div>
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
          if (!cams.length) camSel.innerHTML = '<option value="">(no camera detected — use Mouse Dodge Simulator)</option>';
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
