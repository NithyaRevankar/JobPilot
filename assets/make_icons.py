#!/usr/bin/env python3
"""Generate the JobPilot extension icons (icon16/32/48/128.png).

Pure Python 3 standard library only (struct + zlib) — no PIL/Pillow.

Each icon is a rounded-square tile with a vertical deep-indigo -> violet
gradient (rounded corners cut via alpha = 0, corner radius ~22% of the
icon size) and a white paper-plane / upward-arrow glyph drawn as a filled
polygon. Everything is rendered at 4x resolution and box-downsampled, so
edges and corners are antialiased and the glyph stays readable at 16 px.

Run from the extension root:  python3 assets/make_icons.py
(Output paths are resolved relative to this script, so any cwd works.)
"""

import os
import struct
import zlib

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4                 # samples per axis per output pixel
CORNER_RADIUS_FRACTION = 0.22   # of the icon size

GRADIENT_TOP = (55, 48, 163)     # deep indigo  (#3730A3)
GRADIENT_BOTTOM = (139, 92, 246)  # violet       (#8B5CF6)
GLYPH_COLOR = (255, 255, 255)

# Paper-plane pointing up, as a closed polygon in unit tile coordinates
# (x right, y down): apex at top-center, wing tips at bottom left/right,
# and a notch at bottom-center that gives it the classic "send" shape.
GLYPH_POLYGON = (
    (0.50, 0.17),  # apex
    (0.79, 0.79),  # right wing tip
    (0.50, 0.63),  # bottom notch
    (0.21, 0.79),  # left wing tip
)


def point_in_polygon(x, y, polygon):
    """Even-odd ray-casting point-in-polygon test."""
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def inside_rounded_square(x, y, side, radius):
    """True if (x, y) lies inside a side x side square with rounded corners."""
    if x < 0 or y < 0 or x > side or y > side:
        return False
    # Distance test only matters inside the four corner boxes.
    cx = radius if x < radius else (side - radius if x > side - radius else None)
    cy = radius if y < radius else (side - radius if y > side - radius else None)
    if cx is None or cy is None:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def render_icon(size):
    """Render one icon; returns rows of raw RGBA bytes (no filter bytes)."""
    ss = SUPERSAMPLE
    big = size * ss
    radius = CORNER_RADIUS_FRACTION * big
    samples_per_pixel = ss * ss
    glyph = [(px * big, py * big) for (px, py) in GLYPH_POLYGON]

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Accumulate premultiplied color over the ss x ss sample grid.
            acc_r = acc_g = acc_b = 0.0
            acc_a = 0.0
            for sy in range(ss):
                yy = y * ss + sy + 0.5
                t = yy / big  # vertical gradient position, 0..1
                base = tuple(
                    GRADIENT_TOP[c] + (GRADIENT_BOTTOM[c] - GRADIENT_TOP[c]) * t
                    for c in range(3)
                )
                for sx in range(ss):
                    xx = x * ss + sx + 0.5
                    if not inside_rounded_square(xx, yy, big, radius):
                        continue
                    color = (
                        GLYPH_COLOR
                        if point_in_polygon(xx, yy, glyph)
                        else base
                    )
                    acc_r += color[0]
                    acc_g += color[1]
                    acc_b += color[2]
                    acc_a += 1.0
            if acc_a == 0.0:
                row += b"\x00\x00\x00\x00"
            else:
                alpha = round(255 * acc_a / samples_per_pixel)
                row += bytes((
                    min(255, round(acc_r / acc_a)),
                    min(255, round(acc_g / acc_a)),
                    min(255, round(acc_b / acc_a)),
                    min(255, alpha),
                ))
        rows.append(bytes(row))
    return rows


def png_chunk(tag, payload):
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path, size, rows):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per scanline
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(png_chunk(b"IHDR", ihdr))
        fh.write(png_chunk(b"IDAT", zlib.compress(raw, 9)))
        fh.write(png_chunk(b"IEND", b""))


def main():
    out_dir = os.path.dirname(os.path.abspath(__file__))
    for size in SIZES:
        path = os.path.join(out_dir, f"icon{size}.png")
        write_png(path, size, render_icon(size))
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
