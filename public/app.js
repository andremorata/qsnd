import { hasTranslation, resolveLocale, translate } from './i18n.js';

const SESSION_KEY = 'qsnd-session';
const LOCALE_KEY = 'qsnd-locale';
const THEME_KEY = 'qsnd-theme';
const elements = Object.fromEntries([
  'landing-view', 'room-view', 'connection-label', 'display-name', 'room-label', 'room-code',
  'create-form', 'join-form', 'room-title', 'room-kicker', 'room-code-display', 'copy-code',
  'timer', 'timer-label', 'close-room', 'room-status', 'feed', 'empty-feed', 'message-form',
  'message-input', 'character-count', 'file-input', 'file-button', 'upload-status',
  'participant-list', 'participant-count', 'toast', 'ended-overlay', 'ended-reason', 'back-home',
].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));
const localizableNodes = [...document.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-title]')];
const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

const state = {
  code: null,
  token: null,
  role: null,
  participantId: null,
  name: null,
  room: null,
  participants: [],
  entries: new Map(),
  connected: false,
  ended: false,
  endReason: null,
  pendingMessage: null,
};

let socket;
let pendingAuthentication;
let reconnectTimer;
let toastTimer;
let overflowFrame;
let timeFormatter;
let locale = resolveLocale(readPreference(LOCALE_KEY), navigator.languages?.length ? navigator.languages : [navigator.language]);
let theme = resolveTheme(readPreference(THEME_KEY), colorSchemeQuery.matches);

initialize();

function initialize() {
  applyLanguage();
  for (const button of document.querySelectorAll('[data-language]')) {
    button.addEventListener('click', () => setLanguage(button.dataset.language));
  }
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', toggleTheme);
  }
  colorSchemeQuery.addEventListener('change', (event) => {
    if (readPreference(THEME_KEY)) return;
    theme = event.matches ? 'dark' : 'light';
    applyTheme();
  });

  elements.create_form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = validDisplayName();
    if (!name) return;
    authenticate({ type: 'create', name, label: elements.room_label.value.trim() || null }, name);
  });

  elements.join_form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = validDisplayName();
    if (!name || !elements.join_form.reportValidity()) return;
    authenticate({ type: 'join', name, code: elements.room_code.value.toUpperCase() }, name);
  });

  elements.room_code.addEventListener('input', () => {
    elements.room_code.value = elements.room_code.value.replace(/[^a-z]/gi, '').toUpperCase();
  });

  elements.message_form.addEventListener('submit', sendMessage);
  elements.message_input.addEventListener('input', updateCharacterCount);
  elements.message_input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.message_form.requestSubmit();
    }
  });
  elements.file_button.addEventListener('click', () => elements.file_input.click());
  elements.file_input.addEventListener('change', uploadSelectedFiles);
  elements.copy_code.addEventListener('click', () => copyText(state.code, t('toast.codeCopied')));
  elements.close_room.addEventListener('click', closeRoom);
  elements.feed.addEventListener('click', handleFeedAction);
  elements.back_home.addEventListener('click', () => location.assign('/'));

  for (const button of document.querySelectorAll('[data-wrap]')) {
    button.addEventListener('click', () => wrapSelection(button.dataset.wrap));
  }

  document.addEventListener('visibilitychange', () => {
    send({ type: 'visibility', visibility: document.hidden ? 'background' : 'viewing' });
  });

  window.addEventListener('resize', () => {
    cancelAnimationFrame(overflowFrame);
    overflowFrame = requestAnimationFrame(() => refreshMessageOverflow());
  });

  setInterval(updateTimer, 1_000);
  const saved = readSession();
  if (saved) {
    state.name = saved.name;
    elements.display_name.value = saved.name || '';
    elements.connection_label.textContent = t('connection.resuming');
    authenticate({ type: 'resume', code: saved.code, token: saved.token }, saved.name, true);
  }
}

function setLanguage(nextLocale) {
  locale = resolveLocale(nextLocale);
  writePreference(LOCALE_KEY, locale);
  applyLanguage();
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  writePreference(THEME_KEY, theme);
  applyTheme();
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#161918' : '#f2eee4';
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    const dark = theme === 'dark';
    const label = t(dark ? 'theme.useLight' : 'theme.useDark');
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.querySelector('[aria-hidden]').textContent = dark ? '☾' : '☼';
  }
}

function resolveTheme(savedTheme, prefersDark) {
  return ['light', 'dark'].includes(savedTheme) ? savedTheme : prefersDark ? 'dark' : 'light';
}

function applyLanguage() {
  document.documentElement.lang = locale;
  document.title = t('page.title');
  document.querySelector('meta[name="description"]').content = t('page.description');
  timeFormatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });

  for (const node of localizableNodes) {
    if (node.dataset.i18n) node.textContent = t(node.dataset.i18n);
    if (node.dataset.i18nPlaceholder) node.placeholder = t(node.dataset.i18nPlaceholder);
    if (node.dataset.i18nAriaLabel) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
    if (node.dataset.i18nTitle) node.title = t(node.dataset.i18nTitle);
  }

  for (const button of document.querySelectorAll('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === locale));
  }
  applyTheme();

  if (state.room) rerenderLocalizedRoom();
  if (state.ended) renderEndReason();
}

function rerenderLocalizedRoom() {
  const entries = [...state.entries.values()];
  const scrollTop = elements.feed.scrollTop;
  elements.feed.replaceChildren();
  state.entries = new Map();
  for (const entry of entries) addEntry(entry, false);
  if (!entries.length) elements.feed.append(elements.empty_feed);
  renderRoomIdentity();
  renderPresence();
  updateRoomState();
  requestAnimationFrame(() => { elements.feed.scrollTop = scrollTop; });
}

function renderRoomIdentity() {
  elements.room_title.textContent = state.room.label || t('room.defaultTitle', { code: state.code });
  elements.room_kicker.textContent = state.room.label ? t('room.kickerNamed') : t('room.kickerUnnamed');
}

function renderEndReason() {
  const reasons = {
    'owner-closed': 'end.ownerClosed',
    'owner-timeout': 'end.ownerTimeout',
    inactive: 'end.inactive',
    'server-stopped': 'end.serverStopped',
  };
  elements.ended_reason.textContent = t(reasons[state.endReason] || 'ended.unavailable');
}

function errorMessage(code, fallback) {
  const key = `error.${code}`;
  return hasTranslation(locale, key) ? t(key) : fallback || t('error.internal_error');
}

function t(key, values) {
  return translate(locale, key, values);
}

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function authenticate(payload, name, resuming = false) {
  clearTimeout(reconnectTimer);
  pendingAuthentication = { payload, name, resuming };
  setLandingBusy(true);

  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const currentSocket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = currentSocket;

  currentSocket.addEventListener('open', () => {
    if (socket !== currentSocket) return;
    state.connected = true;
    currentSocket.send(JSON.stringify(payload));
    updateRoomState();
  });

  currentSocket.addEventListener('message', (event) => {
    if (socket === currentSocket) handleServerMessage(JSON.parse(event.data));
  });

  currentSocket.addEventListener('close', () => {
    if (socket !== currentSocket) return;
    state.connected = false;
    state.pendingMessage = null;
    updateRoomState();
    if (!state.ended && state.code && state.token) {
      showToast(t('connection.lost'));
      reconnectTimer = setTimeout(() => {
        authenticate({ type: 'resume', code: state.code, token: state.token }, state.name, true);
      }, 1_500);
    } else {
      setLandingBusy(false);
    }
  });

  currentSocket.addEventListener('error', () => {
    if (!state.code) showToast(t('connection.failed'));
  });
}

function handleServerMessage(message) {
  if (message.type === 'authenticated') {
    state.code = message.code;
    state.token = message.token;
    state.role = message.role;
    state.participantId = message.participantId;
    state.name = pendingAuthentication?.name || state.name;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      code: state.code,
      token: state.token,
      role: state.role,
      participantId: state.participantId,
      name: state.name,
    }));
    pendingAuthentication = null;
    return;
  }

  if (message.type === 'snapshot') {
    renderSnapshot(message.snapshot);
    showRoom();
    return;
  }

  if (message.type === 'entry') {
    if (message.room) state.room = message.room;
    addEntry(message.entry);
    if (
      message.entry.type === 'text'
      && message.entry.author.id === state.participantId
      && message.entry.markdown === state.pendingMessage
    ) {
      state.pendingMessage = null;
      elements.message_input.value = '';
      updateCharacterCount();
    }
    updateRoomState();
    return;
  }

  if (message.type === 'presence') {
    state.participants = message.participants;
    renderPresence();
    return;
  }

  if (message.type === 'room-state') {
    state.room = message.room;
    updateRoomState();
    return;
  }

  if (message.type === 'room-destroyed') {
    endRoom(message.reason);
    return;
  }

  if (message.type === 'error') handleServerError(message);
}

function handleServerError(error) {
  state.pendingMessage = null;
  updateRoomState();
  showToast(errorMessage(error.code, error.message));
  const authenticationFailed = !state.code || pendingAuthentication?.resuming;
  if (authenticationFailed && ['room_not_found', 'room_unavailable', 'rate_limited', 'forbidden', 'invalid_code', 'room_paused'].includes(error.code)) {
    clearSession();
    pendingAuthentication = null;
    socket?.close();
    showLanding();
  }
  setLandingBusy(false);
}

function renderSnapshot(snapshot) {
  state.room = snapshot.room;
  state.participants = snapshot.participants;
  state.entries = new Map();
  elements.feed.replaceChildren();
  for (const entry of snapshot.timeline) addEntry(entry, false);
  if (!snapshot.timeline.length) elements.feed.append(elements.empty_feed);
  renderPresence();
  updateRoomState();
}

function showRoom() {
  elements.landing_view.hidden = true;
  elements.room_view.hidden = false;
  elements.ended_overlay.hidden = true;
  renderRoomIdentity();
  elements.room_code_display.textContent = state.code;
  elements.close_room.hidden = state.role !== 'owner';
  elements.connection_label.textContent = t('tagline');
  setLandingBusy(false);
  updateRoomState();
  requestAnimationFrame(() => elements.message_input.focus());
}

function showLanding() {
  elements.room_view.hidden = true;
  elements.ended_overlay.hidden = true;
  elements.landing_view.hidden = false;
  elements.connection_label.textContent = t('tagline');
  setLandingBusy(false);
}

function addEntry(entry, scroll = true) {
  if (state.entries.has(entry.id)) return;
  state.entries.set(entry.id, entry);
  elements.empty_feed.remove();
  const entryElement = createEntryElement(entry);
  elements.feed.append(entryElement);
  if (entry.type === 'text') requestAnimationFrame(() => refreshMessageOverflow(entryElement));
  if (scroll) elements.feed.scrollTop = elements.feed.scrollHeight;
}

function createEntryElement(entry) {
  const article = element('article', `timeline-entry ${entry.type}-entry`);
  article.dataset.entryId = entry.id;
  const avatar = element('div', 'avatar', entry.author.emoji);
  avatar.setAttribute('aria-hidden', 'true');
  const shell = element('div', 'entry-shell');
  const meta = element('div', 'entry-meta');
  meta.append(element('strong', '', entry.author.name));
  if (entry.author.role === 'owner') meta.append(element('span', 'owner-mark', t('entry.owner')));
  const time = element('time', '', timeFormatter.format(new Date(entry.createdAt)));
  time.dateTime = new Date(entry.createdAt).toISOString();
  meta.append(time);
  shell.append(meta);

  if (entry.type === 'text') {
    const card = element('div', 'message-card');
    const content = element('div', 'message-content collapsed');
    content.id = `message-${entry.id}`;
    content.innerHTML = entry.html;
    const actions = element('div', 'entry-actions');
    const expand = actionButton('toggle-expand', t('entry.expand'));
    expand.hidden = true;
    expand.setAttribute('aria-controls', content.id);
    expand.setAttribute('aria-expanded', 'false');
    actions.append(actionButton('copy-rich', t('entry.copyRich')), actionButton('copy-markdown', t('entry.copyMarkdown')), expand);
    card.append(content, actions);
    shell.append(card);
  } else {
    const card = element('div', 'file-card');
    const icon = element('span', 'file-icon', '↧');
    icon.setAttribute('aria-hidden', 'true');
    const details = element('div', 'file-details');
    details.append(element('strong', '', entry.name), element('span', '', formatBytes(entry.size)));
    const download = actionButton('download', t('entry.download'));
    download.className = 'download-button';
    card.append(icon, details, download);
    shell.append(card);
  }

  article.append(avatar, shell);
  return article;
}

function refreshMessageOverflow(article) {
  const articles = article ? [article] : [...elements.feed.querySelectorAll('.text-entry')];
  for (const currentArticle of articles) {
    const content = currentArticle.querySelector('.message-content');
    const button = currentArticle.querySelector('[data-action="toggle-expand"]');
    const wasExpanded = button?.getAttribute('aria-expanded') === 'true';
    if (!content || !button) continue;

    content.classList.add('collapsed');
    const overflows = content.scrollHeight > content.clientHeight + 1;
    button.hidden = !overflows;
    currentArticle.querySelector('.message-card').classList.toggle('has-overflow', overflows);

    if (wasExpanded && overflows) content.classList.remove('collapsed');
    else if (!overflows) content.classList.remove('collapsed');

    if (!overflows) button.setAttribute('aria-expanded', 'false');
    button.textContent = wasExpanded && overflows ? t('entry.collapse') : t('entry.expand');
  }
}

function renderPresence() {
  elements.participant_list.replaceChildren();
  elements.participant_count.textContent = String(state.participants.length);

  const participants = [...state.participants].sort((left, right) => {
    if (left.role !== right.role) return left.role === 'owner' ? -1 : 1;
    return left.name.localeCompare(right.name, locale);
  });

  for (const participant of participants) {
    const item = element('li', 'participant');
    const avatar = element('span', 'participant-avatar', participant.emoji);
    avatar.setAttribute('aria-hidden', 'true');
    const name = element('div', 'participant-name');
    const ownLabel = participant.id === state.participantId ? ` · ${t('presence.you')}` : '';
    name.append(
      element('strong', '', participant.name),
      element('span', '', `${t(participant.role === 'owner' ? 'presence.owner' : 'presence.guest')}${ownLabel}`),
    );
    const dot = element('span', `presence-dot ${participant.visibility}`);
    dot.title = t(participant.visibility === 'viewing' ? 'presence.viewing' : 'presence.background');
    item.append(avatar, name, dot);
    elements.participant_list.append(item);
  }
}

function updateRoomState() {
  if (!state.room) return;
  const active = state.room.status === 'active' && state.connected;
  const ownerAway = state.room.status === 'owner-away';
  elements.room_status.textContent = t(ownerAway ? 'status.ownerAway' : state.connected ? 'status.active' : 'status.reconnecting');
  elements.room_status.classList.toggle('away', !active);
  elements.message_form.classList.toggle('disabled', !active);
  elements.message_input.disabled = !active;
  elements.file_button.disabled = !active;
  elements.message_form.querySelector('.send-button').disabled = !active || Boolean(state.pendingMessage);
  updateTimer();
}

function updateTimer() {
  if (!state.room || elements.room_view.hidden) return;
  const deadline = state.room.status === 'owner-away'
    ? state.room.ownerReconnectDeadline
    : state.room.expiresAt;
  const remaining = Math.max(0, deadline - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  const prefix = state.room.status === 'owner-away' ? t('timer.owner') : '';
  elements.timer_label.textContent = `${prefix}${minutes}:${String(seconds).padStart(2, '0')}`;
  elements.timer.classList.toggle('warning', remaining <= 5 * 60_000 || state.room.status === 'owner-away');
}

function sendMessage(event) {
  event.preventDefault();
  const markdown = elements.message_input.value;
  if (!markdown.trim() || state.pendingMessage) return;
  state.pendingMessage = markdown;
  send({ type: 'message', markdown });
  updateRoomState();
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN && state.token) socket.send(JSON.stringify(payload));
}

function closeRoom() {
  if (confirm(t('confirm.close'))) send({ type: 'close-room' });
}

async function handleFeedAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const article = button.closest('[data-entry-id]');
  const entry = state.entries.get(article?.dataset.entryId);
  if (!entry) return;

  try {
    if (button.dataset.action === 'copy-markdown') await copyText(entry.markdown, t('toast.markdownCopied'));
    if (button.dataset.action === 'copy-rich') await copyFormatted(article, entry);
    if (button.dataset.action === 'toggle-expand') toggleMessage(article, button);
    if (button.dataset.action === 'download') await downloadFile(entry, button);
  } catch (error) {
    showToast(error.message || t('toast.actionFailed'));
  }
}

function toggleMessage(article, button) {
  const content = article.querySelector('.message-content');
  const expanding = content.classList.contains('collapsed');
  content.classList.toggle('collapsed', !expanding);
  button.textContent = t(expanding ? 'entry.collapse' : 'entry.expand');
  button.setAttribute('aria-expanded', String(expanding));
}

async function copyFormatted(article) {
  const content = article.querySelector('.message-content');
  const text = content.innerText;
  if (window.ClipboardItem && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([content.innerHTML], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    showToast(t('toast.richCopied'));
  } else {
    await copyText(text, t('toast.plainCopy'));
  }
}

async function copyText(text, successMessage) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  showToast(successMessage);
}

async function uploadSelectedFiles() {
  const files = [...elements.file_input.files];
  elements.file_input.value = '';
  if (!files.length) return;
  elements.file_button.disabled = true;

  try {
    for (let index = 0; index < files.length; index += 1) {
      await uploadFile(files[index], index + 1, files.length);
    }
    showToast(files.length === 1 ? t('toast.fileSent') : t('toast.filesSent', { count: files.length }));
  } catch (error) {
    showToast(error.message || t('upload.failed'));
  } finally {
    elements.file_button.disabled = state.room?.status !== 'active';
    elements.upload_status.textContent = '';
  }
}

function uploadFile(file, current, total) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/files');
    request.setRequestHeader('Authorization', `Bearer ${state.token}`);
    request.setRequestHeader('X-Room-Code', state.code);
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.upload.addEventListener('progress', (event) => {
      const percent = event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0;
      elements.upload_status.textContent = `${current}/${total} · ${percent}% · ${file.name}`;
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        let payload = {};
        try { payload = JSON.parse(request.responseText); } catch {}
        reject(new Error(errorMessage(payload.code, payload.message || t('upload.failed'))));
      }
    });
    request.addEventListener('error', () => reject(new Error(t('upload.interrupted'))));
    request.send(file);
  });
}

async function downloadFile(entry, button) {
  button.disabled = true;
  button.textContent = t('entry.downloading');
  try {
    const response = await fetch('/api/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        'X-Room-Code': state.code,
        'X-File-Id': entry.id,
      },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(errorMessage(error.code, error.message || t('download.unavailable')));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } finally {
    button.disabled = false;
    button.textContent = t('entry.download');
  }
}

function wrapSelection(pattern) {
  const [before, after] = pattern.split('|');
  const input = elements.message_input;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const selected = input.value.slice(start, end) || t('selection.fallback');
  input.setRangeText(`${before}${selected}${after}`, start, end, 'end');
  input.focus();
  updateCharacterCount();
}

function updateCharacterCount() {
  elements.character_count.textContent = `${elements.message_input.value.length} / 8000`;
}

function validDisplayName() {
  const name = elements.display_name.value.trim();
  elements.display_name.setCustomValidity(name ? '' : t('validation.name'));
  if (!elements.display_name.reportValidity()) return null;
  return name;
}

function setLandingBusy(busy) {
  for (const button of document.querySelectorAll('.access-card button[type="submit"]')) button.disabled = busy;
  elements.connection_label.textContent = t(busy ? 'connection.opening' : 'tagline');
}

function endRoom(reason) {
  state.ended = true;
  state.endReason = reason;
  clearSession();
  renderEndReason();
  elements.ended_overlay.hidden = false;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  state.code = null;
  state.token = null;
  state.role = null;
  state.participantId = null;
  state.room = null;
}

function readSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return saved?.code && saved?.token ? saved : null;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3_000);
}

function actionButton(action, label) {
  const button = element('button', 'entry-action', label);
  button.type = 'button';
  button.dataset.action = action;
  return button;
}

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
