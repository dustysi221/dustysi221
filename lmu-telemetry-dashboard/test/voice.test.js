'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { VoiceAssistant, BusyError, buildVoiceBrief } = require('../src/voice-assistant');
const { SYSTEM_PROMPT } = require('../src/voice-prompts');
const { MockSource } = require('../src/mockSource');
const { parseSnapshot } = require('../src/telemetryParser');
const { SessionTracker } = require('../src/sessionTracker');
const { TireHistory } = require('../src/tireHistory');

/** Run the simulator for `seconds` of race time and return a voice context. */
function context(seconds) {
  const realNow = Date.now;
  const base = realNow();
  let t = 0;
  Date.now = () => base + t * 1000;
  try {
    const mock = new MockSource();
    const tracker = new SessionTracker();
    const tireHistory = new TireHistory();
    let full;
    for (t = 0; t <= seconds; t++) {
      full = parseSnapshot(mock.read());
      tracker.record(full);
      tireHistory.record(full);
    }
    const { field, ...snapshot } = full;
    return {
      snapshot,
      field,
      tracker,
      tireHistory,
      tireAnalysis: { lap: 15, tire_health: 'fair', radio: 'Front left hot.', pressure_adjustment: '-0.2 PSI front left', pit_window: '20 laps' },
      strategy: { lap: 15, radio: 'Box end of lap 30, fuel only.', service: 'Fuel only', pit_lap: 30, confidence: 'high' },
    };
  } finally {
    Date.now = realNow;
  }
}

function fakeClient(reply = 'Copy that. Tires are fine, stay out.') {
  const calls = [];
  return {
    calls,
    enabled: true,
    async requestJson(req) {
      calls.push(req);
      return { data: { reply }, meta: { model: 'claude-opus-5', latencyMs: 800, usage: {}, totals: {} } };
    },
  };
}

test('voice brief carries tires, fuel, race, rivals and the latest calls', () => {
  const brief = buildVoiceBrief(context(1500));
  assert.equal(brief.car.lap, 16);
  assert.ok(brief.tires.FL.pressurePsi > 20);
  assert.ok(Number.isFinite(brief.tires.FL.tempsC.middle));
  assert.equal(brief.fuel.perLapL, 2.9);
  assert.equal(brief.fuel.lastLapToPitForFuel, 30);
  assert.ok(brief.race.lapsRemaining > 0);
  assert.ok(brief.rivals.ahead && brief.rivals.behind);
  assert.equal(brief.latest_calls.strategist.pit_lap, 30);
  assert.equal(brief.latest_calls.tire_engineer.health, 'fair');
});

test('voice brief without telemetry says so instead of failing', () => {
  assert.match(buildVoiceBrief({}).note, /No live telemetry/);
});

test('ask sends the question with live data, returns a short reply, and remembers it', async () => {
  const client = fakeClient();
  const ctx = context(600);
  const voice = new VoiceAssistant({ client, getContext: () => ctx, effort: 'low' });

  const first = await voice.ask('  How are my tires looking?  ');
  assert.equal(first.question, 'How are my tires looking?');
  assert.equal(first.reply, 'Copy that. Tires are fine, stay out.');
  assert.equal(client.calls[0].system, SYSTEM_PROMPT);
  assert.equal(client.calls[0].effort, 'low');
  assert.equal(client.calls[0].payload.driver_question, 'How are my tires looking?');
  assert.ok(client.calls[0].payload.live_data.tires.FL);
  assert.deepEqual(client.calls[0].history, []);

  await voice.ask('What about the rears?');
  const history = client.calls[1].history;
  assert.equal(history.length, 2);
  assert.equal(history[0].content, 'Driver: How are my tires looking?');
  assert.match(history[1].content, /Tires are fine/);
});

test('long replies are trimmed for the radio', async () => {
  const long = Array(80).fill('word').join(' ');
  const voice = new VoiceAssistant({ client: fakeClient(long), getContext: () => ({}) });
  const r = await voice.ask('Talk to me');
  assert.ok(r.reply.split(/\s+/).length <= 35);
});

test('rejects empty questions, a second question while busy, and a missing API key', async () => {
  let release;
  const slow = {
    enabled: true,
    requestJson: () => new Promise((r) => (release = () => r({ data: { reply: 'Copy.' }, meta: {} }))),
  };
  const voice = new VoiceAssistant({ client: slow, getContext: () => ({}) });
  await assert.rejects(voice.ask('   '), /Empty question/);

  const first = voice.ask('Fuel?');
  await assert.rejects(voice.ask('Tires?'), BusyError);
  release();
  assert.equal((await first).reply, 'Copy.');

  const off = new VoiceAssistant({ client: { enabled: false }, getContext: () => ({}) });
  await assert.rejects(off.ask('Fuel?'), /CLAUDE_API_KEY/);
});

test('browser speech text: units and tire codes are spoken as words', () => {
  const sandbox = { window: {}, navigator: {}, EventTarget, CustomEvent: class {} };
  sandbox.window.navigator = sandbox.navigator;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/voice-engine.js'), 'utf8'), sandbox);
  const say = sandbox.window.VoiceEngine.speakable;
  assert.equal(say('FL at 104°C, 2.9 L/lap, 45 L left'), 'front left at 104 degrees, 2.9 liters a lap, 45 liters left');
  assert.equal(say('Take 0.2 PSI out of the RR, 12% worn'), 'Take 0.2 P S I out of the rear right, 12 percent worn');
});

test('wheel input script loads and exposes WheelInput', () => {
  const sandbox = { window: { addEventListener() {} }, navigator: {}, EventTarget, CustomEvent: class {}, setInterval, clearInterval };
  sandbox.window.navigator = sandbox.navigator;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/wheel-input.js'), 'utf8'), sandbox);
  const wheel = new sandbox.window.WheelInput({ binding: { button: 3 } });
  assert.equal(wheel.binding.button, 3);
  assert.equal(wheel.binding.gamepadId, null);
  assert.equal(wheel.supported, false); // no Gamepad API outside a browser
});

test('voice brief includes damage and where the car is', () => {
  const ctx = context(300);
  ctx.snapshot = {
    ...ctx.snapshot,
    vehicle: { ...ctx.snapshot.vehicle, speedKph: 0, inPits: false, inGarage: false },
    damage: { maxDentSeverity: 2, dentedZones: { front: 2 }, partsDetached: true, flatTires: ['FL'], lastImpactSecAgo: 4 },
  };
  const brief = buildVoiceBrief(ctx);
  assert.equal(brief.car.location, 'on track');
  assert.equal(brief.car.stopped, true);
  assert.equal(brief.damage.maxDentSeverity, 2);
  assert.match(SYSTEM_PROMPT, /Never tell the driver the car is fine/);
  assert.match(SYSTEM_PROMPT, /"world" is probably "wall"/);
});

test('speech recognition alternatives reach Claude, without duplicates', async () => {
  const client = fakeClient('Copy, heavy front damage. Box this lap.');
  const voice = new VoiceAssistant({ client, getContext: () => ({}) });
  await voice.ask("I'm in the world I broke the car", {
    alternatives: ["I'm in the wall I broke the car", "I'm in the world I broke the car", '', 42],
  });
  assert.deepEqual(client.calls[0].payload.other_possible_hearings, ["I'm in the wall I broke the car"]);

  await voice.ask('Fuel?');
  assert.equal('other_possible_hearings' in client.calls[1].payload, false);
});

test('voice brief has the leaderboard with lap times and class bests', () => {
  const brief = buildVoiceBrief(context(1500));
  const st = brief.standings;
  assert.equal(st.totalCars, 6);
  const p1 = st.cars.find((c) => c.pos === 1);
  assert.equal(p1.car, '#50 Ferrari 499P');
  assert.ok(p1.bestLapSec > 98 && p1.bestLapSec < 100);
  assert.equal(p1.gapToLeaderSec, 0);
  const me = st.cars.find((c) => c.you);
  assert.equal(me.classPos, 3);
  assert.ok(Number.isFinite(me.avgPaceSec === null ? 0 : me.avgPaceSec));
  assert.equal(st.classBest.LMGT3.car, '#92 Porsche 911 GT3 R');
  assert.match(SYSTEM_PROMPT, /standings/);
});

test('standings on a big grid keep the top 10, your class top 10 and the cars around you', () => {
  const { buildStandings } = require('../src/voice-assistant');
  const field = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    position: i + 1,
    class: i % 3 === 0 ? 'Hypercar' : i % 3 === 1 ? 'LMP2' : 'LMGT3',
    vehicle: `Car ${i + 1}`,
    driver: `Driver ${i + 1}`,
    isPlayer: i + 1 === 40,
    bestLapSec: 100 + i,
    lastLapSec: 101 + i,
    timeBehindLeaderSec: i * 2,
    lapsBehindLeader: 0,
    pitStops: 0,
  }));
  const st = buildStandings(field, null);
  const positions = st.cars.map((c) => c.pos);
  assert.ok(st.cars.length < 60);
  for (const p of [1, 10, 37, 40, 43]) assert.ok(positions.includes(p), `includes P${p}`);
  assert.ok(st.cars.find((c) => c.you).pos === 40);
});

test('voice engineer answers setup questions even without the setting in telemetry', () => {
  assert.match(SYSTEM_PROMPT, /Always answer the question that was asked/);
  assert.match(SYSTEM_PROMPT, /does NOT include the driver's settings: traction control/);
  assert.match(SYSTEM_PROMPT, /good moment for setup questions/);
  const brief = buildVoiceBrief(context(300));
  assert.equal(brief.session.airTempC, 24);
  assert.equal(brief.car.frontCompound, 'Medium');
  assert.ok('trackWetness' in brief.session);
});

test('voice brief carries the track status and slow cars', () => {
  const ctx = context(350); // local yellow in sector 2, #77 stopped
  const flags = buildVoiceBrief(ctx).session.flags;
  assert.equal(flags.status, 'localYellow');
  assert.deepEqual(flags.yellowSectors, [2]);
  assert.deepEqual(flags.slowCars, ['#77 Ford Mustang GT3']);
  assert.match(SYSTEM_PROMPT, /Under any yellow, never tell the driver to push or overtake/);
});
