# Wedding Guest Upload — Design (Friday MVP)

- **Date:** 2026-09-29
- **Event:** Friday 2026-10-02
- **Status:** Approved

## Goal

Guests scan a QR code at the wedding and upload photos and videos to the couple's
Google Drive with the least friction possible: no Google login, any phone, any file size.

## Success criteria

- A guest can go from scanning the QR to uploading in a few taps, on iOS Safari and Android Chrome.
- Files of any size (including videos > 300 MB) arrive complete and playable in a single Drive folder.
- Uploads survive brief network drops (resume from the last confirmed chunk).
- Files consume the couple's (Dana's) Drive quota, not the developer's.

## Constraints

- Delivery deadline: working and device-tested by Thursday 2026-10-01.
- Couple's account: 100 GB plan, ~32 GB free (to be increased before the event).
- The developer does not have the couple's password; everything is built and tested
  in the developer's account and handed over.
- Free infrastructure only.

## Out of scope (future sub-project)

Multi-tenant product (per-event tenants, OAuth "Connect with Google", backend storing
refresh tokens, `drive.file` scope, Google app verification, admin panel, abuse limits).
This MVP keeps the guest page and the `init` contract stable so the multi-tenant backend
can replace Apps Script without changing the page.

## Architecture

Two components:

1. **Guest page** — static HTML/CSS/vanilla JS hosted on GitHub Pages. Stable URL; the QR
   points here and never changes.
2. **Apps Script web app** — deployed with "Execute as: Me" and "Access: Anyone". Exposes a
   single `init` action. It never receives file bytes.

```
QR → Guest page → POST init (Apps Script) → { uploadUrl }
                → PUT chunks directly to Drive resumable session → file in folder
```

### Apps Script `init`

- Input (JSON body, sent as `text/plain` to avoid CORS preflight):
  `{ action: "init", fileName, mimeType, size, guestName? }`
- Resolves the target folder: on first use it creates "Casamiento Jesús & Dana" in the
  owner's My Drive and stores its ID in Script Properties (`FOLDER_ID`); later calls reuse it.
  After handoff, Dana's deployment creates its own folder automatically.
- Validates input (non-empty name, positive size, image/* or video/* MIME type).
- Checks free quota (`DriveApp.getStorageLimit() - DriveApp.getStorageUsed()`); rejects when
  the file does not fit.
- Creates a Drive v3 resumable session via `UrlFetchApp` using `ScriptApp.getOAuthToken()`,
  with metadata `{ name, parents: [FOLDER_ID] }`, `X-Upload-Content-Type`,
  `X-Upload-Content-Length`, and `Origin` set to the guest page origin so the browser can
  PUT to the session URL cross-origin.
- Output: `{ ok: true, uploadUrl }` or `{ ok: false, error: "no_space" | "invalid" | "server" }`.
- The session URL grants upload of that single file only; the OAuth token is never exposed.

### Contract (stable across MVP and multi-tenant)

```
POST init  { fileName, mimeType, size, guestName? }
  → { ok: true, uploadUrl } | { ok: false, error: "no_space" | "invalid" | "server" }
```

### Guest page upload engine

- Chunk size 8 MiB (multiple of 256 KiB, as Drive requires).
- Each chunk: `PUT uploadUrl` with `Content-Range: bytes start-end/total`.
  - `308` → read `Range` header, continue from the next byte.
  - `200/201` → done.
  - Network error / `5xx` → retry with exponential backoff (max 5 attempts per chunk); before
    retrying, query status with `Content-Range: bytes */total` to resume from the confirmed offset.
  - `404/410` → session expired; restart the file with a fresh `init`.
- Files upload sequentially (one at a time) to keep mobile connections stable.

### File naming

`YYYY-MM-DD_HH-mm-ss_<Guest-Name>_<originalName>` (guest name slugified; `Invitado` when empty).
Timestamp is the upload time in the event's local timezone.

## UX

- Header with the couple's names; optional "Your name" field (remembered in `localStorage`).
- Big "Choose photos & videos" button (`<input type="file" multiple accept="image/*,video/*">`).
- Per-file row: name, size, progress bar, status (queued / uploading / done / error + Retry).
- Files > 300 MB: confirm dialog "This video is X MB. It may take several minutes; keep this
  screen open and use Wi-Fi if possible." — **Upload anyway** / **Cancel**.
- Screen Wake Lock while uploading where supported; persistent "Don't close this screen" notice.
- `no_space` → clear friendly message.
- UI copy in Spanish (guests are Spanish speakers); code and comments in English.

## Error handling summary

| Failure | Behavior |
|---|---|
| Chunk network error / 5xx | Backoff retry, resume from confirmed offset |
| Session expired (404/410) | Re-init and restart file |
| Retries exhausted | Mark row as error with Retry button |
| No space | Friendly message, skip file |
| Invalid input | Friendly message, skip file |

## Testing

- **TDD** (`node:test`, no dependencies) for pure logic: chunk range computation,
  `Content-Range` headers, `Range` header parsing, backoff schedule, file naming/slugify,
  size formatting, large-file threshold.
- **Manual E2E (Thursday):** iPhone Safari + Android Chrome, Wi-Fi and mobile data, photo
  batch and one > 300 MB video; verify playable files in Drive.

## Handoff

1. Build and test in the developer's account.
2. Share the Apps Script project with Dana; she creates a deployment as herself and accepts
   the permissions (guide covers the "unverified app" → Advanced → Go to project step).
3. Set her web app URL in `config.js` and redeploy the page (her folder is created on first upload).
4. Generate the final QR pointing to the guest page URL.
