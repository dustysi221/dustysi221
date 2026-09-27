'use strict';

/**
 * Turns raw rF2 shared-memory buffers into the normalized snapshot the server
 * broadcasts. Pure functions over Buffers, so it runs (and is tested) on any OS.
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

const TELEM_STRIDE = koffi.sizeof(rF2VehicleTelemetry);
const SCORING_STRIDE = koffi.sizeof(rF2VehicleScoring);
const WHEEL_KEYS = ['FL', 'FR', 'RL', 'RR'];

const KELVIN = 273.15;

const GAME_PHASES = [
  'garage', 'warmup', 'gridwalk', 'formation', 'countdown',
  'green', 'fullCourseYellow', 'stopped', 'over', 'paused',
];

function sessionType(session) {
  if (session === 0) return 'testday';
  if (session <= 4) return 'practice';
  if (session <= 8) return 'qualifying';
  if (session === 9) return 'warmup';
  if (session <= 13) return 'race';
  return 'unknown';
}

const round = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const kToC = (k) => round(k - KELVIN, 1);
// Lap/sector times are <= 0 when not set
const lapTime = (t) => (t > 0 ? round(t, 3) : null);

function innerLayer(temps, isLeftSide) {
  if (!Array.isArray(temps)) return null;
  const [left, center, right] = temps;
  return {
    innerC: kToC(isLeftSide ? right : left),
    middleC: kToC(center),
    outerC: kToC(isLeftSide ? left : right),
  };
}

function parseWheel(wheel, key) {
  // mTemperature is left/center/right as seen from the driver's seat, so the
  // outer edge is "left" on left-side tires and "right" on right-side tires.
  const [left, center, right] = wheel.mTemperature;
  const isLeftSide = key === 'FL' || key === 'RL';
  const outer = isLeftSide ? left : right;
  const inner = isLeftSide ? right : left;

  return {
    pressureKpa: round(wheel.mPressure, 1),
    temps: {
      innerC: kToC(inner),
      middleC: kToC(center),
      outerC: kToC(outer),
    },
    surfaceTempC: kToC((left + center + right) / 3),
    carcassTempC: kToC(wheel.mTireCarcassTemperature),
    // Rubber just below the surface (same left/center/right order). Games often
    // display this rather than the fast-changing surface temperature.
    innerLayerTemps: innerLayer(wheel.mTireInnerLayerTemperature, isLeftSide),
    // mWear is 1.0 on a new tire and falls as it wears
    wearPercent: round((1 - wheel.mWear) * 100, 2),
    remainingPercent: round(wheel.mWear * 100, 2),
    brakeTempC: kToC(wheel.mBrakeTemp),
    loadN: round(wheel.mTireLoad, 0),
    gripFraction: round(wheel.mGripFract, 3),
    flat: wheel.mFlat,
    detached: wheel.mDetached,
  };
}

function readScoring(scoringBuf) {
  const header = koffi.decode(scoringBuf, rF2ScoringHeader);
  const info = header.mScoringInfo;
  const count = Math.max(
    0,
    Math.min(info.mNumVehicles, Math.floor((scoringBuf.length - SCORING_VEHICLES_OFFSET) / SCORING_STRIDE)),
  );
  let player = null;
  const field = [];
  for (let i = 0; i < count; i++) {
    const v = koffi.decode(scoringBuf, SCORING_VEHICLES_OFFSET + i * SCORING_STRIDE, rF2VehicleScoring);
    if (v.mIsPlayer) player = v;
    field.push(parseCompetitor(v));
  }
  return { info, player, field };
}

/** Compact scoring entry for one car (used for strategy / competitor pace). */
function parseCompetitor(v) {
  return {
    id: v.mID,
    isPlayer: v.mIsPlayer,
    driver: v.mDriverName,
    vehicle: v.mVehicleName,
    class: v.mVehicleClass,
    position: v.mPlace,
    lapsCompleted: v.mTotalLaps,
    lastLapSec: lapTime(v.mLastLapTime),
    bestLapSec: lapTime(v.mBestLapTime),
    timeBehindLeaderSec: round(v.mTimeBehindLeader, 3),
    lapsBehindLeader: v.mLapsBehindLeader,
    inPits: v.mInPits,
    pitStops: v.mNumPitstops,
    finishStatus: v.mFinishStatus, // 0 none, 1 finished, 2 DNF, 3 DQ
  };
}

function classPosition(field, player) {
  if (!player) return null;
  const sameClass = field.filter((c) => c.class === player.mVehicleClass).sort((a, b) => a.position - b.position);
  const idx = sameClass.findIndex((c) => c.id === player.mID);
  return idx >= 0 ? idx + 1 : null;
}

function findPlayerTelemetry(telemBuf, playerId) {
  const header = koffi.decode(telemBuf, rF2TelemetryHeader);
  const count = Math.max(
    0,
    Math.min(header.mNumVehicles, Math.floor((telemBuf.length - TELEMETRY_VEHICLES_OFFSET) / TELEM_STRIDE)),
  );
  if (count === 0) return null;

  for (let i = 0; i < count; i++) {
    const offset = TELEMETRY_VEHICLES_OFFSET + i * TELEM_STRIDE;
    const id = telemBuf.readInt32LE(offset); // mID is the first field
    if (playerId === null || id === playerId) {
      return koffi.decode(telemBuf, offset, rF2VehicleTelemetry);
    }
  }
  return null;
}

/**
 * @param {{telemetry: Buffer, scoring: Buffer}} raw
 * @returns snapshot object, or null if the player's car is not in the buffers
 */
function parseSnapshot(raw) {
  const { info, player, field } = readScoring(raw.scoring);
  const telem = findPlayerTelemetry(raw.telemetry, player ? player.mID : null);
  if (!telem) return null;

  const v = telem.mLocalVel;
  const speedMs = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

  const tires = {};
  telem.mWheels.forEach((wheel, i) => {
    tires[WHEEL_KEYS[i]] = parseWheel(wheel, WHEEL_KEYS[i]);
  });

  return {
    session: {
      trackName: info.mTrackName || telem.mTrackName,
      type: sessionType(info.mSession),
      phase: GAME_PHASES[info.mGamePhase] || 'unknown',
      elapsedSec: round(info.mCurrentET, 1),
      endSec: round(info.mEndET, 1),
      maxLaps: info.mMaxLaps > 0 && info.mMaxLaps < 10000 ? info.mMaxLaps : null,
      lapDistanceM: round(info.mLapDist, 0),
      numVehicles: info.mNumVehicles,
      ambientTempC: round(info.mAmbientTemp, 1),
      trackTempC: round(info.mTrackTemp, 1),
      raining: round(info.mRaining, 2),
      avgPathWetness: round(info.mAvgPathWetness, 2),
    },
    vehicle: {
      name: telem.mVehicleName,
      class: player ? player.mVehicleClass : null,
      driver: player ? player.mDriverName : null,
      lap: telem.mLapNumber,
      lapsCompleted: player ? player.mTotalLaps : null,
      position: player ? player.mPlace : null,
      classPosition: classPosition(field, player),
      lastLapSec: player ? lapTime(player.mLastLapTime) : null,
      bestLapSec: player ? lapTime(player.mBestLapTime) : null,
      lapDistanceM: player ? round(player.mLapDist, 0) : null,
      currentLapSec: telem.mLapStartET > 0 || telem.mElapsedTime > 0 ? round(telem.mElapsedTime - telem.mLapStartET, 3) : null,
      inPits: player ? player.mInPits : false,
      pitStops: player ? player.mNumPitstops : null,
      speedKph: round(speedMs * 3.6, 1),
      gear: telem.mGear,
      rpm: round(telem.mEngineRPM, 0),
      maxRpm: round(telem.mEngineMaxRPM, 0),
      throttle: round(telem.mUnfilteredThrottle, 3),
      brake: round(telem.mUnfilteredBrake, 3),
      fuelL: round(telem.mFuel, 2),
      fuelCapacityL: round(telem.mFuelCapacity, 1),
      frontCompound: telem.mFrontTireCompoundName,
      rearCompound: telem.mRearTireCompoundName,
    },
    tires,
    // Every car in the session. Not broadcast at 10 Hz; used by the strategy module.
    field,
  };
}

module.exports = { parseSnapshot, parseWheel, sessionType, WHEEL_KEYS };
