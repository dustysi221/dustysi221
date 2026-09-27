'use strict';

/**
 * Simulated LMU session for development without the game (and on non-Windows
 * machines). It writes real rF2 binary buffers with koffi.encode, so the
 * snapshots go through exactly the same parser as live shared memory.
 *
 * The car laps a 5.4 km circuit in ~100 s, wears tires (fronts faster, FL
 * hardest), burns fuel, and heats/cools tires through each lap.
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
const FUEL_PER_LAP = 2.9;
const FUEL_CAPACITY = 90;

// Tread wear per lap as a fraction of a new tire, per corner
const WEAR_PER_LAP = { FL: 0.0105, FR: 0.0085, RL: 0.0075, RR: 0.007 };
const CORNERS = ['FL', 'FR', 'RL', 'RR'];

class MockSource {
  constructor({ speedMultiplier = 1 } = {}) {
    this.speedMultiplier = speedMultiplier;
    this.startedAt = Date.now();
    this.version = 0;
  }

  get isOpen() {
    return true;
  }

  open() {}
  close() {}

  read() {
    const elapsed = ((Date.now() - this.startedAt) / 1000) * this.speedMultiplier;
    const lapsDone = Math.floor(elapsed / LAP_SECONDS);
    const lapFrac = (elapsed % LAP_SECONDS) / LAP_SECONDS;
    const progress = elapsed / LAP_SECONDS; // continuous laps driven

    // Corners/straights: a speed trace with 6 braking zones per lap
    const wave = Math.sin(lapFrac * Math.PI * 12);
    const speedKph = 215 + 65 * wave;
    const braking = wave < -0.6;

    // Slow warm-up over the first lap, then per-corner heat cycles
    const warm = Math.min(1, progress / 1.2);
    const degradation = Math.min(progress / 30, 1); // older tires run hotter

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

      const wear = Math.max(0.2, 1 - WEAR_PER_LAP[key] * progress * (1 + degradation * 0.3));
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

    const lapTime = LAP_SECONDS + degradation * 1.8;
    const fuel = Math.max(0, FUEL_CAPACITY - FUEL_PER_LAP * progress);

    this.version++;
    const telemetry = Buffer.alloc(TELEMETRY_VEHICLES_OFFSET + koffi.sizeof(rF2VehicleTelemetry));
    koffi.encode(telemetry, 0, rF2TelemetryHeader, {
      version: { mVersionUpdateBegin: this.version, mVersionUpdateEnd: this.version },
      mNumVehicles: 1,
    });
    koffi.encode(telemetry, TELEMETRY_VEHICLES_OFFSET, rF2VehicleTelemetry, {
      mID: 7,
      mElapsedTime: elapsed,
      mLapNumber: lapsDone + 1,
      mLapStartET: lapsDone * LAP_SECONDS,
      mVehicleName: 'Mock Hypercar #7',
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

    const scoring = Buffer.alloc(SCORING_VEHICLES_OFFSET + koffi.sizeof(rF2VehicleScoring));
    koffi.encode(scoring, 0, rF2ScoringHeader, {
      version: { mVersionUpdateBegin: this.version, mVersionUpdateEnd: this.version },
      mScoringInfo: {
        mTrackName: 'Mock Circuit',
        mSession: 10, // race
        mCurrentET: elapsed,
        mEndET: 6 * 3600,
        mMaxLaps: 2147483647, // timed race: no lap limit
        mLapDist: LAP_METERS,
        mNumVehicles: 1,
        mGamePhase: 5, // green flag
        mAmbientTemp: 24,
        mTrackTemp: 36,
        mRaining: 0,
      },
    });
    koffi.encode(scoring, SCORING_VEHICLES_OFFSET, rF2VehicleScoring, {
      mID: 7,
      mDriverName: 'Mock Driver',
      mVehicleName: 'Mock Hypercar #7',
      mTotalLaps: lapsDone,
      mLapDist: lapFrac * LAP_METERS,
      mBestLapTime: lapsDone > 0 ? LAP_SECONDS : -1,
      mLastLapTime: lapsDone > 0 ? lapTime : -1,
      mNumPitstops: 0,
      mIsPlayer: true,
      mInPits: false,
      mPlace: 3,
      mVehicleClass: 'Hypercar',
    });

    return { telemetry, scoring, telemetryVersion: this.version };
  }
}

module.exports = { MockSource };
