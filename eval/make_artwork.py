"""Synthetic sticker artwork with known defects, for the artwork agent's eval.

Each case is a PNG a customer might upload for a die-cut sticker, plus the
size they ordered and the issues a good proof check should find. Two kinds of
issue: ones code can measure (resolution, background), and ones only eyes can
see (text on the cut line, an upscaled blurry file, unreadable text).

Usage: py eval/make_artwork.py   -> artwork/cases/*.png + artwork/labels.json
"""
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "artwork"
FONT = "C:/Windows/Fonts/arialbd.ttf"
WORDS = ["BREW CO", "TRAIL CLUB", "PIXEL CAT", "SURF SHACK", "NIGHT OWL", "TACO BOT",
         "MOSS & CO", "RAD DAD", "BYTE ME", "SUN DOG", "FERN LAB", "GLOW UP",
         "ZEN BEAR", "HOT SAUCE", "BEE KIND", "LOFI CLUB"]
DARK = [(30, 60, 140), (150, 30, 40), (20, 110, 70), (90, 40, 130), (200, 90, 20), (25, 25, 25)]
LIGHT = [(250, 245, 230), (255, 255, 255), (235, 245, 255), (255, 240, 245)]

rng = random.Random(7)


def font_for(text, max_w, draw, start):
    size = start
    while size > 8:
        f = ImageFont.truetype(FONT, size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return ImageFont.truetype(FONT, 8)


def design(px, text, *, shape, fill, ink, edge_text=False, background=None):
    """Draw a sticker design on a px*px canvas. Transparent outside the shape
    unless `background` is given (a file whose background wasn't removed)."""
    img = Image.new("RGBA", (px, px), background + (255,) if background else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = int(px * 0.05)
    box = (m, m, px - m, px - m)
    if shape == "circle":
        d.ellipse(box, fill=fill)
    else:
        d.rounded_rectangle(box, radius=int(px * 0.12), fill=fill)
    inner = px - 2 * m
    if edge_text:
        # Text runs right out to the edge of the design: the cut line will clip it.
        f = font_for(text, inner * 1.02, d, int(px * 0.4))
        w = d.textlength(text, font=f)
        d.text(((px - w) / 2, m - int(px * 0.01)), text, font=f, fill=ink)
    else:
        f = font_for(text, inner * 0.62, d, int(px * 0.2))
        w = d.textlength(text, font=f)
        bb = d.textbbox((0, 0), text, font=f)
        d.text(((px - w) / 2, (px - (bb[3] - bb[1])) / 2 - bb[1]), text, font=f, fill=ink)
        # A simple emblem under the words so it reads as artwork, not a label.
        r = px * 0.07
        cy = px * 0.72
        d.ellipse((px / 2 - r, cy - r, px / 2 + r, cy + r), outline=ink, width=max(2, px // 120))
    return img


def make(kind, idx, size_in):
    text = rng.choice(WORDS)
    shape = rng.choice(["circle", "rounded"])
    fill = rng.choice(LIGHT)
    ink = rng.choice(DARK)
    good_px = size_in * 300
    issues = []
    if kind == "clean":
        img = design(good_px, text, shape=shape, fill=fill, ink=ink)
    elif kind == "low_resolution":
        img = design(size_in * 60, text, shape=shape, fill=fill, ink=ink)
        issues = ["low_resolution"]
    elif kind == "background_not_removed":
        img = design(good_px, text, shape=shape, fill=fill, ink=ink, background=rng.choice([(255, 255, 255), (20, 20, 20), (120, 200, 230)]))
        issues = ["background_not_removed"]
    elif kind == "text_near_edge":
        img = design(good_px, text, shape="rounded", fill=fill, ink=ink, edge_text=True)
        issues = ["text_near_edge"]
    elif kind == "upscaled_blurry":
        small = design(70, text, shape=shape, fill=fill, ink=ink)
        img = small.resize((good_px, good_px), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))
        issues = ["upscaled_blurry"]
    elif kind == "low_contrast":
        img = design(good_px, text, shape=shape, fill=(255, 255, 255), ink=rng.choice([(250, 240, 170), (225, 235, 245), (240, 228, 228)]))
        issues = ["low_contrast"]
    elif kind == "combo_lowres_background":
        img = design(size_in * 60, text, shape=shape, fill=fill, ink=ink, background=(255, 255, 255))
        issues = ["low_resolution", "background_not_removed"]
    elif kind == "combo_blurry_edge":
        small = design(70, text, shape="rounded", fill=fill, ink=ink, edge_text=True)
        img = small.resize((good_px, good_px), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))
        issues = ["upscaled_blurry", "text_near_edge"]
    else:
        raise ValueError(kind)
    name = f"art_{idx:02d}.png"
    if issues == ["background_not_removed"] or kind == "combo_lowres_background":
        img = img.convert("RGB")  # an opaque file, as a customer's JPG-turned-PNG would be
    img.save(OUT / "cases" / name, optimize=True)
    return {"file": name, "product": "die_cut_sticker", "width_in": size_in, "height_in": size_in, "issues": issues}


def main():
    (OUT / "cases").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "cases").glob("*.png"):
        old.unlink()
    plan = (["clean"] * 10 + ["low_resolution"] * 4 + ["background_not_removed"] * 4 + ["text_near_edge"] * 4
            + ["upscaled_blurry"] * 4 + ["low_contrast"] * 4 + ["combo_lowres_background", "combo_blurry_edge"])
    rng.shuffle(plan)
    cases = [make(kind, i + 1, rng.choice([3, 4])) for i, kind in enumerate(plan)]
    (OUT / "labels.json").write_text(json.dumps(cases, indent=1))
    print(f"{len(cases)} cases -> {OUT}")


if __name__ == "__main__":
    main()
