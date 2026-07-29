// All persistent state lives here, on the strings device. The fretboard device
// persists nothing.
//
// localStorage can be evicted under storage pressure, especially on iOS, which
// is why export and import exist.

import { SLOT_COUNT, isKey, normalizeChord } from './music.js';
import { isInstrument } from './voicing.js';

const STORAGE_KEY = 'air-guitar.config.v1';
const EXPORT_FORMAT = 'air-guitar.config';

// How much wider the first and last bands are than a middle band, in percent.
// Compensates for the OS gesture zones at the top and bottom edges.
export const ROW_WIDTH_MIN = 0;
export const ROW_WIDTH_MAX = 150;

export function defaultConfig() {
  return {
    key: 'C',
    customSlots: Array(SLOT_COUNT).fill(null),
    instrument: 'guitar',
    rowWidths: { first: 60, last: 60 },
  };
}

function clampWidth(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(ROW_WIDTH_MAX, Math.max(ROW_WIDTH_MIN, Math.round(number)));
}

/** Coerces anything - stored, imported, received - into a usable config. */
export function normalizeConfig(raw) {
  const config = defaultConfig();
  if (!raw || typeof raw !== 'object') return config;

  if (isKey(raw.key)) config.key = raw.key;
  if (isInstrument(raw.instrument)) config.instrument = raw.instrument;

  if (Array.isArray(raw.customSlots)) {
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      config.customSlots[i] = normalizeChord(raw.customSlots[i]);
    }
  }

  const widths = raw.rowWidths;
  if (widths && typeof widths === 'object') {
    config.rowWidths.first = clampWidth(widths.first, config.rowWidths.first);
    config.rowWidths.last = clampWidth(widths.last, config.rowWidths.last);
  }

  return config;
}

export function loadConfig() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    stored = null; // corrupt or unavailable; fall back to defaults
  }
  return normalizeConfig(stored);
}

export function saveConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false; // private mode, quota, eviction - the session still works
  }
}

/** The subset the fretboard is allowed to know about. */
export function configForFretboard(config) {
  return {
    key: config.key,
    customSlots: config.customSlots,
    instrument: config.instrument,
  };
}

/**
 * Applies an edit request from the fretboard.
 * @returns {{ok: boolean, config?: object, error?: string}}
 */
export function applyEdit(config, edit) {
  if (!edit || typeof edit !== 'object') return { ok: false, error: 'Unreadable edit.' };
  const next = { ...config, customSlots: config.customSlots.slice() };

  if (edit.target === 'key') {
    if (!isKey(edit.value)) return { ok: false, error: 'Unknown key.' };
    next.key = edit.value;
    return { ok: true, config: next };
  }

  if (edit.target === 'slot') {
    const index = Number(edit.index);
    if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) {
      return { ok: false, error: 'No such slot.' };
    }
    next.customSlots[index] = normalizeChord(edit.value);
    return { ok: true, config: next };
  }

  return { ok: false, error: 'Unknown edit.' };
}

export function exportToFile(config) {
  const payload = {
    format: EXPORT_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    ...config,
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'air-guitar-config.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importFromFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text); // caller reports the failure
  return normalizeConfig(parsed);
}
