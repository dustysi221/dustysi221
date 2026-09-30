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
  const nearest = (arr, d) => arr[Math.round((((d % LAP_M) + LAP_M) % LAP_M) / DS) % N];
  const at = (arr, d) => {
    const f = ((d % LAP_M) + LAP_M) % LAP_M / DS;
    const i = Math.floor(f), j = (i + 1) % N, t = f - i;
    return arr[i] * (1 - t) + arr[j] * t;
  };

  // ---------- sessions ----------
  const SESSIONS = {
    practice: { label: 'Practice', type: 'practice', sec: 60 * 60 },
    qualifying: { label: 'Quali', type: 'qualifying', sec: 15 * 60 },
    race: { label: 'Race', type: 'race', sec: 90 * 60 },
  };
  // The pit lane runs alongside the main straight: in at 5100 m, garages at 5250 m, out at 300 m
  const PIT_IN = 5100, PIT_BOX = 5250, PIT_OUT = 300, PIT_KPH = 60;
  // Pace on each kind of lap, relative to a normal flying lap
  const KIND_PACE = { race: 1, run: 1.004, push: 0.993, out: 1.07, cool: 1.16, in: 1.09 };
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
      profiles.set(lapNo, buildProfile(lapNo + 1, Math.min(1, state.tireLaps / 30), 1));
      for (const k of profiles.keys()) if (k < lapNo - 2) profiles.delete(k);
    }
    return profiles.get(lapNo);
  }

  let session = 'race';
  let state, player;
  let runNo = 0; // seeds each run's plan

  /** What a car does after leaving the garage: the kinds of lap it drives before boxing again. */
  function runPlan(c) {
    runNo++;
    if (session === 'qualifying') return ['out', 'push', 'push', 'cool', 'in'];
    const flying = 4 + Math.floor(rand(c.id * 13 + runNo) * 4); // 4-7 laps
    return ['out', ...Array(flying).fill('run'), 'in'];
  }
  function garageTime(c) {
    return session === 'qualifying' ? 100 + rand(c.id + runNo) * 80 : 60 + rand(c.id * 3 + runNo) * 180;
  }

  function newState(kind) {
    session = kind;
    runNo = 0;
    profiles.clear();
    const inGarage = kind !== 'race';
    const s = {
      t: 0,
      sec: SESSIONS[kind].sec,
      fuel: kind === 'race' ? 88 : kind === 'qualifying' ? 22 : 45,
      tireLaps: 0,
      tires: Object.fromEntries(['FL', 'FR', 'RL', 'RR'].map((k) => [k, { mid: inGarage ? 32 : 45, carcass: inGarage ? 30 : 40, brake: inGarage ? 60 : 120, wear: 0 }])),
      rc: { kind: 'green', until: 0, stopped: null, sectors: [false, false, false] },
      cars: FIELD.map((c, i) => ({
        ...c, lapStart: 0, lastLap: null, bestLap: null, laps: 0, secT: [], lastSecs: null, v: 0,
        kind: 'race', plan: null, planIdx: 0, pit: 'none', garageUntil: 0, noise: 1,
        // Race: on the grid. Practice / quali: in the garage, leaving at staggered times (you go first)
        D: inGarage ? PIT_BOX - LAP_M : c.grid,
      })),
    };
    for (const c of s.cars) {
      if (!inGarage) continue;
      c.pit = 'garage';
      c.garageUntil = c.id === PLAYER.id ? 0 : 5 + rand(c.id * 7 + (kind === 'qualifying' ? 1 : 2)) * (kind === 'qualifying' ? 90 : 240);
    }
    return s;
  }
  function startSession(kind) {
    state = newState(kind);
    player = state.cars.find((c) => c.id === PLAYER.id);
    last = null;
  }

  // Scripted race control, repeating every 15 minutes; buttons can call one any time.
  // FCY and safety car only happen in the race.
  const SCRIPT = [
    { at: 300, kind: 'yellow', dur: 70 },
    { at: 470, kind: 'fcy', dur: 90, raceOnly: true },
    { at: 650, kind: 'sc', dur: 150, raceOnly: true },
  ];
  function callRaceControl(kind, dur) {
    if ((kind === 'fcy' || kind === 'sc') && session !== 'race') return;
    const rc = state.rc;
    rc.kind = kind;
    rc.until = state.t + (dur || { yellow: 70, fcy: 90, sc: 150 }[kind] || 60);
    rc.sectors = [false, false, false];
    rc.stopped = null;
    rc.started = state.t;
    if (kind === 'yellow') {
      // one of the three rearmost cars on track (taking turns) stops in the sector it's in
      state.yellows = (state.yellows || 0) + 1;
      const onTrack = state.cars.filter((c) => c !== player && c.pit === 'none' && !c.finished).sort((a, b) => a.D - b.D);
      if (!onTrack.length) { rc.kind = 'green'; return; }
      const victim = onTrack[state.yellows % Math.min(3, onTrack.length)];
      rc.stopped = victim.id;
      const d = ((victim.D % LAP_M) + LAP_M) % LAP_M;
      rc.sectors[d < SPLITS[0] ? 0 : d < SPLITS[1] ? 1 : 2] = true;
    }
    if (kind === 'sc') rc.scD = leader().D + 120;
  }
  const allFinished = () => state.cars.every((c) => c.finished);
  const leader = () => state.cars.reduce((a, b) => (b.D > a.D ? b : a));
  const limitKph = () => (state.rc.kind === 'fcy' ? 80 : state.rc.kind === 'sc' ? 120 : Infinity);
  const inLapM = (D) => ((D % LAP_M) + LAP_M) % LAP_M;

  /** Classification: race by distance run; practice and qualifying by best lap (no time = at the back). */
  function classification() {
    if (session === 'race') return [...state.cars].sort((a, b) => b.D - a.D);
    return [...state.cars].sort((a, b) => (a.bestLap || Infinity) - (b.bestLap || Infinity) || FIELD.findIndex((f) => f.id === a.id) - FIELD.findIndex((f) => f.id === b.id));
  }

  function finish(c, atD, when) {
    c.finished = true;
    c.finishT = when;
    c.v = 0;
    state.finishers = (state.finishers || 0) + 1;
    c.D = atD - state.finishers * 0.01; // park in finishing order
  }

  function step(dt) {
    state.t += dt;
    const timeUp = state.t >= state.sec;
    const cycle = state.t % 900;
    for (const s of SCRIPT) {
      if (s.raceOnly && session !== 'race') continue;
      if (cycle >= s.at && cycle - dt < s.at && state.rc.kind === 'green' && state.t < state.sec - 120) callRaceControl(s.kind, s.dur);
    }
    if (state.rc.kind !== 'green' && state.t >= state.rc.until) { state.rc.kind = 'green'; state.rc.stopped = null; state.rc.sectors = [false, false, false]; }
    // Practice / quali: at the flag, cars in the garage are done
    if (timeUp && session !== 'race') { state.chequered = true; for (const c of state.cars) if (!c.finished && c.pit === 'garage') finish(c, c.D, state.t); }

    const cap = limitKph() / 3.6;
    const sc = state.rc.kind === 'sc';
    if (sc) state.rc.scD += Math.min(cap, at(baseProfile.speed, state.rc.scD)) * dt;
    // Order on the road for the safety car queue (cars behind close up, nobody passes)
    const queue = sc ? [...state.cars].sort((a, b) => b.D - a.D) : null;
    for (const c of state.cars) {
      if (c.finished) { c.v = 0; continue; }
      if (c.pit === 'garage') {
        c.v = 0;
        if (state.t >= c.garageUntil) {
          c.pit = 'out';
          c.plan = runPlan(c);
          c.planIdx = -1; // becomes 0 (the out lap) when it crosses the line in the pit lane
          if (c === player) {
            state.fuel = session === 'qualifying' ? 22 : 45;
            state.tireLaps = 0;
            for (const t of Object.values(state.tires)) t.wear = 0;
          }
        } else continue;
      }
      const lapNo = Math.max(0, Math.floor(c.D / LAP_M));
      const prof = c === player ? playerProfile(lapNo) : baseProfile;
      let v = at(prof.speed, c.D) / (c === player ? 1 : c.pace) / KIND_PACE[c.kind] / c.noise;
      if (c.D < 0 && c.pit === 'none') v = Math.min(v, 45); // rolling off the grid
      let limit = cap;
      let maxD = Infinity;
      if (c.pit === 'none' && c.kind === 'in') {
        // brake down to the pit speed limit by the pit entry
        const toEntry = PIT_IN - inLapM(c.D);
        // look one step ahead so the car is at the limit when it reaches the line, not after
        if (toEntry >= 0 && toEntry < 600) limit = Math.min(limit, Math.sqrt((PIT_KPH / 3.6) ** 2 + 2 * BRAKE * 0.6 * Math.max(0, toEntry - 25 * dt * 3.6)));
      }
      if (c.pit !== 'none') {
        limit = Math.min(limit, PIT_KPH / 3.6);
        if (c.pit === 'in') maxD = Math.floor(c.D / LAP_M) * LAP_M + PIT_BOX; // stop at the garage
      }
      if (sc && c.pit === 'none') {
        const i = queue.indexOf(c);
        const ahead = i === 0 ? null : queue[i - 1];
        const target = ahead ? ahead.D - 25 : state.rc.scD - 60; // 25 m car spacing, 60 m to the safety car
        if (target - c.D > 15 && target - c.D < 1500) limit = 165 / 3.6; // close the gap to the car ahead (lapped cars far behind just hold the limit)
        maxD = Math.min(maxD, target);
      }
      v = Math.min(v, limit);
      if (state.rc.stopped === c.id) v = 0;
      const before = c.D;
      c.D = Math.max(before, Math.min(before + v * dt, maxD));
      c.v = (c.D - before) / dt;

      // pit lane: in on the in-lap, garage at the box, out past the pit exit
      const dNow = inLapM(c.D);
      if (c.pit === 'none' && c.kind === 'in' && dNow >= PIT_IN) c.pit = 'in';
      if (c.pit === 'in' && c.D >= maxD - 0.01) {
        c.garaged = true; // this lap won't get a time
        if (state.chequered) { finish(c, c.D, state.t); continue; }
        c.pit = 'garage';
        c.garageUntil = state.t + garageTime(c);
        c.v = 0;
        continue;
      }
      if (c.pit === 'out' && c.planIdx >= 0 && dNow >= PIT_OUT && dNow < PIT_IN) c.pit = 'none';

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
        // no time for the run to the line from the grid or garage, or for an out lap from the pits
        if (lapBefore >= 0 && !c.garaged && !c.outLap) {
          c.lastLap = lapTime;
          if (c.secT.length === 2) c.lastSecs = [c.secT[0], c.secT[1] - c.secT[0], lapTime - c.secT[1]];
          if (!c.bestLap || lapTime < c.bestLap) c.bestLap = lapTime;
        }
        c.garaged = false;
        c.outLap = c.pit === 'out'; // this new lap started in the pit lane
        c.laps = Math.max(0, lapAfter);
        c.lapStart = lineT;
        c.secT = [];
        c.noise = 1 + (rand(c.id * 97 + lapAfter) - 0.5) * 0.004;
        if (c.plan) {
          c.planIdx++;
          c.kind = c.plan[Math.min(c.planIdx, c.plan.length - 1)];
        }
        if (c === player) { state.fuel = Math.max(2, state.fuel - 1.62); state.tireLaps++; }
        // Time is up: race leader first, then everyone as they cross; practice / quali everyone at their next crossing
        if (timeUp && lapBefore >= 0 && (session !== 'race' || state.chequered || c === leader())) {
          state.chequered = true;
          finish(c, lapAfter * LAP_M + 1, lineT);
        }
      }
    }
    updateTires(dt);
  }

  function inputs() {
    const c = player;
    if (c.pit === 'garage' || c.finished) return { kph: 0, thr: 0, brk: 0, gear: 1, rpm: 3200, steer: 0, gLat: 0, gLong: 0 };
    const lapNo = Math.max(0, Math.floor(c.D / LAP_M));
    const prof = playerProfile(lapNo);
    const kph = c.v * 3.6;
    // Held to a limit (FCY / SC / pit lane) or stopped
    const pitLimited = c.pit !== 'none' && kph >= PIT_KPH - 0.5;
    const limited = state.rc.stopped === c.id || pitLimited || kph >= limitKph() - 0.5;
    const easy = KIND_PACE[c.kind] > 1.05; // out, cool-down and in laps
    const thr = limited ? (state.rc.stopped === c.id ? 0 : 0.22) : nearest(prof.thr, c.D) * (easy ? 0.7 : 1);
    const brk = limited ? 0 : nearest(prof.brk, c.D) * (easy ? 0.75 : 1);
    let gear = 1;
    while (gear < 7 && kph > GEAR_TOP[gear] * 0.965) gear++;
    const rpm = Math.max(3200, Math.min(8650, (kph / GEAR_TOP[gear]) * 8650));
    const steer = at(steerShape, c.D) * (limited ? 0.85 : 1);
    const gLat = Math.max(-3.2, Math.min(3.2, (c.v ** 2 * at(curvature, c.D)) / 9.81));
    const gLong = limited ? 0 : Math.max(-3.2, Math.min(1.2, at(prof.along, c.D) / 9.81 / KIND_PACE[c.kind] ** 2));
    return { kph, thr, brk, gear, rpm, steer, gLat, gLong };
  }

  let last = null;
  function updateTires(dt) {
    const x = (last = inputs());
    for (const [k, t] of Object.entries(state.tires)) {
      const left = k.endsWith('L'), front = k.startsWith('F');
      const load = 1 + 0.09 * x.gLat * (left ? 1 : -1) + 0.07 * -x.gLong * (front ? 1 : -1);
      // parked: tires and brakes cool towards the air temperature
      const target = x.kph < 1 ? 30 : 58 + 30 * load * Math.min(1, x.kph / 230) + t.wear * 0.08;
      t.mid += (target - t.mid) * Math.min(1, dt / (x.kph < 1 ? 60 : 9));
      t.carcass += (t.mid - 6 - t.carcass) * Math.min(1, dt / 40);
      const bTarget = x.kph < 1 ? 40 : 260 + (front ? 520 : 380) * x.brk;
      t.brake += (bTarget - t.brake) * Math.min(1, dt / (x.brk > 0.1 ? 1.2 : 5));
      t.wear += (({ FL: 1.05, FR: 0.85, RL: 0.75, RR: 0.7 })[k] * x.kph * dt) / 3.6 / LAP_M * (state.rc.kind === 'green' ? 1 : 0.2);
    }
  }

  const r = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

  function snapshot() {
    const c = player;
    const x = last || inputs();
    const d = inLapM(c.D);
    const [px, pz] = posAt(c.D);
    const order = classification();
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
        type: SESSIONS[session].type,
        phase: player.finished ? 'over' : rc.kind === 'fcy' || rc.kind === 'sc' ? 'fullCourseYellow' : 'green',
        elapsedSec: r(state.t, 1),
        endSec: state.sec,
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
        lap: Math.floor(c.D / LAP_M) + 1, // 0 while in the garage or on the grid before the line
        lapsCompleted: c.laps,
        position: order.indexOf(c) + 1,
        classPosition: order.filter((o) => o.cls === c.cls).indexOf(c) + 1,
        lastLapSec: c.lastLap ? r(c.lastLap, 3) : null,
        bestLapSec: c.bestLap ? r(c.bestLap, 3) : null,
        lapDistanceM: c.D < 0 && c.pit === 'none' ? 0 : Math.floor(d),
        scoringLapBehind: false,
        currentLapSec: r(state.t - c.lapStart, 3),
        inPits: c.pit !== 'none',
        inGarage: c.pit === 'garage',
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
        frontCompound: session === 'qualifying' ? 'Soft' : 'Medium',
        rearCompound: session === 'qualifying' ? 'Soft' : 'Medium',
      },
      tires,
      damage: { maxDentSeverity: 0, dentedZones: {}, partsDetached: false, flatTires: [], detachedWheels: [] },
      flags: {
        state: flagsState,
        sectorYellow: rc.sectors,
        yellowState,
        safetyCar: rc.kind === 'sc' ? { lapDistM: Math.floor(inLapM(rc.scD)), speedKph: 120 } : null,
        yellowLaps: rc.kind === 'fcy' || rc.kind === 'sc' ? 2 : null,
        rulesAvailable: true,
        slowCars: rc.stopped ? [rc.stopped] : [],
      },
      live: true,
      source: 'mock',
      timestamp: Date.now(),
    };
  }

  /** Seconds behind the leader; after the flag it's finishing time (or time since the leader finished plus the run to the line). */
  function gapSec(c, lead, behindM, lapsDown) {
    if (!lead.finished || lapsDown > 0) return behindM / Math.max(20, lead.v || 50);
    if (c.finished) return c.finishT - lead.finishT;
    const toLine = (Math.floor(c.D / LAP_M) + 1) * LAP_M - c.D;
    return state.t - lead.finishT + toLine / Math.max(20, c.v);
  }

  function standings() {
    const order = classification();
    const lead = order[0];
    const race = session === 'race';
    return order.map((c, i) => {
      const behindM = lead.D - c.D;
      const lapsDown = race ? Math.floor(behindM / LAP_M) : 0;
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
        // Race: time behind on the road (finishing time after the flag). Practice / quali: best-lap difference
        gapToLeaderSec: i === 0 ? 0 : race ? r(gapSec(c, lead, behindM, lapsDown), 3) : c.bestLap && lead.bestLap ? r(c.bestLap - lead.bestLap, 3) : null,
        lapsDown,
        inPits: c.pit !== 'none' || undefined,
        pitStops: 0,
        x: r(x, 1),
        z: r(z, 1),
        lapDistM: Math.floor(inLapM(c.D)),
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

  /** Start a session and pre-run it until you have a clean flying lap, so the traces have a reference. */
  function begin(kind) {
    startSession(kind);
    // race: 2.35 laps from the grid; practice / quali: from the garage, out lap + 1 flying lap + a bit
    while (player.D < LAP_M * 2.35 && state.t < 900) { step(DT); send('telemetry', snapshot()); }
    send('standings', standings());
    updateControls();
  }

  class DemoSocket {
    constructor() {
      this.handlers = {};
      setTimeout(() => {
        this.emit('open', {});
        listeners.push((ev) => this.emit('message', ev));
        send('hello', { connected: true, live: true, source: 'mock', message: 'Demo', tireReference: { optimalMinC: 80, optimalMaxC: 100 } });
        if (!state) begin(initialSession());
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
      while (state.t < sec && !allFinished()) { step(DT); if (++n % 10 === 0) send('telemetry', snapshot()); }
      send('standings', standings());
    },
    begin,
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
      if (allFinished()) { send('telemetry', snapshot()); return; }
      for (let i = 0; i < speed && !allFinished(); i++) { step(DT); send('telemetry', snapshot()); }
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
    document.getElementById('demoYellow').addEventListener('click', () => callRaceControl('yellow'));
    document.getElementById('demoFcy').addEventListener('click', () => callRaceControl('fcy'));
    document.getElementById('demoSc').addEventListener('click', () => callRaceControl('sc'));
    document.getElementById('demoGreen').addEventListener('click', () => { state.rc.until = state.t; });
    document.getElementById('demoRestart').addEventListener('click', () => begin(session));
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
    for (const b of document.querySelectorAll('.demo-ctl [data-session]')) b.setAttribute('aria-pressed', String(b.dataset.session === session));
    for (const id of ['demoFcy', 'demoSc']) {
      const b = document.getElementById(id);
      if (b) b.hidden = session !== 'race';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', controls);
  else controls();
})();
