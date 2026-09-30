'use strict';

/**
 * Runs the engineer view with no PC, game or server (e.g. on an iPhone). Only
 * active when the page sets window.LMU_DEMO = true or the URL has ?demo: it
 * replaces the page's WebSocket with a fake one fed by the shared race simulator
 * (public/race-sim.js, the same one the server uses for its simulator), sending
 * the messages the server sends: hello, telemetry (per 0.1 s of session time)
 * and standings. Adds session, speed and race control buttons to the header.
 */
(function () {
  const params = new URLSearchParams(location.search);
  if (!window.LMU_DEMO && !params.has('demo')) return;
  if (!window.RaceSim) { console.error('race-sim.js must load before demo-sim.js'); return; }
  const { SESSIONS, LAP_M } = window.RaceSim;
  const sim = window.RaceSim.createRaceSim();

  // ---------- fake WebSocket ----------
  const DT = 0.1;
  let speed = 1;
  let listeners = [];
  let started = false;
  const send = (type, data) => {
    const ev = { data: JSON.stringify({ type, data }) };
    for (const l of listeners) l(ev);
  };

  /** Start a session and pre-run it until you have a clean flying lap, so the traces have a reference. */
  function begin(kind) {
    sim.start(kind);
    // Race: start on the grid. Practice / quali: from the garage, out lap + 1 flying lap + a bit
    if (kind === 'race') send('telemetry', sim.snapshot());
    else while (sim.internals().player.D < LAP_M * 2.35 && sim.t < 900) { sim.step(DT); send('telemetry', sim.snapshot()); }
    send('standings', sim.standings());
    updateControls();
  }

  class DemoSocket {
    constructor() {
      this.handlers = {};
      setTimeout(() => {
        this.emit('open', {});
        listeners.push((ev) => this.emit('message', ev));
        send('hello', { connected: true, live: true, source: 'mock', message: 'Demo', tireReference: { optimalMinC: 80, optimalMaxC: 100 } });
        if (!started) { started = true; begin(initialSession()); }
        start();
      }, 0);
    }
    emit(type, ev) { (this.handlers[type] || []).forEach((f) => f(ev)); }
    addEventListener(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }
    send() {}
    close() {}
  }
  window.WebSocket = DemoSocket;
  // Test hook: jump the session forward (sends every 10th frame on the way)
  window.__lmuDemo = {
    skipTo(sec) {
      let n = 0;
      while (sim.t < sec && !sim.allParked()) { sim.step(DT); if (++n % 10 === 0) send('telemetry', sim.snapshot()); }
      send('standings', sim.standings());
    },
    begin,
    // run `sec` more seconds of session time (every frame sent)
    stepFor(sec) { const end = sim.t + sec; while (sim.t < end && !sim.allParked()) { sim.step(DT); send('telemetry', sim.snapshot()); } },
  };

  /** Session from the link (#practice, #qualifying, #race), else the last one picked in this tab, else the race. */
  function initialSession() {
    const fromHash = location.hash.replace('#', '');
    if (SESSIONS[fromHash]) return fromHash;
    try {
      const saved = sessionStorage.getItem('lmuDemoSession');
      if (SESSIONS[saved]) return saved;
    } catch { /* storage blocked */ }
    return 'race';
  }

  let timer = null, standingsTimer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      // After the flag, keep running until every car has finished; you stay parked
      if (sim.allParked()) { send('telemetry', sim.snapshot()); return; }
      for (let i = 0; i < speed && !sim.allParked(); i++) { sim.step(DT); send('telemetry', sim.snapshot()); }
    }, 100);
    standingsTimer = setInterval(() => send('standings', sim.standings()), 1000);
  }

  // ---------- demo controls in the header ----------
  function controls() {
    const links = document.querySelector('header .links');
    if (!links) return;
    for (const a of links.querySelectorAll('a')) a.hidden = true; // no driver view or control panel in the demo
    const css = document.createElement('style');
    css.textContent = `
      header { flex-wrap: wrap; }
      .demo-ctl { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; flex: 1 0 100%; padding: 6px 12px; border-top: 1px solid var(--line); }
      .demo-ctl .k { margin-right: 2px; }
      .demo-ctl button {
        font: 700 10px/1 "Segoe UI", system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase;
        color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius);
        padding: 6px 8px; cursor: pointer; min-height: 28px;
      }
      .demo-ctl button:hover, .demo-ctl button:focus-visible { color: var(--text); border-color: var(--faint); outline: none; }
      .demo-ctl button[aria-pressed="true"] { color: var(--text); border-color: var(--text); }
      .demo-ctl .sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }`;
    document.head.appendChild(css);
    const box = document.createElement('div');
    box.className = 'demo-ctl';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Simulator controls');
    box.innerHTML = `<span class="k">Session</span>
      <button type="button" id="demoPractice" data-session="practice" aria-pressed="false">Practice</button>
      <button type="button" id="demoQualifying" data-session="qualifying" aria-pressed="false">Quali</button>
      <button type="button" id="demoRace" data-session="race" aria-pressed="false">Race</button>
      <span class="sep"></span>
      <span class="k">Speed</span>
      <button type="button" id="demoX1" aria-pressed="true">1×</button>
      <button type="button" id="demoX4" aria-pressed="false">4×</button>
      <button type="button" id="demoX10" aria-pressed="false">10×</button>
      <span class="sep"></span>
      <span class="k">Race control</span>
      <button type="button" id="demoYellow">Yellow</button>
      <button type="button" id="demoFcy">FCY</button>
      <button type="button" id="demoSc">SC</button>
      <button type="button" id="demoGreen">Green</button>
      <span class="sep"></span>
      <button type="button" id="demoRestart">Restart</button>`;
    links.closest('header').appendChild(box); // its own row under the timing bar
    for (const [id, x] of [['demoX1', 1], ['demoX4', 4], ['demoX10', 10]]) {
      document.getElementById(id).addEventListener('click', () => {
        speed = x;
        for (const b of ['demoX1', 'demoX4', 'demoX10']) document.getElementById(b).setAttribute('aria-pressed', String(b === id));
      });
    }
    document.getElementById('demoYellow').addEventListener('click', () => sim.callRaceControl('yellow'));
    document.getElementById('demoFcy').addEventListener('click', () => sim.callRaceControl('fcy'));
    document.getElementById('demoSc').addEventListener('click', () => sim.callRaceControl('sc'));
    document.getElementById('demoGreen').addEventListener('click', () => sim.clearFlags());
    document.getElementById('demoRestart').addEventListener('click', () => begin(sim.session));
    for (const b of box.querySelectorAll('[data-session]')) {
      b.addEventListener('click', () => {
        try { sessionStorage.setItem('lmuDemoSession', b.dataset.session); } catch { /* storage blocked */ }
        begin(b.dataset.session);
      });
    }
    updateControls();
  }

  /** Session buttons show the current one; FCY and safety car only exist in the race. */
  function updateControls() {
    for (const b of document.querySelectorAll('.demo-ctl [data-session]')) b.setAttribute('aria-pressed', String(b.dataset.session === sim.session));
    for (const id of ['demoFcy', 'demoSc']) {
      const b = document.getElementById(id);
      if (b) b.hidden = sim.session !== 'race';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', controls);
  else controls();
})();
