"""Turns the frames captured by capture-media.mjs into small README images.

Usage: python3 assemble-media.py <work directory> <output directory>   (needs Pillow)
The game is black and white with one signal green, so a small palette keeps the files small without visible loss.
"""
import json
import sys
from pathlib import Path

from PIL import Image

work, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
COLORS = 24


def palette_image(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB").quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


for name in ("hall", "reveal", "win", "receipt"):
    target = output / f"{name}.png"
    palette_image(work / "raw" / f"{name}.png").save(target, optimize=True)
    print(f"{target.name}: {target.stat().st_size // 1024} KB")

frames = sorted((work / "gif").glob("*.png"))
timing = json.loads((work / "gif" / "timing.json").read_text())
first = Image.open(frames[0]).convert("RGB")
shared = first.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
converted = [Image.open(frame).convert("RGB").quantize(palette=shared, dither=Image.Dither.NONE) for frame in frames]
durations = [max(60, min(500, int(value))) for value in timing]
target = output / "round.gif"
converted[0].save(target, save_all=True, append_images=converted[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f"{target.name}: {len(frames)} frames, {target.stat().st_size // 1024} KB")
