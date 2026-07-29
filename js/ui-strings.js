// The playing surface: band geometry and pointer handling.
//
// Bands are not separate listeners. A touch pointer is implicitly captured by
// whatever element received pointerdown, so pointermove never fires on the
// elements a finger slides into. One full-screen container reads clientY and
// works out band membership from coordinates instead.
//
// Fast swipes then produce tight strums and slow ones spread arpeggios with no
// velocity model, direction falls out of crossing order, and a tap is just the
// degenerate case of one band and no movement.

const FLASH_MS = 220;

export class StringsSurface {
  /**
   * @param {object} options
   * @param {HTMLElement} options.surface full-screen container that hears every pointer
   * @param {HTMLElement} options.bands   element the band divs live in
   * @param {(stringIndex: number) => void} options.onPluck
   */
  constructor({ surface, bands, onPluck }) {
    this.surface = surface;
    this.bandsElement = bands;
    this.onPluck = onPluck;
    this.bandElements = [];
    this.boundaries = [];
    this.pointers = new Map(); // pointerId -> last band index, or null
    this.instrument = null;

    surface.addEventListener('pointerdown', this.#onDown, { passive: false });
    surface.addEventListener('pointermove', this.#onMove, { passive: false });
    surface.addEventListener('pointerup', this.#onUp, { passive: false });
    surface.addEventListener('pointercancel', this.#onUp, { passive: false });
    surface.addEventListener('contextmenu', (event) => event.preventDefault());

    this.#observeGeometry();
  }

  #observeGeometry() {
    const remeasure = () => this.measure();
    if ('ResizeObserver' in window) {
      new ResizeObserver(remeasure).observe(this.bandsElement);
    }
    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);
    window.visualViewport?.addEventListener('resize', remeasure);
  }

  /** Rebuilds the bands. Band 1 is at the top and maps to string 1. */
  setInstrument(instrument) {
    this.instrument = instrument;
    this.bandsElement.replaceChildren();

    // Gauge is spread across whatever range this instrument actually covers, so
    // the ukulele's reentrant top string reads as the light one it is.
    const lowest = Math.min(...instrument.tuning);
    const span = Math.max(1, Math.max(...instrument.tuning) - lowest);

    this.bandElements = instrument.tuning.map((openMidi, index) => {
      const band = document.createElement('div');
      band.className = 'band';
      band.dataset.index = String(index);

      const wire = document.createElement('div');
      wire.className = 'band-wire';
      const weight = 1 - (openMidi - lowest) / span;
      wire.style.setProperty('--wire', `${(2.2 + weight * 6).toFixed(2)}px`);

      const label = document.createElement('span');
      label.className = 'band-label';

      band.append(wire, label);
      this.bandsElement.append(band);
      return { band, label };
    });
    this.pointers.clear();
    this.measure();
  }

  /** How much wider the first and last bands are than a middle one, in percent. */
  setRowWidths({ first, last }) {
    this.bandsElement.style.setProperty('--first-band', String(1 + first / 100));
    this.bandsElement.style.setProperty('--last-band', String(1 + last / 100));
    this.measure();
  }

  /** @param {{name: string, fret: number}[]} entries one per string, in layout order */
  setVoicing(entries) {
    this.bandElements.forEach(({ label }, index) => {
      const entry = entries[index];
      if (!entry) return;
      label.textContent = entry.fret === 0 ? entry.name : `${entry.name} · ${entry.fret}`;
    });
  }

  measure() {
    if (!this.bandElements.length) return;
    const rects = this.bandElements.map(({ band }) => band.getBoundingClientRect());
    this.boundaries = [rects[0].top, ...rects.map((rect) => rect.bottom)];
  }

  /** Band containing a viewport y, or null for the dead margins at the edges. */
  bandAt(y) {
    const edges = this.boundaries;
    if (edges.length < 2 || y < edges[0] || y >= edges[edges.length - 1]) return null;
    for (let i = 0; i < edges.length - 1; i += 1) {
      if (y < edges[i + 1]) return i;
    }
    return null;
  }

  #pluck(index) {
    this.onPluck(index);
    const entry = this.bandElements[index];
    if (!entry) return;
    entry.band.classList.remove('lit');
    void entry.band.offsetWidth; // restart the flash even mid-animation
    entry.band.classList.add('lit');
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => entry.band.classList.remove('lit'), FLASH_MS);
  }

  #onDown = (event) => {
    // Controls layered over the surface keep their own taps.
    if (event.target.closest('[data-ui-control]')) return;
    event.preventDefault();

    const index = this.bandAt(event.clientY);
    this.pointers.set(event.pointerId, index);
    if (index !== null) this.#pluck(index);
  };

  #onMove = (event) => {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();

    // Coalesced events keep the crossing order of a fast swipe intact. Some
    // browsers hand back an empty list, so the event itself is the fallback.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length ? coalesced : [event];
    let previous = this.pointers.get(event.pointerId);

    for (const sample of samples) {
      const index = this.bandAt(sample.clientY);
      if (index === null) {
        previous = null; // out in a dead margin
        continue;
      }
      if (index === previous) continue;

      if (previous === null) {
        this.#pluck(index); // entered the surface from a dead margin
      } else {
        // Pluck every band crossed since the last sample, in crossing order.
        const step = index > previous ? 1 : -1;
        for (let i = previous + step; ; i += step) {
          this.#pluck(i);
          if (i === index) break;
        }
      }
      previous = index;
    }

    this.pointers.set(event.pointerId, previous);
  };

  #onUp = (event) => {
    this.pointers.delete(event.pointerId);
  };
}
