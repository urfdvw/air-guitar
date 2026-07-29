// Tunings and the string-pitch algorithm. There is no chord-shape table:
// voicings are computed, and the standard open shapes fall out of the rule.
//
// Rule: each string plays the lowest pitch at or above its open pitch that is
// a member of the chord.
//
// Exception: on an instrument with a bass string, that string plays the lowest
// pitch at or above its open pitch that is the root.
//
// `rootStringIndex` is what carries the exception. The guitar's lowest-pitched
// string is also its outermost, so it is a bass string and takes the exception
// (this is why C comes out 8 3 2 0 1 0 rather than sounding an E in the bass).
// The ukulele is reentrant, so its lowest-pitched string sits in the middle of
// the layout and is not a bass string; it takes no exception, which is what
// makes F and G come out as the standard 2 0 1 0 and 0 2 3 2.
//
// All strings always sound. There is no muting and no x.
//
// No DOM and no network in this file. See test/voicing.test.mjs.

export const INSTRUMENTS = {
  guitar: {
    id: 'guitar',
    name: 'Guitar',
    // E2 A2 D3 G3 B3 E4, low to high, in layout order.
    tuning: [40, 45, 50, 55, 59, 64],
    rootStringIndex: 0,
  },
  ukulele: {
    id: 'ukulele',
    name: 'Ukulele',
    // G4 C4 E4 A4 - reentrant, so the first string is the highest pitched and
    // the lowest-pitched string (C4) is second in layout order.
    tuning: [67, 60, 64, 69],
    rootStringIndex: null,
  },
};

export const INSTRUMENT_IDS = Object.keys(INSTRUMENTS);

// A triad's largest adjacent interval is 5 semitones, so every string resolves
// well inside this. The ceiling only exists so the search terminates.
export const MAX_REACH = 12;

export function isInstrument(id) {
  return Object.prototype.hasOwnProperty.call(INSTRUMENTS, id);
}

export function getInstrument(id) {
  return INSTRUMENTS[isInstrument(id) ? id : 'guitar'];
}

function lowestAtOrAbove(openPitch, pitchClasses) {
  for (let fret = 0; fret <= MAX_REACH; fret += 1) {
    if (pitchClasses.includes((openPitch + fret) % 12)) return openPitch + fret;
  }
  return openPitch; // unreachable for the supported qualities
}

/**
 * MIDI note for every string, in layout order.
 * @param {object} instrument one of INSTRUMENTS
 * @param {{rootPc: number, pitchClasses: number[]}} chord absolute pitch classes
 */
export function voiceChord(instrument, chord) {
  const { rootStringIndex } = instrument;
  return instrument.tuning.map((openPitch, index) => {
    const allowed = index === rootStringIndex ? [chord.rootPc] : chord.pitchClasses;
    return lowestAtOrAbove(openPitch, allowed);
  });
}

/** Fret number per string, for tests and for display. */
export function fretsFor(instrument, chord) {
  return voiceChord(instrument, chord).map((pitch, i) => pitch - instrument.tuning[i]);
}

/** What sounds when no chord has been chosen yet. */
export function openStrings(instrument) {
  return instrument.tuning.slice();
}

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}
