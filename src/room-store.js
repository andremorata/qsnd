import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { renderMarkdown } from './markdown.js';

export const LIMITS = Object.freeze({
  concurrentUploads: 3,
  fileBytes: 100 * 1024 * 1024,
  filesPerRoom: 20,
  messageCharacters: 8_000,
  participants: 10,
  participantSessions: 20,
  rooms: 50,
  serverFileBytes: 400 * 1024 * 1024,
  timelineEntries: 500,
});

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const AVATARS = ['🦊', '🐙', '🦜', '🐳', '🦔', '🐢', '🦦', '🦩', '🐝', '🦋', '🐬', '🦭', '🐼', '🐸', '🦁', '🐧', '🐨', '🦀', '🐞', '🦎'];

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export class RoomStore extends EventEmitter {
  constructor({
    idleMs = 30 * 60_000,
    ownerGraceMs = 5 * 60_000,
    guestGraceMs = 60_000,
    now = Date.now,
  } = {}) {
    super();
    this.rooms = new Map();
    this.idleMs = idleMs;
    this.ownerGraceMs = ownerGraceMs;
    this.guestGraceMs = guestGraceMs;
    this.now = now;
  }

  createRoom({ ownerName, label }) {
    if (this.rooms.size >= LIMITS.rooms) {
      throw new AppError('server_capacity', 'O servidor atingiu o limite temporário de salas.', 503);
    }
    const code = this.#newCode();
    const createdAt = this.now();
    const room = {
      code,
      label: cleanOptionalLabel(label),
      status: 'active',
      createdAt,
      lastActivityAt: createdAt,
      ownerDisconnectedAt: null,
      ownerToken: null,
      participants: new Map(),
      timeline: [],
      uploads: new Map(),
      totalFileBytes: 0,
      pendingFileBytes: 0,
      pendingFileCount: 0,
      idleTimer: null,
      ownerTimer: null,
    };

    const owner = this.#addParticipant(room, cleanName(ownerName), 'owner');
    room.ownerToken = owner.token;
    this.rooms.set(code, room);
    this.#scheduleIdle(room);

    return this.#authentication(room, owner);
  }

  joinRoom({ code, name }) {
    const room = this.#room(code);
    this.#assertActive(room);

    const connected = [...room.participants.values()].filter((participant) => participant.connected).length;
    if (connected >= LIMITS.participants || room.participants.size >= LIMITS.participantSessions) {
      throw new AppError('room_full', 'A sala já atingiu o limite de participantes.', 409);
    }

    const participant = this.#addParticipant(room, cleanName(name), 'guest');
    this.#touch(room);
    return this.#authentication(room, participant);
  }

  resumeRoom({ code, token }) {
    const room = this.#room(code);
    const participant = this.#participant(room, token);

    if (!participant.connected) {
      const connected = [...room.participants.values()].filter((candidate) => candidate.connected).length;
      if (connected >= LIMITS.participants) {
        throw new AppError('room_full', 'A sala já atingiu o limite de participantes.', 409);
      }
    }

    if (participant.disconnectTimer) {
      clearTimeout(participant.disconnectTimer);
      participant.disconnectTimer = null;
    }

    participant.connected = true;
    participant.visibility = 'viewing';

    if (participant.role === 'owner') {
      clearTimeout(room.ownerTimer);
      room.ownerTimer = null;
      room.ownerDisconnectedAt = null;
      room.status = 'active';
    }

    this.#touch(room);
    return this.#authentication(room, participant);
  }

  disconnectRoom(code, token) {
    const room = this.rooms.get(normalizeCode(code));
    const participant = room?.participants.get(token);
    if (!room || !participant || !participant.connected) return null;

    participant.connected = false;
    participant.visibility = 'background';

    if (participant.role === 'owner') {
      room.status = 'owner-away';
      room.ownerDisconnectedAt = this.now();
      clearTimeout(room.ownerTimer);
      room.ownerTimer = this.#timer(() => this.destroyRoom(room.code, 'owner-timeout'), this.ownerGraceMs);
      this.emit('owner-away', { code: room.code });
    } else {
      clearTimeout(participant.disconnectTimer);
      participant.disconnectTimer = this.#timer(() => {
        const currentRoom = this.rooms.get(room.code);
        const currentParticipant = currentRoom?.participants.get(token);
        if (currentParticipant && !currentParticipant.connected) currentRoom.participants.delete(token);
      }, this.guestGraceMs);
    }

    return this.summary(room.code);
  }

  setVisibility(code, token, visibility) {
    if (!['viewing', 'background'].includes(visibility)) {
      throw new AppError('invalid_visibility', 'Estado de visualização inválido.');
    }

    const room = this.#room(code);
    const participant = this.#connectedParticipant(room, token);
    participant.visibility = visibility;
    return this.presence(room.code);
  }

  addMessage(code, token, source) {
    const room = this.#room(code);
    const participant = this.#activeParticipant(room, token);
    const markdown = cleanMarkdown(source);
    this.#assertTimelineCapacity(room);

    const entry = {
      id: randomUUID(),
      type: 'text',
      author: publicParticipant(participant),
      markdown,
      createdAt: this.now(),
    };

    room.timeline.push(entry);
    this.#touch(room);
    return publicEntry(entry);
  }

  beginUpload(code, token, { name, size }) {
    const room = this.#room(code);
    const participant = this.#activeParticipant(room, token);
    const fileName = cleanFileName(name);

    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.fileBytes) {
      throw new AppError('file_too_large', 'O arquivo excede o limite de 100 MB.', 413);
    }

    const fileCount = room.timeline.filter((entry) => entry.type === 'file').length;
    if (room.pendingFileCount >= LIMITS.concurrentUploads) {
      throw new AppError('too_many_uploads', 'A sala já possui uploads em andamento.', 429);
    }
    if (fileCount + room.pendingFileCount >= LIMITS.filesPerRoom) {
      throw new AppError('too_many_files', 'A sala já atingiu o limite de arquivos.', 413);
    }

    if (room.totalFileBytes + room.pendingFileBytes + size > LIMITS.fileBytes) {
      throw new AppError('room_storage_full', 'Os arquivos da sala excederiam 100 MB.', 413);
    }

    const serverFileBytes = [...this.rooms.values()].reduce(
      (total, currentRoom) => total + currentRoom.totalFileBytes + currentRoom.pendingFileBytes,
      0,
    );
    if (serverFileBytes + size > LIMITS.serverFileBytes) {
      throw new AppError('server_storage_full', 'O servidor atingiu o limite temporário de arquivos.', 503);
    }

    this.#assertTimelineCapacity(room);
    const upload = {
      id: randomUUID(),
      participantId: participant.id,
      token,
      name: fileName,
      size,
    };

    room.uploads.set(upload.id, upload);
    room.pendingFileBytes += size;
    room.pendingFileCount += 1;
    return { id: upload.id, name: upload.name, size: upload.size };
  }

  finishUpload(code, token, uploadId, storage) {
    const room = this.#room(code);
    const upload = room.uploads.get(uploadId);
    if (!upload || upload.token !== token) {
      throw new AppError('upload_not_found', 'Upload não encontrado.', 404);
    }

    const participant = room.participants.get(token);
    if (!participant || participant.id !== upload.participantId) {
      throw new AppError('forbidden', 'Participante inválido.', 403);
    }

    this.#releaseUpload(room, upload);
    const entry = {
      id: randomUUID(),
      type: 'file',
      author: publicParticipant(participant),
      name: upload.name,
      size: upload.size,
      storedPath: storage.path,
      encryptionKey: storage.key,
      encryptionIv: storage.iv,
      authenticationTag: storage.authenticationTag,
      createdAt: this.now(),
    };

    room.timeline.push(entry);
    room.totalFileBytes += entry.size;
    this.#touch(room);
    return publicEntry(entry);
  }

  abortUpload(code, token, uploadId) {
    const room = this.rooms.get(normalizeCode(code));
    const upload = room?.uploads.get(uploadId);
    if (room && upload?.token === token) this.#releaseUpload(room, upload);
  }

  getFile(code, token, fileId) {
    const room = this.#room(code);
    this.#assertActive(room);
    this.#connectedParticipant(room, token);
    const entry = room.timeline.find((candidate) => candidate.type === 'file' && candidate.id === fileId);
    if (!entry) throw new AppError('file_not_found', 'Arquivo não encontrado.', 404);
    this.#touch(room);
    return entry;
  }

  closeRoom(code, token) {
    const room = this.#room(code);
    const participant = this.#connectedParticipant(room, token);
    if (participant.role !== 'owner') {
      throw new AppError('forbidden', 'Somente o dono pode encerrar a sala.', 403);
    }
    this.destroyRoom(room.code, 'owner-closed');
  }

  snapshot(code) {
    const room = this.#room(code);
    return {
      room: publicRoom(room, this.idleMs, this.ownerGraceMs),
      participants: this.presence(room.code),
      timeline: room.timeline.map(publicEntry),
    };
  }

  summary(code) {
    return publicRoom(this.#room(code), this.idleMs, this.ownerGraceMs);
  }

  presence(code) {
    return [...this.#room(code).participants.values()]
      .filter((participant) => participant.connected)
      .map(publicParticipant);
  }

  destroyRoom(code, reason = 'closed') {
    const normalizedCode = normalizeCode(code);
    const room = this.rooms.get(normalizedCode);
    if (!room) return false;

    clearTimeout(room.idleTimer);
    clearTimeout(room.ownerTimer);
    for (const participant of room.participants.values()) clearTimeout(participant.disconnectTimer);

    const fileEntries = room.timeline.filter((entry) => entry.type === 'file');
    const files = fileEntries.map((entry) => entry.storedPath);
    for (const entry of fileEntries) {
      entry.encryptionKey?.fill(0);
      entry.encryptionIv?.fill(0);
      entry.authenticationTag?.fill(0);
    }

    this.rooms.delete(normalizedCode);
    this.emit('destroy', { code: normalizedCode, reason, files });
    return true;
  }

  destroyAll(reason = 'server-stopped') {
    for (const code of [...this.rooms.keys()]) this.destroyRoom(code, reason);
  }

  #authentication(room, participant) {
    return {
      code: room.code,
      token: participant.token,
      role: participant.role,
      participantId: participant.id,
      snapshot: this.snapshot(room.code),
    };
  }

  #addParticipant(room, name, role) {
    const usedAvatars = new Set([...room.participants.values()].filter((item) => item.connected).map((item) => item.emoji));
    const availableAvatars = AVATARS.filter((emoji) => !usedAvatars.has(emoji));
    const avatars = availableAvatars.length ? availableAvatars : AVATARS;
    const participant = {
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      name,
      emoji: avatars[randomInt(avatars.length)],
      role,
      visibility: 'viewing',
      connected: true,
      disconnectTimer: null,
    };
    room.participants.set(participant.token, participant);
    return participant;
  }

  #activeParticipant(room, token) {
    this.#assertActive(room);
    return this.#connectedParticipant(room, token);
  }

  #connectedParticipant(room, token) {
    const participant = this.#participant(room, token);
    if (!participant.connected) throw new AppError('disconnected', 'Participante desconectado.', 403);
    return participant;
  }

  #participant(room, token) {
    const participant = room.participants.get(token);
    if (!participant) throw new AppError('forbidden', 'Sessão temporária inválida.', 403);
    return participant;
  }

  #room(code) {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) throw new AppError('room_not_found', 'Sala não encontrada ou já encerrada.', 404);
    return room;
  }

  #assertActive(room) {
    if (room.status !== 'active') {
      throw new AppError('room_paused', 'A sala aguarda a reconexão do dono.', 409);
    }
  }

  #assertTimelineCapacity(room) {
    if (room.timeline.length + room.pendingFileCount >= LIMITS.timelineEntries) {
      throw new AppError('timeline_full', 'A sala atingiu o limite de itens.', 413);
    }
  }

  #releaseUpload(room, upload) {
    room.uploads.delete(upload.id);
    room.pendingFileBytes -= upload.size;
    room.pendingFileCount -= 1;
  }

  #touch(room) {
    room.lastActivityAt = this.now();
    this.#scheduleIdle(room);
  }

  #scheduleIdle(room) {
    clearTimeout(room.idleTimer);
    const delay = Math.max(0, room.lastActivityAt + this.idleMs - this.now());
    room.idleTimer = this.#timer(() => {
      const current = this.rooms.get(room.code);
      if (!current) return;
      if (this.now() >= current.lastActivityAt + this.idleMs) this.destroyRoom(room.code, 'inactive');
      else this.#scheduleIdle(current);
    }, delay);
  }

  #timer(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  }

  #newCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = '';
      for (let index = 0; index < 5; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new AppError('code_exhausted', 'Não foi possível criar uma sala.', 503);
  }
}

function publicRoom(room, idleMs, ownerGraceMs) {
  return {
    code: room.code,
    label: room.label,
    status: room.status,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    expiresAt: room.lastActivityAt + idleMs,
    ownerReconnectDeadline: room.ownerDisconnectedAt === null
      ? null
      : room.ownerDisconnectedAt + ownerGraceMs,
    limits: LIMITS,
  };
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.name,
    emoji: participant.emoji,
    role: participant.role,
    visibility: participant.visibility,
  };
}

function publicEntry(entry) {
  const base = {
    id: entry.id,
    type: entry.type,
    author: entry.author,
    createdAt: entry.createdAt,
  };

  return entry.type === 'text'
    ? { ...base, markdown: entry.markdown, html: renderMarkdown(entry.markdown) }
    : { ...base, name: entry.name, size: entry.size };
}

function cleanName(value) {
  if (typeof value !== 'string') throw new AppError('invalid_name', 'Informe seu nome.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 24) throw new AppError('invalid_name', 'O nome deve ter entre 1 e 24 caracteres.');
  return name;
}

function cleanOptionalLabel(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError('invalid_label', 'Nome da sala inválido.');
  const label = value.trim().replace(/\s+/g, ' ');
  if (label.length > 40) throw new AppError('invalid_label', 'O nome da sala deve ter até 40 caracteres.');
  return label || null;
}

function cleanMarkdown(value) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('empty_message', 'Escreva uma mensagem.');
  if (value.length > LIMITS.messageCharacters) {
    throw new AppError('message_too_long', 'A mensagem deve ter até 8.000 caracteres.', 413);
  }
  return value;
}

function cleanFileName(value) {
  if (typeof value !== 'string') throw new AppError('invalid_file_name', 'Nome de arquivo inválido.');
  const name = value.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  if (!name) throw new AppError('invalid_file_name', 'Nome de arquivo inválido.');
  return name;
}

function normalizeCode(value) {
  if (typeof value !== 'string') throw new AppError('invalid_code', 'Código de sala inválido.');
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{5}$/.test(code)) throw new AppError('invalid_code', 'Use o código de cinco letras.');
  return code;
}
