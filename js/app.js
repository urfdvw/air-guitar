// Role select and boot. Everything below the role choice is one of two apps
// that never overlap: the strings device, which owns all state and all sound,
// and the fretboard, which is a remote control.

import { StringAudio } from './audio.js';
import {
  MSG,
  codeFromPeerId,
  createGuest,
  createHost,
  describeCameraError,
  parseCode,
  renderQr,
  startScanner,
} from './connection.js';
import { chordLabel, chordPitchClasses, normalizeChord, spellPitchClass } from './music.js';
import * as storage from './storage.js';
import { FretboardUI } from './ui-fretboard.js';
import { StringsSurface } from './ui-strings.js';
import { fretsFor, getInstrument, openStrings, voiceChord } from './voicing.js';

const $ = (id) => document.getElementById(id);

const screens = {
  role: $('screen-role'),
  stringsSetup: $('screen-strings-setup'),
  stringsPlay: $('screen-strings-play'),
  fretboardScan: $('screen-fretboard-scan'),
  fretboardPlay: $('screen-fretboard-play'),
};

function show(name) {
  Object.entries(screens).forEach(([key, element]) => {
    element.hidden = key !== name;
  });
}

// -- screen wake lock ---------------------------------------------------------
// The screen going dark mid-song is worse than any wrong note.

let wakeLock = null;
let wantWakeLock = false;

async function acquireWakeLock() {
  if (wakeLock || !wantWakeLock) return;
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // denied or interrupted; visibilitychange will retry
  }
}

function keepScreenAwake() {
  wantWakeLock = true;
  acquireWakeLock();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
});

// -- strings device -----------------------------------------------------------

function startStrings(audio) {
  let config = storage.loadConfig();
  let activeChord = null;
  let pitches = [];
  let host = null;

  const surface = new StringsSurface({
    surface: $('strings-surface'),
    bands: $('strings-bands'),
    onPluck: (index) => audio.pluck(index, pitches[index]),
  });

  const persist = () => storage.saveConfig(config);

  const pushConfig = () => host?.send(MSG.CONFIG, storage.configForFretboard(config));

  const applyVoicing = () => {
    const instrument = getInstrument(config.instrument);
    let frets;
    if (activeChord) {
      const chord = chordPitchClasses(config.key, activeChord);
      pitches = voiceChord(instrument, chord);
      frets = fretsFor(instrument, chord);
    } else {
      pitches = openStrings(instrument);
      frets = instrument.tuning.map(() => 0);
    }
    surface.setVoicing(
      pitches.map((pitch, i) => ({ name: spellPitchClass(config.key, pitch % 12), fret: frets[i] })),
    );
    const badge = $('strings-chord');
    badge.textContent = activeChord ? chordLabel(config.key, activeChord) : 'Open strings';
    badge.classList.toggle('placeholder', !activeChord);
  };

  const applyInstrument = () => {
    const instrument = getInstrument(config.instrument);
    surface.setInstrument(instrument);
    surface.setRowWidths(config.rowWidths);
    applyVoicing();
    audio.load(instrument).catch(() => {
      $('pair-status').textContent = 'The sound could not start on this phone.';
    });
  };

  // -- settings form ----------------------------------------------------------

  const status = $('pair-status');
  const banner = $('strings-banner');

  const setBanner = (text) => {
    banner.hidden = !text;
    if (text) $('strings-banner-text').textContent = text;
  };

  document.querySelectorAll('input[name="instrument"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      config.instrument = radio.value;
      persist();
      applyInstrument();
      pushConfig();
    });
  });

  const bindRowWidth = (which, input, output) => {
    input.addEventListener('input', () => {
      config.rowWidths[which] = Number(input.value);
      output.textContent = `${input.value}%`;
      surface.setRowWidths(config.rowWidths);
      persist();
    });
  };
  bindRowWidth('first', $('row-first'), $('row-first-value'));
  bindRowWidth('last', $('row-last'), $('row-last-value'));

  const fillForm = () => {
    document.querySelectorAll('input[name="instrument"]').forEach((radio) => {
      radio.checked = radio.value === config.instrument;
    });
    [['row-first', 'first'], ['row-last', 'last']].forEach(([id, which]) => {
      const input = $(id);
      input.min = String(storage.ROW_WIDTH_MIN);
      input.max = String(storage.ROW_WIDTH_MAX);
      input.value = String(config.rowWidths[which]);
      $(`${id}-value`).textContent = `${config.rowWidths[which]}%`;
    });
  };

  $('config-export').addEventListener('click', () => storage.exportToFile(config));

  $('config-import-button').addEventListener('click', () => $('config-import').click());
  $('config-import').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    try {
      config = await storage.importFromFile(file);
      persist();
      fillForm();
      applyInstrument();
      pushConfig();
      status.textContent = 'Settings imported.';
    } catch {
      status.textContent = 'That file could not be read. Choose a settings file exported here.';
    }
  });

  $('setup-done').addEventListener('click', () => show('stringsPlay'));
  $('strings-settings').addEventListener('click', () => show('stringsSetup'));
  $('strings-banner-action').addEventListener('click', () => show('stringsSetup'));

  // -- pairing ----------------------------------------------------------------

  const onEdit = (edit) => {
    const result = storage.applyEdit(config, edit);
    if (!result.ok) {
      host?.send(MSG.ACK, { ok: false, error: result.error });
      return;
    }
    config = result.config;
    persist();
    host?.send(MSG.ACK, { ok: true });
    pushConfig();
    applyVoicing();
  };

  host = createHost({
    onOpen: () => {
      status.textContent = 'Connected.';
      setBanner(null);
      // Once the surface has been reached, settings can always be left again.
      $('setup-done').hidden = false;
      $('pair-panel').hidden = true;
      pushConfig();
      show('stringsPlay');
    },
    onMessage: (type, payload) => {
      if (type === MSG.CHORD) {
        activeChord = normalizeChord(payload);
        applyVoicing();
      } else if (type === MSG.EDIT) {
        onEdit(payload);
      }
    },
    onClose: () => {
      status.textContent = 'Waiting for the fretboard phone.';
      $('pair-panel').hidden = false;
      // Keep playing. Only the remote control is gone.
      setBanner('The phones disconnected.');
    },
    onError: (message) => {
      status.textContent = message;
    },
  });

  host.ready
    .then((peerId) => {
      const code = codeFromPeerId(peerId);
      $('pair-code').textContent = code;
      renderQr($('pair-qr'), peerId);
      status.textContent = 'Waiting for the fretboard phone.';
    })
    .catch((error) => {
      status.textContent = error.message;
    });

  fillForm();
  applyInstrument();
  keepScreenAwake();
  show('stringsSetup');
}

// -- fretboard device ---------------------------------------------------------

function startFretboard() {
  const scanStatus = $('scan-status');
  const codeInput = $('scan-code');
  let guest = null;
  let stopScanner = null;

  const ui = new FretboardUI({
    root: screens.fretboardPlay,
    onChord: (chord) => guest?.send(MSG.CHORD, chord),
    onEdit: (edit) => {
      if (!guest?.isOpen()) {
        ui.showToast('Not connected. The change was not saved.');
        return;
      }
      guest.send(MSG.EDIT, edit);
    },
  });

  const connect = (peerId) => {
    stopScanner?.();
    stopScanner = null;
    guest?.destroy();
    scanStatus.textContent = 'Connecting…';

    guest = createGuest(peerId, {
      onOpen: () => {
        ui.setConnected(true);
        $('fretboard-banner').hidden = true;
      },
      onMessage: (type, payload) => {
        if (type === MSG.CONFIG) {
          ui.setConfig(storage.normalizeConfig(payload));
          keepScreenAwake();
          show('fretboardPlay');
        } else if (type === MSG.ACK) {
          if (payload?.ok) ui.showSaved();
          else ui.showToast(payload?.error || 'That change was not saved.');
        }
      },
      onClose: () => {
        ui.setConnected(false);
        $('fretboard-banner').hidden = false;
      },
      onError: (message) => {
        ui.setConnected(false);
        if (screens.fretboardScan.hidden) {
          $('fretboard-banner').hidden = false;
          ui.showToast(message);
        } else {
          scanStatus.textContent = message;
        }
      },
    });

    guest.ready.catch((error) => {
      scanStatus.textContent = error.message;
    });
  };

  const submitCode = (raw) => {
    const peerId = parseCode(raw);
    if (!peerId) {
      scanStatus.textContent = 'That code is not right. It is eight letters and numbers.';
      return;
    }
    connect(peerId);
  };

  $('scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCode(codeInput.value);
  });

  const rescan = () => {
    guest?.destroy();
    guest = null;
    $('fretboard-banner').hidden = true;
    startScanning();
    show('fretboardScan');
  };
  $('fretboard-rescan').addEventListener('click', rescan);

  async function startScanning() {
    scanStatus.textContent = 'Point the camera at the code on the other phone.';
    try {
      stopScanner = await startScanner($('scan-video'), submitCode);
    } catch (error) {
      scanStatus.textContent = describeCameraError(error);
      $('scan-manual').open = true;
      codeInput.focus();
    }
  }

  show('fretboardScan');
  startScanning();
}

// -- boot ---------------------------------------------------------------------

function boot() {
  const missing = [
    ['Peer', typeof Peer === 'undefined'],
    ['qrcode', typeof qrcode === 'undefined'],
    ['jsQR', typeof jsQR === 'undefined'],
  ].filter(([, absent]) => absent);

  if (missing.length) {
    $('role-error').textContent =
      'Some of the app did not load. Check your internet connection and reload.';
    $('role-error').hidden = false;
    return;
  }

  const audio = new StringAudio();

  $('role-strings').addEventListener('click', async () => {
    await audio.unlock(); // must happen inside the gesture
    startStrings(audio);
  });

  $('role-fretboard').addEventListener('click', () => startFretboard());
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // The app runs without it; only installability suffers.
    });
  });
}

boot();
