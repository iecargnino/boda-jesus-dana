import { COUPLE_NAMES, INIT_ENDPOINT } from './config.js';
import { createInitClient } from './lib/api.js';
import { uploadFile } from './lib/uploader.js';
import { GUEST_STORAGE_KEY, canContinue, resolveGuestName, displayGuestName, parseGuest, serializeGuest } from './lib/guest.js';
import { formatBytes, isLargeFile, resolveMimeType } from './lib/format.js';

const ERROR_MESSAGES = {
  no_space: 'Se llenó el espacio del álbum. Avisales a los novios.',
  invalid: 'Este archivo no es una foto o un video.',
  rejected: 'Google Drive rechazó el archivo.',
  session_expired: 'La subida se venció. Tocá Reintentar.',
  network: 'Problema de conexión. Tocá Reintentar.',
  server: 'Hubo un error en el servidor. Tocá Reintentar.',
  cancelled: 'Cancelado.',
};

const els = {
  couple: document.querySelector('#couple'),
  identity: document.querySelector('#identity'),
  guestName: document.querySelector('#guest-name'),
  anonymous: document.querySelector('#guest-anonymous'),
  continueBtn: document.querySelector('#continue'),
  uploadStep: document.querySelector('#upload-step'),
  display: document.querySelector('#guest-display'),
  change: document.querySelector('#change'),
  picker: document.querySelector('#picker'),
  notice: document.querySelector('#notice'),
  list: document.querySelector('#list'),
};

const init = createInitClient({ endpoint: INIT_ENDPOINT });
let queue = Promise.resolve();
let pending = 0;
let wakeLock = null;
let wakeLockRequesting = false;

els.couple.textContent = COUPLE_NAMES;
els.guestName.addEventListener('input', updateContinue);
els.anonymous.addEventListener('change', onAnonymousToggle);
els.identity.addEventListener('submit', onIdentitySubmit);
els.change.addEventListener('click', showIdentityStep);
els.picker.addEventListener('change', onFilesChosen);
window.addEventListener('beforeunload', (event) => {
  if (pending > 0) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pending > 0) acquireWakeLock();
});

const stored = readGuest();
if (stored) {
  els.guestName.value = stored.name;
  els.anonymous.checked = stored.anonymous;
  els.guestName.disabled = stored.anonymous;
  showUploadStep(stored);
}
updateContinue();

function readGuest() {
  try { return parseGuest(localStorage.getItem(GUEST_STORAGE_KEY)); } catch { return null; }
}

function writeGuest(guest) {
  try { localStorage.setItem(GUEST_STORAGE_KEY, serializeGuest(guest)); } catch { /* storage unavailable */ }
}

function currentGuest() {
  return { name: els.guestName.value, anonymous: els.anonymous.checked };
}

function updateContinue() {
  els.continueBtn.disabled = !canContinue(currentGuest());
}

function onAnonymousToggle() {
  els.guestName.disabled = els.anonymous.checked;
  if (els.anonymous.checked) els.guestName.value = '';
  updateContinue();
}

function onIdentitySubmit(event) {
  event.preventDefault();
  const guest = currentGuest();
  if (!canContinue(guest)) return;
  writeGuest(guest);
  showUploadStep(guest);
  els.change.focus();
}

function showUploadStep(guest) {
  els.display.textContent = displayGuestName(guest);
  els.identity.hidden = true;
  els.uploadStep.hidden = false;
}

function showIdentityStep() {
  els.uploadStep.hidden = true;
  els.identity.hidden = false;
  (els.anonymous.checked ? els.anonymous : els.guestName).focus();
}

function onFilesChosen() {
  const guestName = resolveGuestName(currentGuest());
  for (const file of els.picker.files) {
    if (file.size === 0) continue;
    if (isLargeFile(file.size) && !confirmLarge(file)) continue;
    enqueue(file, createRow(file), guestName);
  }
  els.picker.value = '';
}

function confirmLarge(file) {
  return window.confirm(
    `Este video pesa ${formatBytes(file.size)}. Puede tardar varios minutos: ` +
    'mantené la pantalla abierta y, si podés, usá WiFi. ¿Subirlo igual?',
  );
}

function enqueue(file, row, guestName) {
  pending++;
  updateBusy();
  setRow(row, { state: 'queued', status: 'En espera…', sent: 0, total: file.size });
  const controller = new AbortController();
  addCancel(row, controller);
  queue = queue.then(() => runUpload(file, row, guestName, controller));
}

async function runUpload(file, row, guestName, controller) {
  // A file cancelled while queued is skipped: no init, no network.
  if (!controller.signal.aborted) setRow(row, { state: 'uploading', status: 'Subiendo…' });
  const result = await uploadFile({
    file,
    mimeType: resolveMimeType(file),
    guestName,
    origin: location.origin,
    init,
    signal: controller.signal,
    onProgress: (sent, total) => setRow(row, { sent, total }),
  });
  row.querySelector('.cancel')?.remove();
  if (result.ok) {
    setRow(row, { state: 'done', status: '¡Listo! Gracias ♥' });
  } else if (result.error === 'cancelled') {
    setRow(row, { state: 'cancelled', status: ERROR_MESSAGES.cancelled });
    addRetry(file, row, guestName);
  } else {
    setRow(row, { state: 'error', status: ERROR_MESSAGES[result.error] ?? ERROR_MESSAGES.server });
    if (result.error !== 'invalid' && result.error !== 'no_space') addRetry(file, row, guestName);
  }
  pending--;
  updateBusy();
}

function createRow(file) {
  const row = document.createElement('li');
  row.className = 'item';
  row.innerHTML = `
    <div class="item-head"><span class="item-name"></span><span class="item-size"></span></div>
    <progress max="1" value="0"></progress>
    <div class="item-status"></div>`;
  row.querySelector('.item-name').textContent = file.name;
  row.querySelector('.item-size').textContent = formatBytes(file.size);
  els.list.prepend(row);
  return row;
}

function setRow(row, { state, status, sent, total }) {
  if (state) row.className = `item ${state}`;
  if (status) row.querySelector('.item-status').textContent = status;
  if (sent !== undefined && total) row.querySelector('progress').value = sent / total;
}

function addCancel(row, controller) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cancel';
  button.textContent = 'Cancelar';
  button.addEventListener('click', () => {
    controller.abort();
    button.remove();
    setRow(row, { status: 'Cancelando…' });
  });
  row.append(button);
}

function addRetry(file, row, guestName) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reintentar';
  button.addEventListener('click', () => {
    button.remove();
    enqueue(file, row, guestName);
  });
  row.append(button);
}

function updateBusy() {
  els.notice.hidden = pending === 0;
  if (pending > 0) acquireWakeLock();
  else releaseWakeLock();
}

async function acquireWakeLock() {
  if (wakeLock || wakeLockRequesting || !('wakeLock' in navigator)) return;
  wakeLockRequesting = true;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (pending === 0) {
      sentinel.release(); // Uploads finished while the request was in flight.
    } else {
      wakeLock = sentinel;
      sentinel.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    wakeLock = null; // Not allowed (e.g. low battery); the notice still warns the guest.
  } finally {
    wakeLockRequesting = false;
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}
