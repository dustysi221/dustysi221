/**
 * Steering-wheel push-to-talk via the browser Gamepad API.
 *
 * Wheels, button boxes and pads show up as gamepads once the browser has seen
 * a button press on them. This module watches one button on one device and
 * emits 'press' / 'release' events, and can "learn" a binding by waiting for
 * the next button the driver presses.
 *
 *   const wheel = new WheelInput({ binding: { gamepadId: null, button: 0 } });
 *   wheel.addEventListener('press', ...); wheel.addEventListener('release', ...);
 *   wheel.start();
 *   const binding = await wheel.learn();   // { gamepadId, gamepadName, button }
 *
 * Notes:
 * - Keep the dashboard window visible (not minimized). Browsers stop reporting
 *   gamepads to hidden pages, and some only report to the focused window.
 * - gamepadId null means "this button on any connected device".
 */
(function (global) {
  'use strict';

  const POLL_MS = 16;
  const PRESS_THRESHOLD = 0.5; // analog buttons (e.g. paddles) count as pressed above this

  class WheelInput extends EventTarget {
    constructor({ binding } = {}) {
      super();
      this.binding = { gamepadId: null, button: 0, ...(binding || {}) };
      this.pressed = false;
      this.timer = null;
      this.learning = null; // { resolve, reject, baseline }
      this.supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

      if (this.supported) {
        global.addEventListener('gamepadconnected', (e) => this.#emit('devices', { connected: e.gamepad.id }));
        global.addEventListener('gamepaddisconnected', (e) => {
          this.#emit('devices', { disconnected: e.gamepad.id });
          if (this.pressed && this.#matches(e.gamepad)) this.#setPressed(false);
        });
      }
    }

    /** Start polling. setInterval rather than requestAnimationFrame so it keeps running when the window isn't focused. */
    start() {
      if (!this.supported || this.timer) return;
      this.timer = setInterval(() => this.#poll(), POLL_MS);
    }

    stop() {
      clearInterval(this.timer);
      this.timer = null;
    }

    setBinding(binding) {
      if (this.pressed) this.#setPressed(false);
      this.binding = { gamepadId: null, button: 0, ...binding };
    }

    /** Connected devices: [{ index, id, name, buttons }] */
    devices() {
      if (!this.supported) return [];
      return Array.from(navigator.getGamepads())
        .filter(Boolean)
        .map((g) => ({ index: g.index, id: g.id, name: shortName(g.id), buttons: g.buttons.length }));
    }

    /**
     * Resolve with the next button pressed on any device:
     * { gamepadId, gamepadName, button }. Rejects after `timeoutMs`.
     */
    learn(timeoutMs = 15000) {
      if (!this.supported) return Promise.reject(new Error('This browser has no Gamepad API'));
      this.cancelLearn();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.learning = null;
          reject(new Error('No button pressed'));
        }, timeoutMs);
        this.learning = {
          baseline: snapshotButtons(),
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
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

    #poll() {
      const pads = Array.from(navigator.getGamepads()).filter(Boolean);

      if (this.learning) {
        for (const g of pads) {
          const before = this.learning.baseline[g.index] || [];
          for (let b = 0; b < g.buttons.length; b++) {
            if (isDown(g.buttons[b]) && !before[b]) {
              const { resolve } = this.learning;
              this.learning = null;
              resolve({ gamepadId: g.id, gamepadName: shortName(g.id), button: b });
              return;
            }
          }
        }
        // Buttons released since learning started may be pressed again
        this.learning.baseline = snapshotButtons();
        return; // don't trigger push-to-talk while assigning a button
      }

      let down = false;
      for (const g of pads) {
        if (!this.#matches(g)) continue;
        const btn = g.buttons[this.binding.button];
        if (btn && isDown(btn)) {
          down = true;
          break;
        }
      }
      if (down !== this.pressed) this.#setPressed(down);
    }

    #matches(g) {
      return this.binding.gamepadId == null || g.id === this.binding.gamepadId;
    }

    #setPressed(down) {
      this.pressed = down;
      this.#emit(down ? 'press' : 'release', {});
    }

    #emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  function isDown(button) {
    return button.pressed || button.value > PRESS_THRESHOLD;
  }

  function snapshotButtons() {
    const out = {};
    for (const g of Array.from(navigator.getGamepads()).filter(Boolean)) {
      out[g.index] = g.buttons.map(isDown);
    }
    return out;
  }

  /** "Fanatec Wheel (Vendor: 0eb7 Product: 0020)" -> "Fanatec Wheel" */
  function shortName(id) {
    return String(id || 'Controller').replace(/\s*\(.*?\)\s*/g, ' ').trim() || 'Controller';
  }

  global.WheelInput = WheelInput;
})(window);
