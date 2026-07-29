import test from 'node:test';
import assert from 'node:assert/strict';

import { chordPitchClasses } from '../js/music.js';
import { INSTRUMENTS, fretsFor, voiceChord } from '../js/voicing.js';

const frets = (instrumentId, key, chord) =>
  fretsFor(INSTRUMENTS[instrumentId], chordPitchClasses(key, chord));

const maj = (offset) => ({ offset, quality: 'maj' });
const min = (offset) => ({ offset, quality: 'min' });
const dom7 = (offset) => ({ offset, quality: 'dom7' });

test('the six verification voicings from the spec', () => {
  assert.deepEqual(frets('guitar', 'C', maj(0)), [8, 3, 2, 0, 1, 0], 'guitar C');
  assert.deepEqual(frets('guitar', 'G', maj(0)), [3, 2, 0, 0, 0, 3], 'guitar G');
  assert.deepEqual(frets('guitar', 'G', dom7(0)), [3, 2, 0, 0, 0, 1], 'guitar G7');
  assert.deepEqual(frets('ukulele', 'C', maj(0)), [0, 0, 0, 3], 'ukulele C');
  assert.deepEqual(frets('ukulele', 'F', maj(0)), [2, 0, 1, 0], 'ukulele F');
  assert.deepEqual(frets('ukulele', 'G', maj(0)), [0, 2, 3, 2], 'ukulele G');
});

test('the same chord voices identically whatever key names it', () => {
  // G major as I in G, as V in C, and as bII in F#.
  const asTonic = frets('guitar', 'G', maj(0));
  const asDominant = frets('guitar', 'C', maj(7));
  const asFlatTwo = frets('guitar', 'F#', maj(1));
  assert.deepEqual(asDominant, asTonic);
  assert.deepEqual(asFlatTwo, asTonic);
});

test('the guitar sixth string always plays the root', () => {
  for (let offset = 0; offset < 12; offset += 1) {
    for (const quality of ['maj', 'min', 'dom7']) {
      const chord = chordPitchClasses('C', { offset, quality });
      const pitches = voiceChord(INSTRUMENTS.guitar, chord);
      assert.equal(pitches[0] % 12, chord.rootPc, `offset ${offset} ${quality}`);
    }
  }
});

test('known behaviour: guitar D sounds as D/A, and that is fine', () => {
  // The low E reaches D at fret 10 (D3 = 50), above the open A string (45), so
  // the root is on the sixth string but is not the lowest sounding pitch.
  const pitches = voiceChord(INSTRUMENTS.guitar, chordPitchClasses('C', maj(2)));
  assert.deepEqual(pitches, [50, 45, 50, 57, 62, 66]);
  assert.equal(Math.min(...pitches), 45, 'the bass note is A');
});

test('every string sounds, at or above its open pitch, within reach', () => {
  for (const instrument of Object.values(INSTRUMENTS)) {
    for (let offset = 0; offset < 12; offset += 1) {
      for (const quality of ['maj', 'min', 'dom7']) {
        const chord = chordPitchClasses('C', { offset, quality });
        const fretted = fretsFor(instrument, chord);
        assert.equal(fretted.length, instrument.tuning.length);
        fretted.forEach((fret, index) => {
          // A triad's largest adjacent interval is 5, so chord tones always
          // resolve within 5. Only the root exception can reach further.
          const limit = index === instrument.rootStringIndex ? 11 : 5;
          const where = `${instrument.id} ${offset} ${quality} string ${index}`;
          assert.ok(fret >= 0 && fret <= limit, `${where}: ${fret}`);
        });
      }
    }
  }
});

test('every sounding pitch belongs to the chord', () => {
  for (const instrument of Object.values(INSTRUMENTS)) {
    for (let offset = 0; offset < 12; offset += 1) {
      for (const quality of ['maj', 'min', 'dom7']) {
        const chord = chordPitchClasses('C', { offset, quality });
        for (const pitch of voiceChord(instrument, chord)) {
          assert.ok(chord.pitchClasses.includes(pitch % 12));
        }
      }
    }
  }
});

test('minor and seventh shapes', () => {
  // Em, ukulele Am and ukulele G7 are the standard shapes. Guitar Am differs
  // from the familiar x02210 exactly as guitar C does: the string a human mutes
  // plays the root instead.
  assert.deepEqual(frets('guitar', 'C', min(4)), [0, 2, 2, 0, 0, 0], 'guitar Em');
  assert.deepEqual(frets('guitar', 'C', min(9)), [5, 0, 2, 2, 1, 0], 'guitar Am');
  assert.deepEqual(frets('ukulele', 'C', min(9)), [2, 0, 0, 0], 'ukulele Am');
  assert.deepEqual(frets('ukulele', 'C', dom7(7)), [0, 2, 1, 2], 'ukulele G7');
});
