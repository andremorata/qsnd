import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, RoomStore } from './room-store.js';
import { stopTelemetry, telemetryEnabled, trackEvent, trackRequest } from './telemetry.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '') || null;
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS) || 10_000;
const PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const TEMP_ROOT = join(tmpdir(), 'qsnd');
const MAX_WEBSOCKETS = 200;
const MAX_TRANSFERS = 100;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
]);
const SECURITY_HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});
const CSP_DIRECTIVES = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

await rm(TEMP_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
await mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });

const store = new RoomStore();
const socketsByRoom = new Map();
const sessionBySocket = new WeakMap();
const activeTransfers = new Map();
const pendingDeletions = new Set();
const rateLimits = new Map();
const KNOWN_PATHS = new Set([...ASSETS.keys(), '/health', '/api/files', '/api/files/download']);
const server = createServer((request, response) => {
  if (telemetryEnabled) observeRequest(request, response);
  handleRequest(request, response).catch((error) => sendHttpError(response, error));
});
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.headersTimeout = 15_000;
server.requestTimeout = 5 * 60_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;
server.maxConnections = 300;

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws') throw new AppError('not_found', 'Recurso não encontrado.', 404);
    if (!hasAllowedOrigin(request)) throw new AppError('origin_rejected', 'Origem não autorizada.', 403);
    if (webSockets.clients.size >= MAX_WEBSOCKETS) {
      throw new AppError('server_capacity', 'Servidor temporariamente ocupado.', 503);
    }
    consumeRate('connection:global', 600, 60_000);
    consumeRate(`connection:${clientAddress(request)}`, 60, 60_000);

    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
  } catch (error) {
    rejectUpgrade(socket, error);
  }
});

webSockets.on('connection', (socket, request) => {
  socket.clientAddress = clientAddress(request);
  socket.isAlive = true;
  socket.authenticationTimer = setTimeout(() => socket.close(4001, 'Autenticação expirada'), AUTH_TIMEOUT_MS);
  socket.authenticationTimer.unref?.();
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => handleSocketMessage(socket, raw));
  socket.on('close', () => handleSocketClose(socket));
  socket.on('error', () => {});
});

store.on('owner-away', ({ code }) => abortRoomTransfers(code));

store.on('destroy', ({ code, reason, stats }) => {
  trackEvent('room_destroyed', stats, { reason });
  abortRoomTransfers(code);

  const roomSockets = socketsByRoom.get(code);
  if (roomSockets) {
    for (const socket of roomSockets.values()) {
      sendSocket(socket, { type: 'room-destroyed', reason });
      socket.close(4000, 'Sala encerrada');
    }
  }
  socketsByRoom.delete(code);

  const deletion = rm(join(TEMP_ROOT, code), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  }).catch(() => {
    console.error('QSND não conseguiu remover um diretório temporário.');
  }).finally(() => pendingDeletions.delete(deletion));
  pendingDeletions.add(deletion);
});

const heartbeat = setInterval(() => {
  for (const socket of webSockets.clients) {
    if (!socket.isAlive) socket.terminate();
    else {
      socket.isAlive = false;
      socket.ping();
    }
  }
}, 15_000);
heartbeat.unref();

server.listen(PORT, () => {
  console.log(`QSND disponível na porta ${PORT}`);
});

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/health') {
    return sendJson(response, 200, { status: 'ok' });
  }

  if (request.method === 'POST' && url.pathname === '/api/files') {
    consumeRate('file:global', 600, 60_000);
    consumeRate(`file:${clientAddress(request)}`, 120, 60_000);
    try {
      return await uploadFile(request, response, roomCode(request));
    } catch (error) {
      throw obscureRoomAccess(error);
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/files/download') {
    consumeRate('file:global', 600, 60_000);
    consumeRate(`file:${clientAddress(request)}`, 120, 60_000);
    try {
      return await downloadFile(request, response, roomCode(request), fileId(request));
    } catch (error) {
      throw obscureRoomAccess(error);
    }
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && ASSETS.has(url.pathname)) {
    const [fileName, contentType] = ASSETS.get(url.pathname);
    return sendAsset(request, response, fileName, contentType);
  }

  throw new AppError('not_found', 'Recurso não encontrado.', 404);
}

async function uploadFile(request, response, code) {
  const token = bearerToken(request);
  const name = uploadName(request);
  const size = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new AppError('length_required', 'O tamanho do arquivo é obrigatório.', 411);
  }

  const upload = store.beginUpload(code, token, { name, size });
  let transfer;
  try {
    transfer = startTransfer(code);
  } catch (error) {
    store.abortUpload(code, token, upload.id);
    throw error;
  }

  const roomDirectory = join(TEMP_ROOT, code);
  const filePath = join(roomDirectory, upload.id);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let keyTransferred = false;

  try {
    await mkdir(roomDirectory, { recursive: true, mode: 0o700 });
    await pipeline(
      request,
      cipher,
      createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
      { signal: transfer.signal },
    );
    const fileStats = await stat(filePath);
    if (fileStats.size !== size) throw new AppError('invalid_file_size', 'O arquivo recebido está incompleto.', 400);

    const entry = store.finishUpload(code, token, upload.id, {
      path: filePath,
      key,
      iv,
      authenticationTag: cipher.getAuthTag(),
    });
    keyTransferred = true;
    trackEvent('file_uploaded', { bytes: size }, {}, clientAddress(request));
    broadcast(code, { type: 'entry', entry, room: store.summary(code) });
    sendJson(response, 201, { entry });
  } catch (error) {
    store.abortUpload(code, token, upload.id);
    await rm(filePath, { force: true }).catch(() => {});
    if (transfer.signal.aborted) throw new AppError('room_unavailable', 'Sala indisponível.', 410);
    throw error;
  } finally {
    transfer.done();
    if (!keyTransferred) {
      key.fill(0);
      iv.fill(0);
    }
  }
}

async function downloadFile(request, response, code, requestedFileId) {
  const token = bearerToken(request);
  const file = store.getFile(code, token, requestedFileId);
  const transfer = startTransfer(code);
  const decipher = createDecipheriv('aes-256-gcm', file.encryptionKey, file.encryptionIv);
  decipher.setAuthTag(file.authenticationTag);

  try {
    await stat(file.storedPath).catch(() => {
      throw new AppError('file_not_found', 'Arquivo não encontrado.', 404);
    });
    if (transfer.signal.aborted) throw new AppError('room_unavailable', 'Sala indisponível.', 410);

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Disposition': contentDisposition(file.name),
      'Content-Length': file.size,
      'Content-Type': 'application/octet-stream',
    });
    broadcast(code, { type: 'room-state', room: store.summary(code) });
    trackEvent('file_downloaded', { bytes: file.size }, {}, clientAddress(request));
    await pipeline(createReadStream(file.storedPath), decipher, response, { signal: transfer.signal });
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (transfer.signal.aborted) throw new AppError('room_unavailable', 'Sala indisponível.', 410);
    throw error;
  } finally {
    transfer.done();
  }
}

function handleSocketMessage(socket, raw) {
  let message;
  const session = sessionBySocket.get(socket);
  try {
    message = JSON.parse(raw.toString());

    if (!session) return authenticateSocket(socket, message);
    consumeRate(`event:${session.token}`, 120, 60_000);

    if (message.type === 'message') {
      const entry = store.addMessage(session.code, session.token, message.markdown);
      broadcast(session.code, { type: 'entry', entry, room: store.summary(session.code) });
      trackEvent('message_sent', {}, {}, socket.clientAddress);
      return;
    }

    if (message.type === 'visibility') {
      store.setVisibility(session.code, session.token, message.visibility);
      broadcastPresence(session.code);
      return;
    }

    if (message.type === 'close-room') {
      store.closeRoom(session.code, session.token);
      return;
    }

    throw new AppError('invalid_event', 'Evento desconhecido.');
  } catch (error) {
    const authenticationAttempt = !session;
    const safeError = authenticationAttempt && ['join', 'resume'].includes(message?.type)
      && error?.code !== 'rate_limited'
      ? new AppError('room_unavailable', 'Sala indisponível.', 404)
      : error;
    sendSocketError(socket, safeError);
    if (authenticationAttempt) setTimeout(() => socket.close(4003, 'Autenticação recusada'), 20);
  }
}

function authenticateSocket(socket, message) {
  const limits = {
    create: { address: 5, global: 20 },
    join: { address: 12, global: 120 },
    resume: { address: 30, global: 300 },
  };
  const limit = limits[message.type];
  if (limit) {
    consumeRate(`${message.type}:global`, limit.global, 60_000);
    consumeRate(`${message.type}:${socket.clientAddress}`, limit.address, 60_000);
  }

  let authentication;
  if (message.type === 'create') {
    authentication = store.createRoom({ ownerName: message.name, label: message.label });
  } else if (message.type === 'join') {
    authentication = store.joinRoom({ code: message.code, name: message.name });
  } else if (message.type === 'resume') {
    authentication = store.resumeRoom({ code: message.code, token: message.token });
  } else {
    throw new AppError('authentication_required', 'Entre ou crie uma sala.');
  }

  associateSocket(socket, authentication.code, authentication.token);
  trackEvent(`room_${message.type}`, {}, { role: authentication.role }, socket.clientAddress);
  sendSocket(socket, {
    type: 'authenticated',
    code: authentication.code,
    token: authentication.token,
    role: authentication.role,
    participantId: authentication.participantId,
  });
  sendSocket(socket, { type: 'snapshot', snapshot: authentication.snapshot });
  broadcastPresence(authentication.code);
  broadcast(authentication.code, { type: 'room-state', room: store.summary(authentication.code) });
}

function associateSocket(socket, code, token) {
  clearTimeout(socket.authenticationTimer);
  let roomSockets = socketsByRoom.get(code);
  if (!roomSockets) {
    roomSockets = new Map();
    socketsByRoom.set(code, roomSockets);
  }

  const previousSocket = roomSockets.get(token);
  if (previousSocket && previousSocket !== socket) previousSocket.terminate();
  roomSockets.set(token, socket);
  sessionBySocket.set(socket, { code, token });
}

function handleSocketClose(socket) {
  clearTimeout(socket.authenticationTimer);
  const session = sessionBySocket.get(socket);
  if (!session) return;

  const roomSockets = socketsByRoom.get(session.code);
  if (roomSockets?.get(session.token) !== socket) return;

  roomSockets.delete(session.token);
  if (roomSockets.size === 0) socketsByRoom.delete(session.code);

  const room = store.disconnectRoom(session.code, session.token);
  if (room) {
    broadcastPresence(session.code);
    broadcast(session.code, { type: 'room-state', room });
  }
}

function broadcastPresence(code) {
  try {
    broadcast(code, { type: 'presence', participants: store.presence(code) });
  } catch {}
}

function broadcast(code, payload) {
  const roomSockets = socketsByRoom.get(code);
  if (!roomSockets) return;
  for (const socket of roomSockets.values()) sendSocket(socket, payload);
}

function sendSocket(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendSocketError(socket, error) {
  const knownError = error instanceof AppError;
  sendSocket(socket, {
    type: 'error',
    code: knownError ? error.code : 'internal_error',
    message: knownError ? error.message : 'Não foi possível concluir a ação.',
  });
}

function startTransfer(code) {
  const transferCount = [...activeTransfers.values()].reduce((total, transfers) => total + transfers.size, 0);
  if (transferCount >= MAX_TRANSFERS) {
    throw new AppError('server_capacity', 'Servidor temporariamente ocupado.', 503);
  }

  const controller = new AbortController();
  let roomTransfers = activeTransfers.get(code);
  if (!roomTransfers) {
    roomTransfers = new Set();
    activeTransfers.set(code, roomTransfers);
  }
  roomTransfers.add(controller);

  return {
    signal: controller.signal,
    done() {
      roomTransfers.delete(controller);
      if (roomTransfers.size === 0) activeTransfers.delete(code);
    },
  };
}

function abortRoomTransfers(code) {
  const transfers = activeTransfers.get(code);
  if (!transfers) return;
  for (const controller of transfers) controller.abort();
  activeTransfers.delete(code);
}

function consumeRate(key, limit, windowMs) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    if (current.count >= limit) throw new AppError('rate_limited', 'Muitas tentativas. Aguarde um minuto.', 429);
    current.count += 1;
  }

  if (rateLimits.size > 10_000) {
    for (const [currentKey, value] of rateLimits) if (value.resetAt <= now) rateLimits.delete(currentKey);
  }
}

function hasAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).origin === (PUBLIC_ORIGIN || inferredOrigin(request));
  } catch {
    return false;
  }
}

function inferredOrigin(request) {
  const trustedProxy = process.env.TRUST_PROXY === '1' || Boolean(process.env.WEBSITE_INSTANCE_ID);
  const forwardedProtocol = trustedProxy && typeof request.headers['x-forwarded-proto'] === 'string'
    ? request.headers['x-forwarded-proto'].split(',').at(-1).trim()
    : null;
  const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${request.headers.host}`;
}

function clientAddress(request) {
  const trustedProxy = process.env.TRUST_PROXY === '1' || Boolean(process.env.WEBSITE_INSTANCE_ID);
  const forwarded = request.headers['x-forwarded-for'];
  if (trustedProxy && typeof forwarded === 'string') return forwarded.split(',').at(-1).trim();
  return request.socket.remoteAddress || 'unknown';
}

function rejectUpgrade(socket, error) {
  const status = error instanceof AppError ? error.status : 400;
  const text = status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function obscureRoomAccess(error) {
  if (error instanceof AppError && [
    'disconnected',
    'forbidden',
    'invalid_code',
    'room_not_found',
    'room_paused',
  ].includes(error.code)) {
    return new AppError('room_unavailable', 'Sala indisponível.', 404);
  }
  return error;
}

function roomCode(request) {
  const code = request.headers['x-room-code'];
  if (typeof code !== 'string') throw new AppError('invalid_code', 'Código de sala inválido.');
  return code;
}

function fileId(request) {
  const id = request.headers['x-file-id'];
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new AppError('file_not_found', 'Arquivo não encontrado.', 404);
  }
  return id;
}

function uploadName(request) {
  const encodedName = request.headers['x-file-name'];
  if (typeof encodedName !== 'string') throw new AppError('invalid_file_name', 'Nome de arquivo inválido.');
  try {
    return decodeURIComponent(encodedName);
  } catch {
    throw new AppError('invalid_file_name', 'Nome de arquivo inválido.');
  }
}

function bearerToken(request) {
  const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match) throw new AppError('unauthorized', 'Sessão temporária ausente.', 401);
  return match[1];
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  const json = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(json),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(json);
}

function sendHttpError(response, error) {
  const knownError = error instanceof AppError;
  sendJson(response, knownError ? error.status : 500, {
    code: knownError ? error.code : 'internal_error',
    message: knownError ? error.message : 'Não foi possível concluir a ação.',
  });
}

async function sendAsset(request, response, fileName, contentType) {
  const filePath = join(PUBLIC_ROOT, fileName);
  const fileStats = await stat(filePath);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Length': fileStats.size,
    'Content-Security-Policy': contentSecurityPolicy(request),
    'Content-Type': contentType,
  });
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(filePath), response).catch(() => response.destroy());
}

function contentSecurityPolicy(request) {
  const webSocketOrigin = (PUBLIC_ORIGIN || inferredOrigin(request)).replace(/^http/, 'ws');
  return `${CSP_DIRECTIVES}; connect-src 'self' ${webSocketOrigin}`;
}

function contentDisposition(name) {
  const fallback = basename(name).replace(/[^\x20-\x7e]|["\\]/g, '_') || 'arquivo';
  const encoded = encodeURIComponent(name).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  store.destroyAll();
  for (const socket of webSockets.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([...pendingDeletions]);
  await rm(TEMP_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await stopTelemetry();
}

function observeRequest(request, response) {
  const startedAt = performance.now();
  response.once('close', () => {
    const { pathname } = new URL(request.url, 'http://localhost');
    trackRequest({
      method: request.method,
      // Unknown paths are scanner noise and may carry arbitrary text.
      path: KNOWN_PATHS.has(pathname) ? pathname : '/{other}',
      status: response.statusCode,
      durationMs: performance.now() - startedAt,
      clientIp: clientAddress(request),
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => stop().finally(() => process.exit(0)));
}
