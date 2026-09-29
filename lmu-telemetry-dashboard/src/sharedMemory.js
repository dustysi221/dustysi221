'use strict';

/**
 * Reads the memory-mapped files published by rFactor2SharedMemoryMapPlugin64.dll
 * while Le Mans Ultimate is running. Windows only: it opens the named file
 * mappings through kernel32 (via koffi) and copies a consistent snapshot of
 * each buffer into a Node Buffer for parsing.
 */

const {
  koffi,
  TELEMETRY_MAP_NAME,
  SCORING_MAP_NAME,
  RULES_MAP_NAME,
  RULES_READ_SIZE,
  TELEMETRY_BUFFER_SIZE,
  SCORING_BUFFER_SIZE,
  TELEMETRY_VEHICLES_OFFSET,
  SCORING_VEHICLES_OFFSET,
  rF2VehicleTelemetry,
  rF2VehicleScoring,
  rF2TelemetryHeader,
  rF2ScoringHeader,
  rF2ScoringInfo,
} = require('./rf2Layout');

const FILE_MAP_READ = 0x0004;
const MAX_READ_ATTEMPTS = 5;
const RULES_RETRY_MS = 5000;

const TELEMETRY_NUM_VEHICLES_OFFSET = koffi.offsetof(rF2TelemetryHeader, 'mNumVehicles');
const SCORING_NUM_VEHICLES_OFFSET =
  koffi.offsetof(rF2ScoringHeader, 'mScoringInfo') + koffi.offsetof(rF2ScoringInfo, 'mNumVehicles');

let kernel32 = null;

function loadKernel32() {
  if (kernel32) return kernel32;
  const lib = koffi.load('kernel32.dll');
  const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
  kernel32 = {
    OpenFileMappingW: lib.func('__stdcall', 'OpenFileMappingW', HANDLE, ['uint32', 'bool', 'str16']),
    MapViewOfFile: lib.func('__stdcall', 'MapViewOfFile', 'void *', [HANDLE, 'uint32', 'uint32', 'uint32', 'size_t']),
    UnmapViewOfFile: lib.func('__stdcall', 'UnmapViewOfFile', 'bool', ['void *']),
    CloseHandle: lib.func('__stdcall', 'CloseHandle', 'bool', [HANDLE]),
    GetLastError: lib.func('__stdcall', 'GetLastError', 'uint32', []),
  };
  return kernel32;
}

class MappedBuffer {
  constructor(name, size) {
    this.name = name;
    this.size = size;
    this.handle = null;
    this.ptr = null;
    this.view = null; // Uint8Array over the mapped memory (no copy)
  }

  open() {
    const k = loadKernel32();
    const handle = k.OpenFileMappingW(FILE_MAP_READ, false, this.name);
    if (!handle) {
      const code = k.GetLastError();
      throw new Error(`OpenFileMapping(${this.name}) failed (Win32 error ${code})`);
    }
    const ptr = k.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
    if (!ptr) {
      const code = k.GetLastError();
      k.CloseHandle(handle);
      throw new Error(`MapViewOfFile(${this.name}) failed (Win32 error ${code})`);
    }
    this.handle = handle;
    this.ptr = ptr;
    this.view = new Uint8Array(koffi.view(ptr, this.size));
  }

  close() {
    if (!kernel32) return;
    if (this.ptr) kernel32.UnmapViewOfFile(this.ptr);
    if (this.handle) kernel32.CloseHandle(this.handle);
    this.handle = null;
    this.ptr = null;
    this.view = null;
  }

  get isOpen() {
    return this.view !== null;
  }

  readVersion() {
    const v = this.view;
    const dv = new DataView(v.buffer, v.byteOffset, 8);
    return { begin: dv.getUint32(0, true), end: dv.getUint32(4, true) };
  }

  /**
   * Copies the first `length` bytes. Retries while the plugin is mid-write
   * (version counters differ, or changed during the copy) so the result is
   * never a mix of two frames.
   */
  readConsistent(length) {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      const before = this.readVersion();
      if (before.begin !== before.end) continue;
      const copy = Buffer.from(this.view.subarray(0, length));
      const after = this.readVersion();
      if (after.begin === before.begin && after.end === before.end) {
        return { buffer: copy, version: before.end };
      }
    }
    return null; // writer too busy; caller keeps the previous frame
  }

  readNumVehicles(offset) {
    const v = this.view;
    return new DataView(v.buffer, v.byteOffset + offset, 4).getInt32(0, true);
  }
}

class SharedMemoryReader {
  constructor() {
    if (process.platform !== 'win32') {
      throw new Error('rF2 shared memory is only available on Windows (use TELEMETRY_SOURCE=mock elsewhere)');
    }
    this.telemetry = new MappedBuffer(TELEMETRY_MAP_NAME, TELEMETRY_BUFFER_SIZE);
    this.scoring = new MappedBuffer(SCORING_MAP_NAME, SCORING_BUFFER_SIZE);
    // Optional: only its first bytes (safety car / full-course yellow state) are read
    this.rules = new MappedBuffer(RULES_MAP_NAME, RULES_READ_SIZE);
    this.rulesTriedAt = 0;
  }

  get isOpen() {
    return this.telemetry.isOpen && this.scoring.isOpen;
  }

  /** Throws if LMU is not running or the plugin is not enabled. */
  open() {
    this.close();
    try {
      this.telemetry.open();
      this.scoring.open();
    } catch (err) {
      this.close();
      throw err;
    }
    this.#openRules();
  }

  /** The Rules buffer is optional: without it, flags come from scoring alone. */
  #openRules() {
    this.rulesTriedAt = Date.now();
    try {
      this.rules.open();
    } catch {
      this.rules.close();
    }
  }

  close() {
    this.telemetry.close();
    this.scoring.close();
    this.rules.close();
  }

  /**
   * Returns { telemetry: Buffer, scoring: Buffer, rules: Buffer|null, telemetryVersion } covering
   * only the vehicles currently in the session, or null if a consistent read
   * was not possible this tick.
   */
  read() {
    const numTelem = clampVehicles(this.telemetry.readNumVehicles(TELEMETRY_NUM_VEHICLES_OFFSET));
    const telem = this.telemetry.readConsistent(
      TELEMETRY_VEHICLES_OFFSET + numTelem * koffi.sizeof(rF2VehicleTelemetry),
    );
    if (!telem) return null;

    const numScoring = clampVehicles(this.scoring.readNumVehicles(SCORING_NUM_VEHICLES_OFFSET));
    const scoring = this.scoring.readConsistent(
      SCORING_VEHICLES_OFFSET + numScoring * koffi.sizeof(rF2VehicleScoring),
    );
    if (!scoring) return null;

    if (!this.rules.isOpen && Date.now() - this.rulesTriedAt > RULES_RETRY_MS) this.#openRules();
    const rules = this.rules.isOpen ? this.rules.readConsistent(RULES_READ_SIZE) : null;

    return {
      telemetry: telem.buffer,
      scoring: scoring.buffer,
      rules: rules ? rules.buffer : null,
      telemetryVersion: telem.version,
    };
  }
}

function clampVehicles(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 128);
}

module.exports = { SharedMemoryReader };
