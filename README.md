# Air guitar

Two phones, one strummed instrument. One phone is the **fretboard** — chord
buttons only, a remote control. The other is the **strings** — it holds all the
state and makes all the sound. They pair over WebRTC.

Guitar and ukulele.

## The invariant

**Audio is always generated locally on the strings device.** Only abstract chord
state crosses the network, and a chord change always precedes the strum that
uses it, so transport latency on it is inaudible. No audio, note-on events or
per-string data ever go over the wire.

## Running it

No build step and no server of our own — it is plain HTML, CSS and ES modules.
Serve the directory over HTTP and open it on both phones:

```sh
python3 -m http.server 8000
```

Pairing needs internet on both phones (PeerJS uses a public broker). The
fretboard's camera needs a **secure context**, so in practice you want HTTPS or
`localhost`; over plain HTTP on a LAN address the camera will be refused and the
app falls back to typing the eight-character code by hand.

Add it to the home screen on both phones. It runs in `standalone` display mode,
and the address bar costs a meaningful slice of strum travel.

## Chord grid

A chord sounds while a finger is held on it. Sliding onto another cell changes
the chord without lifting; with several fingers down, the one that most
recently landed on or slid into a cell wins. Lifting every finger goes back to
open strings. (Editing, behind the lock, is still a tap.)

## Android app

`android/` is the same web app in a full-screen WebView, plus a native bridge
(`window.AirGuitarAndroid`, see `js/native.js`) that reads the accelerometer at
its full rate. It adds two strum inputs, chosen under **Strum input** in the
strings settings or the standalone settings sheet:

- **Force button** - one big button; how hard it is hit sets the volume.
- **Edge scratch** - scrape a nail or pick across the phone's edge; each bump
  is a strum, its strength sets the volume, and up/down is guessed from the
  long-axis direction when it is clear.

Touch stays available. The browser never shows these options.

The web files are copied into the APK at build time, so there is one source.
CI (`.github/workflows/android.yml`) builds a debug APK on every push: open the
run under the repository's **Actions** tab and download the
`air-guitar-debug-*` artifact. Builds share one committed debug key, so a new
APK installs over the previous one.

### Logs

Every hit, force press, chord change and setting change is logged, together
with the device and sensor details.

- **From the app:** settings, **Strum input**, **Export log** opens the share
  sheet with this session's log and any traces. **Record 10 s** saves a CSV of
  raw and high-passed accelerometer samples, marked with touches and hits,
  which is what to record while trying a scratch or tap that misbehaves.
- **Over USB:** `adb logcat -s AirGuitar` live, or
  `adb pull /sdcard/Android/data/io.github.urfdvw.airguitar/files/logs` for
  the files.
- `chrome://inspect` on a computer can attach to the WebView.

## Tests

```sh
npm test          # or: node --test test/*.test.mjs
```

`js/music.js` and `js/voicing.js` are free of DOM and network code, which is
what makes them directly testable. The six verification voicings from the spec
are in `test/voicing.test.mjs`.

## How voicings are computed

There is no chord-shape table. For each string, play the lowest pitch at or
above that string's open pitch which is a member of the chord. The standard open
shapes come out of this because that is what the standard open shapes are.

The exception: on an instrument with a bass string, that string plays the lowest
pitch at or above its open pitch which is the **root**. This is what makes
guitar C come out `8 3 2 0 1 0` — the low string, which a human mutes, plays the
root instead.

### Where this departs from the written spec

The spec says the root exception applies to the ukulele's C string, and also
gives ukulele F as `2 0 1 0` and G as `0 2 3 2`. Those cannot both hold: the
exception would put the C string on fret 5 for F and fret 7 for G. Both
verification cases pass only with no exception at all.

It is resolved here by making the exception a property of the tuning
(`rootStringIndex` in `js/voicing.js`): the guitar's lowest-pitched string is
also its outermost, so it is a bass string and takes the exception; the ukulele
is reentrant, its lowest-pitched string sits in the middle of the layout, and it
takes none. All six verification voicings pass. Changing this back is one field.

### Known behaviour, not a bug

The root exception guarantees the sixth string plays the root; it does not
guarantee the root is the lowest sounding pitch. For guitar D the low E string
reaches D at fret 10 (D3 = 50), above the open A string (A2 = 45), so the bass
note is A and the chord sounds as D/A. This is fine on a strummed instrument and
the simple rule is worth keeping.

## Notes on the sound

`js/audio.js` uses one sample per string with playback-rate shifting for fretted
notes. The samples are plucked-string tones rendered by Karplus-Strong at
startup rather than downloaded, so there are no audio assets and nothing to
host; from the mixer's point of view they are ordinary samples.

## Data

Everything persistent lives in `localStorage` on the strings device — key, the
seven custom slots, instrument, row widths. The fretboard persists nothing and
never learns the string count, tuning or voicing; it sends an abstract
`{ offset, quality }` and nothing else.

`localStorage` can be evicted under storage pressure, especially on iOS, so
settings can be exported to and imported from a JSON file.

## Layout

```
index.html
manifest.json      sw.js
css/    base.css  fretboard.css  strings.css
js/     app.js         role select, boot
        connection.js  PeerJS, QR generate/scan, protocol
        storage.js     localStorage, import/export
        music.js       offsets, qualities, key spelling, transposition
        voicing.js     tunings + the string-pitch algorithm
        audio.js       Web Audio, sample rendering, voice management
        ui-fretboard.js  grid, lock/edit mode, dropdowns
        ui-strings.js    band geometry, pointer handling
test/   music.test.mjs  voicing.test.mjs
tools/  make-icons.py   run by hand when the icon changes
```

`package.json` exists only so `node --test` reads the source as ES modules.

Three scripts load from a CDN at runtime: PeerJS, `qrcode-generator` and `jsQR`.
Offline operation is explicitly not a goal — pairing needs the network anyway.
