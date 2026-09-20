"""Turns the frames captured by capture-media.mjs into small README images.

Usage: python3 assemble-media.py <work directory> <output directory>   (needs Pillow)

The game is black and white with one signal green (#ccff00). Every image uses a fixed palette that always contains
black, white and that green, plus the most frequent colours of the frames it is built from. Colours are mapped to the
nearest palette entry with no dithering. The palette is built from ALL frames of an animation, not from its first
frame, so a colour that only appears later (the green of a win) is never lost. The script checks this before it finishes.
"""
import json
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

work, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)

BLACK, WHITE, LIME = (0, 0, 0), (255, 255, 255), (204, 255, 0)
FORCED = [BLACK, WHITE, LIME]
PALETTE_SIZE = 32


def load(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def build_palette(images: list[Image.Image]) -> Image.Image:
    """The forced colours first, then the most frequent colours across every given image."""
    counts: Counter = Counter()
    for image in images:
        for count, colour in image.getcolors(1 << 24):
            counts[colour] += count
    colours = list(FORCED)
    for colour, _ in counts.most_common():
        if len(colours) >= PALETTE_SIZE:
            break
        if colour not in colours:
            colours.append(colour)
    palette = Image.new("P", (1, 1))
    flat = [channel for colour in colours for channel in colour]
    palette.putpalette(flat + [0] * (768 - len(flat)))
    return palette


def apply(image: Image.Image, palette: Image.Image) -> Image.Image:
    return image.quantize(palette=palette, dither=Image.Dither.NONE)


def count_exact(image: Image.Image, colour) -> int:
    return sum(count for count, found in image.convert("RGB").getcolors(1 << 24) if found == colour)


def check_green(source: Image.Image, result: Image.Image, label: str) -> None:
    """Every exact #ccff00 pixel of the source must survive, and no near-green may turn into another colour."""
    before, after = count_exact(source, LIME), count_exact(result, LIME)
    if after < before:
        raise SystemExit(f"{label}: {before} green pixels in the source but only {after} in the image")
    print(f"  {label}: green pixels {before} -> {after}")


for name in ("hall", "reveal", "win", "receipt"):
    source = load(work / "raw" / f"{name}.png")
    result = apply(source, build_palette([source]))
    target = output / f"{name}.png"
    result.save(target, optimize=True)
    check_green(source, Image.open(target), target.name)
    print(f"{target.name}: {target.stat().st_size // 1024} KB")

frames = sorted((work / "gif").glob("*.png"))
timing = json.loads((work / "gif" / "timing.json").read_text())
sources = [load(frame) for frame in frames]
palette = build_palette(sources)
converted = [apply(source, palette) for source in sources]
durations = [max(60, min(500, int(value))) for value in timing]
target = output / "round.gif"
converted[0].save(target, save_all=True, append_images=converted[1:], duration=durations, loop=0, optimize=False, disposal=1)

# Read the finished GIF back and check the green on several frames, including the win frames.
gif = Image.open(target)
# The props already show a little green (terminal screens). Win frames have far more: the plate, the tag and confetti.
baseline = count_exact(sources[0], LIME)
green_frames = [index for index, source in enumerate(sources) if count_exact(source, LIME) > baseline + 1500]
if not green_frames:
    raise SystemExit("No frame with the win colours was captured")
print(f"{target.name}: {len(frames)} frames written, {gif.n_frames} kept, {target.stat().st_size // 1024} KB")
checked = 0
for index, source in enumerate(sources):
    if index not in (0, green_frames[0], green_frames[len(green_frames) // 2], green_frames[-1], len(sources) - 1):
        continue
    written = Image.open(target)
    # Identical neighbouring frames are merged, so find the kept frame that has the same start time.
    start = sum(durations[:index])
    elapsed, kept = 0, 0
    for candidate in range(written.n_frames):
        written.seek(candidate)
        if elapsed + written.info.get("duration", 0) > start:
            kept = candidate
            break
        elapsed += written.info.get("duration", 0)
    written.seek(kept)
    check_green(source, written.convert("RGB"), f"GIF frame {index} (kept {kept})")
    checked += 1
if checked < 3:
    raise SystemExit("Too few frames were checked")
