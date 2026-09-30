import { COUPLE_NAMES, INIT_ENDPOINT } from './config.js';
import { createInitClient } from './lib/api.js';
import { uploadFile } from './lib/uploader.js';
import { formatBytes, isLargeFile, resolveMimeType } from './lib/format.js';

const ERROR_MESSAGES = {
  no_space: 'Se llenó el espacio del álbum. Avisales a los novios.',
  invalid: 'Este archivo no es una foto o un video.',
  rejected: 'Google Drive rechazó el archivo.',
  session_expired: 'La subida se venció. Tocá Reintentar.',
  network: 'Problema de conexión. Tocá Reintentar.',
  server: 'Hubo un error en el servidor. Tocá Reintentar.',
};

const GUEST_NAME_KEY = 'guestName';

const els = {
  couple: document.querySelector('#couple'),
  guestName: document.querySelector('#guest-name'),
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
els.guestName.value = readGuestName();
els.guestName.addEventListener('change', () => writeGuestName(els.guestName.value.trim()));
els.picker.addEventListener('change', onFilesChosen);
window.addEventListener('beforeunload', (event) => {
  if (pending > 0) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pending > 0) acquireWakeLock();
});

function readGuestName() {
  try { return localStorage.getItem(GUEST_NAME_KEY) ?? ''; } catch { return ''; }
}

function writeGuestName(value) {
  try { localStorage.setItem(GUEST_NAME_KEY, value); } catch { /* storage unavailable */ }
}

function onFilesChosen() {
  for (const file of els.picker.files) {
    if (file.size === 0) continue;
    if (isLargeFile(file.size) && !confirmLarge(file)) continue;
    enqueue(file, createRow(file));
  }
  els.picker.value = '';
}

function confirmLarge(file) {
  return window.confirm(
    `Este video pesa ${formatBytes(file.size)}. Puede tardar varios minutos: ` +
    'mantené la pantalla abierta y, si podés, usá WiFi. ¿Subirlo igual?',
  );
}

function enqueue(file, row) {
  pending++;
  updateBusy();
  setRow(row, { state: 'queued', status: 'En espera…', sent: 0, total: file.size });
  queue = queue.then(() => runUpload(file, row));
}

async function runUpload(file, row) {
  setRow(row, { state: 'uploading', status: 'Subiendo…' });
  const result = await uploadFile({
    file,
    mimeType: resolveMimeType(file),
    guestName: els.guestName.value.trim(),
    origin: location.origin,
    init,
    onProgress: (sent, total) => setRow(row, { sent, total }),
  });
  if (result.ok) {
    setRow(row, { state: 'done', status: '¡Listo! Gracias ♥' });
  } else {
    setRow(row, { state: 'error', status: ERROR_MESSAGES[result.error] ?? ERROR_MESSAGES.server });
    if (result.error !== 'invalid' && result.error !== 'no_space') addRetry(file, row);
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

function addRetry(file, row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reintentar';
  button.addEventListener('click', () => {
    button.remove();
    enqueue(file, row);
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
