'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const { applyEnvUpdates } = require('../src/envFile');

test('env editor changes, adds and removes lines and keeps everything else', () => {
  const before = '# my settings\r\nCLAUDE_API_KEY=old\r\n\r\nANALYSIS_MODEL=claude-opus-5\r\n';
  const after = applyEnvUpdates(before, { ANALYSIS_MODEL: 'claude-sonnet-5', AI_ENABLED: 'false', CLAUDE_API_KEY: null });
  assert.equal(after, '# my settings\r\n\r\nANALYSIS_MODEL=claude-sonnet-5\r\nAI_ENABLED=false\r\n');
  assert.equal(applyEnvUpdates('', { A_B: '1' }), 'A_B=1\n');
  assert.equal(applyEnvUpdates('X=1\n', { X: 'a\nY=2' }), 'X=aY=2\n'); // no line injection
  assert.throws(() => applyEnvUpdates('', { 'bad-name': '1' }));
});

async function startServer(envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-control-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, envText);
  const port = 30000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, ENV_FILE: envFile, PORT: String(port) };
  delete env.CLAUDE_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  for (const k of ['AI_ENABLED', 'TIRE_ENGINEER', 'STRATEGIST', 'VOICE_ENGINEER', 'ANALYSIS_MODEL', 'ANALYSIS_INTERVAL_MS']) delete env[k];
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('Control Panel:')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { proc, port, base, envFile, post, stop: () => proc.kill() };
}

test('control panel: switches apply live, are saved to .env, and reach dashboards', async (t) => {
  const srv = await startServer('# keep me\nAI_ENABLED=true\n');
  t.after(srv.stop);

  const initial = await (await fetch(srv.base + '/api/control')).json();
  assert.equal(initial.ai.hasKey, false);
  assert.equal(initial.telemetry.source, 'simulator');
  assert.deepEqual(initial.engineers, { tireEngineer: true, strategist: true, voiceEngineer: true });

  const page = await fetch(srv.base + '/control');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Control Panel/);

  // A dashboard sees status changes
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/telemetry`);
  const statuses = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.type === 'status') statuses.push(msg.data);
  });
  await new Promise((r) => ws.on('open', r));

  const r1 = await srv.post('/api/control', { strategist: false, model: 'claude-sonnet-5', tireIntervalSec: 15 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.engineers.strategist, false);
  assert.equal(r1.body.ai.model, 'claude-sonnet-5');
  assert.equal(r1.body.ai.tireIntervalSec, 15);

  const r2 = await srv.post('/api/control', { model: 'gpt-4', tireIntervalSec: 1 }); // invalid values are ignored
  assert.equal(r2.body.ai.model, 'claude-sonnet-5');
  assert.equal(r2.body.ai.tireIntervalSec, 15);

  const saved = fs.readFileSync(srv.envFile, 'utf8');
  assert.match(saved, /^# keep me$/m);
  assert.match(saved, /^STRATEGIST=false$/m);
  assert.match(saved, /^ANALYSIS_MODEL=claude-sonnet-5$/m);
  assert.match(saved, /^ANALYSIS_INTERVAL_MS=15000$/m);

  await new Promise((r) => setTimeout(r, 200));
  ws.close();
  assert.ok(statuses.some((s) => s.ai.strategist === false), 'dashboards get the new state');
});

test('control panel: API key is validated, saved, masked, and removable', async (t) => {
  const srv = await startServer('');
  t.after(srv.stop);

  const bad = await srv.post('/api/control/api-key', { key: 'hello' });
  assert.equal(bad.status, 400);

  const key = 'sk-ant-api03-' + 'x'.repeat(40);
  const ok = await srv.post('/api/control/api-key', { key });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ai.hasKey, true);
  assert.ok(!JSON.stringify(ok.body).includes(key), 'the full key is never sent back');
  assert.match(fs.readFileSync(srv.envFile, 'utf8'), new RegExp(`^CLAUDE_API_KEY=${key}$`, 'm'));

  const off = await srv.post('/api/control', { aiEnabled: false });
  assert.equal(off.body.ai.active, false);

  const removed = await srv.post('/api/control/api-key', { key: '' });
  assert.equal(removed.body.ai.hasKey, false);
  assert.doesNotMatch(fs.readFileSync(srv.envFile, 'utf8'), /CLAUDE_API_KEY/);
});

test('control panel: other websites cannot change settings', async (t) => {
  const srv = await startServer('');
  t.after(srv.stop);
  const res = await srv.post('/api/control', { aiEnabled: false }, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  const state = await (await fetch(srv.base + '/api/control')).json();
  assert.equal(state.ai.master, true);
});

test('control panel: simulator speed restarts the simulator; game source is refused off Windows', async (t) => {
  const srv = await startServer('');
  t.after(srv.stop);
  const sped = await srv.post('/api/control', { mockSpeed: 10 });
  assert.equal(sped.body.telemetry.mockSpeed, 10);
  assert.equal(sped.body.telemetry.source, 'simulator');

  if (process.platform !== 'win32') {
    const game = await srv.post('/api/control', { source: 'game' });
    assert.equal(game.status, 400);
    assert.equal(game.body.state.telemetry.source, 'simulator');
  }
});

test('control panel: stop server shuts it down', async (t) => {
  const srv = await startServer('');
  t.after(srv.stop);
  const exited = new Promise((r) => srv.proc.on('exit', r));
  const res = await srv.post('/api/control/shutdown', {});
  assert.equal(res.status, 200);
  await exited;
});
