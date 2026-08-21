import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';

test('serves the app and exchanges text and files only while the room exists', async (context) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, AUTH_TIMEOUT_MS: '500', PORT: String(port), PUBLIC_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => child.kill('SIGTERM'));
  await waitForStart(child);

  assert.equal(await rejectedUpgrade(`ws://127.0.0.1:${port}/ws`, 'https://evil.example'), 403);
  const idleSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  await onceOpen(idleSocket);
  assert.equal(await onceClose(idleSocket), 4001);

  const probeSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const probeMessages = socketMessages(probeSocket);
  await onceOpen(probeSocket);
  const probeClosed = onceClose(probeSocket);
  probeSocket.send(JSON.stringify({ type: 'join', code: 'AAAAA', name: 'Intruso' }));
  assert.equal((await probeMessages.next('error')).code, 'room_unavailable');
  assert.equal(await probeClosed, 4003);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const messages = socketMessages(socket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const homeResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(homeResponse.status, 200);
  assert.match(homeResponse.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(homeResponse.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(homeResponse.headers.get('content-security-policy'), new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${port}`));
  assert.doesNotMatch(homeResponse.headers.get('content-security-policy'), /connect-src 'self' ws: wss:/);
  assert.equal(homeResponse.headers.get('x-frame-options'), 'DENY');
  const localeResponse = await fetch(`${origin}/i18n.js`);
  assert.equal(localeResponse.status, 200);
  assert.match(localeResponse.headers.get('content-type'), /^text\/javascript/);

  socket.send(JSON.stringify({ type: 'create', name: 'Ana', label: 'Teste' }));
  const authentication = await messages.next('authenticated');
  await messages.next('snapshot');

  const guestSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const guestMessages = socketMessages(guestSocket);
  context.after(() => guestSocket.close());
  await new Promise((resolve, reject) => {
    guestSocket.once('open', resolve);
    guestSocket.once('error', reject);
  });
  guestSocket.send(JSON.stringify({ type: 'join', code: authentication.code, name: 'Beto' }));
  await guestMessages.next('authenticated');
  await guestMessages.next('snapshot');
  const maximumMarkdown = '**recebido**'.padEnd(8_000, 'a');
  guestSocket.send(JSON.stringify({ type: 'message', markdown: maximumMarkdown }));
  const textEntry = await messages.next('entry');
  assert.equal(textEntry.entry.markdown.length, 8_000);
  assert.match(textEntry.entry.html, /<strong>recebido<\/strong>/);

  const plainText = 'conteúdo temporário';
  const uploadResponse = await fetch(`${origin}/api/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authentication.token}`,
      'X-File-Name': encodeURIComponent('teste.txt'),
      'X-Room-Code': authentication.code,
    },
    body: Buffer.from(plainText),
  });
  assert.equal(uploadResponse.status, 201);
  const { entry } = await uploadResponse.json();

  const roomDirectory = join(tmpdir(), 'qsnd', authentication.code);
  const [storedFile] = await readdir(roomDirectory);
  const storedPath = join(roomDirectory, storedFile);
  const encryptedBytes = await readFile(storedPath);
  assert.equal(encryptedBytes.includes(Buffer.from(plainText)), false);
  assert.equal((await stat(roomDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(storedPath)).mode & 0o777, 0o600);

  const downloadResponse = await fetch(`${origin}/api/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authentication.token}`,
      'X-File-Id': entry.id,
      'X-Room-Code': authentication.code,
    },
  });
  assert.equal(downloadResponse.status, 200);
  assert.equal(await downloadResponse.text(), plainText);
  assert.match(downloadResponse.headers.get('content-disposition'), /teste\.txt/);

  socket.send(JSON.stringify({ type: 'close-room' }));
  await messages.next('room-destroyed');

  await waitForMissing(roomDirectory);
  const expiredResponse = await fetch(`${origin}/api/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authentication.token}`,
      'X-File-Id': entry.id,
      'X-Room-Code': authentication.code,
    },
  });
  assert.equal(expiredResponse.status, 404);
  assert.equal((await expiredResponse.json()).code, 'room_unavailable');
  assert.equal((await fetch(`${origin}/api/rooms/${authentication.code}/files`)).status, 404);
  socket.close();

  const transferSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const transferMessages = socketMessages(transferSocket);
  await onceOpen(transferSocket);
  transferSocket.send(JSON.stringify({ type: 'create', name: 'Carla' }));
  const transferAuthentication = await transferMessages.next('authenticated');
  await transferMessages.next('snapshot');

  const uploadBytes = 1024 * 1024;
  const interruptedUpload = fetch(`${origin}/api/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${transferAuthentication.token}`,
      'Content-Length': String(uploadBytes),
      'X-File-Name': 'lento.bin',
      'X-Room-Code': transferAuthentication.code,
    },
    body: Readable.from(slowBody(uploadBytes)),
    duplex: 'half',
  }).catch((error) => error);

  await new Promise((resolve) => setTimeout(resolve, 60));
  transferSocket.send(JSON.stringify({ type: 'close-room' }));
  await transferMessages.next('room-destroyed');
  const interruptedResult = await interruptedUpload;
  assert.equal(interruptedResult instanceof Error || interruptedResult.status === 410, true);
  await waitForMissing(join(tmpdir(), 'qsnd', transferAuthentication.code));
  transferSocket.close();
});

async function* slowBody(totalBytes) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  for (let sent = 0; sent < totalBytes; sent += chunk.length) {
    yield chunk.subarray(0, Math.min(chunk.length, totalBytes - sent));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function onceClose(socket) {
  return new Promise((resolve) => socket.once('close', resolve));
}

function rejectedUpgrade(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
      response.destroy();
    });
    socket.once('open', () => reject(new Error('A origem indevida foi aceita.')));
    socket.once('error', () => {});
  });
}

async function waitForMissing(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(path);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  assert.fail('O diretório temporário não foi removido.');
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForStart(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Servidor não iniciou.')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (chunk.includes('QSND disponível')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Servidor encerrou com código ${code}.`));
    });
  });
}

function socketMessages(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0].resolve(message);
    else queue.push(message);
  });

  return {
    next(type) {
      const messageIndex = queue.findIndex((message) => message.type === type);
      if (messageIndex >= 0) return Promise.resolve(queue.splice(messageIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Evento ${type} não recebido.`)), 5_000);
        waiters.push({
          type,
          resolve(message) {
            clearTimeout(timeout);
            resolve(message);
          },
        });
      });
    },
  };
}
