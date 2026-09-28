'use strict';

/**
 * Push-to-talk wheel button read by the server through Windows' built-in
 * joystick API (winmm.dll). Unlike the browser's Gamepad API this works no
 * matter which window has focus, so LMU can stay the active window while the
 * dashboard sits on another monitor.
 *
 * Button numbers are 1-based, the same as Windows' "Set up USB game
 * controllers" (joy.cpl) dialog. The winmm API reports up to 32 buttons per
 * device and up to 16 devices.
 *
 * Events: 'down', 'up' (the bound button), 'devices' (list changed)
 */

const { EventEmitter } = require('events');

const MAX_DEVICES = 16;
const JOY_RETURNBUTTONS = 0x80;

/** Windows joystick API via koffi. Returns null on other platforms. */
function loadWinmm() {
  if (process.platform !== 'win32') return null;
  const koffi = require('koffi');
  const lib = koffi.load('winmm.dll');

  const JOYCAPSW = koffi.struct('JOYCAPSW', {
    wMid: 'uint16',
    wPid: 'uint16',
    szPname: koffi.array('char16', 32, 'String'),
    wXmin: 'uint32',
    wXmax: 'uint32',
    wYmin: 'uint32',
    wYmax: 'uint32',
    wZmin: 'uint32',
    wZmax: 'uint32',
    wNumButtons: 'uint32',
    wPeriodMin: 'uint32',
    wPeriodMax: 'uint32',
    wRmin: 'uint32',
    wRmax: 'uint32',
    wUmin: 'uint32',
    wUmax: 'uint32',
    wVmin: 'uint32',
    wVmax: 'uint32',
    wCaps: 'uint32',
    wMaxAxes: 'uint32',
    wNumAxes: 'uint32',
    wMaxButtons: 'uint32',
    szRegKey: koffi.array('char16', 32, 'String'),
    szOEMVxD: koffi.array('char16', 260, 'String'),
  });
  const JOYINFOEX = koffi.struct('JOYINFOEX', {
    dwSize: 'uint32',
    dwFlags: 'uint32',
    dwXpos: 'uint32',
    dwYpos: 'uint32',
    dwZpos: 'uint32',
    dwRpos: 'uint32',
    dwUpos: 'uint32',
    dwVpos: 'uint32',
    dwButtons: 'uint32',
    dwButtonNumber: 'uint32',
    dwPOV: 'uint32',
    dwReserved1: 'uint32',
    dwReserved2: 'uint32',
  });

  const joyGetDevCapsW = lib.func('__stdcall', 'joyGetDevCapsW', 'uint32', [
    'uintptr_t',
    koffi.out(koffi.pointer(JOYCAPSW)),
    'uint32',
  ]);
  const joyGetPosEx = lib.func('__stdcall', 'joyGetPosEx', 'uint32', ['uint32', koffi.inout(koffi.pointer(JOYINFOEX))]);
  const capsSize = koffi.sizeof(JOYCAPSW);
  const infoSize = koffi.sizeof(JOYINFOEX);

  return {
    /** { name, buttons } or null if no controller uses this id */
    caps(id) {
      const c = {};
      if (joyGetDevCapsW(id, c, capsSize) !== 0) return null;
      return { name: String(c.szPname || '').trim(), buttons: c.wNumButtons };
    },
    /** Pressed-buttons bitmask (bit 0 = button 1), or null if unplugged */
    buttons(id) {
      const info = { dwSize: infoSize, dwFlags: JOY_RETURNBUTTONS };
      if (joyGetPosEx(id, info) !== 0) return null;
      return info.dwButtons >>> 0;
    },
  };
}

class WheelButtons extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{deviceName?: string, deviceId?: number, button?: number}} [opts.binding]  button is 1-based; 0 = none
   * @param {object} [opts.api]  joystick API ({ caps(id), buttons(id) }); defaults to winmm on Windows
   */
  constructor({ binding = {}, api, pollMs = 16, scanMs = 3000, logger = console } = {}) {
    super();
    this.api = api === undefined ? safeLoad(logger) : api;
    this.supported = Boolean(this.api);
    this.pollMs = pollMs;
    this.scanMs = scanMs;
    this.logger = logger;
    this.binding = normalizeBinding(binding);
    this.devices = []; // [{ id, name, buttons }]
    this.boundId = null;
    this.pressed = false;
    this.learning = null;
    this.timers = [];
  }

  start() {
    if (!this.supported || this.timers.length) return;
    this.scan();
    this.timers.push(setInterval(() => this.poll(), this.pollMs));
    this.timers.push(setInterval(() => this.scan(), this.scanMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Find connected controllers. Only ids that report capabilities are polled. */
  scan() {
    if (!this.supported) return;
    const found = [];
    for (let id = 0; id < MAX_DEVICES; id++) {
      let caps;
      try {
        caps = this.api.caps(id);
      } catch {
        caps = null;
      }
      if (!caps) continue;
      if (this.api.buttons(id) === null) continue; // configured but unplugged
      found.push({ id, name: caps.name || `Controller ${id + 1}`, buttons: Math.min(32, caps.buttons || 32) });
    }
    const changed = JSON.stringify(found) !== JSON.stringify(this.devices);
    this.devices = found;
    this.boundId = this.#resolveBound();
    if (changed) this.emit('devices', found);
  }

  #resolveBound() {
    const b = this.binding;
    if (!b.button) return null;
    if (b.deviceName) {
      const byName = this.devices.filter((d) => d.name === b.deviceName);
      if (byName.length) return (byName.find((d) => d.id === b.deviceId) || byName[0]).id;
    }
    const byId = this.devices.find((d) => d.id === b.deviceId);
    return byId ? byId.id : null;
  }

  poll() {
    if (this.learning) {
      this.#pollLearning();
      return;
    }
    if (this.boundId === null) {
      if (this.pressed) this.#set(false);
      return;
    }
    const mask = this.api.buttons(this.boundId);
    if (mask === null) {
      // unplugged: release and look for it again on the next scan
      if (this.pressed) this.#set(false);
      this.boundId = null;
      return;
    }
    const down = Boolean(mask & (1 << (this.binding.button - 1)));
    if (down !== this.pressed) this.#set(down);
  }

  #set(down) {
    this.pressed = down;
    this.emit(down ? 'down' : 'up');
  }

  /**
   * Resolve with the next button pressed on any controller:
   * { deviceId, deviceName, button } (button 1-based). Rejects on timeout.
   */
  learn(timeoutMs = 15000) {
    if (!this.supported) return Promise.reject(new Error('Wheel buttons can only be read on Windows'));
    this.cancelLearn();
    this.scan();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.learning = null;
        reject(new Error('No button pressed'));
      }, timeoutMs);
      this.learning = {
        baseline: this.#masks(),
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  cancelLearn() {
    if (this.learning) {
      this.learning.reject(new Error('Cancelled'));
      this.learning = null;
    }
  }

  #masks() {
    const out = {};
    for (const d of this.devices) out[d.id] = this.api.buttons(d.id) || 0;
    return out;
  }

  #pollLearning() {
    const now = this.#masks();
    for (const d of this.devices) {
      const fresh = (now[d.id] || 0) & ~(this.learning.baseline[d.id] || 0);
      if (fresh) {
        const bit = Math.log2(fresh & -fresh);
        const found = { deviceId: d.id, deviceName: d.name, button: bit + 1 };
        const { resolve } = this.learning;
        this.learning = null;
        this.setBinding(found);
        resolve(found);
        return;
      }
    }
    this.learning.baseline = now; // released buttons may be pressed again
  }

  setBinding(binding) {
    if (this.pressed) this.#set(false);
    this.binding = normalizeBinding(binding);
    this.boundId = this.#resolveBound();
  }

  state() {
    const b = this.binding;
    return {
      supported: this.supported,
      devices: this.devices,
      binding: b.button ? { deviceName: b.deviceName, deviceId: b.deviceId, button: b.button } : null,
      connected: this.boundId !== null,
      pressed: this.pressed,
      learning: Boolean(this.learning),
    };
  }
}

function normalizeBinding(b = {}) {
  const button = Number(b.button);
  const deviceId = Number(b.deviceId);
  return {
    deviceName: b.deviceName ? String(b.deviceName) : null,
    deviceId: Number.isInteger(deviceId) && deviceId >= 0 ? deviceId : null,
    button: Number.isInteger(button) && button >= 1 && button <= 32 ? button : 0,
  };
}

function safeLoad(logger) {
  try {
    return loadWinmm();
  } catch (err) {
    logger.warn?.('[wheel] joystick API unavailable:', err.message);
    return null;
  }
}

module.exports = { WheelButtons, loadWinmm };
