'use strict';

/**
 * Race simulator shared by the browser demo (public/demo-sim.js) and the server's
 * simulator source (src/raceSimSource.js), so both run exactly the same race:
 * a 5.4 km circuit built from corner apex speeds and turn angles, a braking and
 * acceleration model, lap-to-lap variation, tire temperatures and wear, fuel,
 * eight cars in two classes, practice / qualifying / race sessions with a pit
 * lane and garages, a rolling race start, and race control (local yellows, FCY,
 * safety car, chequered flag).
 *
 * createRaceSim() returns one independent simulation. snapshot() and standings()
 * give the same data the server sends the dashboards; internals() is for the
 * server, which turns it into rF2 shared-memory buffers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RaceSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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
  const GRID_SEC = 10, PACE_KPH = 110, LEAD_KPH = 90, GRID_GAP_M = 14;
  // Scripted race control, repeating every 15 minutes; buttons can call one any time.
  // FCY and safety car only happen in the race.
  const SCRIPT = [
    { at: 300, kind: 'yellow', dur: 70 },
    { at: 470, kind: 'fcy', dur: 90, raceOnly: true },
    { at: 650, kind: 'sc', dur: 150, raceOnly: true },
  ];
  const COOL_KPH = 100;
  const inLapM = (D) => ((D % LAP_M) + LAP_M) % LAP_M;
  const r = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
  /**
   * Queue behind a car (or the pace / safety car) `gapM` metres ahead: too close, ease off to its
   * speed; well behind (but within 1.5 km), close up at `closeKph`. Never closer than 4 m.
   */
  function follow(c, aheadD, aheadV, gapM, limit, closeKph) {
    const gap = aheadD - c.D;
    if (gap < gapM) limit = Math.min(limit, Math.max(0, aheadV - 1.5));
    else if (gap > gapM + 15 && gap < 1500) limit = Math.max(limit, closeKph / 3.6);
    return { limit, maxD: aheadD - 4 };
  }

  function createRaceSim() {
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
    let qualiOrder = null; // car ids in qualifying order, used as the race grid
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
        cars: gridOrder(kind).map((c, i) => ({
          ...c, lapStart: 0, lastLap: null, bestLap: null, laps: 0, secT: [], lastSecs: null, v: 0,
          kind: 'race', plan: null, planIdx: 0, pit: 'none', garageUntil: 0, noise: 1,
          // Race: on the grid a lap before the start line (the formation lap brings them round).
          // Practice / quali: in the garage, leaving at staggered times (you go first)
          D: inGarage ? PIT_BOX - LAP_M : -LAP_M - 20 - i * GRID_GAP_M,
        })),
        // Race start: 10 s on the grid, a formation lap behind the pace car, then the green flag
        start: kind === 'race' ? { phase: 'grid', until: GRID_SEC, paceD: null, paceIn: false } : null,
        greenT: null,
      };
      for (const c of s.cars) {
        if (!inGarage) continue;
        c.pit = 'garage';
        c.garageUntil = c.id === PLAYER.id ? 0 : 5 + rand(c.id * 7 + (kind === 'qualifying' ? 1 : 2)) * (kind === 'qualifying' ? 90 : 240);
      }
      return s;
    }
    /** Race grid: the last qualifying result in this tab, else the default order. */
    function gridOrder(kind) {
      if (kind !== 'race' || !qualiOrder) return FIELD;
      return [...FIELD].sort((a, b) => qualiOrder.indexOf(a.id) - qualiOrder.indexOf(b.id));
    }
    /** Session clock: the race clock only runs from the green flag. */
    const sessionTime = () => (session === 'race' ? (state.greenT == null ? 0 : state.t - state.greenT) : state.t);

    function startSession(kind) {
      state = newState(kind);
      player = state.cars.find((c) => c.id === PLAYER.id);
      last = null;
    }

    function callRaceControl(kind, dur) {
      if ((kind === 'fcy' || kind === 'sc') && session !== 'race') return;
      if (session === 'race' && state.greenT == null) return; // not before the start
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
    const allParked = () => state.cars.every((c) => c.parked);
    const leader = () => state.cars.reduce((a, b) => (b.D > a.D ? b : a));
    const limitKph = () => {
      const st = state.start;
      if (st && st.phase === 'formation') return st.paceIn ? LEAD_KPH : PACE_KPH;
      return state.rc.kind === 'fcy' ? 80 : state.rc.kind === 'sc' ? 120 : Infinity;
    };

    /** Classification: race by distance run; practice and qualifying by best lap (no time = at the back). */
    function classification() {
      if (session === 'race') return [...state.cars].sort((a, b) => classD(b) - classD(a));
      return [...state.cars].sort((a, b) => (a.bestLap || Infinity) - (b.bestLap || Infinity) || FIELD.findIndex((f) => f.id === a.id) - FIELD.findIndex((f) => f.id === b.id));
    }

    /**
     * Take the chequered flag. The classification is frozen here (finishing order); a car
     * that crossed the line does a slow cool-down lap into the pits, one already in the
     * garage or pit lane is done.
     */
    function finish(c, atD, when, parked = false) {
      c.finished = true;
      c.finishT = when;
      state.finishers = (state.finishers || 0) + 1;
      c.classD = atD - state.finishers * 0.01;
      c.kind = 'in';
      if (parked) { c.parked = true; c.pit = 'garage'; c.v = 0; }
    }
    const classD = (c) => (c.finished ? c.classD : c.D);


    function step(dt) {
      state.t += dt;
      const clock = sessionTime();
      const timeUp = clock >= state.sec;
      const cycle = clock % 900;
      const started = session !== 'race' || state.greenT != null;
      for (const s of SCRIPT) {
        if (s.raceOnly && session !== 'race') continue;
        if (started && clock > dt && cycle >= s.at && cycle - dt < s.at && state.rc.kind === 'green' && clock < state.sec - 120) callRaceControl(s.kind, s.dur);
      }
      // Race start: grid -> formation lap behind the pace car -> pace car pits -> green at the line
      const st = state.start;
      if (st && st.phase === 'grid' && state.t >= st.until) { st.phase = 'formation'; st.paceD = leader().D + 70; }
      if (st && st.phase === 'formation') {
        if (!st.paceIn) {
          st.paceV = Math.min(PACE_KPH / 3.6, at(baseProfile.speed, st.paceD));
          st.paceD += st.paceV * dt;
          if (st.paceD > -LAP_M + 1000 && inLapM(st.paceD) >= PIT_IN) st.paceIn = true; // pace car into the pit lane
        }
        if (leader().D >= -120) { st.phase = 'green'; state.greenT = state.t; } // green flag just before the line
      }
      const formation = st && st.phase !== 'green';
      if (state.rc.kind !== 'green' && state.t >= state.rc.until) { state.rc.kind = 'green'; state.rc.stopped = null; state.rc.sectors = [false, false, false]; }
      // Practice / quali: at the flag, cars in the garage are done
      if (timeUp && session !== 'race') { state.chequered = true; for (const c of state.cars) if (!c.finished && c.pit === 'garage') finish(c, c.D, state.t, true); }

      const cap = limitKph() / 3.6;
      const sc = state.rc.kind === 'sc';
      const scV = sc ? Math.min(cap, at(baseProfile.speed, state.rc.scD)) : 0;
      if (sc) state.rc.scD += scV * dt;
      // Order on the road for the safety car / formation queue (cars behind close up, nobody passes)
      const queue = sc || formation ? [...state.cars].sort((a, b) => b.D - a.D) : null;
      for (const c of state.cars) {
        if (c.parked) { c.v = 0; continue; }
        if (st && st.phase === 'grid') { c.v = 0; continue; } // waiting on the grid
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
        let limit = cap;
        let maxD = Infinity;
        if (formation) {
          // single file behind the pace car; once it has pitted the leader holds a steady pace
          const i = queue.indexOf(c);
          const ahead = i === 0 ? null : queue[i - 1];
          limit = (st.paceIn ? LEAD_KPH : PACE_KPH) / 3.6;
          if (ahead) ({ limit, maxD } = follow(c, ahead.D, ahead.v, GRID_GAP_M, limit, 140));
          else if (!st.paceIn) ({ limit, maxD } = follow(c, st.paceD, st.paceV, 60, limit, 140));
        }
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
          // 25 m car spacing, 60 m to the safety car; cars further back close up (lapped cars far behind just hold the limit)
          const i = queue.indexOf(c);
          const ahead = i === 0 ? null : queue[i - 1];
          const f = ahead ? follow(c, ahead.D, ahead.v, 25, limit, 165) : follow(c, state.rc.scD, scV, 60, limit, 165);
          limit = f.limit;
          maxD = Math.min(maxD, f.maxD);
        }
        if (c.finished) limit = Math.min(limit, COOL_KPH / 3.6); // cool-down lap
        v = Math.min(v, limit);
        // speed changes at what the car can do: accelerating out of a slow zone, braking down to a
        // new limit (FCY, safety car, pit lane, cool-down) instead of dropping to it instantly
        v = Math.min(v, c.v + Math.max(1.2, 10.5 * (1 - c.v / VMAX)) * dt);
        v = Math.max(v, c.v - BRAKE * 1.05 * dt);
        if (state.rc.stopped === c.id) v = 0;
        const before = c.D;
        c.D = Math.max(before, Math.min(before + v * dt, maxD));
        c.v = (c.D - before) / dt;

        // pit lane: in on the in-lap, garage at the box, out past the pit exit
        const dNow = inLapM(c.D);
        if (c.pit === 'none' && c.kind === 'in' && dNow >= PIT_IN) c.pit = 'in';
        if (c.pit === 'in' && c.D >= maxD - 0.01) {
          c.garaged = true; // this lap won't get a time
          if (c.finished) { c.parked = true; c.pit = 'garage'; c.v = 0; continue; } // end of the cool-down lap
          if (state.chequered) { finish(c, c.D, state.t, true); continue; }
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
          if (c === player && lapBefore >= 0) { state.fuel = Math.max(2, state.fuel - 1.62); state.tireLaps++; }
          // Time is up: race leader first, then everyone as they cross; practice / quali everyone at their next crossing
          if (timeUp && !c.finished && lapBefore >= 0 && (session !== 'race' || state.chequered || c === leader())) {
            state.chequered = true;
            finish(c, lapAfter * LAP_M + 1, lineT);
          }
        }
      }
      updateTires(dt);
    }

    function inputs() {
      const c = player;
      if (c.pit === 'garage' || c.parked || (state.start && state.start.phase === 'grid')) return { kph: 0, thr: 0, brk: 0, gear: 1, rpm: 3200, steer: 0, gLat: 0, gLong: 0 };
      const lapNo = Math.max(0, Math.floor(c.D / LAP_M));
      const prof = playerProfile(lapNo);
      const kph = c.v * 3.6;
      // Held to a limit (FCY / SC / pit lane) or stopped
      const pitLimited = c.pit !== 'none' && kph >= PIT_KPH - 0.5;
      const limited = state.rc.stopped === c.id || pitLimited || kph >= limitKph() - 0.5 || (c.finished && kph >= COOL_KPH - 0.5);
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
          phase: player.finished ? 'over'
            : state.start && state.start.phase === 'grid' ? 'gridwalk'
            : state.start && state.start.phase === 'formation' ? 'formation'
            : rc.kind === 'fcy' || rc.kind === 'sc' ? 'fullCourseYellow' : 'green',
          elapsedSec: r(sessionTime(), 1),
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
          lap: Math.max(0, Math.floor(c.D / LAP_M) + 1), // 0 in the garage, on the grid and on the formation lap
          lapsCompleted: c.laps,
          position: order.indexOf(c) + 1,
          classPosition: order.filter((o) => o.cls === c.cls).indexOf(c) + 1,
          lastLapSec: c.lastLap ? r(c.lastLap, 3) : null,
          bestLapSec: c.bestLap ? r(c.bestLap, 3) : null,
          lapDistanceM: Math.floor(d),
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
          // before the start the game reports no flag (like LMU); the pace car shows on the map
          // before the start and after the flag the game reports no flag (like LMU)
          state: (state.start && state.start.phase !== 'green') || player.finished ? 'other' : flagsState,
          sectorYellow: rc.sectors,
          yellowState,
          safetyCar: rc.kind === 'sc' ? { lapDistM: Math.floor(inLapM(rc.scD)), speedKph: 120 }
            : state.start && state.start.phase === 'formation' && !state.start.paceIn ? { lapDistM: Math.floor(inLapM(state.start.paceD)), speedKph: PACE_KPH } : null,
          yellowLaps: rc.kind === 'fcy' || rc.kind === 'sc' ? 2 : null,
          rulesAvailable: true,
          // same rule as the telemetry parser: on track (not in the pits) below 40 km/h, or stopped under a full-course yellow
          slowCars: player.finished || (state.start && state.start.phase !== 'green') ? [] : state.cars
            .filter((o) => o.pit === 'none' && !o.finished && o.v * 3.6 < (rc.kind === 'fcy' || rc.kind === 'sc' ? 10 : 40))
            .map((o) => o.id),
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
        const behindM = classD(lead) - classD(c);
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


    /** Start a session. Leaving qualifying makes its result the race grid. */
    function start(kind) {
      if (state && session === 'qualifying') {
        const q = classification();
        qualiOrder = q.filter((c) => c.bestLap).map((c) => c.id).concat(q.filter((c) => !c.bestLap).map((c) => c.id));
      }
      startSession(kind);
    }

    return {
      start,
      step,
      snapshot,
      standings,
      callRaceControl,
      /** End the current yellow / FCY / safety car on the next step. */
      clearFlags() { if (state) state.rc.until = state.t; },
      allParked: () => allParked(),
      get session() { return session; },
      get t() { return state ? state.t : 0; },
      get sessionTime() { return state ? sessionTime() : 0; },
      /** Everything the server needs to build rF2 buffers. */
      internals() {
        return { session, state, player, order: classification(), inputs: last || inputs(), sessionTime: sessionTime(), classD, gapSec };
      },
    };
  }

  return {
    createRaceSim, LAP_M, SPLITS, SESSIONS, PIT_IN, PIT_BOX, PIT_OUT, PIT_KPH, PACE_KPH, FIELD, PLAYER,
    posAt, inLapM, rand,
  };
});
