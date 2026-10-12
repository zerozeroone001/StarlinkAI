"""Chroma-key lime-green pet portraits to transparent PNG and crop."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

ROOT = Path(r"C:\Users\Administrator\.grok\sessions\I%3A%5Ccode%5Cpython%5CgrokDeskTop\01a038b1-cc43-7791-a60c-fe1f00efc8ac\images")
OUT = Path(r"I:\code\python\grokDeskTop\resources\pets")

JOBS = [
    ("13.jpg", "ragdoll.png"),
    ("12.jpg", "shiba.png"),
    ("8.jpg", "imp.png"),
    ("9.jpg", "elf.png"),
    ("10.jpg", "xiaomei.png"),
    ("11.jpg", "secretary.png"),
]


def sample_key(im: Image.Image) -> tuple[int, int, int]:
    px = im.load()
    w, h = im.size
    pts = [
        px[2, 2],
        px[w - 3, 2],
        px[2, h - 3],
        px[w - 3, h - 3],
        px[w // 2, 2],
        px[w // 2, h - 3],
    ]
    r = sum(p[0] for p in pts) // len(pts)
    g = sum(p[1] for p in pts) // len(pts)
    b = sum(p[2] for p in pts) // len(pts)
    return r, g, b


def chroma(src: Path, dest: Path) -> None:
    im = Image.open(src).convert("RGBA")
    key = sample_key(im)
    pixels = im.load()
    w, h = im.size
    min_x, min_y, max_x, max_y = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            dr, dg, db = r - key[0], g - key[1], b - key[2]
            dist = math.sqrt(dr * dr + dg * dg + db * db)
            greenish = g > 90 and g > r + 28 and g > b + 28
            if dist < 42 or (greenish and dist < 92):
                alpha = 0
            elif dist < 72 or (greenish and dist < 128):
                t = (dist - 42) / 50.0
                alpha = int(max(0, min(255, t * 255)))
            else:
                alpha = a
            pixels[x, y] = (r, g, b, alpha)
            if alpha > 24:
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x <= min_x:
        cropped = im
    else:
        pad = 18
        box = (
            max(0, min_x - pad),
            max(0, min_y - pad),
            min(w, max_x + 1 + pad),
            min(h, max_y + 1 + pad),
        )
        cropped = im.crop(box)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(dest, "PNG")
    print(f"{src.name} -> {dest.name} {cropped.size} key={key}")


def main() -> None:
    for src_name, dest_name in JOBS:
        chroma(ROOT / src_name, OUT / dest_name)


if __name__ == "__main__":
    main()
