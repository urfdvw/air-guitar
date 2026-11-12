// How a strum is triggered, on the Android app.
//
// Three ways, picked in settings:
//   touch   - the screen, as in the browser: bands on the strings device, the
//             strum button standalone. Full volume, as it has always been.
//   force   - one big button. How hard it is hit, read off the accelerometer,
//             sets the volume.
//   scratch - a fingernail or pick scraped across the phone's edge. The
//             accelerometer hears the bump; each one is a strum, louder the
//             harder it was.
//
// force and scratch need the native accelerometer, so the browser only ever
// gets touch. Detection for scratch runs natively at sensor rate; this file
// turns hits into strums and owns the settings.

import { isNative, log, native, onNativeEvent } from './native.js';

export const MODES = ['touch', 'force', 'scratch'];

const STORAGE_KEY = 'air-guitar.strum-input.v1';

/** Every tunable, with its range. Units are in the labels. */
export const FIELDS = {
  tapMin: { label: 'Soft tap', unit: 'm/s²', min: 0, max: 20, step: 0.1, value: 0.6 },
  tapMax: { label: 'Hard tap', unit: 'm/s²', min: 0.5, max: 40, step: 0.5, value: 8 },
  tapDelayMs: { label: 'Wait for the bump', unit: 'ms', min: 0, max: 60, step: 1, value: 18 },
  tapWindowMs: { label: 'Look back', unit: 'ms', min: 10, max: 150, step: 5, value: 60 },
  scratchThreshold: { label: 'Trigger level', unit: 'm/s²', min: 0.1, max: 20, step: 0.1, value: 1.5 },
  scratchMax: { label: 'Loudest at', unit: 'm/s²', min: 0.5, max: 40, step: 0.5, value: 10 },
  scratchRefractoryMs: { label: 'Gap between strums', unit: 'ms', min: 20, max: 400, step: 5, value: 90 },
  scratchPeakWindowMs: { label: 'Measure for', unit: 'ms', min: 0, max: 30, step: 1, value: 4 },
  touchSuppressMs: { label: 'Ignore after a screen touch', unit: 'ms', min: 0, max: 300, step: 5, value: 80 },
  spreadMs: { label: 'Strum spread', unit: 'ms/string', min: 0, max: 40, step: 1, value: 8 },
};

export function defaultSettings() {
  const settings = { mode: 'touch', detectDirection: true, flipDirection: false };
  Object.entries(FIELDS).forEach(([key, field]) => {
    settings[key] = field.value;
  });
  return settings;
}

export function normalizeSettings(raw) {
  const settings = defaultSettings();
  if (!raw || typeof raw !== 'object') return settings;
  if (MODES.includes(raw.mode)) settings.mode = raw.mode;
  if (typeof raw.detectDirection === 'boolean') settings.detectDirection = raw.detectDirection;
  if (typeof raw.flipDirection === 'boolean') settings.flipDirection = raw.flipDirection;
  Object.entries(FIELDS).forEach(([key, field]) => {
    const number = Number(raw[key]);
    if (Number.isFinite(number)) settings[key] = Math.min(field.max, Math.max(field.min, number));
  });
  return settings;
}

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage full or blocked; the settings still apply until the app closes
  }
}

const QUIETEST = 0.15;

/** Maps a strength between `low` and `high` onto a 0..1 velocity. */
export function velocityFor(strength, low, high) {
  if (!Number.isFinite(strength)) return 0.8;
  const span = Math.max(0.01, high - low);
  const norm = Math.min(1, Math.max(0, (strength - low) / span));
  return QUIETEST + (1 - QUIETEST) * norm ** 0.8;
}

export class StrumInput {
  /**
   * @param {object} options
   * @param {import('./audio.js').StringAudio} options.audio
   * @param {() => number[]} options.getPitches current pitch per string
   * @param {(mode: string) => void} [options.onModeChange]
   * @param {() => void} [options.onStrum] called after every strum, for a visual flash
   */
  constructor({ audio, getPitches, onModeChange, onStrum }) {
    this.audio = audio;
    this.getPitches = getPitches;
    this.onModeChange = onModeChange ?? (() => {});
    this.onStrum = onStrum ?? (() => {});
    this.settings = isNative ? loadSettings() : defaultSettings();
    this.meterWanted = false;
    this.lastHit = null;

    if (!isNative) {
      this.settings.mode = 'touch';
      return;
    }

    this.unsubscribe = onNativeEvent((event) => this.#onNative(event));
    // Every touch anywhere is a bump the scratch detector must not mistake for
    // a strum: holding a chord means pressing the screen.
    this.onAnyTouch = () => native.noteTouch();
    document.addEventListener('pointerdown', this.onAnyTouch, { capture: true, passive: true });

    const info = native.deviceInfo();
    if (info) log(`device ${JSON.stringify(info)}`);
    this.#push();
  }

  get mode() {
    return this.settings.mode;
  }

  update(patch) {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    saveSettings(this.settings);
    this.#push();
    if ('mode' in patch) {
      log(`strum input mode -> ${this.settings.mode}`);
      this.onModeChange(this.settings.mode);
    }
  }

  /** The live meter in settings needs the sensor even in touch mode. */
  setMeterWanted(wanted) {
    if (this.meterWanted === wanted) return;
    this.meterWanted = wanted;
    this.#pushActive();
  }

  #push() {
    if (!isNative) return;
    const s = this.settings;
    native.configure({
      scratch: s.mode === 'scratch',
      threshold: s.scratchThreshold,
      refractoryMs: s.scratchRefractoryMs,
      peakWindowMs: s.scratchPeakWindowMs,
      touchSuppressMs: s.touchSuppressMs,
    });
    this.#pushActive();
  }

  #pushActive() {
    native.setSensorActive(this.settings.mode !== 'touch' || this.meterWanted);
  }

  /** A touch strum: full volume, all strings together, as the browser does it. */
  touchStrum() {
    this.audio.strum(this.getPitches(), { velocity: 1, direction: 'down', spread: 0 });
    this.onStrum();
  }

  /**
   * The force button went down. The bump of the finger reaches the
   * accelerometer around the same moment the touch does, so wait a few ms for
   * it to land, then take the strongest reading of the last stretch.
   */
  forcePress() {
    const s = this.settings;
    const pressedAt = performance.now();
    setTimeout(() => {
      const reading = native.peakSince(s.tapWindowMs + s.tapDelayMs);
      const peak = reading ? Number(reading.peak) : NaN;
      const velocity = velocityFor(peak, s.tapMin, s.tapMax);
      this.audio.strum(this.getPitches(), { velocity, direction: 'down', spread: s.spreadMs / 1000 });
      this.onStrum();
      this.lastHit = { kind: 'force', strength: peak, velocity };
      log(
        `force press peak=${fmt(peak)} vel=${velocity.toFixed(2)} samples=${reading?.samples ?? '?'} ` +
          `rate=${fmt(reading?.rate)} latency=${(performance.now() - pressedAt).toFixed(1)}ms`,
      );
    }, s.tapDelayMs);
  }

  #onNative(event) {
    if (event?.type !== 'hit' || this.settings.mode !== 'scratch') return;
    const s = this.settings;
    const strength = Number(event.strength);
    const velocity = velocityFor(strength, s.scratchThreshold, s.scratchMax);

    let direction = 'down';
    let directionNote = 'fixed';
    if (s.detectDirection) {
      // Scraping along the long edge pushes the phone along its long (y) axis.
      // Only trust the sign when that axis carries most of the bump.
      const along = Number(event.hy);
      if (Number.isFinite(along) && Math.abs(along) >= 0.6 * strength) {
        direction = along > 0 ? 'down' : 'up';
        if (s.flipDirection) direction = direction === 'down' ? 'up' : 'down';
        directionNote = 'detected';
      } else {
        directionNote = 'ambiguous';
      }
    }

    this.audio.strum(this.getPitches(), { velocity, direction, spread: s.spreadMs / 1000 });
    this.onStrum();
    this.lastHit = { kind: 'scratch', strength, velocity, direction };
    log(
      `scratch hit strength=${fmt(strength)} h=(${fmt(event.hx)},${fmt(event.hy)},${fmt(event.hz)}) ` +
        `vel=${velocity.toFixed(2)} dir=${direction}(${directionNote}) ` +
        `age=${fmt(event.ageMs)}ms`,
    );
  }

  destroy() {
    if (!isNative) return;
    this.unsubscribe?.();
    document.removeEventListener('pointerdown', this.onAnyTouch, { capture: true });
    native.setSensorActive(false);
  }
}

function fmt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '–';
}

// -- settings panel -------------------------------------------------------------

const MODE_LABELS = {
  touch: ['Touch', 'Tap or swipe the screen.'],
  force: ['Force button', 'One big button. Hit harder for louder.'],
  scratch: ['Edge scratch', 'Scrape a nail or pick across the phone’s edge.'],
};

const GROUPS = [
  { title: 'Force button', modes: ['force'], fields: ['tapMin', 'tapMax', 'tapDelayMs', 'tapWindowMs'] },
  {
    title: 'Edge scratch',
    modes: ['scratch'],
    fields: ['scratchThreshold', 'scratchMax', 'scratchRefractoryMs', 'scratchPeakWindowMs', 'touchSuppressMs'],
  },
  { title: 'Strum', modes: ['force', 'scratch'], fields: ['spreadMs'] },
];

/**
 * Fills `container` with the strum-input settings. Only meaningful on Android;
 * in a browser the container stays hidden.
 * @returns {() => void} teardown
 */
export function buildStrumSettings(container, input, { radioName }) {
  if (!isNative) {
    container.hidden = true;
    return () => {};
  }
  container.hidden = false;
  container.replaceChildren();

  const heading = document.createElement('h2');
  heading.textContent = 'Strum input';
  container.append(heading);

  const modes = document.createElement('div');
  modes.className = 'mode-list';
  MODES.forEach((mode) => {
    const label = document.createElement('label');
    label.className = 'radio radio-block';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioName;
    radio.value = mode;
    radio.checked = input.mode === mode;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        input.update({ mode });
        syncGroups();
      }
    });
    const text = document.createElement('span');
    const [name, note] = MODE_LABELS[mode];
    text.innerHTML = `<b></b><small></small>`;
    text.querySelector('b').textContent = name;
    text.querySelector('small').textContent = note;
    label.append(radio, text);
    modes.append(label);
  });
  container.append(modes);

  const groupElements = GROUPS.map((group) => {
    const box = document.createElement('div');
    box.className = 'tuning-group';
    const title = document.createElement('h3');
    title.textContent = group.title;
    box.append(title);
    group.fields.forEach((key) => box.append(slider(key, input)));
    if (group.title === 'Edge scratch') {
      box.append(
        checkbox('Detect up / down', 'detectDirection', input),
        checkbox('Flip up / down', 'flipDirection', input),
      );
    }
    container.append(box);
    return { group, box };
  });

  const syncGroups = () => {
    groupElements.forEach(({ group, box }) => {
      box.hidden = !group.modes.includes(input.mode);
    });
  };
  syncGroups();

  // Live meter: the number to set the levels against.
  const meter = document.createElement('p');
  meter.className = 'sensor-meter';
  meter.textContent = 'Sensor: –';
  container.append(meter);

  const tools = document.createElement('div');
  tools.className = 'button-row';
  const trace = document.createElement('button');
  trace.type = 'button';
  trace.className = 'button';
  trace.textContent = 'Record 10 s';
  trace.addEventListener('click', () => {
    native.recordTrace(10);
    trace.disabled = true;
    trace.textContent = 'Recording…';
  });
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'button';
  share.textContent = 'Export log';
  share.addEventListener('click', () => native.exportLogs());
  tools.append(trace, share);
  container.append(tools);

  const unsubscribe = onNativeEvent((event) => {
    if (event?.type === 'trace') {
      trace.disabled = false;
      trace.textContent = 'Record 10 s';
      meter.dataset.note = event.ok ? 'Recording saved. Export log to send it.' : 'Recording failed.';
    }
  });

  let shownPeak = 0;
  const timer = setInterval(() => {
    // offsetParent is null while the panel (or a screen around it) is hidden.
    const visible = container.offsetParent !== null;
    input.setMeterWanted(visible);
    if (!visible) return;
    const reading = native.meter();
    if (!reading) return;
    shownPeak = Math.max(Number(reading.peak) || 0, shownPeak * 0.8);
    const last = input.lastHit
      ? ` · last ${input.lastHit.kind} ${fmt(input.lastHit.strength)} → ${Math.round(input.lastHit.velocity * 100)}%`
      : '';
    meter.textContent =
      `Sensor ${Math.round(reading.rate || 0)} Hz · now ${fmt(shownPeak)} m/s²${last}` +
      (meter.dataset.note ? `\n${meter.dataset.note}` : '');
  }, 120);

  return () => {
    clearInterval(timer);
    unsubscribe();
    input.setMeterWanted(false);
  };
}

function slider(key, input) {
  const field = FIELDS[key];
  const label = document.createElement('label');
  label.className = 'slider';
  const caption = document.createElement('span');
  caption.className = 'slider-label';
  const output = document.createElement('output');
  const show = () => {
    output.textContent = `${input.settings[key]} ${field.unit}`;
  };
  caption.append(`${field.label} `, output);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(field.min);
  range.max = String(field.max);
  range.step = String(field.step);
  range.value = String(input.settings[key]);
  range.addEventListener('input', () => {
    input.update({ [key]: Number(range.value) });
    show();
  });
  show();
  label.append(caption, range);
  return label;
}

function checkbox(text, key, input) {
  const label = document.createElement('label');
  label.className = 'radio';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(input.settings[key]);
  box.addEventListener('change', () => input.update({ [key]: box.checked }));
  const span = document.createElement('span');
  span.textContent = text;
  label.append(box, span);
  return label;
}
