'use strict';

/**
 * The server's simulator (TELEMETRY_SOURCE=mock): runs the shared race simulator
 * (public/race-sim.js, the same one the browser demo uses) and writes each frame
 * as real rF2 shared-memory buffers (telemetry, scoring and rules), so it goes
 * through exactly the same parser as Le Mans Ultimate.
 *
 * Practice, qualifying and race; speed and race control are switchable at run
 * time from the Control Panel.
 */

const {
  koffi,
  rF2VehicleTelemetry,
  rF2VehicleScoring,
  rF2TelemetryHeader,
  rF2ScoringHeader,
  rF2RulesHeader,
  RULES_READ_SIZE,
  TELEMETRY_VEHICLES_OFFSET,
  SCORING_VEHICLES_OFFSET,
} = require('./rf2Layout');
const RaceSim = require('../public/race-sim');

const KELVIN = 273.15;
const DT = 0.1; // simulation step, seconds
const MAX_CATCH_UP_SEC = 30; // after a stall, don't simulate more than this in one read

const SESSION_CODE = { practice: 1, qualifying: 5, race: 10 }; // rF2 mSession values
const PHASE_CODE = { gridwalk: 2, formation: 3, green: 5, fullCourseYellow: 6, over: 8 };
const YELLOW_CODE = { pending: 1, pitsClosed: 2, pitLeadLap: 3, pitsOpen: 4, lastLap: 5, resume: 6 };
const SESSIONS = Object.keys(RaceSim.SESSIONS);

class RaceSimSource {
  constructor({ speedMultiplier = 1, session = 'race' } = {}) {
    this.speedMultiplier = speedMultiplier;
    this.sim = RaceSim.createRaceSim();
    this.sim.start(SESSIONS.includes(session) ? session : 'race');
    this.version = 0;
    this.lastRealMs = Date.now();
    this.pendingSec = 0;
  }

  get isOpen() {
    return true;
  }

  open() {}
  close() {}

  get session() {
    return this.sim.session;
  }

  /** Start practice, qualifying or the race. Leaving qualifying makes its result the race grid. */
  setSession(kind) {
    if (!SESSIONS.includes(kind)) throw new Error(`Unknown session "${kind}"`);
    this.sim.start(kind);
    this.pendingSec = 0;
  }

  /** 'yellow' | 'fcy' | 'sc' (race only) | 'green' (ends the current one) */
  raceControl(kind) {
    if (kind === 'green') this.sim.clearFlags();
    else if (['yellow', 'fcy', 'sc'].includes(kind)) this.sim.callRaceControl(kind);
    else throw new Error(`Unknown race control "${kind}"`);
  }

  read() {
    // Advance by the real time since the last read, times the speed
    const now = Date.now();
    this.pendingSec += Math.min(MAX_CATCH_UP_SEC, ((now - this.lastRealMs) / 1000) * this.speedMultiplier);
    this.lastRealMs = now;
    while (this.pendingSec >= DT && !this.sim.allParked()) {
      this.sim.step(DT);
      this.pendingSec -= DT;
    }
    if (this.sim.allParked()) this.pendingSec = 0;
    this.version++;
    return this.encode();
  }

  encode() {
    const sim = this.sim;
    const snap = sim.snapshot();
    const table = sim.standings();
    const { state } = sim.internals();
    const byId = new Map(state.cars.map((c) => [c.id, c]));
    const t = sim.t;
    const v = snap.vehicle;
    const phase = PHASE_CODE[snap.session.phase] ?? 5;
    const endET = snap.session.type === 'race' ? (state.greenT == null ? t : state.greenT) + state.sec : state.sec;
    const version = { mVersionUpdateBegin: this.version, mVersionUpdateEnd: this.version };

    // --- telemetry: the player's car
    const telemetry = Buffer.alloc(TELEMETRY_VEHICLES_OFFSET + koffi.sizeof(rF2VehicleTelemetry));
    koffi.encode(telemetry, 0, rF2TelemetryHeader, { version, mNumVehicles: 1 });
    const player = byId.get(RaceSim.PLAYER.id);
    const wheels = ['FL', 'FR', 'RL', 'RR'].map((k) => {
      const w = snap.tires[k];
      const left = k.endsWith('L');
      // rF2 tread temps are left / centre / right as seen from the seat: the outside edge is "left" on left-side tires
      const [a, b, c] = left ? [w.temps.outerC, w.temps.middleC, w.temps.innerC] : [w.temps.innerC, w.temps.middleC, w.temps.outerC];
      return {
        mPressure: w.pressureKpa,
        mTemperature: [a + KELVIN, b + KELVIN, c + KELVIN],
        mTireInnerLayerTemperature: [a - 3 + KELVIN, b - 3 + KELVIN, c - 3 + KELVIN],
        mTireCarcassTemperature: w.carcassTempC + KELVIN,
        mWear: 1 - w.wearPercent / 100,
        mBrakeTemp: w.brakeTempC + KELVIN,
        mTireLoad: 4200,
        mGripFract: 0.9,
      };
    });
    koffi.encode(telemetry, TELEMETRY_VEHICLES_OFFSET, rF2VehicleTelemetry, {
      mID: player.id,
      mElapsedTime: t,
      mLapNumber: v.lap,
      mLapStartET: player.lapStart,
      mVehicleName: v.name,
      mTrackName: snap.session.trackName,
      mPos: { x: v.posX, y: 0, z: v.posZ },
      mLocalVel: { x: 0, y: 0, z: -v.speedKph / 3.6 },
      mLocalAccel: { x: -v.gLat * 9.81, y: 0, z: -v.gLong * 9.81 },
      mUnfilteredThrottle: v.throttle,
      mUnfilteredBrake: v.brake,
      mUnfilteredSteering: v.steering,
      mGear: v.gear,
      mEngineRPM: v.rpm,
      mEngineMaxRPM: v.maxRpm,
      mFuel: v.fuelL,
      mFuelCapacity: v.fuelCapacityL,
      mFrontTireCompoundName: v.frontCompound,
      mRearTireCompoundName: v.rearCompound,
      mWheels: wheels,
    });

    // --- scoring: session and every car, in classification order
    const scoring = Buffer.alloc(SCORING_VEHICLES_OFFSET + table.length * koffi.sizeof(rF2VehicleScoring));
    const y = snap.flags.sectorYellow || [false, false, false];
    koffi.encode(scoring, 0, rF2ScoringHeader, {
      version,
      mScoringInfo: {
        mTrackName: snap.session.trackName,
        mSession: SESSION_CODE[snap.session.type] ?? 10,
        mCurrentET: t,
        mEndET: endET,
        mMaxLaps: 0,
        mLapDist: snap.session.lapDistanceM,
        mNumVehicles: table.length,
        mGamePhase: phase,
        mYellowFlagState: YELLOW_CODE[snap.flags.yellowState] || 0,
        mSectorFlag: [y[2] ? 1 : 0, y[0] ? 1 : 0, y[1] ? 1 : 0], // rF2 order: sector 3, 1, 2
        mAmbientTemp: snap.session.ambientTempC,
        mTrackTemp: snap.session.trackTempC,
        mRaining: 0,
      },
    });
    table.forEach((row, i) => {
      const c = byId.get(row.id);
      const d = row.lapDistM;
      const sec = (x) => (x > 0 ? x : -1);
      const s = c.lastSecs;
      koffi.encode(scoring, SCORING_VEHICLES_OFFSET + i * koffi.sizeof(rF2VehicleScoring), rF2VehicleScoring, {
        mID: c.id,
        mDriverName: c.driver,
        mVehicleName: c.car,
        mVehicleClass: c.cls,
        mTotalLaps: c.laps,
        mLapDist: d,
        mSector: d < RaceSim.SPLITS[0] ? 1 : d < RaceSim.SPLITS[1] ? 2 : 0,
        mBestLapTime: sec(c.bestLap),
        mLastLapTime: sec(c.lastLap),
        mLastSector1: s ? s[0] : -1,
        mLastSector2: s ? s[0] + s[1] : -1, // cumulative, like the game
        mCurSector1: sec(c.secT[0]),
        mCurSector2: sec(c.secT[1]), // already cumulative from the lap start
        mNumPitstops: 0,
        mIsPlayer: c.id === RaceSim.PLAYER.id,
        mInPits: !!row.inPits,
        mInGarageStall: c.pit === 'garage',
        mPlace: row.pos,
        mTimeBehindLeader: row.gapToLeaderSec || 0,
        mLapsBehindLeader: row.lapsDown || 0,
        mFinishStatus: c.finished ? 1 : 0,
        mPos: { x: row.x, y: 0, z: row.z },
        mLocalVel: { x: 0, y: 0, z: -(row.speedKph || 0) / 3.6 },
      });
    });

    // --- rules: the safety car (or the pace car on the formation lap)
    const rules = Buffer.alloc(RULES_READ_SIZE);
    const car = snap.flags.safetyCar;
    koffi.encode(rules, 0, rF2RulesHeader, {
      version,
      mTrackRules: {
        mCurrentET: t,
        mStage: phase === 6 ? 4 : phase === 3 ? 1 : 2,
        mNumParticipants: table.length,
        mSafetyCarExists: true,
        mSafetyCarActive: !!car,
        mSafetyCarLapDist: car ? car.lapDistM : 0,
        mYellowFlagState: YELLOW_CODE[snap.flags.yellowState] || 0,
        mYellowFlagLaps: snap.flags.yellowLaps || 0,
        mSafetyCarSpeed: car ? car.speedKph / 3.6 : 0,
      },
    });

    return { telemetry, scoring, rules, telemetryVersion: this.version };
  }
}

module.exports = { RaceSimSource, SIM_SESSIONS: SESSIONS };
