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
  rF2RulesHeader,
  RULES_READ_SIZE,
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

const DENT_ZONES = ['front', 'frontRight', 'right', 'rearRight', 'rear', 'rearLeft', 'left', 'frontLeft'];

/**
 * Body damage and impacts. Dent severity per zone is 0 (none), 1 (some) or
 * 2 (more). Impact magnitude is the game's own unit: compare, don't convert.
 */
function parseDamage(telem, tires) {
  const dents = Array.from(telem.mDentSeverity || []);
  const zones = {};
  dents.forEach((v, i) => {
    if (v > 0 && DENT_ZONES[i]) zones[DENT_ZONES[i]] = v;
  });
  const impactAgo = telem.mLastImpactET > 0 ? telem.mElapsedTime - telem.mLastImpactET : null;
  return {
    maxDentSeverity: dents.length ? Math.max(...dents) : 0,
    dentedZones: zones,
    partsDetached: Boolean(telem.mDetached),
    engineOverheating: Boolean(telem.mOverheating),
    flatTires: Object.keys(tires).filter((k) => tires[k].flat),
    detachedWheels: Object.keys(tires).filter((k) => tires[k].detached),
    lastImpactSecAgo: impactAgo !== null && impactAgo >= 0 ? round(impactAgo, 1) : null,
    lastImpactMagnitude: telem.mLastImpactET > 0 ? round(telem.mLastImpactMagnitude, 0) : null,
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
    inGarage: v.mInGarageStall,
    pitStops: v.mNumPitstops,
    finishStatus: v.mFinishStatus, // 0 none, 1 finished, 2 DNF, 3 DQ
    lapDistM: round(v.mLapDist, 0),
    // World position (x/z plane) for the track map
    posX: round(v.mPos.x, 1),
    posZ: round(v.mPos.z, 1),
    speedKph: round(Math.hypot(v.mLocalVel.x, v.mLocalVel.y, v.mLocalVel.z) * 3.6, 0),
    sector: SECTOR[v.mSector] || null,
  };
}

const YELLOW_STATES = ['none', 'pending', 'pitsClosed', 'pitLeadLap', 'pitsOpen', 'lastLap', 'resume', 'raceHalt'];
const SLOW_CAR_KPH = 40;
const STOPPED_KPH = 10;
const RULES_MAX_LAG_SEC = 10;

/**
 * Track status for the map and the engineers.
 *   state: 'green' | 'localYellow' | 'fcy' | 'safetyCar' | 'fullCourse' | 'other'
 *     fcy        full-course yellow without a safety car on track (LMU's FCY, like a VSC)
 *     safetyCar  full-course yellow with the safety car out
 *     fullCourse full-course yellow, but the Rules buffer is unavailable to tell which
 *   sectorYellow: [S1, S2, S3] local yellows
 *   slowCars: ids of cars crawling or stopped on track (likely the cause of a yellow)
 */
function parseFlags(info, rulesBuf, field) {
  let rules = null;
  const r = rulesBuf && rulesBuf.length >= RULES_READ_SIZE ? koffi.decode(rulesBuf, rF2RulesHeader).mTrackRules : null;
  // Track rules run where the race is hosted, so online the buffer can be stale:
  // only trust it while its clock keeps up with scoring
  if (r && Math.abs(r.mCurrentET - info.mCurrentET) < RULES_MAX_LAG_SEC) {
    rules = {
      safetyCarExists: r.mSafetyCarExists,
      safetyCarActive: r.mSafetyCarActive,
      safetyCarLapDistM: r.mSafetyCarActive ? round(r.mSafetyCarLapDist, 0) : null,
      safetyCarSpeedKph: r.mSafetyCarActive && r.mSafetyCarSpeed > 0 ? round(r.mSafetyCarSpeed * 3.6, 0) : null,
      yellowLaps: r.mYellowFlagLaps > 0 ? r.mYellowFlagLaps : null,
    };
  }

  // rF2 orders mSectorFlag like mSector: [sector 3, sector 1, sector 2]
  const raw = Array.isArray(info.mSectorFlag) ? info.mSectorFlag : [0, 0, 0];
  // Only 1 means a yellow; LMU leaves other non-zero values in here under green
  const sectorYellow = [raw[1] === 1, raw[2] === 1, raw[0] === 1];
  const fullCourse = info.mGamePhase === 6;
  const running = info.mGamePhase === 5 || fullCourse;

  let state = 'other';
  if (fullCourse) state = !rules ? 'fullCourse' : rules.safetyCarActive ? 'safetyCar' : 'fcy';
  else if (info.mGamePhase === 5) state = sectorYellow.some(Boolean) ? 'localYellow' : 'green';

  // Under a full-course yellow everyone is slow, so only stopped cars count then
  const slowKph = fullCourse ? STOPPED_KPH : SLOW_CAR_KPH;
  const slowCars = running
    ? field.filter((c) => !c.inPits && !c.inGarage && c.finishStatus === 0 && c.speedKph != null && c.speedKph < slowKph).map((c) => c.id)
    : [];

  return {
    state,
    sectorYellow,
    yellowState: fullCourse ? YELLOW_STATES[info.mYellowFlagState] || null : null,
    safetyCar: rules && rules.safetyCarActive ? { lapDistM: rules.safetyCarLapDistM, speedKph: rules.safetyCarSpeedKph } : null,
    yellowLaps: fullCourse && rules ? rules.yellowLaps : null,
    rulesAvailable: !!rules,
    slowCars,
    // Raw values for checking against the game (/api/snapshot): [sector 3, 1, 2] as rF2 sends them
    rawSectorFlags: raw.slice(0, 3),
    rawYellowFlagState: info.mYellowFlagState,
  };
}

// rF2 counts sectors 1, 2 and 0 (= sector 3)
const SECTOR = { 1: 1, 2: 2, 0: 3 };
const secTime = (t) => (t > 0 ? round(t, 3) : null);

/**
 * Sector times in seconds (not cumulative). The game reports sector 2 as
 * "sector 1 + sector 2", so it is converted here.
 */
function sectorTimes(p) {
  if (!p) return null;
  const split = (s1, s12, lap) => {
    const a = secTime(s1);
    const b = s12 > 0 && s1 > 0 ? round(s12 - s1, 3) : null;
    const c = lap > 0 && s12 > 0 ? round(lap - s12, 3) : null;
    return [a, b, c];
  };
  return {
    current: SECTOR[p.mSector] ?? null,
    currentLap: [secTime(p.mCurSector1), p.mCurSector2 > 0 && p.mCurSector1 > 0 ? round(p.mCurSector2 - p.mCurSector1, 3) : null, null],
    lastLap: split(p.mLastSector1, p.mLastSector2, p.mLastLapTime),
    // Best individual sectors across the session (sector 3 isn't reported separately)
    bestSectors: [secTime(p.mBestSector1), p.mBestSector2 > 0 && p.mBestSector1 > 0 ? round(p.mBestSector2 - p.mBestSector1, 3) : null, null],
    bestLap: split(p.mBestLapSector1, p.mBestLapSector2, p.mBestLapTime),
  };
}

/**
 * Lap distance brought up to the telemetry frame. Scoring (and its mLapDist)
 * only updates ~5 times a second, telemetry much more often, so:
 * - add the distance driven since the scoring update
 * - just after the line, telemetry already has the new lap while scoring still
 *   has ~full-lap distance of the old one: count from the lap start instead
 */
const MAX_SCORING_AGE_SEC = 0.6;
function playerLapDistance(player, telem, info, speedMs) {
  if (!player) return null;
  const lapLen = info.mLapDist > 0 ? info.mLapDist : Infinity;
  let dist;
  if (telem.mLapStartET > info.mCurrentET) {
    dist = speedMs * (telem.mElapsedTime - telem.mLapStartET);
  } else {
    const age = telem.mElapsedTime - info.mCurrentET;
    dist = player.mLapDist + (age > 0 && age < MAX_SCORING_AGE_SEC ? speedMs * age : 0);
  }
  return round(Math.max(0, Math.min(dist, lapLen)), 0);
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
      lapDistanceM: playerLapDistance(player, telem, info, speedMs),
      // True for a moment after the line, while scoring (laps completed, last
      // lap time, sectors) still describes the previous lap
      scoringLapBehind: !!player && telem.mLapStartET > info.mCurrentET,
      currentLapSec: telem.mLapStartET > 0 || telem.mElapsedTime > 0 ? round(telem.mElapsedTime - telem.mLapStartET, 3) : null,
      inPits: player ? player.mInPits : false,
      inGarage: player ? player.mInGarageStall : false,
      pitStops: player ? player.mNumPitstops : null,
      speedKph: round(speedMs * 3.6, 1),
      gear: telem.mGear,
      rpm: round(telem.mEngineRPM, 0),
      maxRpm: round(telem.mEngineMaxRPM, 0),
      throttle: round(telem.mUnfilteredThrottle, 3),
      brake: round(telem.mUnfilteredBrake, 3),
      steering: round(telem.mUnfilteredSteering, 3), // -1 left .. +1 right
      // Accelerations in g. rF2 local axes: +x left, +z backward.
      gLat: round(-telem.mLocalAccel.x / 9.81, 2), // + = pulling right
      gLong: round(-telem.mLocalAccel.z / 9.81, 2), // + = accelerating, - = braking
      posX: round(telem.mPos.x, 1),
      posZ: round(telem.mPos.z, 1),
      sectors: sectorTimes(player),
      fuelL: round(telem.mFuel, 2),
      fuelCapacityL: round(telem.mFuelCapacity, 1),
      frontCompound: telem.mFrontTireCompoundName,
      rearCompound: telem.mRearTireCompoundName,
    },
    tires,
    damage: parseDamage(telem, tires),
    flags: parseFlags(info, raw.rules, field),
    // Every car in the session. Not broadcast at 10 Hz; used by the strategy module.
    field,
  };
}

module.exports = { parseSnapshot, parseWheel, parseFlags, sessionType, WHEEL_KEYS };
