// Web Audio: one sample per string, playback-rate shifted for fretted notes,
// with one voice per string.
//
// Audio is always generated here, on the strings device. Nothing in this file
// waits on the network.
//
// The samples are plucked-string tones rendered once at startup rather than
// downloaded, so the app needs no audio assets and no server. From the mixer's
// point of view they are ordinary samples.

import { midiToFrequency } from './voicing.js';

const RETRIGGER_FADE = 0.012; // a ringing string is faded, never stacked
const PEAK = 0.85;

function decayTime(frequency) {
  const scaled = 4.0 * (110 / frequency) ** 0.35;
  return Math.min(4.5, Math.max(1.8, scaled));
}

/**
 * Renders one plucked note by Karplus-Strong: a burst of shaped noise fed
 * through a delay line one period long, losing a little energy each trip.
 */
function renderPluck(sampleRate, frequency) {
  const seconds = decayTime(frequency);
  const length = Math.floor(sampleRate * seconds * 1.15);
  const out = new Float32Array(length);

  // The averaging filter in the loop adds half a sample of delay; the read is
  // interpolated so the pitch lands on the note rather than the nearest sample.
  const period = sampleRate / frequency - 0.5;
  const wholeDelay = Math.max(2, Math.floor(period));
  const fraction = period - wholeDelay;
  const size = wholeDelay + 2;

  // Excitation: lowpassed noise, minus a copy of itself delayed by the pick
  // position, which notches out the harmonics a real pick would not excite.
  const noise = new Float32Array(size);
  let lowpass = 0;
  for (let i = 0; i < size; i += 1) {
    lowpass += (Math.random() * 2 - 1 - lowpass) * 0.55;
    noise[i] = lowpass;
  }
  const pickOffset = Math.max(1, Math.round(wholeDelay * 0.14));
  const line = new Float32Array(size);
  let excitationPeak = 0;
  for (let i = 0; i < size; i += 1) {
    line[i] = noise[i] - (i >= pickOffset ? noise[i - pickOffset] : 0);
    excitationPeak = Math.max(excitationPeak, Math.abs(line[i]));
  }
  if (excitationPeak > 0) {
    for (let i = 0; i < size; i += 1) line[i] /= excitationPeak;
  }

  // One trip round the loop is one period, so this is the per-period loss that
  // lands the note 60 dB down after `seconds`.
  const damping = 0.001 ** (1 / (frequency * seconds));

  let write = 0;
  let previous = 0;
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const near = line[(write - wholeDelay + size) % size];
    const far = line[(write - wholeDelay - 1 + size) % size];
    const delayed = near * (1 - fraction) + far * fraction;
    const value = 0.5 * (delayed + previous) * damping;
    previous = delayed;
    line[write] = value;
    write = (write + 1) % size;
    out[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  const gain = peak > 0 ? PEAK / peak : 0;
  const tail = Math.min(length, Math.floor(sampleRate * 0.08));
  for (let i = 0; i < length; i += 1) {
    const fade = i >= length - tail ? (length - i) / tail : 1;
    out[i] *= gain * fade;
  }
  return out;
}

export class StringAudio {
  constructor() {
    this.context = null;
    this.bus = null;
    this.instrument = null;
    this.buffers = [];
    this.voices = [];
    this.loading = null;
  }

  get ready() {
    return Boolean(this.context && this.buffers.length);
  }

  /**
   * Call from inside a user gesture, before anything else.
   * @returns {Promise<boolean>} whether there is a context to play through
   */
  async unlock() {
    if (!this.context) {
      // Safari 16.4+: keeps the hardware mute switch from silencing the
      // instrument.
      if ('audioSession' in navigator) {
        try {
          navigator.audioSession.type = 'playback';
        } catch {
          // not fatal; the app just respects the mute switch
        }
      }
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        this.context = new Context({ latencyHint: 'interactive' });
        this.#buildGraph();
      } catch {
        this.context = null;
        return false;
      }
    }
    if (this.context.state !== 'running') {
      try {
        await this.context.resume();
      } catch {
        // a later gesture will try again
      }
    }
    return true;
  }

  #buildGraph() {
    const { context } = this;

    const master = context.createGain();
    master.gain.value = 0.9;

    // Keeps six strings at once from clipping without audibly pumping.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.25;

    // Stands in for a soundbox: a little lift where the body resonates and a
    // little off the top so the samples do not sound brittle on a phone.
    const body = context.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 200;
    body.Q.value = 1.1;
    body.gain.value = 3;

    const air = context.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 5500;
    air.gain.value = -4;

    body.connect(air).connect(limiter).connect(master).connect(context.destination);
    // Voices feed the body filter, so it is both the input bus and the one node
    // that changes when the instrument does.
    this.bus = body;
  }

  /** Renders one sample per string. Safe to call again when the instrument changes. */
  async load(instrument) {
    if (!(await this.unlock())) throw new Error('Web Audio is unavailable here.');
    if (this.instrument && this.instrument.id === instrument.id && this.ready) return;

    this.stopAll();
    this.instrument = instrument;
    this.buffers = [];
    this.voices = instrument.tuning.map(() => null);
    this.bus.frequency.value = instrument.id === 'ukulele' ? 420 : 200;

    const { sampleRate } = this.context;
    const buffers = [];
    for (const openMidi of instrument.tuning) {
      const data = renderPluck(sampleRate, midiToFrequency(openMidi));
      const buffer = this.context.createBuffer(1, data.length, sampleRate);
      buffer.copyToChannel(data, 0);
      buffers.push(buffer);
      // Yield so a six-string render does not block the first paint.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (this.instrument === instrument) this.buffers = buffers;
  }

  /** Sounds one string at an absolute MIDI pitch, replacing whatever it was ringing. */
  pluck(stringIndex, midi) {
    if (!this.ready || !Number.isFinite(midi)) return;
    const buffer = this.buffers[stringIndex];
    if (!buffer) return;
    if (this.context.state !== 'running') this.context.resume();

    const now = this.context.currentTime;
    this.#release(stringIndex, now);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const semitones = midi - this.instrument.tuning[stringIndex];
    source.playbackRate.value = 2 ** (semitones / 12);

    const gain = this.context.createGain();
    // A touch of variation so repeated strums do not sound machine-stamped.
    gain.gain.value = 0.62 * (0.94 + Math.random() * 0.12);

    const panner = this.context.createStereoPanner
      ? this.context.createStereoPanner()
      : null;
    if (panner) {
      const spread = this.instrument.tuning.length - 1;
      panner.pan.value = spread > 0 ? (stringIndex / spread - 0.5) * 0.35 : 0;
      source.connect(gain).connect(panner).connect(this.bus);
    } else {
      source.connect(gain).connect(this.bus);
    }

    const voice = { source, gain };
    source.onended = () => {
      if (this.voices[stringIndex] === voice) this.voices[stringIndex] = null;
      try {
        gain.disconnect();
        panner?.disconnect();
      } catch {
        // already torn down
      }
    };
    source.start(now);
    this.voices[stringIndex] = voice;
  }

  #release(stringIndex, when) {
    const voice = this.voices[stringIndex];
    if (!voice) return;
    this.voices[stringIndex] = null;
    const level = voice.gain.gain;
    level.cancelScheduledValues(when);
    level.setValueAtTime(level.value, when);
    level.linearRampToValueAtTime(0, when + RETRIGGER_FADE);
    try {
      voice.source.stop(when + RETRIGGER_FADE + 0.02);
    } catch {
      // already stopped
    }
  }

  stopAll() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.voices.forEach((_, index) => this.#release(index, now));
  }
}
