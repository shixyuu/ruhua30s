/**
 * /main — Mac + projector + external wide-angle camera
 * - The 30-second camera recording stays local (MediaRecorder → Blob URL replay) and is never uploaded
 * - Only the mono freeze frame at 30s is uploaded (JPEG ≤1280px, q=0.78)
 */
import { Net, mountNetDot } from '../lib/net';
import { audioCtx, heartbeat, out, rewindSfx, setAudioSink, shutter, stopAllLoops, unlockAudio } from '../lib/sfx';
import { assetAvailable, dataURLToArrayBuffer, drawDefaultDoorPhoto, filmFilter, pickVideoMime } from '../lib/media';
import { cropMarks, filmStrip, keepAwake, requestFullscreen } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { clear, drawIdle, drawNoRecording, drawRewind, drawSimFilm, preloadCanvasFonts, setupCanvas } from '../lib/film';
import type { Phase } from '../../../shared/protocol';
import { TIMELINE } from '../../../shared/protocol';

const LS_CAM = 'ruhua.main.camera';
const LS_SINK = 'ruhua.main.sink';
const BYSTANDER = 'You kept to the rules and did not become the killer. But you also watched it end.';

type SinkEl = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

export default async function mainPage(app: HTMLElement): Promise<void> {
  document.title = `Main projector · ${TITLE_EN}`;
  app.innerHTML = `
    <canvas class="layer" id="fx"></canvas>
    <video class="layer hidden" id="base" playsinline preload="auto"></video>
    <video class="layer hidden" id="rewind" playsinline preload="auto"></video>
    <video class="layer hidden" id="replay" playsinline muted></video>
    <div class="countdown hidden" id="countdownBox"><div class="k"><span>ENTER BUFFER</span><span class="chem"><span class="on"><b>DEV</b></span><span><b>STOP</b></span><span><b>FIX</b></span></span></div><div class="n" id="countdown"></div></div>
    <div class="bystander" id="bystander"><p id="bystanderText"></p></div>
    <div class="cctv hidden" id="cctv">
      <div class="rule"><span><b>RH-30</b> · NODE SYNC · CONTACT PROOF</span><span id="cctvClock">--:--:--</span></div>
      <div class="pane left">
        <div class="neg">
          ${filmStrip(29)}
          <div class="frame"><img id="freezeImg" alt="" /></div>
          ${filmStrip(30)}
          <span class="ring"></span><span class="grease">PRINT ✓</span>
        </div>
        <div class="cap"><span class="no" id="frameNo">FR 001</span><span class="t">New node negative synced to the entrance</span></div>
      </div>
      <div class="pane right">
        <div class="frame">
          <img id="cctvImg" class="hidden" alt="" />
          <div class="nosignal hidden" id="nosig">ENTRANCE FEED · NO SIGNAL</div>
          <div class="osd"><span>CH-01</span><span class="live">LIVE</span></div>
        </div>
        <div class="cap"><span class="no">CH-01</span><span class="t">Entrance live feed · next visitor</span></div>
      </div>
      <div class="exit"><span>Please exit to the north</span><span class="arr">↑</span></div>
    </div>
    <div class="flash" id="flash"></div>
    <video id="cam" class="hidden" muted playsinline autoplay></video>`;
  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const fx = $<HTMLCanvasElement>('#fx');
  const g = setupCanvas(fx);
  preloadCanvasFonts();
  const baseV = $<HTMLVideoElement>('#base');
  const rewindV = $<HTMLVideoElement>('#rewind');
  const replayV = $<HTMLVideoElement>('#replay');
  const countdown = $<HTMLDivElement>('#countdown');
  const countdownBox = $<HTMLDivElement>('#countdownBox');
  const bystander = $<HTMLDivElement>('#bystander');
  $<HTMLParagraphElement>('#bystanderText').textContent = BYSTANDER;
  const frameNo = $<HTMLSpanElement>('#frameNo');
  const cctvClock = $<HTMLSpanElement>('#cctvClock');
  const cctv = $<HTMLDivElement>('#cctv');
  const freezeImg = $<HTMLImageElement>('#freezeImg');
  const cctvImg = $<HTMLImageElement>('#cctvImg');
  const nosig = $<HTMLDivElement>('#nosig');
  const flashEl = $<HTMLDivElement>('#flash');
  const camV = $<HTMLVideoElement>('#cam');

  const net = new Net('main');
  (window as any).__net = net; // debugging / automated tests
  mountNetDot(net);

  // ====================================================================
  // asset probe (re-HEAD on every return to IDLE so files can be hot-swapped)
  // ====================================================================
  const assets = { base: false, rewind: false };
  async function checkAssets(): Promise<void> {
    const [b, r] = await Promise.all([assetAvailable('/assets/base.mp4'), assetAvailable('/assets/rewind.mp4')]);
    assets.base = b;
    assets.rewind = r;
    updateAssetInfo?.();
  }
  let updateAssetInfo: (() => void) | null = null;

  // ====================================================================
  // camera
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
  // local recording (never uploaded)
  // ====================================================================
  let recorder: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let recRound = -1;
  let replayUrl: string | null = null;
  let replayRound = -1;

  function startRecording(roundId: number): void {
    if (recorder || !camLive()) return;
    const mime = pickVideoMime();
    try {
      recorder = new MediaRecorder(camStream!, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
    } catch {
      recorder = new MediaRecorder(camStream!);
    }
    recChunks = [];
    recRound = roundId;
    recorder.ondataavailable = (e) => e.data && e.data.size && recChunks.push(e.data);
    recorder.start(1000);
  }

  function stopRecording(keep: boolean): Promise<void> {
    return new Promise((resolve) => {
      const r = recorder;
      if (!r) return resolve();
      recorder = null;
      r.onstop = () => {
        if (keep && recChunks.length) {
          if (replayUrl) URL.revokeObjectURL(replayUrl);
          replayUrl = URL.createObjectURL(new Blob(recChunks, { type: r.mimeType || 'video/webm' }));
          replayRound = recRound;
        }
        recChunks = [];
        resolve();
      };
      try {
        r.stop();
      } catch {
        resolve();
      }
    });
  }

  // ====================================================================
  // visitor's voice: telephone-receiver filter
  // ====================================================================
  let voice: { roundId: number; offset: number; buffer: AudioBuffer | null; el: HTMLAudioElement | null } | null = null;
  let voiceSource: AudioScheduledSourceNode | null = null;
  let voiceTimer: number | null = null;
  let voicePlayedRound = -1;

  function telephoneChain(): AudioNode {
    const c = audioCtx();
    const bp = c.createBiquadFilter(); // 300–3000 Hz band-pass: centre √(300·3000) ≈ 949 Hz, Q = 949/2700 ≈ 0.35
    bp.type = 'bandpass';
    bp.frequency.value = 949;
    bp.Q.value = 0.35;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.7;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    lp.Q.value = 0.7;
    const shaper = c.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 6;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const gain = c.createGain();
    gain.gain.value = 2.2;
    bp.connect(hp).connect(lp).connect(shaper).connect(gain).connect(out());
    return bp;
  }

  net.on('audio', async (m) => {
    const entry = { roundId: m.roundId, offset: m.audioOffsetMs, buffer: null as AudioBuffer | null, el: null as HTMLAudioElement | null };
    voice = entry;
    try {
      entry.buffer = await audioCtx().decodeAudioData(dataURLToArrayBuffer(m.data));
    } catch {
      // some codecs fail decodeAudioData: fall back to <audio> + MediaElementSource
      const el = new Audio();
      el.src = m.data;
      el.preload = 'auto';
      entry.el = el;
    }
    if (net.phase === 'REPLAY_TRUTH') scheduleVoice();
  });

  function scheduleVoice(): void {
    const st = net.state;
    if (!st || !voice || voice.roundId !== st.round.id || voicePlayedRound === st.round.id) return;
    const v = voice;
    const startAtLocal = net.toLocal(st.phaseStartedAt + v.offset);
    const delayMs = startAtLocal - Date.now();
    const play = (skipSec: number) => {
      voicePlayedRound = st.round.id;
      const c = audioCtx();
      const input = telephoneChain();
      if (v.buffer) {
        if (skipSec >= v.buffer.duration) return;
        const s = c.createBufferSource();
        s.buffer = v.buffer;
        s.connect(input);
        s.start(c.currentTime + 0.01, Math.max(0, skipSec));
        voiceSource = s;
      } else if (v.el) {
        try {
          c.createMediaElementSource(v.el).connect(input);
        } catch {
          /* already connected */
        }
        v.el.currentTime = Math.max(0, skipSec);
        v.el.play().catch(() => {});
      }
    };
    if (voiceTimer) clearTimeout(voiceTimer);
    if (delayMs > 0) voiceTimer = window.setTimeout(() => play(0), delayMs);
    else play(-delayMs / 1000);
  }

  function stopVoice(): void {
    if (voiceTimer) clearTimeout(voiceTimer);
    voiceTimer = null;
    try {
      voiceSource?.stop();
    } catch {
      /* ignore */
    }
    voiceSource = null;
    voice?.el?.pause();
  }

  // ====================================================================
  // flash / freeze
  // ====================================================================
  function flash(ms = 200): void {
    flashEl.classList.add('on');
    shutter();
    window.setTimeout(() => flashEl.classList.remove('on'), ms);
  }
  net.on('flash', () => flash(200));

  let freezeDataUrl: string | null = null;
  let freezeRound = -1;
  function captureFreeze(roundId: number): void {
    if (freezeRound === roundId) return;
    freezeRound = roundId;
    let src: CanvasImageSource;
    if (camLive() && camV.videoWidth > 0) src = camV;
    else {
      // no camera: use the last simulated-film frame so the flow works with zero assets
      drawSimFilm(g, 30);
      src = fx;
    }
    const c = filmFilter(src, 1280);
    freezeDataUrl = c.toDataURL('image/jpeg', 0.78);
    net.send({ type: 'freeze', data: freezeDataUrl });
  }

  // ====================================================================
  // phase changes
  // ====================================================================
  let curPhase: Phase | null = null;
  let curRound = -1;
  let lastCctvAt = 0;
  let cctvPhaseStart = 0;
  let baseFailed = false;
  let rewindFailed = false;

  const hideAll = () => {
    for (const el of [baseV, rewindV, replayV, countdownBox, cctv]) el.classList.add('hidden');
    bystander.classList.remove('show');
  };

  function sinkAll(): void {
    for (const el of [baseV, rewindV] as SinkEl[]) {
      if (sinkId && typeof el.setSinkId === 'function') el.setSinkId(sinkId === 'default' ? '' : sinkId).catch(() => {});
    }
  }

  function videoSrc(v: HTMLVideoElement, name: string): void {
    v.src = `/assets/${name}?v=${Date.now()}`;
    v.load();
  }

  async function onPhase(phase: Phase, fresh: boolean): Promise<void> {
    const st = net.state!;
    const roundId = st.round.id;
    const elapsedSec = net.elapsedMs() / 1000;
    hideAll();
    switch (phase) {
      case 'IDLE':
        stopAllLoops();
        stopVoice();
        await stopRecording(false);
        baseV.pause();
        rewindV.pause();
        replayV.pause();
        checkAssets();
        break;

      case 'ENTER_BUFFER':
        stopVoice();
        countdownBox.classList.remove('hidden');
        heartbeat.setRate(70);
        heartbeat.start(Math.max(0.5, net.remainingMs() / 1000), 0.9);
        baseFailed = rewindFailed = false;
        await Promise.all([ensureCamera(), checkAssets()]);
        if (net.phase !== 'ENTER_BUFFER') break; // already moved on; don't clobber
        if (assets.base) {
          videoSrc(baseV, 'base.mp4');
          baseV.currentTime = 0;
        }
        break;

      case 'ACTIVE_30S':
        heartbeat.start(0.3, 1);
        if (!camLive()) await ensureCamera();
        startRecording(roundId);
        if (assets.base && !baseFailed) {
          if (!baseV.src) videoSrc(baseV, 'base.mp4');
          baseV.classList.remove('hidden');
          if (elapsedSec > 0.3) baseV.currentTime = elapsedSec;
          baseV.play().catch(() => (baseFailed = true));
        }
        break;

      case 'FLASH_FREEZE':
        if (fresh && net.elapsedMs() < 600) flash(200);
        stopAllLoops();
        baseV.pause();
        captureFreeze(roundId);
        await stopRecording(true);
        if (assets.rewind) videoSrc(rewindV, 'rewind.mp4');
        break;

      case 'REWIND':
        stopAllLoops();
        rewindSfx(Math.max(0.3, net.remainingMs() / 1000));
        if (assets.rewind && !rewindFailed) {
          if (!rewindV.src) videoSrc(rewindV, 'rewind.mp4');
          rewindV.classList.remove('hidden');
          if (elapsedSec > 0.3) rewindV.currentTime = elapsedSec;
          rewindV.play().catch(() => (rewindFailed = true));
        }
        break;

      case 'REPLAY_TRUTH':
        // total silence: drop all score and alarms, keep only the visitor's voice
        stopAllLoops();
        rewindV.pause();
        if (replayUrl && replayRound === roundId) {
          replayV.src = replayUrl;
          replayV.classList.remove('hidden');
          try {
            if (elapsedSec > 0.5) replayV.currentTime = elapsedSec;
          } catch {
            /* webm may not be seekable */
          }
          replayV.play().catch(() => {});
        }
        scheduleVoice();
        break;

      case 'CCTV_REVEAL':
        stopAllLoops();
        stopVoice();
        replayV.pause();
        cctv.classList.remove('hidden');
        frameNo.textContent = `FR ${String(roundId).padStart(3, '0')}`;
        cctvPhaseStart = Date.now();
        lastCctvAt = 0;
        cctvImg.classList.add('hidden');
        nosig.classList.add('hidden');
        if (freezeDataUrl && freezeRound === roundId) freezeImg.src = freezeDataUrl;
        else if (net.doorPhoto?.url) freezeImg.src = net.doorPhoto.url;
        else {
          const c = document.createElement('canvas');
          drawDefaultDoorPhoto(c);
          freezeImg.src = c.toDataURL('image/jpeg', 0.8);
        }
        break;
    }
  }

  net.on('state', (m) => {
    const fresh = m.state !== curPhase || m.round.id !== curRound;
    if (!fresh) return;
    curPhase = m.state;
    curRound = m.round.id;
    onPhase(m.state, true);
  });

  net.on('cctv', (m) => {
    if (net.phase !== 'CCTV_REVEAL') return;
    cctvImg.src = m.data;
    cctvImg.classList.remove('hidden');
    lastCctvAt = Date.now();
  });

  // ====================================================================
  // render loop
  // ====================================================================
  let lastDrift = 0;
  function frame(): void {
    const phase = net.phase;
    const t = net.storySec();
    const st = net.state;
    switch (phase) {
      case 'IDLE':
        drawIdle(g, net.now());
        break;
      case 'ENTER_BUFFER': {
        drawIdle(g, net.now());
        const remain = net.remainingMs() / 1000 / net.timeScale;
        countdown.textContent = remain > 3 ? '' : String(Math.max(1, Math.ceil(remain)));
        break;
      }
      case 'ACTIVE_30S':
        heartbeat.setRate(72 + (Math.min(30, t) / 30) * 60);
        if (!assets.base || baseFailed) drawSimFilm(g, t);
        else {
          clear(g);
          // drift correction (real-time scale only)
          if (net.timeScale === 1 && performance.now() - lastDrift > 2000 && !baseV.paused) {
            lastDrift = performance.now();
            const want = net.elapsedMs() / 1000;
            if (Math.abs(baseV.currentTime - want) > 0.25 && want < (baseV.duration || 30)) baseV.currentTime = want;
          }
        }
        break;
      case 'REWIND':
        if (!assets.rewind || rewindFailed) drawRewind(g, net.elapsedMs() / Math.max(1, st?.phaseDurationMs || 3000));
        else clear(g);
        break;
      case 'REPLAY_TRUTH': {
        if (!(replayUrl && replayRound === st?.round.id)) drawNoRecording(g, t);
        else clear(g);
        const show = !!st && !st.round.didSpeak && !st.round.didPullBreaker && t >= 30 - TIMELINE.bystanderLastSec;
        bystander.classList.toggle('show', show);
        break;
      }
      case 'CCTV_REVEAL': {
        clear(g);
        const now = Date.now();
        const firstWait = Math.min(1500, (st?.phaseDurationMs || 6000) * 0.25);
        const noFrames = lastCctvAt === 0 ? now - cctvPhaseStart > firstWait : now - lastCctvAt > 2000;
        nosig.classList.toggle('hidden', !noFrames);
        cctvClock.textContent = new Date(net.now()).toLocaleTimeString('en-GB', { hour12: false });
        if (noFrames) cctvImg.classList.add('hidden');
        break;
      }
      default:
        clear(g);
    }
    requestAnimationFrame(frame);
  }

  // ====================================================================
  // setup panel
  // ====================================================================
  await setupPanel();
  net.connect();
  requestAnimationFrame(frame);

  window.addEventListener('keydown', (e) => {
    if (e.key === 's' || e.key === 'S') setupPanel();
    if (e.key === 'f' || e.key === 'F') requestFullscreen();
  });

  function setupPanel(): Promise<void> {
    return new Promise((resolve) => {
      document.querySelector('.setup')?.remove();
      const el = document.createElement('div');
      el.className = 'setup';
      el.innerHTML = `
        <div class="ticket">
          <div class="head"><h2><small>RUHUA FILM LAB · JOB TICKET · PROJ /main</small>Main projector<br>setup</h2><span class="stamp double">Pre-flight</span></div>
          <div class="fields">
            <label><span class="no">01 / CAMERA</span>Choose the external USB wide-angle camera<select id="camSel"></select></label>
            <label><span class="no">02 / AUDIO OUT</span>Audio output device<select id="sinkSel"></select></label>
            <div class="assets" id="assetInfo"></div>
            <div class="hint">While running: press S to reopen this panel, F for fullscreen.</div>
          </div>
          <div class="fields">
            <div class="pv"><video id="pv" muted playsinline autoplay></video>${cropMarks()}<span class="mono">PREVIEW · CAM</span></div>
            <div class="row">
              <button id="refresh">Refresh devices</button>
              <button class="primary" id="go">Unlock audio/video &amp; go fullscreen</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(el);
      const camSel = el.querySelector('#camSel') as HTMLSelectElement;
      const sinkSel = el.querySelector('#sinkSel') as HTMLSelectElement;
      const pv = el.querySelector('#pv') as HTMLVideoElement;
      const info = el.querySelector('#assetInfo') as HTMLDivElement;
      updateAssetInfo = () => {
        info.innerHTML =
          `<b>base.mp4</b> ··· ${assets.base ? '<span class="ok">FOUND</span>' : '<span class="warn">MISSING → simulated film (canvas)</span>'}<br>` +
          `<b>rewind.mp4</b> ··· ${assets.rewind ? '<span class="ok">FOUND</span>' : '<span class="warn">MISSING → procedural rewind</span>'}`;
      };
      checkAssets();

      async function fill(): Promise<void> {
        try {
          let devs = await navigator.mediaDevices.enumerateDevices();
          if (!devs.some((d) => d.kind === 'videoinput' && d.label)) {
            // ask for permission once so device labels become available
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
          if (!cams.length) camSel.innerHTML = '<option value="">(no camera detected)</option>';
          const saved = cams.find((d) => d.deviceId === camId);
          const external = cams.find((d) => !/facetime|built-?in|integrated|\u5185\u5efa/i.test(d.label));
          camSel.value = (saved || external || cams[0])?.deviceId || '';

          const sinks = devs.filter((d) => d.kind === 'audiooutput');
          sinkSel.innerHTML = '';
          const canSink = typeof (audioCtx() as any).setSinkId === 'function' || 'setSinkId' in HTMLMediaElement.prototype;
          if (!canSink || !sinks.length) {
            sinkSel.innerHTML = '<option value="">System default output (this browser cannot choose an output)</option>';
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
          info.innerHTML += `<br>Device enumeration failed: ${(err as Error).message} (HTTPS required)`;
        }
      }

      async function preview(): Promise<void> {
        camId = camSel.value;
        const s = await openCamera(camId);
        pv.srcObject = s;
        pv.play().catch(() => {});
      }

      camSel.addEventListener('change', preview);
      (el.querySelector('#refresh') as HTMLButtonElement).addEventListener('click', fill);
      (el.querySelector('#go') as HTMLButtonElement).addEventListener('click', async () => {
        const fsP = requestFullscreen();
        const auP = unlockAudio();
        keepAwake();
        camId = camSel.value;
        sinkId = sinkSel.value;
        localStorage.setItem(LS_CAM, camId);
        localStorage.setItem(LS_SINK, sinkId);
        await Promise.allSettled([fsP, auP]);
        if (sinkId) await setAudioSink(sinkId);
        sinkAll();
        // unlock autoplay on the video elements
        for (const v of [baseV, rewindV, replayV]) {
          v.muted = v === replayV;
          v.play().catch(() => {});
          v.pause();
        }
        if (!camLive()) await openCamera(camId);
        pv.srcObject = null;
        el.remove();
        updateAssetInfo = null;
        resolve();
      });
      fill();
    });
  }
}
