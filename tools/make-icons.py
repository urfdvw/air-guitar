#!/usr/bin/env python3
"""Renders the app icons.

The project has no build step; this is run by hand when the icon changes:

    python3 tools/make-icons.py

A guitar pick in one flat colour, cut in half across the middle. 180 is the
iOS apple-touch-icon size; 192 and 512 are what the web app manifest wants.
Full-bleed square, no rounded corners - both platforms mask it themselves.
"""

import struct
import zlib
from pathlib import Path

BACKGROUND = (0x14, 0x12, 0x10)
PICK = (0xE8, 0xA3, 0x3C)

SIZES = (180, 192, 512)
CANVAS = 512.0  # the space the outline below is drawn in

# A 351-shape pick: wide rounded shoulders tapering to a rounded tip.
OUTLINE = [
    ((256, 108), (320, 108), (386, 150), (386, 214)),
    ((386, 214), (386, 268), (330, 340), (286, 386)),
    ((286, 386), (270, 403), (242, 403), (226, 386)),
    ((226, 386), (182, 340), (126, 268), (126, 214)),
    ((126, 214), (126, 150), (192, 108), (256, 108)),
]

GAP_TOP, GAP_BOTTOM = 238.0, 274.0  # the break across the middle

# Grown about the centre to fill the tile, stopping inside the safe zone a
# maskable icon can be cropped to.
SCALE = 1.15

SUBSAMPLES = 4  # scanlines per pixel row, for antialiasing

OUT = Path(__file__).resolve().parent.parent / "icons"


def grow(value):
    return CANVAS / 2 + (value - CANVAS / 2) * SCALE


def flatten(steps=48):
    """Turns the cubic outline into one polygon."""
    points = []
    for (x0, y0), (x1, y1), (x2, y2), (x3, y3) in OUTLINE:
        for i in range(steps):
            t = i / steps
            u = 1 - t
            points.append(
                (
                    grow(u**3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3),
                    grow(u**3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3),
                )
            )
    return points


def edges_for(size):
    scale = size / CANVAS
    polygon = [(x * scale, y * scale) for x, y in flatten()]
    return [
        (polygon[i], polygon[(i + 1) % len(polygon)])
        for i in range(len(polygon))
        if polygon[i][1] != polygon[(i + 1) % len(polygon)][1]
    ]


def span_coverage(row, x0, x1, size):
    """Adds a horizontal span's exact per-pixel coverage into `row`."""
    x0, x1 = max(0.0, x0), min(float(size), x1)
    if x1 <= x0:
        return
    first, last = int(x0), min(int(x1), size - 1)
    if first == last:
        row[first] += x1 - x0
        return
    row[first] += first + 1 - x0
    for x in range(first + 1, last):
        row[x] += 1.0
    row[last] += x1 - last


def render(size):
    edges = edges_for(size)
    gap_top = grow(GAP_TOP) * size / CANVAS
    gap_bottom = grow(GAP_BOTTOM) * size / CANVAS
    pixels = bytearray()

    for y in range(size):
        # How much of this pixel row falls outside the gap.
        overlap = max(0.0, min(y + 1.0, gap_bottom) - max(float(y), gap_top))
        outside = 1.0 - overlap

        row = [0.0] * size
        if outside > 0:
            for s in range(SUBSAMPLES):
                sy = y + (s + 0.5) / SUBSAMPLES
                if gap_top <= sy < gap_bottom:
                    continue
                crossings = sorted(
                    (x0 + (sy - y0) * (x1 - x0) / (y1 - y0))
                    for (x0, y0), (x1, y1) in edges
                    if min(y0, y1) <= sy < max(y0, y1)
                )
                scratch = [0.0] * size
                for i in range(0, len(crossings) - 1, 2):
                    span_coverage(scratch, crossings[i], crossings[i + 1], size)
                for x in range(size):
                    row[x] += scratch[x] / SUBSAMPLES

        for x in range(size):
            alpha = min(1.0, row[x])
            colour = tuple(
                round(b + (c - b) * alpha) for b, c in zip(BACKGROUND, PICK)
            )
            pixels += bytes(colour) + b"\xff"

    return bytes(pixels)


def write_png(path, size, pixels):
    stride = size * 4
    raw = b"".join(b"\x00" + pixels[y * stride : (y + 1) * stride] for y in range(size))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    OUT.mkdir(exist_ok=True)
    for size in SIZES:
        write_png(OUT / f"icon-{size}.png", size, render(size))
        print(f"icons/icon-{size}.png")


if __name__ == "__main__":
    main()
