export const GUEST_STORAGE_KEY = 'guest';
export const ANONYMOUS_LABEL = 'Anónimo';

// True when the guest may continue: anonymous, or a non-blank name.
export function canContinue({ name, anonymous }) {
  return anonymous === true || String(name ?? '').trim() !== '';
}

// The guestName sent to the server: '' when anonymous, otherwise the trimmed name.
export function resolveGuestName({ name, anonymous }) {
  return anonymous ? '' : String(name ?? '').trim();
}

// Text shown in "Subiendo como …".
export function displayGuestName({ name, anonymous }) {
  return anonymous ? ANONYMOUS_LABEL : String(name ?? '').trim();
}

// Parses stored JSON into { name, anonymous } or null when missing/corrupt/invalid.
export function parseGuest(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data.name !== 'string' || typeof data.anonymous !== 'boolean') return null;
  const guest = { name: data.name.trim(), anonymous: data.anonymous };
  if (guest.anonymous) guest.name = '';
  return canContinue(guest) ? guest : null;
}

export function serializeGuest({ name, anonymous }) {
  return JSON.stringify({ name: anonymous ? '' : String(name ?? '').trim(), anonymous: Boolean(anonymous) });
}
