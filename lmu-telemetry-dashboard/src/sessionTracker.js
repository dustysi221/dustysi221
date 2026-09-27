'use strict';

/**
 * Cumulative race history for strategy: one record per completed lap (time,
 * fuel used, tire wear), stints and pit stops, plus recent lap times for every
 * car in the field. Fed at 1 Hz; unlike TireHistory it does not reset on a
 * tire change, only when a new session starts.
 */

const { WHEEL_KEYS } = require('./telemetryParser');

const MAX_LAPS = 500;
const COMPETITOR_LAPS = 5;
const PIT_EPISODE_GAP_SEC = 60; // fuel/tire changes this close together count as one stop

class SessionTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.sessionKey = null;
    this.laps = [];
    this.stints = [];
    this.pitStops = [];
    this.competitors = new Map(); // id -> { lapsCompleted, laps: [sec] }
    this.prev = null; // previous sample
    this.lapStart = null; // { lapsCompleted, fuelL, wear, sawPits }
  }

  /** Call once per second with the full snapshot (including `field`). */
  record(snapshot) {
    const { session, vehicle, tires } = snapshot;

    // New session (different track/session type, or the clock went backwards)
    const key = `${session.trackName}|${session.type}`;
    if (this.sessionKey !== key || (this.prev && session.elapsedSec < this.prev.elapsedSec - 5)) {
      this.reset();
      this.sessionKey = key;
    }

    const now = {
      elapsedSec: session.elapsedSec,
      lapsCompleted: vehicle.lapsCompleted ?? Math.max(0, (vehicle.lap || 1) - 1),
      fuelL: vehicle.fuelL,
      inPits: vehicle.inPits,
      pitStopsCount: vehicle.pitStops,
      wear: Object.fromEntries(WHEEL_KEYS.map((k) => [k, tires[k].wearPercent])),
    };

    if (this.stints.length === 0) this.#startStint(now, { initial: true });
    this.#detectPitStop(now);

    if (!this.lapStart) {
      this.lapStart = { lapsCompleted: now.lapsCompleted, fuelL: now.fuelL, wear: now.wear, sawPits: now.inPits, partial: true };
    } else if (now.inPits) {
      this.lapStart.sawPits = true;
    }

    if (now.lapsCompleted > this.lapStart.lapsCompleted) this.#completeLap(now, vehicle.lastLapSec);

    this.#recordCompetitors(snapshot.field || []);
    this.prev = now;
  }

  #completeLap(now, lastLapSec) {
    const start = this.lapStart;
    const refuelled = now.fuelL > start.fuelL + 1;
    const tiresChanged = WHEEL_KEYS.some((k) => start.wear[k] - now.wear[k] > 0.5);
    // Only a full green lap with no pit visit is representative for pace/fuel/wear
    const clean = !start.partial && !start.sawPits && !refuelled && !tiresChanged;

    this.laps.push({
      lap: now.lapsCompleted,
      lapTimeSec: lastLapSec,
      stint: this.stints.length,
      clean,
      pitted: start.sawPits || refuelled || tiresChanged,
      fuelEndL: now.fuelL,
      fuelUsedL: clean ? round(start.fuelL - now.fuelL, 3) : null,
      wearEnd: now.wear,
      wearDelta: clean ? Object.fromEntries(WHEEL_KEYS.map((k) => [k, round(now.wear[k] - start.wear[k], 3)])) : null,
    });
    if (this.laps.length > MAX_LAPS) this.laps.shift();

    this.lapStart = { lapsCompleted: now.lapsCompleted, fuelL: now.fuelL, wear: now.wear, sawPits: now.inPits, partial: false };
  }

  #detectPitStop(now) {
    const p = this.prev;
    if (!p) return;
    const fuelAdded = now.fuelL - p.fuelL > 1 ? now.fuelL - p.fuelL : 0;
    const tiresChanged = WHEEL_KEYS.some((k) => p.wear[k] - now.wear[k] > 0.5);
    const countIncreased = now.pitStopsCount != null && p.pitStopsCount != null && now.pitStopsCount > p.pitStopsCount;
    if (!fuelAdded && !tiresChanged && !countIncreased) return;

    const last = this.pitStops[this.pitStops.length - 1];
    if (last && now.elapsedSec - last.atSec < PIT_EPISODE_GAP_SEC) {
      // Same stop, e.g. fuel and tires registered on different ticks
      last.fuelAddedL = round(last.fuelAddedL + fuelAdded, 1);
      last.tiresChanged = last.tiresChanged || tiresChanged;
      return;
    }
    this.pitStops.push({ lap: now.lapsCompleted + 1, atSec: now.elapsedSec, fuelAddedL: round(fuelAdded, 1), tiresChanged });
    this.#startStint(now, {});
  }

  #startStint(now, { initial = false }) {
    this.stints.push({
      number: this.stints.length + 1,
      startLap: now.lapsCompleted + 1,
      startSec: now.elapsedSec,
      startFuelL: now.fuelL,
      initial,
    });
  }

  #recordCompetitors(field) {
    for (const car of field) {
      let c = this.competitors.get(car.id);
      if (!c) {
        c = { lapsCompleted: car.lapsCompleted, laps: [] };
        this.competitors.set(car.id, c);
        continue;
      }
      if (car.lapsCompleted > c.lapsCompleted && car.lastLapSec) {
        c.laps.push({ sec: car.lastLapSec, pit: car.inPits });
        if (c.laps.length > COMPETITOR_LAPS + 2) c.laps.shift();
      }
      c.lapsCompleted = car.lapsCompleted;
      c.info = car;
    }
  }

  /** Recent representative lap times for a competitor (pit laps and outliers dropped). */
  competitorPace(id) {
    const c = this.competitors.get(id);
    if (!c || c.laps.length === 0) return null;
    const times = c.laps.map((l) => l.sec);
    const best = Math.min(...times);
    const clean = times.filter((t) => t < best * 1.07).slice(-COMPETITOR_LAPS);
    return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
  }

  get currentStint() {
    return this.stints[this.stints.length - 1] || null;
  }

  cleanLaps({ stint = null, last = null } = {}) {
    let laps = this.laps.filter((l) => l.clean && (stint == null || l.stint === stint));
    if (last) laps = laps.slice(-last);
    return laps;
  }
}

function round(n, d = 1) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

module.exports = { SessionTracker };
