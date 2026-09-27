'use strict';

/**
 * Keeps a 1 Hz history of tire state plus a per-lap wear log, and condenses
 * it into the compact context sent to Claude (trends, not raw 10 Hz data).
 */

const { WHEEL_KEYS } = require('./telemetryParser');

const MAX_SAMPLES = 600; // 10 minutes at 1 Hz
const MAX_LAPS = 50;

class TireHistory {
  constructor() {
    this.reset();
  }

  reset() {
    this.samples = [];
    this.laps = []; // { lap, lapTimeSec, wearPercent: {FL..}, fuelL }
    this.stintStartLap = null;
    this.lastLap = null;
    this.lapStartWear = null;
    this.lapStartFuel = null;
  }

  /** Call once per second with the latest snapshot. */
  record(snapshot) {
    const { vehicle, tires } = snapshot;
    const now = Date.now();

    // Wear only ever grows on track, so any real drop means fresh tires: new stint
    const last = this.samples[this.samples.length - 1];
    if (last && WHEEL_KEYS.some((k) => last.tires[k].wear - tires[k].wearPercent > 0.5)) {
      this.reset();
    }

    this.samples.push({
      at: now,
      lap: vehicle.lap,
      tires: Object.fromEntries(
        WHEEL_KEYS.map((k) => [
          k,
          { wear: tires[k].wearPercent, temp: tires[k].surfaceTempC, pressure: tires[k].pressureKpa },
        ]),
      ),
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    if (this.stintStartLap === null) this.stintStartLap = vehicle.lap;

    if (this.lastLap !== null && vehicle.lap > this.lastLap && this.lapStartWear) {
      this.laps.push({
        lap: this.lastLap,
        lapTimeSec: vehicle.lastLapSec,
        wearPercent: Object.fromEntries(
          WHEEL_KEYS.map((k) => [k, round(tires[k].wearPercent - this.lapStartWear[k], 3)]),
        ),
        fuelUsedL: this.lapStartFuel !== null ? round(this.lapStartFuel - vehicle.fuelL, 2) : null,
      });
      if (this.laps.length > MAX_LAPS) this.laps.shift();
    }
    if (this.lastLap === null || vehicle.lap !== this.lastLap) {
      this.lapStartWear = Object.fromEntries(WHEEL_KEYS.map((k) => [k, tires[k].wearPercent]));
      this.lapStartFuel = vehicle.fuelL;
      this.lastLap = vehicle.lap;
    }
  }

  /** Change of each metric over the last `seconds` of samples. */
  trend(seconds = 60) {
    if (this.samples.length < 2) return null;
    const latest = this.samples[this.samples.length - 1];
    const cutoff = latest.at - seconds * 1000;
    const earliest = this.samples.find((s) => s.at >= cutoff) || this.samples[0];
    const spanSec = (latest.at - earliest.at) / 1000;
    if (spanSec < 5) return null;
    return {
      spanSec: Math.round(spanSec),
      ...Object.fromEntries(
        WHEEL_KEYS.map((k) => [
          k,
          {
            tempChangeC: round(latest.tires[k].temp - earliest.tires[k].temp, 1),
            pressureChangeKpa: round(latest.tires[k].pressure - earliest.tires[k].pressure, 1),
            wearChangePercent: round(latest.tires[k].wear - earliest.tires[k].wear, 3),
          },
        ]),
      ),
    };
  }

  /** Average wear per lap over the last `n` completed laps of this stint. */
  wearPerLap(n = 3) {
    const recent = this.laps.slice(-n);
    if (recent.length === 0) return null;
    return Object.fromEntries(
      WHEEL_KEYS.map((k) => [k, round(recent.reduce((sum, l) => sum + l.wearPercent[k], 0) / recent.length, 3)]),
    );
  }

  summary() {
    return {
      stintStartLap: this.stintStartLap,
      lapsThisStint: this.laps.length,
      trendLast60s: this.trend(60),
      avgWearPerLapLast3: this.wearPerLap(3),
      recentLaps: this.laps.slice(-5),
    };
  }
}

function round(n, d) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

module.exports = { TireHistory };
