import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYS,
  chordLabel,
  chordPitchClasses,
  diatonicColumn,
  noteNames,
  normalizeChord,
  spellPitchClass,
  tonicPitchClass,
} from '../js/music.js';

const labels = (key) => diatonicColumn(key).map((row) => row.label);

test('the right column is generated from the key', () => {
  assert.deepEqual(labels('C'), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'G7']);
  assert.deepEqual(labels('F'), ['F', 'Gm', 'Am', 'Bb', 'C', 'Dm', 'C7']);
  assert.deepEqual(labels('G'), ['G', 'Am', 'Bm', 'C', 'D', 'Em', 'D7']);
  assert.deepEqual(labels('Eb'), ['Eb', 'Fm', 'Gm', 'Ab', 'Bb', 'Cm', 'Bb7']);
});

test('spelling follows the circle of fifths', () => {
  assert.equal(chordLabel('C', { offset: 6, quality: 'maj' }), 'F#');
  assert.equal(chordLabel('C', { offset: 10, quality: 'dom7' }), 'Bb7');
  assert.equal(chordLabel('C', { offset: 8, quality: 'maj' }), 'Ab');
  assert.equal(chordLabel('D', { offset: 3, quality: 'maj' }), 'F');
  assert.equal(chordLabel('Bb', { offset: 6, quality: 'maj' }), 'E');
});

test('the key at six accidentals is F#, never Gb', () => {
  assert.ok(KEYS.includes('F#'));
  assert.ok(!KEYS.includes('Gb'));
  assert.equal(chordLabel('F#', { offset: 0, quality: 'maj' }), 'F#');
});

test('no key ever spells Cb, Fb, E# or B#', () => {
  for (const key of KEYS) {
    for (const name of noteNames(key)) {
      assert.ok(!['Cb', 'Fb', 'E#', 'B#'].includes(name), `${key} spells ${name}`);
    }
  }
});

test('each key names all twelve pitch classes exactly once', () => {
  for (const key of KEYS) {
    const names = noteNames(key);
    assert.equal(names.length, 12);
    assert.equal(new Set(names).size, 12, `${key} repeats a name`);
    names.forEach((_, offset) => {
      const expected = (tonicPitchClass(key) + offset) % 12;
      const chord = chordPitchClasses(key, { offset, quality: 'maj' });
      assert.equal(chord.rootPc, expected);
    });
  }
});

test('twelve keys, all selectable', () => {
  assert.equal(KEYS.length, 12);
  assert.equal(new Set(KEYS.map(tonicPitchClass)).size, 12);
});

test('transposing a stored slot relabels it and touches nothing', () => {
  const slot = Object.freeze({ offset: 11, quality: 'dom7' });
  assert.equal(chordLabel('C', slot), 'B7');
  assert.equal(chordLabel('F', slot), 'E7');
});

test('pitch classes are spelled for the key they appear in', () => {
  assert.equal(spellPitchClass('C', 10), 'Bb');
  assert.equal(spellPitchClass('E', 10), 'A#');
  assert.equal(spellPitchClass('E', 2), 'D');
  assert.equal(spellPitchClass('B', 6), 'F#');
});

test('normalizeChord rejects anything unusable', () => {
  assert.deepEqual(normalizeChord({ offset: 5, quality: 'min' }), { offset: 5, quality: 'min' });
  assert.equal(normalizeChord(null), null);
  assert.equal(normalizeChord({ offset: 12, quality: 'maj' }), null);
  assert.equal(normalizeChord({ offset: -1, quality: 'maj' }), null);
  assert.equal(normalizeChord({ offset: 1.5, quality: 'maj' }), null);
  assert.equal(normalizeChord({ offset: 3, quality: 'power' }), null);
  assert.equal(normalizeChord('C'), null);
});
