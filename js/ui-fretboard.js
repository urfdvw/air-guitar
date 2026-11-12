// The fretboard grid, the lock, and the edit sheets.
//
// The layout is absolutely static: two columns, seven rows, no pagination, no
// reflow, no scrolling, and nothing moves when the key or a slot changes. The
// player is not expected to be looking at it.
//
// This device holds no state of its own. It sends an abstract chord and knows
// nothing about strings, tuning or voicing.

import {
  DIATONIC_ROWS,
  KEYS,
  QUALITIES,
  QUALITY_IDS,
  chordLabel,
  noteNames,
} from './music.js';

const LONG_PRESS_MS = 550;
const SLOT_COUNT = 7;

function button(className, text) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Cells are never `disabled`: a disabled button may swallow the pointerdown that
// starts a hold, and the grid has to hear every finger.
function setInert(cell, inert) {
  cell.classList.toggle('inert', inert);
  cell.setAttribute('aria-disabled', String(inert));
}

export class FretboardUI {
  /**
   * @param {object} options
   * @param {(chord: object|null) => void} options.onChord
   * @param {(edit: object) => void} options.onEdit
   */
  constructor({ root, onChord, onEdit }) {
    this.root = root;
    this.onChord = onChord;
    this.onEdit = onEdit;
    this.config = { key: 'C', customSlots: Array(SLOT_COUNT).fill(null) };
    this.editing = false;
    this.activeCell = null;
    // pointerId -> { cell, seq }. The held cell entered most recently wins;
    // when no finger is on a chord the instrument goes back to open strings.
    this.holds = new Map();
    this.holdSeq = 0;

    this.keyButton = root.querySelector('.key-name');
    this.lockButton = root.querySelector('.lock');
    this.grid = root.querySelector('.grid');
    this.sheet = root.querySelector('.sheet');
    this.toast = root.querySelector('.toast');

    // A root re-used from a previous session (the back button lets a role be
    // re-entered) may still carry state classes from before.
    root.classList.remove('editing', 'offline');
    this.keyButton.disabled = true;
    this.lockButton.setAttribute('aria-pressed', 'false');
    this.lockButton.textContent = '🔒';

    this.#buildGrid();
    this.#wireLock();
    this.keyButton.addEventListener('click', () => {
      if (this.editing) this.#openKeySheet();
    });
    this.sheet.addEventListener('click', (event) => {
      if (event.target === this.sheet) this.#closeSheet();
    });
  }

  #buildGrid() {
    this.grid.replaceChildren();
    this.customCells = [];
    this.diatonicCells = [];
    for (let row = 0; row < SLOT_COUNT; row += 1) {
      const custom = button('cell cell-custom');
      custom.dataset.slot = String(row);
      custom.dataset.column = 'custom';
      custom.dataset.row = String(row);
      this.grid.append(custom);
      this.customCells.push(custom);

      const diatonic = button('cell cell-diatonic');
      diatonic.dataset.column = 'diatonic';
      diatonic.dataset.row = String(row);
      this.grid.append(diatonic);
      this.diatonicCells.push(diatonic);
    }

    // Chords follow where fingers are held, not where they went down. One
    // listener on the grid reads coordinates, because a touch pointer stays
    // captured by the cell it first landed on and the cells it slides into
    // never hear it.
    this.grid.addEventListener('pointerdown', this.#onGridDown, { passive: false });
    this.grid.addEventListener('pointermove', this.#onGridMove, { passive: false });
    this.grid.addEventListener('pointerup', this.#onGridUp, { passive: false });
    this.grid.addEventListener('pointercancel', this.#onGridUp, { passive: false });
    this.grid.addEventListener('lostpointercapture', this.#onGridUp);
    this.grid.addEventListener('contextmenu', (event) => event.preventDefault());
    // Editing is a tap: the left column opens its sheet, the right is fixed.
    // On click rather than pointerdown, or the click that follows would land
    // on the freshly opened sheet's backdrop and close it again.
    this.grid.addEventListener('click', (event) => {
      if (!this.editing) return;
      const target = event.target.closest?.('.cell');
      if (target?.dataset.column === 'custom') this.#openSlotSheet(Number(target.dataset.row));
    });
  }

  #wireLock() {
    let timer = null;
    let fired = false;

    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };

    this.lockButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      fired = false;
      timer = setTimeout(() => {
        fired = true;
        this.#setEditing(true);
      }, LONG_PRESS_MS);
    });

    this.lockButton.addEventListener('pointerup', (event) => {
      event.preventDefault();
      cancel();
      if (fired) return;
      if (this.editing) this.#setEditing(false);
      else this.showToast('Hold the lock to edit');
    });

    this.lockButton.addEventListener('pointercancel', cancel);
    this.lockButton.addEventListener('pointerleave', cancel);
  }

  #setEditing(editing) {
    this.editing = editing;
    if (editing) this.releaseAll();
    this.root.classList.toggle('editing', editing);
    this.lockButton.setAttribute('aria-pressed', String(editing));
    this.lockButton.textContent = editing ? '🔓' : '🔒';
    this.keyButton.disabled = !editing;
    if (!editing) this.#closeSheet();
    this.render();
  }

  setConfig(config) {
    this.config = config;
    this.render();
  }

  setConnected(connected) {
    this.root.classList.toggle('offline', !connected);
  }

  render() {
    const { key, customSlots } = this.config;
    this.keyButton.textContent = key;

    this.diatonicCells.forEach((cell, row) => {
      const chord = DIATONIC_ROWS[row];
      cell.textContent = chordLabel(key, chord);
      setInert(cell, this.editing);
    });

    this.customCells.forEach((cell, row) => {
      const chord = customSlots[row];
      const empty = !chord;
      cell.classList.toggle('empty', empty);
      cell.textContent = empty ? 'Add chord' : chordLabel(key, chord);
      // Empty slots are inert placeholders until the lock is open.
      setInert(cell, empty && !this.editing);
    });

    // A held cell whose slot was just emptied can no longer sound.
    if (this.activeCell && !this.#chordFor(this.activeCell)) {
      for (const hold of this.holds.values()) {
        if (hold.cell === this.activeCell) hold.cell = null;
      }
      this.#resolveHold();
    }
    this.#paintActive();
  }

  #paintActive() {
    const cells = [...this.customCells, ...this.diatonicCells];
    cells.forEach((cell) => cell.classList.toggle('active', cell === this.activeCell));
  }

  /** The playable cell under a viewport point, or null for gaps and empty slots. */
  #cellAt(x, y) {
    const hit = document.elementFromPoint(x, y)?.closest?.('.cell');
    if (!hit || !this.grid.contains(hit)) return null;
    return this.#chordFor(hit) ? hit : null;
  }

  #chordFor(cell) {
    const row = Number(cell.dataset.row);
    if (cell.dataset.column === 'diatonic') return DIATONIC_ROWS[row];
    return this.config.customSlots[row] || null;
  }

  /** Re-derives the sounding chord from the fingers currently held. */
  #resolveHold() {
    let best = null;
    for (const hold of this.holds.values()) {
      if (hold.cell && (!best || hold.seq > best.seq)) best = hold;
    }
    const cell = best ? best.cell : null;
    if (cell === this.activeCell) return;
    this.activeCell = cell;
    this.#paintActive();
    this.onChord(cell ? this.#chordFor(cell) : null);
  }

  #onGridDown = (event) => {
    event.preventDefault();
    if (this.editing) return; // editing is a tap, handled on click
    const cell = this.#cellAt(event.clientX, event.clientY);
    this.holdSeq += 1;
    this.holds.set(event.pointerId, { cell, seq: this.holdSeq });
    this.#resolveHold();
  };

  #onGridMove = (event) => {
    const hold = this.holds.get(event.pointerId);
    if (!hold) return;
    event.preventDefault();
    const cell = this.#cellAt(event.clientX, event.clientY);
    // Sliding through a gap or off the grid keeps the last chord: only lifting
    // the finger lets go of it.
    if (!cell || cell === hold.cell) return;
    this.holdSeq += 1;
    hold.cell = cell;
    hold.seq = this.holdSeq;
    this.#resolveHold();
  };

  #onGridUp = (event) => {
    if (!this.holds.delete(event.pointerId)) return;
    this.#resolveHold();
  };

  /** Lets go of every held chord, e.g. when edit mode opens. */
  releaseAll() {
    if (!this.holds.size && !this.activeCell) return;
    this.holds.clear();
    this.#resolveHold();
  }

  // -- sheets ---------------------------------------------------------------

  #openSheet(title, body) {
    const panel = document.createElement('div');
    panel.className = 'sheet-panel';

    const heading = document.createElement('h2');
    heading.textContent = title;
    panel.append(heading, body);

    this.sheet.replaceChildren(panel);
    this.sheet.hidden = false;
  }

  #closeSheet() {
    this.sheet.hidden = true;
    this.sheet.replaceChildren();
  }

  #openKeySheet() {
    const list = document.createElement('div');
    list.className = 'sheet-keys';
    KEYS.forEach((key) => {
      const option = button('sheet-option', key);
      option.classList.toggle('chosen', key === this.config.key);
      option.addEventListener('click', () => {
        this.#closeSheet();
        if (key !== this.config.key) this.onEdit({ target: 'key', value: key });
      });
      list.append(option);
    });

    const footer = document.createElement('div');
    footer.className = 'sheet-actions';
    const cancel = button('sheet-button', 'Cancel');
    cancel.addEventListener('click', () => this.#closeSheet());
    footer.append(cancel);

    const body = document.createElement('div');
    body.append(list, footer);
    this.#openSheet('Key', body);
  }

  #openSlotSheet(index) {
    const current = this.config.customSlots[index];
    const draft = {
      offset: current ? current.offset : 0,
      quality: current ? current.quality : 'maj',
    };

    const preview = document.createElement('p');
    preview.className = 'sheet-preview';

    const notes = document.createElement('div');
    notes.className = 'sheet-keys';
    const noteButtons = noteNames(this.config.key).map((name, offset) => {
      const option = button('sheet-option', name);
      option.addEventListener('click', () => {
        draft.offset = offset;
        update();
      });
      notes.append(option);
      return option;
    });

    const qualities = document.createElement('div');
    qualities.className = 'sheet-qualities';
    const qualityButtons = QUALITY_IDS.map((id) => {
      const option = button('sheet-option', QUALITIES[id].name);
      option.addEventListener('click', () => {
        draft.quality = id;
        update();
      });
      qualities.append(option);
      return option;
    });

    const update = () => {
      preview.textContent = chordLabel(this.config.key, draft);
      noteButtons.forEach((option, offset) => {
        option.classList.toggle('chosen', offset === draft.offset);
      });
      qualityButtons.forEach((option, i) => {
        option.classList.toggle('chosen', QUALITY_IDS[i] === draft.quality);
      });
    };
    update();

    const footer = document.createElement('div');
    footer.className = 'sheet-actions';

    const cancel = button('sheet-button', 'Cancel');
    cancel.addEventListener('click', () => this.#closeSheet());

    const clear = button('sheet-button sheet-button-quiet', 'Clear slot');
    clear.disabled = !current;
    clear.addEventListener('click', () => {
      this.#closeSheet();
      if (this.activeCell === this.customCells[index]) {
        this.activeCell = null;
        this.#paintActive();
        this.onChord(null);
      }
      this.onEdit({ target: 'slot', index, value: null });
    });

    const save = button('sheet-button sheet-button-strong', 'Save');
    save.addEventListener('click', () => {
      this.#closeSheet();
      this.onEdit({ target: 'slot', index, value: { ...draft } });
    });

    footer.append(clear, cancel, save);

    const body = document.createElement('div');
    body.append(preview, notes, qualities, footer);
    this.#openSheet(`Slot ${index + 1}`, body);
  }

  // -- feedback -------------------------------------------------------------

  showToast(text) {
    this.toast.textContent = text;
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
    }, 1600);
  }

  showSaved() {
    this.showToast('Saved');
  }
}
