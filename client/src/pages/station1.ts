/**
 * /station1 — tablet 2: south-west acoustic developer gauge
 * - Pure black (#000000) outside DEVELOPING.
 * - During DEVELOPING: full-screen vintage analog needle meter driven smoothly by live microphone energy,
 *   with a single caption below: MAKE NOISE TO DEVELOP (never displays devProgress percentage).
 * - Streams normalized energy (0.0–1.0) at 12 Hz via WebSocket `{ type: 'AUDIO_ENERGY', level }`.
 */
import { Net, mountNetDot } from '../lib/net';
import { audioCtx, stationWakeChime } from '../lib/sfx';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';

const SEND_INTERVAL_MS = 83; // ~12 Hz

function arcPoint(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const [x1, y1] = arcPoint(cx, cy, r, startDeg);
  const [x2, y2] = arcPoint(cx, cy, r, endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

export default async function station1(app: HTMLElement): Promise<void> {
  document.title = `Acoustic Developer · ${TITLE_EN}`;

  const ticks: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const deg = -52 + (i / 20) * 104;
    const major = i % 5 === 0;
    const [x1, y1] = arcPoint(240, 230, major ? 150 : 160, deg);
    const [x2, y2] = arcPoint(240, 230, 174, deg);
    ticks.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(232,226,213,${major ? 0.85 : 0.35})" stroke-width="${major ? 2.2 : 1.1}" />`,
    );
  }

  app.innerHTML = `
    <div class="inst-screen black" id="root">
      <div class="meter-stage">
        <svg class="analog-meter" viewBox="0 0 480 300" aria-label="Acoustic developer meter">
          <rect x="14" y="14" width="452" height="272" rx="4" fill="#0B0A09" stroke="rgba(232,226,213,0.22)" stroke-width="1.5" />
          <path id="arcQuiet" d="${arcPath(240, 230, 184, -52, -40)}" fill="none" stroke="#9E2A22" stroke-width="8" stroke-linecap="butt" />
          <path id="arcActive" d="${arcPath(240, 230, 184, -40, 52)}" fill="none" stroke="#538C4D" stroke-width="8" stroke-linecap="butt" />
          <path d="${arcPath(240, 230, 174, -52, 52)}" fill="none" stroke="rgba(232,226,213,0.35)" stroke-width="1.2" />
          ${ticks.join('')}
          <text x="64" y="250" fill="rgba(232,226,213,0.45)" font-family="'RH Mono', monospace" font-size="11" letter-spacing="2">QUIET</text>
          <text x="364" y="250" fill="rgba(123,168,98,0.75)" font-family="'RH Mono', monospace" font-size="11" letter-spacing="2">DEVELOP</text>
          <g id="needle" transform="rotate(-52 240 230)">
            <line x1="240" y1="230" x2="240" y2="56" stroke="#E8E2D5" stroke-width="2.6" stroke-linecap="round" />
            <circle cx="240" cy="230" r="10" fill="#1C1916" stroke="#E8E2D5" stroke-width="2" />
            <circle cx="240" cy="230" r="3" fill="#9E2A22" />
          </g>
        </svg>
        <div class="inst-caption">MAKE NOISE TO DEVELOP</div>
        <div class="inst-sub">Watch the wall — stop before it turns black</div>
      </div>
    </div>`;

  const root = app.querySelector('#root') as HTMLDivElement;
  const arcQuiet = app.querySelector('#arcQuiet') as SVGPathElement;
  const arcActive = app.querySelector('#arcActive') as SVGPathElement;
  const needle = app.querySelector('#needle') as SVGGElement;

  const net = new Net('station1');
  (window as any).__net = net;
  mountNetDot(net);

  let mic: MediaStream | null = null;
  let analyser: AnalyserNode | null = null;
  let micSrc: MediaStreamAudioSourceNode | null = null;
  const waveBuf = new Uint8Array(256);

  async function ensureMic(): Promise<void> {
    if (mic && mic.getAudioTracks().some((t) => t.readyState === 'live')) return;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
      });
      const c = audioCtx();
      analyser = c.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;
      micSrc?.disconnect();
      micSrc = c.createMediaStreamSource(mic);
      micSrc.connect(analyser);
    } catch (e) {
      console.warn('microphone unavailable', e);
      mic = null;
      analyser = null;
    }
  }

  function updateThresholdArc(): void {
    const floor = Math.max(0.02, Math.min(0.5, net.config?.noiseFloor ?? 0.08));
    const splitDeg = -52 + floor * 104;
    arcQuiet.setAttribute('d', arcPath(240, 230, 184, -52, splitDeg));
    arcActive.setAttribute('d', arcPath(240, 230, 184, splitDeg, 52));
  }
  net.on('config', updateThresholdArc);

  function readEnergy(): number {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(waveBuf);
    let sum = 0;
    for (let i = 0; i < waveBuf.length; i++) {
      const d = (waveBuf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / waveBuf.length);
    return Math.max(0, Math.min(1, rms * 3.8));
  }

  let smoothed = 0;
  let lastSentAt = 0;
  let wasActive = false;

  function renderPhase(): void {
    const active = net.connected && net.phase === 'DEVELOPING';
    root.classList.toggle('black', !active);
    if (active && !wasActive) stationWakeChime();
    wasActive = active;
    if (active) void ensureMic();
  }
  net.on('state', renderPhase);
  net.on('open', renderPhase);

  function tick(): void {
    const active = net.connected && net.phase === 'DEVELOPING';
    if (active) {
      const raw = readEnergy();
      // Fast needle attack, calm physical ballistic decay
      smoothed = raw > smoothed ? smoothed + (raw - smoothed) * 0.42 : smoothed + (raw - smoothed) * 0.14;
      const deg = -52 + smoothed * 104;
      needle.setAttribute('transform', `rotate(${deg.toFixed(2)} 240 230)`);

      const now = performance.now();
      if (now - lastSentAt >= SEND_INTERVAL_MS) {
        lastSentAt = now;
        net.send({ type: 'AUDIO_ENERGY', level: Number(raw.toFixed(3)) });
      }
    } else if (smoothed > 0.001) {
      smoothed = 0;
      needle.setAttribute('transform', 'rotate(-52 240 230)');
    }
    requestAnimationFrame(tick);
  }

  await showStartOverlay({
    code: 'T-02',
    kicker: '/station1',
    title: 'ACOUSTIC DEVELOPER',
    subtitle: 'Tap to allow microphone & fullscreen',
    button: 'TAP TO START',
    onUnlock: async () => {
      await ensureMic();
    },
  });
  net.connect();
  updateThresholdArc();
  renderPhase();
  requestAnimationFrame(tick);
}
