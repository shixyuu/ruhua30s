import { filmStrip } from '../lib/unlock';
import { LOGO_CJK, TITLE_EN } from '../lib/brand';

export default function home(app: HTMLElement): void {
  document.body.classList.add('scrollable');
  document.title = TITLE_EN;
  app.style.position = 'static';
  const rows: [string, string, string][] = [
    ['/main', 'Main projector · Mac + wide-angle USB camera', 'PROJ'],
    ['/door', 'Tablet 1 · Entrance darkroom screen', 'T-01'],
    ['/station1', 'Tablet 2 · South-west comms terminal', 'T-02'],
    ['/station2', 'Tablet 3 · North-west emergency breaker', 'T-03'],
    ['/admin', 'Control desk · Chromebook or phone', 'DESK'],
  ];
  const today = new Date();
  const dd = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getFullYear()).slice(2)}`;
  app.innerHTML = `
  <div class="home-desk">
    ${filmStrip(1)}
    <div class="home">
      <div class="home-head">
        <span class="kick">RH-30 · Device directory</span>
        <span class="stamp seal cjk" aria-hidden="true">${LOGO_CJK}</span>
        <h1>Thirty<br>seconds<small>into the <em>frame</em></small></h1>
        <p>An interactive time-loop installation. Open the matching page on each device before the first visitor arrives.</p>
        <div class="note">Every screen syncs to the server clock. The round can only be started from the control desk.</div>
      </div>
      <div class="envelope">
        <div class="flap"></div>
        <div class="eh"><h2>Ruhua Film Lab<br>Processing envelope</h2><span class="no">№ 030</span></div>
        <div class="fields">
          <div class="field"><span class="k">Job</span><span class="v">RH-30</span></div>
          <div class="field"><span class="k">Process</span><span class="v">B&amp;W · PUSH 1</span></div>
          <div class="field"><span class="k">Received</span><span class="v">${dd}</span></div>
          <div class="field"><span class="k">Format</span><span class="v">135 · 36</span></div>
          <div class="field"><span class="k">Rolls</span><span class="v">5 DEVICES</span></div>
          <div class="field"><span class="k">Window</span><span class="v">00:30</span></div>
        </div>
        <span class="stamp double">Rush</span>
        <nav class="dir">
          ${rows.map(([r, d, n]) => `<a href="${r}"><span class="r">${r}</span><span class="d">${d}</span><span class="n">${n}</span></a>`).join('')}
        </nav>
        <span class="stamp b">Checked</span>
      </div>
      <aside class="chart">
        <h3>Process chart</h3>
        <table>
          <tr><td>BUF</td><td>Visitor steps in</td><td>2–8 S</td></tr>
          <tr class="on"><td>DEV</td><td>Incoming call</td><td>05–13</td></tr>
          <tr><td>STOP</td><td>Overexposure</td><td>13–21</td></tr>
          <tr><td>FIX</td><td>Main breaker</td><td>21–30</td></tr>
          <tr><td>WASH</td><td>Replay · CCTV</td><td>+41.5</td></tr>
        </table>
        <span class="grease">30 s exactly!</span>
        <p>Times are story seconds inside the 30-second exposure.</p>
      </aside>
    </div>
    ${filmStrip(21, 'bottom')}
  </div>`;
}
