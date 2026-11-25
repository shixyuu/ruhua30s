/**
 * /station1 — tablet 2: south-west comms terminal
 *  Window A 05s–13s: red incoming-call screen + ring; hold the button to record (stops on release or at 13s) → sends audio + audioOffsetMs
 *  Window B 13s–21s: overexposure alarm screen
 */
import { Net, mountNetDot } from '../lib/net';
import { alarm, ring, stopAllLoops } from '../lib/sfx';
import { blobToDataURL, pickAudioMime } from '../lib/media';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { TIMELINE } from '../../../shared/protocol';

const TEXT_A = 'ANOMALY DETECTED! HOLD THE BUTTON BELOW AND SHOUT TO STOP HIM — NOW!';
const TEXT_B = 'WARNING: OVEREXPOSURE IS BURNING THE NEGATIVE! RUN TO THE CENTRE OF THE ROOM AND SPREAD YOUR ARMS TO BLOCK THE BEAM ON THE WALL!';

type Seg = 'black' | 'A' | 'B';

export default async function station1(app: HTMLElement): Promise<void> {
  document.title = `Comms terminal · ${TITLE_EN}`;
  app.innerHTML = `
    <div class="station black" id="root">
      <div class="st-band"><span class="id"><span>T-02</span></span><span class="zone" id="zone">SW comms terminal</span><span class="clock" id="clock">--.-</span></div>
      <div class="st-body stack" id="body">
        <p class="st-msg" id="msg"></p>
        <div class="st-aside" id="aside">
          <div class="plate-col"><div class="plate">PUSH TO TALK<b>Release to send</b></div><div class="st-sub" id="sub"></div></div>
          <div class="mush"><div class="collar"></div><button class="talk-btn" id="talk">Hold<br>to talk</button></div>
        </div>
      </div>
      <div class="st-foot"><span>RH-30 / LINE 02 · <span id="foot"></span></span><span class="chem" id="chem"><span data-s="A"><b>DEV</b> 05–13</span><span data-s="B"><b>STOP</b> 13–21</span><span data-s="C"><b>FIX</b> 21–30</span></span></div>
    </div>`;
  const root = app.querySelector('#root') as HTMLDivElement;
  const aside = app.querySelector('#aside') as HTMLDivElement;
  const zone = app.querySelector('#zone') as HTMLSpanElement;
  const clock = app.querySelector('#clock') as HTMLSpanElement;
  const foot = app.querySelector('#foot') as HTMLSpanElement;
  const msgEl = app.querySelector('#msg') as HTMLDivElement;
  const subEl = app.querySelector('#sub') as HTMLDivElement;
  const btn = app.querySelector('#talk') as HTMLButtonElement;
  const chem = Array.from(app.querySelectorAll<HTMLSpanElement>('#chem > span'));

  const net = new Net('station1');
  (window as any).__net = net; // debugging / automated tests
  mountNetDot(net);

  let mic: MediaStream | null = null;
  const mime = pickAudioMime();

  // ---------------- recording ----------------
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let recStartServer = 0;
  let sentRound = -1;
  let recRound = -1;

  async function ensureMic(): Promise<MediaStream | null> {
    if (mic && mic.getAudioTracks().some((t) => t.readyState === 'live')) return mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      console.warn('microphone unavailable', e);
      mic = null;
    }
    return mic;
  }

  async function startRec(): Promise<void> {
    const r = net.round;
    if (rec || !r || sentRound === r.id || seg !== 'A') return;
    const s = await ensureMic();
    if (!s || seg !== 'A') return;
    try {
      rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
    } catch {
      rec = new MediaRecorder(s);
    }
    chunks = [];
    recRound = r.id;
    recStartServer = net.now();
    rec.onstart = () => (recStartServer = net.now());
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      const type = rec?.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks, { type });
      const round = net.round;
      rec = null;
      btn.classList.remove('rec');
      if (!round || round.id !== recRound || blob.size < 800 || !round.activeStartedAt) {
        subEl.textContent = '';
        return;
      }
      const audioOffsetMs = Math.max(0, Math.round(recStartServer - round.activeStartedAt));
      const data = await blobToDataURL(blob);
      if (net.send({ type: 'speak', mime: type, data, audioOffsetMs })) {
        sentRound = round.id;
        subEl.textContent = 'Connected · signal sent';
        btn.disabled = true;
      }
    };
    rec.start(250);
    ring.duck(0.05);
    btn.classList.add('rec');
    subEl.textContent = 'Recording… release to end';
  }

  function stopRec(): void {
    if (rec && rec.state !== 'inactive') {
      try {
        rec.requestData();
      } catch {
        /* ignore */
      }
      rec.stop();
    }
    ring.duck(1);
  }

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    startRec();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) btn.addEventListener(ev, () => stopRec());

  // ---------------- phase rendering ----------------
  let seg: Seg = 'black';
  function setSeg(next: Seg): void {
    if (next === seg) return;
    seg = next;
    chem.forEach((c) => c.classList.toggle('on', c.dataset.s === next));
    root.className = 'station black';
    aside.classList.add('hidden');
    msgEl.textContent = '';
    subEl.textContent = '';
    ring.stop();
    alarm.stop();
    if (next !== 'A') stopRec();
    if (next === 'A') {
      root.className = 'station st-call';
      zone.textContent = 'SW comms terminal · Incoming call';
      foot.textContent = 'PHASE A';
      msgEl.textContent = TEXT_A;
      aside.classList.remove('hidden');
      btn.disabled = sentRound === net.round?.id;
      ring.start();
    } else if (next === 'B') {
      root.className = 'station st-over';
      zone.textContent = 'SW comms terminal · Overexposure';
      foot.textContent = 'PHASE B';
      msgEl.textContent = TEXT_B;
      alarm.start('overexposure', 0.7);
    } else {
      stopAllLoops();
    }
  }

  function tick(): void {
    let next: Seg = 'black';
    if (net.connected && net.phase === 'ACTIVE_30S') {
      const t = net.storySec();
      if (t >= TIMELINE.station1A[0] && t < TIMELINE.station1A[1]) next = 'A';
      else if (t >= TIMELINE.station1B[0] && t < TIMELINE.station1B[1]) next = 'B';
    }
    setSeg(next);
    if (next !== 'black') {
      const end = next === 'A' ? TIMELINE.station1A[1] : TIMELINE.station1B[1];
      clock.textContent = Math.max(0, end - net.storySec()).toFixed(1).padStart(4, '0');
    }
    requestAnimationFrame(tick);
  }

  await showStartOverlay({
    code: 'T-02',
    kicker: '/station1',
    title: 'South-west comms terminal',
    subtitle: 'Tap to allow the microphone, go fullscreen\nand keep the screen awake.',
    button: 'Tap to start',
    onUnlock: async () => {
      await ensureMic();
    },
  });
  net.connect();
  requestAnimationFrame(tick);
}
