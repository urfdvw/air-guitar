// PeerJS pairing, the QR code either side of it, and the wire protocol.
//
// Only abstract chord state crosses this link, and a chord change always
// precedes the strum that uses it, so transport latency on it is inaudible.
// Never send audio, note-on events or per-string data over the wire.

export const MSG = {
  CONFIG: 'config', // strings -> fretboard
  CHORD: 'chord', //   fretboard -> strings
  EDIT: 'edit', //     fretboard -> strings
  ACK: 'ack', //       strings -> fretboard
};

// No l/o/0/1/i - the code is also typed by hand when a camera is unavailable.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LENGTH = 8;
const ID_PREFIX = 'ag-';

export function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Accepts "ag-abcd2345" or "ABCD 2345" and returns a peer id, or null. */
export function parseCode(input) {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/^ag-/, '')
    .replace(/[^a-z0-9]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  if (![...cleaned].every((c) => CODE_ALPHABET.includes(c))) return null;
  return ID_PREFIX + cleaned;
}

export function codeFromPeerId(peerId) {
  return peerId.replace(/^ag-/, '');
}

function describeError(error) {
  switch (error && error.type) {
    case 'peer-unavailable':
      return 'No phone is waiting with that code. Check the code and try again.';
    case 'browser-incompatible':
      return 'This browser cannot make a direct connection.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Cannot reach the pairing service. Check your internet connection.';
    case 'unavailable-id':
      return 'That code is already in use.';
    case 'disconnected':
      return 'The phones disconnected.';
    default:
      return 'Something went wrong with the connection.';
  }
}

function wireUp(conn, handlers, state) {
  conn.on('open', () => {
    state.conn = conn;
    handlers.onOpen?.();
  });
  conn.on('data', (data) => {
    if (data && typeof data === 'object' && typeof data.type === 'string') {
      handlers.onMessage?.(data.type, data.payload);
    }
  });
  conn.on('close', () => {
    if (state.conn === conn) {
      state.conn = null;
      handlers.onClose?.();
    }
  });
  conn.on('error', (error) => handlers.onError?.(describeError(error), error));
}

function makeLink(peer, state, handlers) {
  return {
    peer,
    get peerId() {
      return peer.id;
    },
    isOpen() {
      return Boolean(state.conn && state.conn.open);
    },
    send(type, payload) {
      if (!state.conn || !state.conn.open) return false;
      state.conn.send({ type, payload });
      return true;
    },
    destroy() {
      handlers.onClose = null;
      state.conn?.close();
      state.conn = null;
      peer.destroy();
    },
  };
}

const PEER_OPTIONS = { debug: 0 };
const CONNECT_OPTIONS = { reliable: true, serialization: 'json', metadata: { app: 'air-guitar' } };

/**
 * Strings device. Owns the peer id shown in the QR code and waits for the
 * fretboard. A later connection replaces an earlier one, so re-pairing after a
 * drop needs no teardown.
 */
export function createHost(handlers = {}) {
  const state = { conn: null };
  const peer = new Peer(ID_PREFIX + randomCode(), PEER_OPTIONS);

  const ready = new Promise((resolve, reject) => {
    peer.on('open', (id) => resolve(id));
    peer.on('error', (error) => {
      if (error.type === 'unavailable-id') {
        reject(new Error(describeError(error)));
        return;
      }
      if (peer.open) handlers.onError?.(describeError(error), error);
      else reject(new Error(describeError(error)));
    });
  });

  peer.on('connection', (conn) => {
    if (state.conn && state.conn !== conn) {
      const previous = state.conn;
      state.conn = null;
      previous.close();
    }
    wireUp(conn, handlers, state);
  });

  peer.on('disconnected', () => peer.reconnect());

  return { ...makeLink(peer, state, handlers), ready };
}

/** Fretboard device. Dials the code it scanned or was given. */
export function createGuest(remoteId, handlers = {}) {
  const state = { conn: null };
  const peer = new Peer(PEER_OPTIONS);

  const ready = new Promise((resolve, reject) => {
    peer.on('open', () => {
      wireUp(peer.connect(remoteId, CONNECT_OPTIONS), handlers, state);
      resolve(peer.id);
    });
    peer.on('error', (error) => {
      if (peer.open) handlers.onError?.(describeError(error), error);
      else reject(new Error(describeError(error)));
    });
  });

  peer.on('disconnected', () => peer.reconnect());

  return { ...makeLink(peer, state, handlers), ready };
}

/** Draws `text` as a QR code into `element`. */
export function renderQr(element, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  element.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  const svg = element.querySelector('svg');
  if (svg) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
}

/**
 * Runs the camera until a QR code is read.
 * @returns {Promise<() => void>} resolves with a stop function once the camera is live
 */
export async function startScanner(video, onResult, onError) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });

  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  let stopped = false;
  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch {
      detector = null; // fall through to the software decoder
    }
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let frame = 0;

  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };

  const found = (text) => {
    if (stopped || !text) return;
    stop();
    onResult(text);
  };

  const tick = async () => {
    if (stopped) return;
    frame += 1;
    if (frame % 2 === 0 && video.videoWidth > 0) {
      try {
        if (detector) {
          const [code] = await detector.detect(video);
          if (code) found(code.rawValue);
        } else {
          // Decode a downscaled frame; a QR this big survives it and the phone
          // stays responsive.
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code) found(code.data);
        }
      } catch (error) {
        onError?.(error);
      }
    }
    if (!stopped) requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  return stop;
}

export function describeCameraError(error) {
  switch (error && error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was refused. Allow it in your browser settings, or enter the code by hand.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Enter the code by hand.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it, or enter the code by hand.';
    default:
      return 'The camera could not start. Enter the code by hand.';
  }
}
