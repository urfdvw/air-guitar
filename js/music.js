// Keys, chord qualities, note-name spelling, and the fixed diatonic column.
//
// A chord is { offset, quality } where offset is 0-11 semitones above the
// tonic. Offsets, not scale degrees: bIII, bVI, bVII and a Bb7 in C all fall
// out of one rule, and transposing is just relabelling.
//
// No DOM and no network in this file. See test/music.test.mjs.

export const QUALITIES = {
  maj: { suffix: '', name: 'Major', intervals: [0, 4, 7] },
  min: { suffix: 'm', name: 'Minor', intervals: [0, 3, 7] },
  dom7: { suffix: '7', name: 'Dominant 7th', intervals: [0, 4, 7, 10] },
};

export const QUALITY_IDS = Object.keys(QUALITIES);

// Chromatic order, using the canonical name for each key. At six accidentals
// the key is F#, never Gb.
export const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const KEY_PITCH_CLASS = {
  C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
};

// One row per key: the name for every offset 0-11 above that tonic.
//
// Diatonic offsets follow the key signature. Chromatic ones take the reading a
// player expects on a chord chart (b2, b3, #4, b6, b7), except where that would
// produce Cb, Fb, E# or B#, which are always respelled to the plain letter. A
// generated pitch-class-to-name map gets this wrong; the table does not.
const SPELLING = {
  C: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  Db: ['Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', 'C'],
  D: ['D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B', 'C', 'C#'],
  Eb: ['Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'Db', 'D'],
  E: ['E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C', 'C#', 'D', 'D#'],
  F: ['F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E'],
  'F#': ['F#', 'G', 'G#', 'A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F'],
  G: ['G', 'Ab', 'A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#'],
  Ab: ['Ab', 'A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G'],
  A: ['A', 'Bb', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'],
  Bb: ['Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A'],
  B: ['B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#'],
};

// Rows 1-6 are the diatonic triads, row 7 the dominant seventh. Generated from
// the key, so in F this column reads F, Gm, Am, Bb, C, Dm, C7.
export const DIATONIC_ROWS = [
  { offset: 0, quality: 'maj' },
  { offset: 2, quality: 'min' },
  { offset: 4, quality: 'min' },
  { offset: 5, quality: 'maj' },
  { offset: 7, quality: 'maj' },
  { offset: 9, quality: 'min' },
  { offset: 7, quality: 'dom7' },
];

export const SLOT_COUNT = 7;

export function isKey(key) {
  return Object.prototype.hasOwnProperty.call(SPELLING, key);
}

export function tonicPitchClass(key) {
  return KEY_PITCH_CLASS[key];
}

/** Name of the note `offset` semitones above the tonic, spelled for the key. */
export function spellOffset(key, offset) {
  return SPELLING[key][((offset % 12) + 12) % 12];
}

/** Every note name available in a key, indexed by offset above the tonic. */
export function noteNames(key) {
  return SPELLING[key].slice();
}

/** Name of an absolute pitch class, spelled for the key. */
export function spellPitchClass(key, pitchClass) {
  const offset = (((pitchClass - tonicPitchClass(key)) % 12) + 12) % 12;
  return spellOffset(key, offset);
}

/** Display label for a chord, e.g. "Bb7". Always a note name, never a degree. */
export function chordLabel(key, chord) {
  if (!chord) return '';
  return spellOffset(key, chord.offset) + QUALITIES[chord.quality].suffix;
}

/** The pitch classes a chord is built from, plus its root, in absolute terms. */
export function chordPitchClasses(key, chord) {
  const rootPc = (tonicPitchClass(key) + chord.offset) % 12;
  const pitchClasses = QUALITIES[chord.quality].intervals.map((i) => (rootPc + i) % 12);
  return { rootPc, pitchClasses };
}

/** The seven fixed right-column chords for a key. */
export function diatonicColumn(key) {
  return DIATONIC_ROWS.map((chord) => ({ chord, label: chordLabel(key, chord) }));
}

/** Returns a clean { offset, quality } or null. Used on anything stored or received. */
export function normalizeChord(value) {
  if (!value || typeof value !== 'object') return null;
  const offset = Number(value.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 11) return null;
  if (!Object.prototype.hasOwnProperty.call(QUALITIES, value.quality)) return null;
  return { offset, quality: value.quality };
}
