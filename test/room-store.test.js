import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { AppError, LIMITS, RoomStore } from '../src/room-store.js';

test('creates a room, joins a guest, and renders safe Markdown', () => {
  const store = new RoomStore();
  const owner = store.createRoom({ ownerName: 'Ana', label: 'Plantão' });
  const guest = store.joinRoom({ code: owner.code, name: 'Beto' });

  const entry = store.addMessage(
    owner.code,
    guest.token,
    '**oi** [seguro](https://example.com) [js](javascript:alert(1)) [data](data:text/html,x) [vb](vbscript:x) ![pixel](https://example.com/pixel) <script>alert(1)</script>',
  );

  assert.match(owner.code, /^[A-HJ-NP-Z]{5}$/);
  assert.equal(store.presence(owner.code).length, 2);
  assert.match(entry.html, /<strong>oi<\/strong>/);
  assert.match(entry.html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(entry.html, /href="(?:javascript|data|vbscript):/);
  assert.doesNotMatch(entry.html, /<img|<script>/);
  assert.match(entry.html, /&lt;script&gt;/);
  assert.equal(entry.markdown.startsWith('**oi**'), true);

  const maximumMessage = store.addMessage(owner.code, owner.token, 'a'.repeat(LIMITS.messageCharacters));
  assert.equal(maximumMessage.markdown.length, 8_000);
  assert.throws(
    () => store.addMessage(owner.code, owner.token, 'a'.repeat(LIMITS.messageCharacters + 1)),
    (error) => error.code === 'message_too_long',
  );

  store.destroyAll();
});

test('lets the owner resume before the grace period', async () => {
  const store = new RoomStore({ ownerGraceMs: 30 });
  const owner = store.createRoom({ ownerName: 'Ana' });

  store.disconnectRoom(owner.code, owner.token);
  assert.equal(store.summary(owner.code).status, 'owner-away');

  await new Promise((resolve) => setTimeout(resolve, 5));
  store.resumeRoom({ code: owner.code, token: owner.token });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(store.summary(owner.code).status, 'active');
  store.destroyAll();
});

test('destroys the room when the owner does not return', async () => {
  const store = new RoomStore({ ownerGraceMs: 10 });
  const owner = store.createRoom({ ownerName: 'Ana' });
  const destroyed = once(store, 'destroy');

  store.disconnectRoom(owner.code, owner.token);
  const [event] = await destroyed;

  assert.equal(event.reason, 'owner-timeout');
  assert.throws(() => store.summary(owner.code), AppError);
});

test('reserves aggregate file space and removes file paths on destroy', async () => {
  const store = new RoomStore();
  const owner = store.createRoom({ ownerName: 'Ana' });
  const upload = store.beginUpload(owner.code, owner.token, {
    name: '../relatório.pdf',
    size: LIMITS.fileBytes,
  });

  assert.equal(upload.name, 'relatório.pdf');
  assert.throws(
    () => store.beginUpload(owner.code, owner.token, { name: 'extra.txt', size: 1 }),
    (error) => error.code === 'room_storage_full',
  );

  const encryptionKey = Buffer.alloc(32, 1);
  const encryptionIv = Buffer.alloc(12, 2);
  const authenticationTag = Buffer.alloc(16, 3);
  const entry = store.finishUpload(owner.code, owner.token, upload.id, {
    path: '/tmp/qsnd/file',
    key: encryptionKey,
    iv: encryptionIv,
    authenticationTag,
  });
  assert.equal(entry.name, 'relatório.pdf');
  assert.equal('storedPath' in entry, false);

  store.disconnectRoom(owner.code, owner.token);
  assert.throws(
    () => store.getFile(owner.code, owner.token, entry.id),
    (error) => error.code === 'room_paused',
  );
  store.resumeRoom({ code: owner.code, token: owner.token });

  const destroyed = once(store, 'destroy');
  store.closeRoom(owner.code, owner.token);
  const [event] = await destroyed;
  assert.deepEqual(event.files, ['/tmp/qsnd/file']);
  assert.deepEqual([...encryptionKey], Array(32).fill(0));
  assert.deepEqual([...encryptionIv], Array(12).fill(0));
  assert.deepEqual([...authenticationTag], Array(16).fill(0));
});

test('enforces global room and file budgets', () => {
  const store = new RoomStore();
  for (let index = 0; index < LIMITS.rooms; index += 1) {
    store.createRoom({ ownerName: `Dono ${index}` });
  }
  assert.throws(
    () => store.createRoom({ ownerName: 'Excedente' }),
    (error) => error.code === 'server_capacity',
  );
  store.destroyAll();

  const fileStore = new RoomStore();
  for (let index = 0; index < LIMITS.serverFileBytes / LIMITS.fileBytes; index += 1) {
    const owner = fileStore.createRoom({ ownerName: `Dono ${index}` });
    fileStore.beginUpload(owner.code, owner.token, { name: `${index}.bin`, size: LIMITS.fileBytes });
  }
  const extraOwner = fileStore.createRoom({ ownerName: 'Excedente' });
  assert.throws(
    () => fileStore.beginUpload(extraOwner.code, extraOwner.token, { name: 'extra.bin', size: 1 }),
    (error) => error.code === 'server_storage_full',
  );
  fileStore.destroyAll();
});

test('limits concurrent uploads per room', () => {
  const store = new RoomStore();
  const owner = store.createRoom({ ownerName: 'Dono' });
  for (let index = 0; index < LIMITS.concurrentUploads; index += 1) {
    store.beginUpload(owner.code, owner.token, { name: `${index}.bin`, size: 1 });
  }
  assert.throws(
    () => store.beginUpload(owner.code, owner.token, { name: 'extra.bin', size: 1 }),
    (error) => error.code === 'too_many_uploads',
  );
  store.destroyAll();
});

test('does not resume a disconnected guest above the participant limit', () => {
  const store = new RoomStore();
  const owner = store.createRoom({ ownerName: 'Dono' });
  const guests = Array.from({ length: LIMITS.participants - 1 }, (_, index) => (
    store.joinRoom({ code: owner.code, name: `Pessoa ${index}` })
  ));

  store.disconnectRoom(owner.code, guests[0].token);
  store.joinRoom({ code: owner.code, name: 'Nova pessoa' });
  assert.throws(
    () => store.resumeRoom({ code: owner.code, token: guests[0].token }),
    (error) => error.code === 'room_full',
  );
  store.destroyAll();
});
