import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';

test('sends request and room telemetry without room secrets', async (context) => {
  const received = [];
  const ingestion = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push(...JSON.parse(body));
      response.end('{}');
    });
  });
  await new Promise((resolve) => ingestion.listen(0, '127.0.0.1', resolve));
  context.after(() => ingestion.close());

  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
      APPLICATIONINSIGHTS_CONNECTION_STRING:
        `InstrumentationKey=test-key;IngestionEndpoint=http://127.0.0.1:${ingestion.address().port}/`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => child.stdout.once('data', resolve));

  await fetch(`${origin}/`);
  await fetch(`${origin}/wp-login.php?user=secret`);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ type: 'create', name: 'Ana' }));
  const authentication = await new Promise((resolve) => socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'authenticated') resolve(message);
  }));

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));

  const names = received.map((item) => item.data.baseData.name);
  assert.ok(names.includes('GET /'));
  assert.ok(names.includes('GET /{other}'));
  assert.ok(names.includes('room_create'));
  assert.ok(names.includes('room_destroyed'));
  assert.ok(received.every((item) => item.iKey === 'test-key'));
  const payload = JSON.stringify(received);
  for (const secret of [authentication.code, authentication.token, 'Ana', 'secret', 'wp-login']) {
    assert.equal(payload.includes(secret), false, `telemetry leaked ${secret}`);
  }
});
