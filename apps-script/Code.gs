/* global ContentService, DriveApp, LockService, PropertiesService, ScriptApp, UrlFetchApp, Utilities */

var FOLDER_NAME = 'Casamiento Jesús & Dana';
var FOLDER_PROPERTY = 'FOLDER_ID';
var TIMEZONE = 'America/Argentina/Buenos_Aires';
// First entry is the production guest page origin; the rest are for local testing.
var ALLOWED_ORIGINS = ['https://iecargnino.github.io', 'http://localhost:8080'];
var DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';

function doGet() {
  return jsonOutput({ ok: true, service: 'wedding-upload' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ ok: false, error: 'invalid' });
  }
  try {
    return jsonOutput(handleInit(body));
  } catch (err) {
    console.error(err);
    return jsonOutput({ ok: false, error: 'server' });
  }
}

function jsonOutput(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function handleInit(body) {
  if (!isValidInit(body)) return { ok: false, error: 'invalid' };
  if (!hasSpaceFor(body.size)) return { ok: false, error: 'no_space' };
  var uploadUrl = createUploadSession({
    name: buildFileName(new Date(), body.guestName, body.fileName),
    folderId: getFolderId(),
    mimeType: body.mimeType,
    size: body.size,
    origin: resolveOrigin(body.origin)
  });
  return uploadUrl ? { ok: true, uploadUrl: uploadUrl } : { ok: false, error: 'server' };
}

function isValidInit(body) {
  return !!body && body.action === 'init' &&
    typeof body.fileName === 'string' && body.fileName.trim().length > 0 &&
    typeof body.mimeType === 'string' && /^(image|video)\//.test(body.mimeType) &&
    typeof body.size === 'number' && Number.isInteger(body.size) && body.size > 0 &&
    (body.guestName === undefined || body.guestName === null || typeof body.guestName === 'string');
}

function hasSpaceFor(size) {
  var limit = DriveApp.getStorageLimit();
  if (!(limit > 0)) return true; // Unlimited or unknown quota.
  return size <= limit - DriveApp.getStorageUsed();
}

function slugify(value) {
  var slug = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'Invitado';
}

function sanitizeFileName(value) {
  // Keep the tail so the extension survives truncation.
  return String(value).replace(/[\/\\\u0000-\u001f]/g, '_').trim().slice(-120);
}

function buildFileName(date, guestName, fileName) {
  return Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd_HH-mm-ss') + '_' + slugify(guestName) + '_' + sanitizeFileName(fileName);
}

function resolveOrigin(requested) {
  return ALLOWED_ORIGINS.indexOf(requested) >= 0 ? requested : ALLOWED_ORIGINS[0];
}

function getFolderId() {
  var props = PropertiesService.getUserProperties();
  var existing = findFolder(props.getProperty(FOLDER_PROPERTY));
  if (existing) return existing;

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Another request may have created the folder while we waited for the lock.
    existing = findFolder(props.getProperty(FOLDER_PROPERTY));
    if (existing) return existing;
    var id = DriveApp.createFolder(FOLDER_NAME).getId();
    props.setProperty(FOLDER_PROPERTY, id);
    return id;
  } finally {
    lock.releaseLock();
  }
}

function findFolder(id) {
  if (!id) return null;
  try {
    return DriveApp.getFolderById(id).isTrashed() ? null : id;
  } catch (err) {
    return null;
  }
}

// The Origin header makes Drive answer the browser's cross-origin chunk PUTs with CORS headers.
function createUploadSession(opts) {
  var response = UrlFetchApp.fetch(DRIVE_UPLOAD_URL, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ name: opts.name, parents: [opts.folderId] }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': opts.mimeType,
      'X-Upload-Content-Length': String(opts.size),
      Origin: opts.origin
    },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    console.error('Drive session failed: ' + response.getResponseCode() + ' ' + response.getContentText());
    return null;
  }
  var headers = response.getHeaders();
  return headers.Location || headers.location || null;
}
