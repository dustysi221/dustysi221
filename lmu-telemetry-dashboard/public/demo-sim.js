'use strict';

/**
 * In-browser race simulator for the engineer view, so the dashboard can run
 * with no PC, no game and no server (e.g. on an iPhone). It is only active
 * when the page sets window.LMU_DEMO = true or the URL has ?demo, and then
 * replaces the page's WebSocket with a fake one that delivers the same
 * messages the server sends: hello, telemetry (per 0.1 s of race time) and
 * standings.
 *
 * The lap is modelled from a real-looking circuit: corners with apex speeds
 * and turn angles, braking at ~3 g into each apex and speed-limited
 * acceleration out of it. The track outline comes from integrating the turn
 * angles, so the map matches the traces. Each lap varies a little (driver
 * noise, tire wear), so the live delta and sector colors mean something.
 */
(function () {
  const params = new URLSearchParams(location.search);
  if (!window.LMU_DEMO && !params.has('demo')) return;

  // ---------- circuit ----------
  const LAP_M = 5400;
  const DS = 5; // profile resolution, meters
  const N = LAP_M / DS;
  const SPLITS = [1800, 3600]; // sector 2 and 3 start
  // apex distance (m), apex speed (km/h), turn angle (deg, + = right), corner length (m)
  const CORNERS = [
    { d: 450, v: 92, a: 150, len: 60 },
    { d: 900, v: 158, a: -60, len: 50 },
    { d: 1250, v: 212, a: 45, len: 60 },
    { d: 1700, v: 118, a: -90, len: 35 },
    { d: 1790, v: 114, a: 80, len: 35 },
    { d: 2600, v: 252, a: 35, len: 90 },
    { d: 3300, v: 138, a: 100, len: 55 },
    { d: 3700, v: 178, a: -70, len: 50 },
    { d: 4300, v: 84, a: 140, len: 55 },
    { d: 5050, v: 232, a: 30, len: 80 },
  ];
  const VMAX = 330 / 3.6;
  const BRAKE = 21; // m/s², a little over 2 g on average through the braking zone
  const GEAR_TOP = [0, 98, 138, 172, 208, 246, 286, 336]; // km/h at the limiter

  // seeded noise so every lap differs a little but a reload replays the same race
  function rand(seed) {
    let x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  /** Speed and inputs for one lap. `lapNo` seeds the variation; `wear` 0..1 costs grip. */
  function buildProfile(lapNo, wear, paceFactor) {
    const corners = CORNERS.map((c, i) => ({
      ...c,
      v: (c.v * (1 + (rand(lapNo * 31 + i) - 0.5) * 0.025) * (1 - wear * 0.02)) / paceFactor / 3.6,
    }));
    const brake = BRAKE * (1 + (rand(lapNo * 7 + 99) - 0.5) * 0.06);
    const cap = new Float64Array(N).fill(VMAX);
    for (const c of corners) {
      for (let k = -Math.round(c.len / 2); k <= Math.round(c.len / 2); k += DS) {
        const i = (((Math.round((c.d + k) / DS)) % N) + N) % N;
        cap[i] = Math.min(cap[i], c.v);
      }
    }
    // three laps back to back so the start/finish line joins smoothly
    const M = N * 3;
    const v = new Float64Array(M);
    for (let i = 0; i < M; i++) v[i] = cap[i % N];
    const acc = (s) => Math.max(1.2, 10.5 * (1 - s / VMAX));
    for (let i = 1; i < M; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * acc(v[i - 1]) * DS));
    for (let i = M - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * brake * DS));
    const speed = v.slice(N, 2 * N);
    const next = (i) => speed[(i + 1) % N];
    const out = { speed, thr: new Float64Array(N), brk: new Float64Array(N), along: new Float64Array(N) };
    for (let i = 0; i < N; i++) {
      const a = (next(i) ** 2 - speed[i] ** 2) / (2 * DS);
      out.along[i] = a;
      if (a < -4) { out.brk[i] = Math.min(1, -a / brake) * 0.96; out.thr[i] = 0; }
      else if (a > acc(speed[i]) * 0.6) { out.thr[i] = 1; }
      else out.thr[i] = speed[i] >= VMAX - 0.5 ? 1 : 0.35 + 0.25 * Math.max(0, a) / acc(speed[i]);
    }
    return out;
  }

  // Heading (turn angles spread over each corner) and the outline it traces
  const heading = new Float64Array(N);
  const curvature = new Float64Array(N);
  const steerShape = new Float64Array(N);
  {
    for (let i = 0; i < N; i++) {
      const d = i * DS;
      let h = 0, k = 0, st = 0;
      for (const c of CORNERS) {
        const w = c.len * 0.9 + 25;
        const rad = (c.a * Math.PI) / 180;
        // heading: a running sum over the lap (no wrap), so it ends at exactly one full turn
        const th = Math.tanh((1.6 * (d - c.d)) / w);
        h += rad * (0.5 + 0.5 * th);
        k += ((rad * 0.8) / w) * (1 - th * th);
        // steering: a bell around each apex, wrapped across the start/finish line
        let dd = d - c.d;
        if (dd > LAP_M / 2) dd -= LAP_M;
        if (dd < -LAP_M / 2) dd += LAP_M;
        st += Math.sign(c.a) * Math.min(1, 0.12 + Math.abs(c.a) / 170) * Math.exp(-((dd / w) ** 2));
      }
      heading[i] = h;
      curvature[i] = k;
      steerShape[i] = Math.max(-1, Math.min(1, st));
    }
  }
  const outline = [];
  {
    let x = 0, z = 0;
    const pts = [];
    for (let i = 0; i < N; i++) {
      pts.push([x, z]);
      x += Math.sin(heading[i]) * DS;
      z += Math.cos(heading[i]) * DS;
    }
    // close the loop: spread the leftover gap evenly along the lap
    for (let i = 0; i < N; i++) outline.push([pts[i][0] - (x * i) / N, pts[i][1] - (z * i) / N]);
  }
  const posAt = (d) => {
    const i = ((Math.floor(d / DS) % N) + N) % N;
    return outline[i];
  };
  const at = (arr, d) => {
    const f = ((d % LAP_M) + LAP_M) % LAP_M / DS;
    const i = Math.floor(f), j = (i + 1) % N, t = f - i;
    return arr[i] * (1 - t) + arr[j] * t;
  };

  // ---------- race ----------
  const RACE_SEC = 90 * 60;
  const PLAYER = { id: 7, car: 'Hypercar #7', driver: 'You', cls: 'Hypercar', pace: 1, grid: 0 };
  const FIELD = [
    { id: 50, car: '#50 Ferrari 499P', driver: 'A. Fuoco', cls: 'Hypercar', pace: 0.994, grid: 30 },
    { id: 6, car: '#6 Porsche 963', driver: 'K. Estre', cls: 'Hypercar', pace: 0.999, grid: 15 },
    PLAYER,
    { id: 8, car: '#8 Toyota GR010', driver: 'S. Buemi', cls: 'Hypercar', pace: 1.007, grid: -15 },
    { id: 51, car: '#51 Ferrari 499P', driver: 'A. Pier Guidi', cls: 'Hypercar', pace: 1.011, grid: -30 },
    { id: 92, car: '#92 Porsche 911 GT3 R', driver: 'K. Malykhin', cls: 'LMGT3', pace: 1.086, grid: -70 },
    { id: 77, car: '#77 Ford Mustang GT3', driver: 'B. Barker', cls: 'LMGT3', pace: 1.093, grid: -85 },
    { id: 31, car: '#31 BMW M4 GT3', driver: 'A. Farfus', cls: 'LMGT3', pace: 1.097, grid: -100 },
  ];
  const baseProfile = buildProfile(0, 0, 1);
  const profiles = new Map();
  function playerProfile(lapNo) {
    if (!profiles.has(lapNo)) {
      profiles.set(lapNo, buildProfile(lapNo + 1, Math.min(1, lapNo / 30), 1));
      for (const k of profiles.keys()) if (k < lapNo - 2) profiles.delete(k);
    }
    return profiles.get(lapNo);
  }

  const state = {
    t: 0,
    cars: FIELD.map((c) => ({ ...c, D: c.grid, lapStart: 0, lastLap: null, bestLap: null, laps: 0, secT: [], lastSecs: null, v: 0 })),
    fuel: 88,
    tires: Object.fromEntries(['FL', 'FR', 'RL', 'RR'].map((k) => [k, { mid: 45, carcass: 40, brake: 120, wear: 0 }])),
    rc: { kind: 'green', until: 0, stopped: null, sectors: [false, false, false] },
    greenQueued: false,
  };
  const player = state.cars.find((c) => c.id === PLAYER.id);

  // Scripted race control, repeating every 15 minutes of race time; buttons can call one any time
  const SCRIPT = [
    { at: 300, kind: 'yellow', dur: 70 },
    { at: 470, kind: 'fcy', dur: 90 },
    { at: 650, kind: 'sc', dur: 150 },
  ];
  function callRaceControl(kind, dur) {
    const rc = state.rc;
    rc.kind = kind;
    rc.until = state.t + (dur || { yellow: 70, fcy: 90, sc: 150 }[kind] || 60);
    rc.sectors = [false, false, false];
    rc.stopped = null;
    rc.started = state.t;
    if (kind === 'yellow') {
      // the last car on track stops in the sector it's in
      const victim = [...state.cars].filter((c) => c !== player).sort((a, b) => a.D - b.D)[0];
      rc.stopped = victim.id;
      const d = ((victim.D % LAP_M) + LAP_M) % LAP_M;
      rc.sectors[d < SPLITS[0] ? 0 : d < SPLITS[1] ? 1 : 2] = true;
    }
    if (kind === 'sc') rc.scD = leader().D + 120;
  }
  const leader = () => state.cars.reduce((a, b) => (b.D > a.D ? b : a));
  const limitKph = () => (state.rc.kind === 'fcy' ? 80 : state.rc.kind === 'sc' ? 120 : Infinity);

  function step(dt) {
    state.t += dt;
    const cycle = state.t % 900;
    for (const s of SCRIPT) if (cycle >= s.at && cycle - dt < s.at && state.rc.kind === 'green') callRaceControl(s.kind, s.dur);
    if (state.rc.kind !== 'green' && state.t >= state.rc.until) { state.rc.kind = 'green'; state.rc.stopped = null; state.rc.sectors = [false, false, false]; }

    const cap = limitKph() / 3.6;
    if (state.rc.kind === 'sc') state.rc.scD += Math.min(cap, at(baseProfile.speed, state.rc.scD)) * dt;
    for (const c of state.cars) {
      const lapNo = Math.max(0, Math.floor(c.D / LAP_M));
      const prof = c === player ? playerProfile(lapNo) : baseProfile;
      let v = at(prof.speed, c.D) / (c === player ? 1 : c.pace);
      if (c.D < 0) v = Math.min(v, 45); // rolling off the grid
      v = Math.min(v, cap);
      if (state.rc.stopped === c.id) v = 0;
      c.v = v;
      const before = c.D;
      c.D += v * dt;
      // sector and lap timing
      const lapBefore = Math.floor(before / LAP_M), lapAfter = Math.floor(c.D / LAP_M);
      const inLapBefore = before - lapBefore * LAP_M, inLap = c.D - lapAfter * LAP_M;
      // exact crossing time within the step, so times aren't rounded to the 0.1 s step
      const crossAt = (mark) => state.t - dt + (dt * (mark - before)) / Math.max(1e-6, c.D - before);
      for (const sp of SPLITS) {
        if (lapAfter === lapBefore && inLapBefore < sp && inLap >= sp) c.secT.push(crossAt(lapBefore * LAP_M + sp) - c.lapStart);
      }
      if (lapAfter > lapBefore) {
        const lineT = crossAt(lapAfter * LAP_M);
        const lapTime = lineT - c.lapStart;
        if (lapBefore >= 0) { // cars that started behind the line don't get a lap time for the run to it
          c.lastLap = lapTime;
          if (c.secT.length === 2) c.lastSecs = [c.secT[0], c.secT[1] - c.secT[0], lapTime - c.secT[1]];
          if (!c.bestLap || lapTime < c.bestLap) c.bestLap = lapTime;
        }
        c.laps = Math.max(0, lapAfter);
        c.lapStart = lineT;
        c.secT = [];
        if (c === player) state.fuel = Math.max(2, state.fuel - 1.62);
      }
    }
    updateTires(dt);
  }

  function inputs() {
    const c = player;
    const lapNo = Math.max(0, Math.floor(c.D / LAP_M));
    const prof = playerProfile(lapNo);
    const kph = c.v * 3.6;
    // Held below the lap's natural speed by race control (FCY / SC limit) or stopped
    const limited = state.rc.stopped === c.id || kph >= limitKph() - 0.5;
    const thr = limited ? (state.rc.stopped === c.id ? 0 : 0.22) : at(prof.thr, c.D);
    const brk = limited ? 0 : at(prof.brk, c.D);
    let gear = 1;
    while (gear < 7 && kph > GEAR_TOP[gear] * 0.965) gear++;
    const rpm = Math.max(3200, Math.min(8650, (kph / GEAR_TOP[gear]) * 8650));
    const steer = at(steerShape, c.D) * (limited ? 0.85 : 1);
    const gLat = Math.max(-3.2, Math.min(3.2, (c.v ** 2 * at(curvature, c.D)) / 9.81));
    const gLong = limited ? 0 : Math.max(-3.2, Math.min(1.2, at(prof.along, c.D) / 9.81));
    return { kph, thr, brk, gear, rpm, steer, gLat, gLong };
  }

  let last = null;
  function updateTires(dt) {
    const x = (last = inputs());
    for (const [k, t] of Object.entries(state.tires)) {
      const left = k.endsWith('L'), front = k.startsWith('F');
      const load = 1 + 0.09 * x.gLat * (left ? 1 : -1) + 0.07 * -x.gLong * (front ? 1 : -1);
      const target = 58 + 30 * load * Math.min(1, x.kph / 230) + t.wear * 0.08;
      t.mid += (target - t.mid) * Math.min(1, dt / 9);
      t.carcass += (t.mid - 6 - t.carcass) * Math.min(1, dt / 40);
      const bTarget = 260 + (front ? 520 : 380) * x.brk;
      t.brake += (bTarget - t.brake) * Math.min(1, dt / (x.brk > 0.1 ? 1.2 : 5));
      t.wear += (({ FL: 1.05, FR: 0.85, RL: 0.75, RR: 0.7 })[k] * x.kph * dt) / 3.6 / LAP_M * (state.rc.kind === 'green' ? 1 : 0.2);
    }
  }

  const r = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

  function snapshot() {
    const c = player;
    const x = last || inputs();
    const d = ((c.D % LAP_M) + LAP_M) % LAP_M;
    const [px, pz] = posAt(c.D);
    const order = [...state.cars].sort((a, b) => b.D - a.D);
    const sectorNow = d < SPLITS[0] ? 1 : d < SPLITS[1] ? 2 : 3;
    const cur = [c.secT[0] ?? null, c.secT.length > 1 ? c.secT[1] - c.secT[0] : null, null];
    const rc = state.rc;
    const flagsState = rc.kind === 'yellow' ? 'localYellow' : rc.kind === 'fcy' ? 'fcy' : rc.kind === 'sc' ? 'safetyCar' : 'green';
    const fcElapsed = state.t - (rc.started || 0), fcLeft = rc.until - state.t;
    const yellowState = rc.kind === 'fcy' || rc.kind === 'sc'
      ? fcElapsed < 12 ? 'pending' : fcElapsed < 35 ? 'pitsClosed' : fcLeft < 10 ? 'resume' : fcLeft < 45 ? 'lastLap' : 'pitsOpen'
      : null;
    const tires = {};
    for (const [k, t] of Object.entries(state.tires)) {
      const front = k.startsWith('F');
      const inner = t.mid + (front ? 4.5 : 3), outer = t.mid - 1.5;
      const psi = 23.4 + (t.mid - 20) * 0.047;
      tires[k] = {
        pressureKpa: r(psi / 0.145038, 1),
        temps: { innerC: r(inner), middleC: r(t.mid), outerC: r(outer) },
        surfaceTempC: r((inner + t.mid + outer) / 3),
        carcassTempC: r(t.carcass),
        wearPercent: r(t.wear, 2),
        remainingPercent: r(100 - t.wear, 2),
        brakeTempC: r(t.brake, 0),
        flat: false,
        detached: false,
      };
    }
    return {
      session: {
        trackName: 'Demo Circuit · 5.4 km',
        type: 'race',
        phase: rc.kind === 'fcy' || rc.kind === 'sc' ? 'fullCourseYellow' : 'green',
        elapsedSec: r(state.t, 1),
        endSec: RACE_SEC,
        maxLaps: null,
        lapDistanceM: LAP_M,
        ambientTempC: 24,
        trackTempC: 36,
        raining: 0,
      },
      vehicle: {
        name: c.car,
        class: c.cls,
        driver: c.driver,
        lap: c.laps + 1,
        lapsCompleted: c.laps,
        position: order.indexOf(c) + 1,
        classPosition: order.filter((o) => o.cls === c.cls).indexOf(c) + 1,
        lastLapSec: c.lastLap ? r(c.lastLap, 3) : null,
        bestLapSec: c.bestLap ? r(c.bestLap, 3) : null,
        lapDistanceM: r(Math.max(0, c.D < 0 ? 0 : d), 0),
        scoringLapBehind: false,
        currentLapSec: r(state.t - c.lapStart, 3),
        inPits: false,
        inGarage: false,
        pitStops: 0,
        speedKph: r(x.kph, 1),
        gear: x.gear,
        rpm: r(x.rpm, 0),
        maxRpm: 8700,
        throttle: r(x.thr, 3),
        brake: r(x.brk, 3),
        steering: r(x.steer, 3),
        gLat: r(x.gLat, 2),
        gLong: r(x.gLong, 2),
        posX: r(px, 1),
        posZ: r(pz, 1),
        sectors: { current: sectorNow, currentLap: cur.map((v) => (v == null ? null : r(v, 3))), lastLap: (c.lastSecs || [null, null, null]).map((v) => (v == null ? null : r(v, 3))) },
        fuelL: r(state.fuel, 2),
        fuelCapacityL: 90,
        frontCompound: 'Medium',
        rearCompound: 'Medium',
      },
      tires,
      damage: { maxDentSeverity: 0, dentedZones: {}, partsDetached: false, flatTires: [], detachedWheels: [] },
      flags: {
        state: flagsState,
        sectorYellow: rc.sectors,
        yellowState,
        safetyCar: rc.kind === 'sc' ? { lapDistM: r(((rc.scD % LAP_M) + LAP_M) % LAP_M, 0), speedKph: 120 } : null,
        yellowLaps: rc.kind === 'fcy' || rc.kind === 'sc' ? 2 : null,
        rulesAvailable: true,
        slowCars: rc.stopped ? [rc.stopped] : [],
      },
      live: true,
      source: 'mock',
      timestamp: Date.now(),
    };
  }

  function standings() {
    const order = [...state.cars].sort((a, b) => b.D - a.D);
    const lead = order[0];
    return order.map((c, i) => {
      const behindM = lead.D - c.D;
      const lapsDown = Math.floor(behindM / LAP_M);
      const [x, z] = posAt(c.D);
      return {
        id: c.id,
        pos: i + 1,
        class: c.cls,
        car: c.car,
        driver: c.driver,
        you: c === player || undefined,
        laps: c.laps,
        lastLapSec: c.lastLap ? r(c.lastLap, 3) : null,
        bestLapSec: c.bestLap ? r(c.bestLap, 3) : null,
        gapToLeaderSec: i === 0 ? 0 : r(behindM / Math.max(20, lead.v || 50), 3),
        lapsDown,
        inPits: undefined,
        pitStops: 0,
        x: r(x, 1),
        z: r(z, 1),
        lapDistM: r(((c.D % LAP_M) + LAP_M) % LAP_M, 0),
        speedKph: r(c.v * 3.6, 0),
      };
    });
  }

  // ---------- fake WebSocket ----------
  const DT = 0.1;
  let speed = 1;
  let listeners = [];
  const send = (type, data) => {
    const ev = { data: JSON.stringify({ type, data }) };
    for (const l of listeners) l(ev);
  };

  class DemoSocket {
    constructor() {
      this.handlers = {};
      setTimeout(() => {
        this.emit('open', {});
        listeners.push((ev) => this.emit('message', ev));
        send('hello', { connected: true, live: true, source: 'mock', message: 'Demo', tireReference: { optimalMinC: 80, optimalMaxC: 100 } });
        // Pre-run the first laps so the traces, best lap and sectors are there from the start
        if (!state.prerolled) {
          state.prerolled = true;
          while (player.D < LAP_M * 2.35 && state.t < 600) { step(DT); send('telemetry', snapshot()); }
          send('standings', standings());
        }
        start();
      }, 0);
    }
    emit(type, ev) { (this.handlers[type] || []).forEach((f) => f(ev)); }
    addEventListener(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }
    send() {}
    close() {}
  }
  window.WebSocket = DemoSocket;

  let timer = null, standingsTimer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (state.t >= RACE_SEC) return;
      for (let i = 0; i < speed; i++) { step(DT); send('telemetry', snapshot()); }
    }, 100);
    standingsTimer = setInterval(() => send('standings', standings()), 1000);
  }

  // ---------- demo controls in the header ----------
  function controls() {
    const links = document.querySelector('header .links');
    if (!links) return;
    for (const a of links.querySelectorAll('a')) a.hidden = true; // no driver view or control panel in the demo
    const css = document.createElement('style');
    css.textContent = `
      .demo-ctl { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
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
    box.innerHTML = `<span class="k">Speed</span>
      <button type="button" id="demoX1" aria-pressed="true">1×</button>
      <button type="button" id="demoX4" aria-pressed="false">4×</button>
      <button type="button" id="demoX10" aria-pressed="false">10×</button>
      <span class="sep"></span>
      <span class="k">Race control</span>
      <button type="button" id="demoYellow">Yellow</button>
      <button type="button" id="demoFcy">FCY</button>
      <button type="button" id="demoSc">SC</button>
      <button type="button" id="demoGreen">Green</button>`;
    links.appendChild(box);
    for (const [id, x] of [['demoX1', 1], ['demoX4', 4], ['demoX10', 10]]) {
      document.getElementById(id).addEventListener('click', () => {
        speed = x;
        for (const b of ['demoX1', 'demoX4', 'demoX10']) document.getElementById(b).setAttribute('aria-pressed', String(b === id));
      });
    }
    document.getElementById('demoYellow').addEventListener('click', () => callRaceControl('yellow'));
    document.getElementById('demoFcy').addEventListener('click', () => callRaceControl('fcy'));
    document.getElementById('demoSc').addEventListener('click', () => callRaceControl('sc'));
    document.getElementById('demoGreen').addEventListener('click', () => { state.rc.until = state.t; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', controls);
  else controls();
})();
