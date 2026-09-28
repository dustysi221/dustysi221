'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WheelButtons } = require('../src/wheelButtons');

/** Fake joystick API: set `masks[id]` to press buttons; delete an id to unplug it. */
function fakeApi() {
  const names = { 0: 'Fanatec Wheel', 2: 'Button Box' };
  const masks = { 0: 0, 2: 0 };
  return {
    masks,
    caps: (id) => (id in names ? { name: names[id], buttons: 32 } : null),
    buttons: (id) => (id in masks ? masks[id] : null),
  };
}

const tick = (w, n = 1) => {
  for (let i = 0; i < n; i++) w.poll();
};

test('emits down/up for the bound button only', () => {
  const api = fakeApi();
  const w = new WheelButtons({ api, binding: { deviceName: 'Button Box', button: 5 } });
  w.scan();
  const events = [];
  w.on('down', () => events.push('down'));
  w.on('up', () => events.push('up'));

  api.masks[0] = 1 << 4; // same button number on the other device: ignored
  tick(w);
  api.masks[2] = 1 << 4; // button 5 on the button box
  tick(w, 3);
  api.masks[2] = 0;
  tick(w);
  assert.deepEqual(events, ['down', 'up']);
});

test('learn picks the next newly pressed button and binds it', async () => {
  const api = fakeApi();
  api.masks[0] = 1; // button 1 already held when learning starts: ignored
  const w = new WheelButtons({ api });
  w.scan();
  const p = w.learn(1000);
  tick(w);
  api.masks[0] = 1 | (1 << 9); // button 10 pressed
  tick(w);
  const found = await p;
  assert.deepEqual(found, { deviceId: 0, deviceName: 'Fanatec Wheel', button: 10 });
  assert.deepEqual(w.state().binding, { deviceName: 'Fanatec Wheel', deviceId: 0, button: 10 });
  assert.equal(w.state().connected, true);
});

test('learn times out when nothing is pressed', async () => {
  const w = new WheelButtons({ api: fakeApi() });
  w.scan();
  await assert.rejects(w.learn(30), /No button pressed/);
});

test('unplugging releases the button and finds the device again by name', () => {
  const api = fakeApi();
  const w = new WheelButtons({ api, binding: { deviceName: 'Fanatec Wheel', deviceId: 0, button: 1 } });
  w.scan();
  const events = [];
  w.on('down', () => events.push('down'));
  w.on('up', () => events.push('up'));
  api.masks[0] = 1;
  tick(w);
  delete api.masks[0]; // unplugged mid-press
  tick(w);
  assert.deepEqual(events, ['down', 'up']);
  assert.equal(w.state().connected, false);

  api.masks[0] = 0; // plugged back in
  w.scan();
  assert.equal(w.state().connected, true);
});

test('bad bindings are ignored; no joystick API means unsupported', () => {
  const w = new WheelButtons({ api: fakeApi(), binding: { button: 99 } });
  w.scan();
  assert.equal(w.state().binding, null);

  const none = new WheelButtons({ api: null });
  assert.equal(none.state().supported, false);
  return assert.rejects(none.learn(10), /only be read on Windows/);
});
