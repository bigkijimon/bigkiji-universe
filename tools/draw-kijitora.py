#!/usr/bin/env python3
"""Draw the BigKiji kijitora (brown tabby) sprite sheets from one description.

Why this file exists rather than six hand-edited grids: the previous cat was typed as
16-character strings, and what shipped read as a bear — round ears set wide apart, a
muzzle covering the whole lower face, no whiskers and no tail. Nobody could see that
from the text, because a grid of digits is not a picture. Here the shapes are named and
placed by coordinate, and `tools/preview-kijitora.js` renders the result to a PNG to
look at, so "the ears are triangles" is a claim you can check.

Outputs (all derived — never hand-edit the grids):
    src/components/UI/assets/pixel/frames16/frame-N.txt   16x16 index grids — the CLI
    src/components/UI/assets/pixel/frames/frame-N.txt     32x32 index grids — the GUI
    src/components/UI/assets/pixel/loading-cat-16.png     96x16   sprite strip
    src/components/UI/assets/pixel/loading-cat.png        192x32  sprite strip (main.html)
    src/components/UI/assets/pixel/loading-cat@4x.png     768x128 nearest-neighbour 4x

What makes it read as a cat, in the order a viewer resolves it:
    1. ear silhouette — sharp triangles, apex 1px, sitting ON the skull and close together
    2. eyes — large, wide-set, with a single glint pixel, which is the cheapest "alive"
    3. muzzle — SMALL. A wide tan muzzle is exactly what made the old sprite a bear.
    4. tail — always visible, curling clear of the body, because it is the second most
       cat-shaped thing there is after the ears
    5. whiskers and the tabby stripes — kijitora specifics, read last, so they are one
       pixel each and stepped diagonally. A straight two-pixel bar reads as a horizon,
       which is what the first attempt at this drew.

The 32x32 sheet is an exact 2x of the 16x16 rather than a redraw. main.html paints it
into a 24px box, so a redraw's extra detail would be resampled away, and two cats that
can drift apart is a worse outcome than one blocky one.
"""

import json
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PIXEL = ROOT / 'src' / 'components' / 'UI' / 'assets' / 'pixel'

# Palette indices. 0 is transparent; the rest match palette.json.
T, INK, DARK, FUR, TAN, CREAM, ROSE = 0, 1, 2, 3, 4, 5, 6

PALETTE = [
    (0, 0, 0, 0),          # 0 transparent
    (22, 16, 14, 255),     # 1 ink        eyes, mouth
    (75, 46, 31, 255),     # 2 dark brown rim, tabby stripes, ear rims, tail tip
    (150, 96, 58, 255),    # 3 mid brown  fur
    (227, 192, 139, 255),  # 4 light tan  muzzle, chest, paws, inner ear
    (247, 232, 206, 255),  # 5 cream      eye glint and whiskers
    (217, 140, 122, 255),  # 6 rose       nose
]


class Grid:
    def __init__(self, size):
        self.size = size
        self.px = [[T] * size for _ in range(size)]

    def set(self, x, y, value):
        if 0 <= x < self.size and 0 <= y < self.size:
            self.px[y][x] = value

    def span(self, y, x0, x1, value):
        for x in range(x0, x1 + 1):
            self.set(x, y, value)

    def spans(self, items, value):
        """items: iterable of (y, x0, x1). A list, not a dict — a dict silently drops
        duplicate rows, which is how the first draft lost half of the tail."""
        for y, x0, x1 in items:
            self.span(y, x0, x1, value)

    def scaled(self, factor):
        out = Grid(self.size * factor)
        for y in range(self.size):
            for x in range(self.size):
                value = self.px[y][x]
                if value == T:
                    continue
                for dy in range(factor):
                    for dx in range(factor):
                        out.set(x * factor + dx, y * factor + dy, value)
        return out

    def text(self):
        return '\n'.join(''.join(str(v) for v in row) for row in self.px)


# ---------------------------------------------------------------------------
# 16x16. Two pixel rows per terminal row, so the head occupies pixel rows 0-7
# and the CLI's header mark can crop rows 0-5 — ears, eyes and nose — and still
# be a face. Nothing important is below row 8.
# ---------------------------------------------------------------------------

def cat16(blink=False, tail=0, ear=0, bob=0):
    g = Grid(16)

    # --- ears: apex 1px at row 0, base 3px at row 1, inner ear in tan.
    #     `ear` lifts the left one by a pixel — a twitch, not a flap.
    lift = -1 if ear else 0
    g.set(3, max(0, 0 + lift), DARK)
    g.span(1 + lift, 2, 4, DARK)
    g.set(3, 1 + lift, TAN)
    g.set(12, 0, DARK)
    g.span(1, 11, 13, DARK)
    g.set(12, 1, TAN)

    # --- skull: rows 2-7, widest in the middle so the silhouette is a head and not a
    #     box. The dark pixels are the rim, on the corners only.
    g.spans([(2, 3, 12), (3, 2, 13), (4, 1, 14), (5, 1, 14), (6, 2, 13), (7, 3, 12)], FUR)
    g.spans([(4, 1, 1), (5, 1, 1), (4, 14, 14), (5, 14, 14)], DARK)
    g.set(2, 3, DARK); g.set(13, 3, DARK); g.set(2, 6, DARK); g.set(13, 6, DARK)

    # --- tabby stripes on the forehead. Kijitora means brown tabby; this says so.
    g.set(5, 2, DARK); g.set(10, 2, DARK)

    # --- eyes: 2x2, wide-set, glint in the upper outer corner. Three pixels wide read
    #     as sunglasses — one continuous bar across the face with a gap in it.
    for ex in (4, 10):
        if blink:
            g.span(4, ex, ex + 1, INK)
        else:
            g.spans([(3, ex, ex + 1), (4, ex, ex + 1)], INK)
            g.set(ex if ex == 4 else ex + 1, 3, CREAM)

    # --- muzzle: four pixels wide, nose above a short mouth. Small on purpose.
    g.spans([(5, 6, 9), (6, 6, 9)], TAN)
    g.span(5, 7, 8, ROSE)
    g.span(6, 7, 8, INK)

    # --- whiskers: one pixel each, touching the cheek. Floated out at the frame edge
    #     they read as two unrelated dots, which is what the previous attempt drew.
    g.set(1, 6, CREAM); g.set(14, 6, CREAM)

    # --- body: narrower than the head, which is what makes it chibi rather than lumpy.
    g.spans([(8, 4, 11), (9, 3, 12), (10, 3, 12), (11, 3, 12), (12, 3, 12), (13, 4, 11)], FUR)
    g.spans([(9, 6, 9), (10, 5, 10), (11, 5, 10), (12, 6, 9)], TAN)   # chest
    g.set(3, 10, DARK); g.set(12, 10, DARK)                            # flank shading
    g.span(13, 4, 5, TAN); g.span(13, 10, 11, TAN)                     # front paws

    # --- tail: out of the right hip, clear of the body, three poses.
    curls = [
        [(11, 13, 14), (10, 14, 15), (9, 14, 15)],
        [(11, 13, 14), (10, 14, 15), (9, 15, 15), (8, 14, 15)],
        [(12, 13, 14), (11, 14, 15), (10, 15, 15)],
    ]
    g.spans(curls[tail % 3], FUR)
    tip = curls[tail % 3][-1]
    g.set(tip[2], tip[0], DARK)

    # --- the bob, baked into the art.
    #
    # docs/reference-analysis.md §1: the bat's body rises and falls about 7 sprite
    # pixels in ANTI-PHASE with the wings, and the reference bakes that into the sprite
    # rather than adding a second transform, "so the two stay locked in phase". Ours was
    # six frames that differed by a blink and one pixel of ear — the measured bat frames
    # move their bounding box by a fifth of its width. One pixel of a sixteen pixel cat
    # is the same proportional move, and it is the difference between an animation you
    # can see and one you have to be told about.
    if bob:
        shifted = Grid(16)
        for y in range(15, 0, -1):
            shifted.px[y] = list(g.px[y - 1])
        return shifted
    return g


# ---------------------------------------------------------------------------
# PNG writing. No image dependency is added to the project: a PNG is a header,
# one zlib stream of filtered scanlines and a trailer, and zlib ships with Python.
# ---------------------------------------------------------------------------

def png_bytes(width, height, rgba_rows):
    raw = b''.join(b'\x00' + bytes(row) for row in rgba_rows)

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff))

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def strip_png(grids, scale=1):
    size = grids[0].size
    width, height = size * len(grids) * scale, size * scale
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            grid = grids[(x // scale) // size]
            r, g, b, a = PALETTE[grid.px[y // scale][(x // scale) % size]]
            row += bytes((r, g, b, a))
        rows.append(row)
    return png_bytes(width, height, rows)


# Six frames, because palette.json, the CLI ticker and main.html's `steps(6)` all agree
# on six. The reference holds each cell for a full 66.67 ms and never interpolates, so
# each of these has to be worth holding: the body bobs in anti-phase with the tail, the
# ears twitch on the way back up, and there is exactly one blink per loop.
POSES = [
    dict(blink=False, tail=0, ear=0, bob=0),
    dict(blink=False, tail=1, ear=0, bob=1),
    dict(blink=True,  tail=1, ear=0, bob=1),
    dict(blink=False, tail=2, ear=1, bob=0),
    dict(blink=False, tail=2, ear=0, bob=0),
    dict(blink=False, tail=0, ear=1, bob=1),
]


def main():
    small = [cat16(**pose) for pose in POSES]
    large = [grid.scaled(2) for grid in small]

    (PIXEL / 'frames16').mkdir(parents=True, exist_ok=True)
    (PIXEL / 'frames').mkdir(parents=True, exist_ok=True)
    for index, grid in enumerate(small):
        (PIXEL / 'frames16' / f'frame-{index}.txt').write_text(grid.text() + '\n')
    for index, grid in enumerate(large):
        (PIXEL / 'frames' / f'frame-{index}.txt').write_text(grid.text() + '\n')

    (PIXEL / 'loading-cat-16.png').write_bytes(strip_png(small, 1))
    (PIXEL / 'loading-cat.png').write_bytes(strip_png(large, 1))
    (PIXEL / 'loading-cat@4x.png').write_bytes(strip_png(large, 4))

    palette = json.loads((PIXEL / 'palette.json').read_text())
    palette['colors'] = [
        {'index': 0, 'role': 'transparent', 'hex': None, 'rgba': list(PALETTE[0])},
        {'index': 1, 'role': 'ink - eyes and mouth', 'hex': '#16100E', 'rgba': list(PALETTE[1])},
        {'index': 2, 'role': 'dark brown - rim, tabby stripes, ear rims, tail tip', 'hex': '#4B2E1F', 'rgba': list(PALETTE[2])},
        {'index': 3, 'role': 'mid brown - fur', 'hex': '#96603A', 'rgba': list(PALETTE[3])},
        {'index': 4, 'role': 'light tan - muzzle, chest, paws, inner ear', 'hex': '#E3C08B', 'rgba': list(PALETTE[4])},
        {'index': 5, 'role': 'cream - eye glint and whiskers', 'hex': '#F7E8CE', 'rgba': list(PALETTE[5])},
        {'index': 6, 'role': 'rose - nose', 'hex': '#D98C7A', 'rgba': list(PALETTE[6])},
    ]
    palette['note'] = ('index 0 is transparent; indices match the digits in frames/ and frames16/. '
                       'Everything in this directory is generated by tools/draw-kijitora.py — edit the '
                       'script, not the grids, or the 16x16 and the 32x32 cats will drift apart.')
    palette['sheets']['loading-cat.png']['note'] = 'exact 2x of the 16x16 grids; main.html paints it into a 24px box'
    (PIXEL / 'palette.json').write_text(json.dumps(palette, indent=2) + '\n')
    print('wrote 6 frames at 16x16 and 32x32, three PNG strips, and the palette')


if __name__ == '__main__':
    main()
