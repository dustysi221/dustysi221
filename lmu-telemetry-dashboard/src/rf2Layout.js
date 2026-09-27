'use strict';

/**
 * Binary layout of the buffers published by rFactor2SharedMemoryMapPlugin64.dll
 * (TheIronWolf's rF2SharedMemoryMapPlugin, rF2State.h). The plugin compiles
 * these structs with `#pragma pack(push, 4)`, so we declare them with
 * koffi.pack() and let koffi compute the offsets.
 *
 * Windows C types used by the plugin map as follows:
 *   long / unsigned long -> int32 / uint32 (always 32-bit on Windows)
 *   unsigned char        -> uint8
 *   signed char          -> int8
 *   bool                 -> bool (1 byte)
 *
 * Verified field-by-field against the plugin's Include/rF2State.h (compiled
 * for x64). Each mapped buffer is an rF2MappedBufferVersionBlock (8 bytes)
 * followed by the struct, which starts with mBytesUpdatedHint (4 bytes).
 *
 * Expected struct sizes (asserted in test/telemetry.test.js):
 *   rF2Wheel 260, rF2VehicleTelemetry 1888, rF2ScoringInfo 548, rF2VehicleScoring 584
 */

const koffi = require('koffi');

const MAX_MAPPED_VEHICLES = 128;

// Names from the plugin source (SharedMemoryPlugin::MM_*_FILE_NAME). A plugin
// running inside a dedicated server appends its PID; the game itself does not.
const TELEMETRY_MAP_NAME = '$rFactor2SMMP_Telemetry$';
const SCORING_MAP_NAME = '$rFactor2SMMP_Scoring$';

// Fixed-size C strings: int8 arrays with the 'String' hint decode to JS strings.
const cstr = (n) => koffi.array('int8', n, 'String');
const bytes = (n) => koffi.array('uint8', n, 'Array');

const rF2Vec3 = koffi.pack('rF2Vec3', {
  x: 'double',
  y: 'double',
  z: 'double',
});

const rF2Wheel = koffi.pack('rF2Wheel', {
  mSuspensionDeflection: 'double',
  mRideHeight: 'double',
  mSuspForce: 'double',
  mBrakeTemp: 'double', // Kelvin
  mBrakePressure: 'double', // 0.0-1.0
  mRotation: 'double',
  mLateralPatchVel: 'double',
  mLongitudinalPatchVel: 'double',
  mLateralGroundVel: 'double',
  mLongitudinalGroundVel: 'double',
  mCamber: 'double',
  mLateralForce: 'double',
  mLongitudinalForce: 'double',
  mTireLoad: 'double',
  mGripFract: 'double',
  mPressure: 'double', // kPa
  mTemperature: koffi.array('double', 3, 'Array'), // Kelvin: left/center/right tread
  mWear: 'double', // 1.0 = new, decreases as the tire wears
  mTerrainName: cstr(16),
  mSurfaceType: 'uint8',
  mFlat: 'bool',
  mDetached: 'bool',
  mStaticUndeflectedRadius: 'uint8',
  mVerticalTireDeflection: 'double',
  mWheelYLocation: 'double',
  mToe: 'double',
  mTireCarcassTemperature: 'double', // Kelvin
  mTireInnerLayerTemperature: koffi.array('double', 3, 'Array'), // Kelvin
  mExpansion: bytes(24),
});

const rF2VehicleTelemetry = koffi.pack('rF2VehicleTelemetry', {
  mID: 'int32',
  mDeltaTime: 'double',
  mElapsedTime: 'double',
  mLapNumber: 'int32',
  mLapStartET: 'double',
  mVehicleName: cstr(64),
  mTrackName: cstr(64),

  mPos: rF2Vec3,
  mLocalVel: rF2Vec3, // m/s
  mLocalAccel: rF2Vec3,
  mOri: koffi.array(rF2Vec3, 3, 'Array'),
  mLocalRot: rF2Vec3,
  mLocalRotAccel: rF2Vec3,

  mGear: 'int32',
  mEngineRPM: 'double',
  mEngineWaterTemp: 'double',
  mEngineOilTemp: 'double',
  mClutchRPM: 'double',

  mUnfilteredThrottle: 'double',
  mUnfilteredBrake: 'double',
  mUnfilteredSteering: 'double',
  mUnfilteredClutch: 'double',
  mFilteredThrottle: 'double',
  mFilteredBrake: 'double',
  mFilteredSteering: 'double',
  mFilteredClutch: 'double',

  mSteeringShaftTorque: 'double',
  mFront3rdDeflection: 'double',
  mRear3rdDeflection: 'double',

  mFrontWingHeight: 'double',
  mFrontRideHeight: 'double',
  mRearRideHeight: 'double',
  mDrag: 'double',
  mFrontDownforce: 'double',
  mRearDownforce: 'double',

  mFuel: 'double', // liters
  mEngineMaxRPM: 'double',
  mScheduledStops: 'uint8',
  mOverheating: 'bool',
  mDetached: 'bool',
  mHeadlights: 'bool',
  mDentSeverity: bytes(8),
  mLastImpactET: 'double',
  mLastImpactMagnitude: 'double',
  mLastImpactPos: rF2Vec3,

  mEngineTorque: 'double',
  mCurrentSector: 'int32',
  mSpeedLimiter: 'uint8',
  mMaxGears: 'uint8',
  mFrontTireCompoundIndex: 'uint8',
  mRearTireCompoundIndex: 'uint8',
  mFuelCapacity: 'double',
  mFrontFlapActivated: 'uint8',
  mRearFlapActivated: 'uint8',
  mRearFlapLegalStatus: 'uint8',
  mIgnitionStarter: 'uint8',
  mFrontTireCompoundName: cstr(18),
  mRearTireCompoundName: cstr(18),
  mSpeedLimiterAvailable: 'uint8',
  mAntiStallActivated: 'uint8',
  mUnused: bytes(2),
  mVisualSteeringWheelRange: 'float',
  mRearBrakeBias: 'double',
  mTurboBoostPressure: 'double',
  mPhysicsToGraphicsOffset: koffi.array('float', 3, 'Array'),
  mPhysicalSteeringWheelRange: 'float',
  mExpansion: bytes(152),

  mWheels: koffi.array(rF2Wheel, 4, 'Array'), // FL, FR, RL, RR
});

const rF2ScoringInfo = koffi.pack('rF2ScoringInfo', {
  mTrackName: cstr(64),
  mSession: 'int32',
  mCurrentET: 'double',
  mEndET: 'double',
  mMaxLaps: 'int32',
  mLapDist: 'double',
  pointer1: bytes(8),
  mNumVehicles: 'int32',
  mGamePhase: 'uint8',
  mYellowFlagState: 'int8',
  mSectorFlag: koffi.array('int8', 3, 'Array'),
  mStartLight: 'uint8',
  mNumRedLights: 'uint8',
  mInRealtime: 'bool',
  mPlayerName: cstr(32),
  mPlrFileName: cstr(64),
  mDarkCloud: 'double',
  mRaining: 'double',
  mAmbientTemp: 'double', // Celsius
  mTrackTemp: 'double', // Celsius
  mWind: rF2Vec3,
  mMinPathWetness: 'double',
  mMaxPathWetness: 'double',
  mGameMode: 'uint8',
  mIsPasswordProtected: 'bool',
  mServerPort: 'uint16',
  mServerPublicIP: 'uint32',
  mMaxPlayers: 'int32',
  mServerName: cstr(32),
  mStartET: 'float',
  mAvgPathWetness: 'double',
  mExpansion: bytes(200),
  pointer2: bytes(8),
});

const rF2VehicleScoring = koffi.pack('rF2VehicleScoring', {
  mID: 'int32',
  mDriverName: cstr(32),
  mVehicleName: cstr(64),
  mTotalLaps: 'int16',
  mSector: 'int8',
  mFinishStatus: 'int8',
  mLapDist: 'double',
  mPathLateral: 'double',
  mTrackEdge: 'double',
  mBestSector1: 'double',
  mBestSector2: 'double',
  mBestLapTime: 'double',
  mLastSector1: 'double',
  mLastSector2: 'double',
  mLastLapTime: 'double',
  mCurSector1: 'double',
  mCurSector2: 'double',
  mNumPitstops: 'int16',
  mNumPenalties: 'int16',
  mIsPlayer: 'bool',
  mControl: 'int8',
  mInPits: 'bool',
  mPlace: 'uint8',
  mVehicleClass: cstr(32),
  mTimeBehindNext: 'double',
  mLapsBehindNext: 'int32',
  mTimeBehindLeader: 'double',
  mLapsBehindLeader: 'int32',
  mLapStartET: 'double',
  mPos: rF2Vec3,
  mLocalVel: rF2Vec3,
  mLocalAccel: rF2Vec3,
  mOri: koffi.array(rF2Vec3, 3, 'Array'),
  mLocalRot: rF2Vec3,
  mLocalRotAccel: rF2Vec3,
  mHeadlights: 'uint8',
  mPitState: 'uint8',
  mServerScored: 'uint8',
  mIndividualPhase: 'uint8',
  mQualification: 'int32',
  mTimeIntoLap: 'double',
  mEstimatedLapTime: 'double',
  mPitGroup: cstr(24),
  mFlag: 'uint8',
  mUnderYellow: 'bool',
  mCountLapFlag: 'uint8',
  mInGarageStall: 'bool',
  mUpgradePack: bytes(16),
  mPitLapDist: 'float',
  mBestLapSector1: 'float',
  mBestLapSector2: 'float',
  mExpansion: bytes(48),
});

// Every mapped buffer starts with this block. Readers compare begin/end to
// detect a torn read (the plugin was writing while we copied).
const rF2VersionBlockWithSize = koffi.pack('rF2VersionBlockWithSize', {
  mVersionUpdateBegin: 'uint32',
  mVersionUpdateEnd: 'uint32',
  mBytesUpdatedHint: 'int32',
});

const rF2TelemetryHeader = koffi.pack('rF2TelemetryHeader', {
  version: rF2VersionBlockWithSize,
  mNumVehicles: 'int32',
});

const rF2ScoringHeader = koffi.pack('rF2ScoringHeader', {
  version: rF2VersionBlockWithSize,
  mScoringInfo: rF2ScoringInfo,
});

const TELEMETRY_VEHICLES_OFFSET = koffi.sizeof(rF2TelemetryHeader); // 16
const SCORING_VEHICLES_OFFSET = koffi.sizeof(rF2ScoringHeader); // 560

const TELEMETRY_BUFFER_SIZE =
  TELEMETRY_VEHICLES_OFFSET + MAX_MAPPED_VEHICLES * koffi.sizeof(rF2VehicleTelemetry);
const SCORING_BUFFER_SIZE =
  SCORING_VEHICLES_OFFSET + MAX_MAPPED_VEHICLES * koffi.sizeof(rF2VehicleScoring);

module.exports = {
  koffi,
  MAX_MAPPED_VEHICLES,
  TELEMETRY_MAP_NAME,
  SCORING_MAP_NAME,
  rF2Wheel,
  rF2VehicleTelemetry,
  rF2ScoringInfo,
  rF2VehicleScoring,
  rF2VersionBlockWithSize,
  rF2TelemetryHeader,
  rF2ScoringHeader,
  TELEMETRY_VEHICLES_OFFSET,
  SCORING_VEHICLES_OFFSET,
  TELEMETRY_BUFFER_SIZE,
  SCORING_BUFFER_SIZE,
};
