// The Android shell's bridge, when there is one.
//
// The Android app is this same web app in a WebView, plus a Java object named
// `AirGuitarAndroid` that reads the accelerometer at its full rate (hundreds of
// Hz, where a browser's devicemotion gives about 60) and keeps a log that can
// be exported. In a browser none of this exists and every call is a no-op.
//
// Native-to-page events arrive through `window.__airGuitarNativeEvent`.

const bridge = typeof window !== 'undefined' ? window.AirGuitarAndroid ?? null : null;

export const isNative = Boolean(bridge);

const listeners = new Set();

if (isNative) {
  window.__airGuitarNativeEvent = (event) => {
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        log(`native event listener failed: ${error?.message || error}`);
      }
    });
  };
}

/** @param {(event: {type: string}) => void} listener @returns {() => void} unsubscribe */
export function onNativeEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function call(name, ...args) {
  if (!bridge || typeof bridge[name] !== 'function') return undefined;
  try {
    return bridge[name](...args);
  } catch (error) {
    console.warn(`AirGuitarAndroid.${name} failed`, error);
    return undefined;
  }
}

function callJson(name, ...args) {
  const raw = call(name, ...args);
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Writes a line to the exported log (and logcat). In a browser, the console. */
export function log(message) {
  if (bridge) call('log', String(message));
  else console.debug(`[air-guitar] ${message}`);
}

export const native = {
  /** Thresholds and switches for the detector that runs at sensor rate. */
  configure(settings) {
    call('configure', JSON.stringify(settings));
  },
  /** The accelerometer only runs while something needs it. */
  setSensorActive(active) {
    call('setSensorActive', Boolean(active));
  },
  /** A finger landed on the screen; its own bump must not count as a scratch. */
  noteTouch() {
    call('noteTouch');
  },
  /** Strongest high-passed acceleration in the last `ms`, m/s². */
  peakSince(ms) {
    return callJson('peakSince', Math.round(ms));
  },
  /** {rate, peak} since the previous call, for the live meter. */
  meter() {
    return callJson('meter');
  },
  recordTrace(seconds) {
    call('recordTrace', Math.round(seconds));
  },
  exportLogs() {
    call('exportLogs');
  },
  deviceInfo() {
    return callJson('deviceInfo');
  },
};
