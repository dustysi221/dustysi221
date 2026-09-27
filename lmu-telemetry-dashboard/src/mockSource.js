'use strict';

/**
 * Simulated LMU race for development without the game (and on non-Windows
 * machines). It writes real rF2 binary buffers with koffi.encode, so the
 * snapshots go through exactly the same parser as live shared memory.
 *
 * - 90-minute race on a 5.4 km circuit, ~100 s laps
 * - the player car wears tires (fronts faster, FL hardest), burns ~2.9 L/lap
 *   from a 90 L tank, slows as tires age, and pits automatically for fuel and
 *   four tires when it can't make another lap and a half
 * - five AI cars in two classes, each with its own pace and one pit stop
 */

const {
  koffi,
  rF2VehicleTelemetry,
  rF2VehicleScoring,
  rF2TelemetryHeader,
  rF2ScoringHeader,
  TELEMETRY_VEHICLES_OFFSET,
  SCORING_VEHICLES_OFFSET,
} = require('./rf2Layout');

const KELVIN = 273.15;
const LAP_SECONDS = 100;
const LAP_METERS = 5400;
const RACE_SECONDS = 90 * 60;
const FUEL_PER_LAP = 2.9;
const FUEL_CAPACITY = 90;
const PIT_LOSS_SEC = 35;
const PIT_LANE_FRACTION = 0.06; // share of the lap spent in the pit lane after a stop

// Tread wear per lap as a fraction of a new tire, per corner
const WEAR_PER_LAP = { FL: 0.0105, FR: 0.0085, RL: 0.0075, RR: 0.007 };
const CORNERS = ['FL', 'FR', 'RL', 'RR'];

const PLAYER = { id: 7, name: 'Mock Hypercar #7', driver: 'Mock Driver', cls: 'Hypercar' };
const AI_CARS = [
  { id: 50, name: '#50 Ferrari 499P', driver: 'AI Fuoco', cls: 'Hypercar', lapSec: 99.4, pitLap: 29 },
  { id: 6, name: '#6 Porsche 963', driver: 'AI Estre', cls: 'Hypercar', lapSec: 99.9, pitLap: 30 },
  { id: 8, name: '#8 Toyota GR010', driver: 'AI Buemi', cls: 'Hypercar', lapSec: 100.7, pitLap: 28 },
  { id: 92, name: '#92 Porsche 911 GT3 R', driver: 'AI Malykhin', cls: 'LMGT3', lapSec: 108.6, pitLap: 26 },
  { id: 77, name: '#77 Ford Mustang GT3', driver: 'AI Barker', cls: 'LMGT3', lapSec: 109.3, pitLap: 25 },
];

class MockSource {
  constructor({ speedMultiplier = 1 } = {}) {
    this.speedMultiplier = speedMultiplier;
    this.startedAt = Date.now();
    this.version = 0;
    // Player stint state; the car pits at lap boundaries when fuel runs short
    this.stintStartProgress = 0;
    this.stintStartFuel = FUEL_CAPACITY;
    this.pitStops = 0;
    this.lastPitLap = -1;
    this.checkedLap = 0;
  }

  get isOpen() {
    return true;
  }

  open() {}
  close() {}

  read() {
    const elapsed = ((Date.now() - this.startedAt) / 1000) * this.speedMultiplier;
    const progress = elapsed / LAP_SECONDS; // continuous laps driven
    const lapsDone = Math.floor(progress);
    const lapFrac = progress - lapsDone;

    this.#maybePit(lapsDone);

    const stintLaps = progress - this.stintStartProgress;
    const fuel = Math.max(0, this.stintStartFuel - FUEL_PER_LAP * stintLaps);
    const inPits = this.lastPitLap === lapsDone && lapFrac < PIT_LANE_FRACTION;

    // Corners/straights: a speed trace with 6 braking zones per lap
    const wave = Math.sin(lapFrac * Math.PI * 12);
    const speedKph = inPits ? 60 : 215 + 65 * wave;
    const braking = !inPits && wave < -0.6;

    // Slow warm-up over the first lap of a stint, older tires run hotter
    const warm = Math.min(1, stintLaps / 1.2);
    const degradation = Math.min(stintLaps / 30, 1);

    const wheels = CORNERS.map((key, i) => {
      const isFront = i < 2;
      const isLeft = key === 'FL' || key === 'RL';
      const base = 45 + warm * (isFront ? 42 : 38) + degradation * 6;
      const load = isLeft ? 1 + 0.08 * Math.sin(lapFrac * Math.PI * 4) : 1 - 0.05 * Math.sin(lapFrac * Math.PI * 4);
      const center = base * load + 3 * Math.sin(elapsed * 0.7 + i);
      const outerBias = isFront ? 4 : 2;
      const innerBias = isFront ? 6 : 5; // negative camber runs the inside hotter
      const left = center + (isLeft ? outerBias : innerBias) - 3;
      const right = center + (isLeft ? innerBias : outerBias) - 3;

      const wear = Math.max(0.2, 1 - WEAR_PER_LAP[key] * stintLaps * (1 + degradation * 0.3));
      const tempC = (left + center + right) / 3;
      const pressure = 162 + (tempC - 20) * 0.28 + (isFront ? 1.5 : 0);

      return {
        mBrakeTemp: KELVIN + (braking ? 620 : 380) + (isFront ? 80 : 0),
        mPressure: pressure,
        mTemperature: [left + KELVIN, center + KELVIN, right + KELVIN],
        mWear: wear,
        mTireCarcassTemperature: KELVIN + center - 6,
        mTireInnerLayerTemperature: [KELVIN + left - 3, KELVIN + center - 3, KELVIN + right - 3],
        mTireLoad: 4200 * load * (isFront ? 1.05 : 1),
        mGripFract: 0.85 + 0.1 * Math.abs(wave),
      };
    });

    // Reported lap times: tire age costs ~0.06 s/lap, the pit lap carries the stop
    const lastStintAge = Math.max(0, lapsDone - 1 - this.stintStartProgress);
    let lastLapSec = LAP_SECONDS + lastStintAge * 0.06 + Math.sin(lapsDone * 1.3) * 0.15;
    if (this.lastPitLap === lapsDone - 1) lastLapSec += PIT_LOSS_SEC;

    this.version++;
    const telemetry = Buffer.alloc(TELEMETRY_VEHICLES_OFFSET + koffi.sizeof(rF2VehicleTelemetry));
    koffi.encode(telemetry, 0, rF2TelemetryHeader, {
      version: { mVersionUpdateBegin: this.version, mVersionUpdateEnd: this.version },
      mNumVehicles: 1,
    });
    koffi.encode(telemetry, TELEMETRY_VEHICLES_OFFSET, rF2VehicleTelemetry, {
      mID: PLAYER.id,
      mElapsedTime: elapsed,
      mLapNumber: lapsDone + 1,
      mLapStartET: lapsDone * LAP_SECONDS,
      mVehicleName: PLAYER.name,
      mTrackName: 'Mock Circuit',
      mLocalVel: { x: 0, y: 0, z: -speedKph / 3.6 },
      mGear: Math.max(2, Math.min(7, Math.round(speedKph / 42))),
      mEngineRPM: 6200 + 1800 * Math.abs(wave),
      mEngineMaxRPM: 8500,
      mUnfilteredThrottle: braking ? 0 : 0.6 + 0.4 * Math.max(0, wave),
      mUnfilteredBrake: braking ? 0.85 : 0,
      mFuel: fuel,
      mFuelCapacity: FUEL_CAPACITY,
      mFrontTireCompoundName: 'Medium',
      mRearTireCompoundName: 'Medium',
      mWheels: wheels,
    });

    // Scoring: player + AI cars, ordered by effective race distance
    const cars = [
      {
        ...PLAYER,
        isPlayer: true,
        distance: progress - (this.pitStops * PIT_LOSS_SEC) / LAP_SECONDS,
        lapSec: LAP_SECONDS,
        lapsDone,
        lastLapSec: lapsDone > 0 ? lastLapSec : -1,
        bestLapSec: lapsDone > 0 ? LAP_SECONDS - 0.1 : -1,
        pitStops: this.pitStops,
        inPits,
        lapDist: lapFrac * LAP_METERS,
      },
      ...AI_CARS.map((car) => aiState(car, elapsed)),
    ].sort((a, b) => b.distance - a.distance);
    const leader = cars[0];

    const scoring = Buffer.alloc(SCORING_VEHICLES_OFFSET + cars.length * koffi.sizeof(rF2VehicleScoring));
    koffi.encode(scoring, 0, rF2ScoringHeader, {
      version: { mVersionUpdateBegin: this.version, mVersionUpdateEnd: this.version },
      mScoringInfo: {
        mTrackName: 'Mock Circuit',
        mSession: 10, // race
        mCurrentET: elapsed,
        mEndET: RACE_SECONDS,
        mMaxLaps: 2147483647, // timed race: no lap limit
        mLapDist: LAP_METERS,
        mNumVehicles: cars.length,
        mGamePhase: elapsed < RACE_SECONDS ? 5 : 8, // green, then over
        mAmbientTemp: 24,
        mTrackTemp: 36,
        mRaining: 0,
      },
    });
    cars.forEach((car, i) => {
      const behind = leader.distance - car.distance;
      koffi.encode(scoring, SCORING_VEHICLES_OFFSET + i * koffi.sizeof(rF2VehicleScoring), rF2VehicleScoring, {
        mID: car.id,
        mDriverName: car.driver,
        mVehicleName: car.name,
        mVehicleClass: car.cls,
        mTotalLaps: car.lapsDone,
        mLapDist: car.lapDist,
        mBestLapTime: car.bestLapSec,
        mLastLapTime: car.lastLapSec,
        mNumPitstops: car.pitStops,
        mIsPlayer: !!car.isPlayer,
        mInPits: car.inPits,
        mPlace: i + 1,
        mTimeBehindLeader: behind * car.lapSec,
        mLapsBehindLeader: Math.floor(behind),
      });
    });

    return { telemetry, scoring, telemetryVersion: this.version };
  }

  // At each new lap, box if the car can't complete another lap and a half.
  #maybePit(lapsDone) {
    if (lapsDone <= this.checkedLap) return;
    this.checkedLap = lapsDone;
    const fuelNow = this.stintStartFuel - FUEL_PER_LAP * (lapsDone - this.stintStartProgress);
    if (fuelNow < FUEL_PER_LAP * 1.5) {
      this.pitStops++;
      this.lastPitLap = lapsDone;
      this.stintStartProgress = lapsDone;
      this.stintStartFuel = FUEL_CAPACITY;
    }
  }
}

function aiState(car, elapsed) {
  const pitted = elapsed / car.lapSec > car.pitLap;
  const distance = (elapsed - (pitted ? PIT_LOSS_SEC : 0)) / car.lapSec;
  const lapsDone = Math.max(0, Math.floor(distance));
  const noise = Math.sin(lapsDone * 1.7 + car.id) * 0.3;
  const pitLap = pitted && lapsDone === car.pitLap + 1;
  return {
    ...car,
    distance,
    lapsDone,
    lastLapSec: lapsDone > 0 ? car.lapSec + noise + (pitLap ? PIT_LOSS_SEC : 0) : -1,
    bestLapSec: lapsDone > 0 ? car.lapSec - 0.25 : -1,
    pitStops: pitted ? 1 : 0,
    inPits: pitted && distance - car.pitLap < PIT_LANE_FRACTION,
    lapDist: (distance - lapsDone) * LAP_METERS,
  };
}

module.exports = { MockSource };
