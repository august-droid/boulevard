"""
Boulevard — App Store / Play Store marketing mockup generator.

Produces simple, Spotify-style screenshots: one bold message per image, a phone
mockup centered, dark premium background. Logo: /assets/icon.png.

Outputs to /store_assets:
  - ios_*.png            (1290 x 2796)   App Store
  - play_*.png           (1080 x 1920)   Play Store phone
  - play_feature_graphic.png  (1024 x 500)
  - play_icon_512.png    (512 x 512)
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
OUT = ROOT / "store_assets"
OUT.mkdir(exist_ok=True)

LOGO_PATH = ASSETS / "icon.png"

# ------------------------------------------------------------------ fonts ----

FONT_PATHS = [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


# ----------------------------------------------------------------- colors ----
# Light, premium champagne-cream gradient. Dark phone mockups pop against it.
BG_TOP = (248, 244, 236)
BG_BOTTOM = (224, 217, 205)

# Text colors used on the light background
HEADLINE_DARK = (18, 18, 22)
SUB_DARK = (78, 75, 70)
LOGO_TEXT_DARK = (18, 18, 22)

ACCENT_PURPLE = (138, 92, 246)
ACCENT_BLUE = (96, 165, 250)
ACCENT_PINK = (244, 114, 182)
ACCENT_AMBER = (251, 191, 36)
ACCENT_GREEN = (74, 222, 128)
ACCENT_CYAN = (94, 234, 212)
ACCENT_RED = (239, 80, 90)

WHITE = (255, 255, 255)
DIM_WHITE = (230, 230, 230)
MUTED = (140, 140, 145)
PANEL = (22, 22, 26)
PANEL_LIGHT = (32, 32, 38)
GLASS = (60, 60, 68)


# ------------------------------------------------------------- primitives ----


def vertical_gradient(size, top, bottom) -> Image.Image:
    w, h = size
    img = Image.new("RGB", (w, h), top)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def radial_glow(size, color, intensity=180, radius_ratio=0.7) -> Image.Image:
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    max_r = int(min(w, h) * radius_ratio)
    steps = 60
    for i in range(steps, 0, -1):
        t = i / steps
        r = int(max_r * t)
        alpha = int(intensity * (1 - t) ** 2)
        d.ellipse(
            (cx - r, cy - r, cx + r, cy + r),
            fill=(color[0], color[1], color[2], alpha),
        )
    return img.filter(ImageFilter.GaussianBlur(40))


def text_w(draw, text, fnt):
    l, t, r, b = draw.textbbox((0, 0), text, font=fnt)
    return r - l


def draw_centered_text(draw, text, y, fnt, fill=WHITE, canvas_w=0):
    tw = text_w(draw, text, fnt)
    draw.text(((canvas_w - tw) / 2, y), text, font=fnt, fill=fill)


def draw_multiline_centered(draw, lines, y, fnt, fill=WHITE, canvas_w=0, line_gap=10):
    bb = draw.textbbox((0, 0), "Ag", font=fnt)
    line_h = bb[3] - bb[1]
    cy = y
    for line in lines:
        tw = text_w(draw, line, fnt)
        draw.text(((canvas_w - tw) / 2, cy), line, font=fnt, fill=fill)
        cy += line_h + line_gap
    return cy


# ----------------------------------------------------- drawn glyph icons ----
# We draw all icons as vector shapes rather than rely on font fallbacks for
# unicode pictographs (✦ ♡ ⚡ etc.). Every icon is sized in a fixed box
# (cx, cy) with radius r.


def icon_sparkle(d, cx, cy, r, color=WHITE, width=None):
    """A 4-pointed sparkle / star with concave sides — reads as a star at any size."""
    # Build a single 8-point polygon with inner/outer radii so the star has
    # a filled body that stays legible at small sizes.
    inner = r * 0.42
    pts = []
    # Tip angles: top, right, bottom, left (clockwise)
    tips = [(0, -1), (1, 0), (0, 1), (-1, 0)]
    inners = [(0.7, -0.7), (0.7, 0.7), (-0.7, 0.7), (-0.7, -0.7)]
    for i in range(4):
        tx, ty = tips[i]
        pts.append((cx + tx * r, cy + ty * r))
        ix, iy = inners[i]
        pts.append((cx + ix * inner, cy + iy * inner))
    d.polygon(pts, fill=color)


def icon_heart(d, cx, cy, r, color=ACCENT_PINK, filled=True, width=4):
    """A classic heart: two overlapping disks + downward triangle that meets them."""
    lobe_r = int(r * 0.6)
    lcx = cx - int(r * 0.4)
    rcx = cx + int(r * 0.4)
    lcy = cy - int(r * 0.25)
    d.ellipse((lcx - lobe_r, lcy - lobe_r, lcx + lobe_r, lcy + lobe_r), fill=color)
    d.ellipse((rcx - lobe_r, lcy - lobe_r, rcx + lobe_r, lcy + lobe_r), fill=color)
    # Triangle: tangent to the outer sides of each lobe at the lobe vertical
    # midline, meeting at a point below.
    d.polygon(
        [
            (lcx - lobe_r, lcy + 2),
            (rcx + lobe_r, lcy + 2),
            (cx, cy + int(r * 0.95)),
        ],
        fill=color,
    )


def icon_target(d, cx, cy, r, color=ACCENT_GREEN, width=5):
    # Three concentric circles
    for rr in (r, int(r * 0.62), int(r * 0.28)):
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=color, width=width)
    d.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=color)


def icon_bolt(d, cx, cy, r, color=ACCENT_AMBER):
    pts = [
        (cx - r * 0.3, cy - r),
        (cx + r * 0.5, cy - r * 0.15),
        (cx + r * 0.05, cy - r * 0.15),
        (cx + r * 0.5, cy + r),
        (cx - r * 0.5, cy + r * 0.1),
        (cx, cy + r * 0.1),
    ]
    d.polygon(pts, fill=color)


def icon_cloud(d, cx, cy, r, color=ACCENT_BLUE):
    # Cloud silhouette built from 4 overlapping ovals
    base_w = int(r * 1.7)
    base_h = int(r * 0.55)
    d.ellipse(
        (cx - base_w // 2, cy + r * 0.05, cx + base_w // 2, cy + r * 0.05 + base_h),
        fill=color,
    )
    blob_r = int(r * 0.55)
    d.ellipse(
        (cx - r * 0.65, cy - r * 0.4, cx - r * 0.65 + blob_r * 2, cy - r * 0.4 + blob_r * 2),
        fill=color,
    )
    d.ellipse(
        (cx - r * 0.1, cy - r * 0.65, cx - r * 0.1 + blob_r * 2.2, cy - r * 0.65 + blob_r * 2.2),
        fill=color,
    )


def icon_sun(d, cx, cy, r, color=ACCENT_AMBER):
    # Center disk + rays
    cr = int(r * 0.45)
    d.ellipse((cx - cr, cy - cr, cx + cr, cy + cr), fill=color)
    for i in range(8):
        ang = i * (math.pi / 4)
        x1 = cx + math.cos(ang) * r * 0.6
        y1 = cy + math.sin(ang) * r * 0.6
        x2 = cx + math.cos(ang) * r
        y2 = cy + math.sin(ang) * r
        d.line((x1, y1, x2, y2), fill=color, width=6)


def icon_moon(d, cx, cy, r, color=ACCENT_PURPLE):
    """Crescent moon as a single polygon — no background-cutout trick needed."""
    pts = []
    # Outer arc: left side of full circle, points from top → left → bottom
    for i in range(31):
        a = math.pi / 2 + (math.pi) * (i / 30)
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    # Inner arc: a smaller offset arc curving back from bottom → top
    inner_r = r * 0.85
    offset = r * 0.35
    for i in range(31):
        a = math.pi / 2 + (math.pi) * (1 - i / 30)
        pts.append((cx + offset + math.cos(a) * inner_r, cy + math.sin(a) * inner_r))
    d.polygon(pts, fill=color)


def icon_rain(d, cx, cy, r, color=ACCENT_BLUE):
    # smaller cloud + droplets
    icon_cloud(d, cx, cy - int(r * 0.15), int(r * 0.75), color=color)
    for dx in (-r * 0.4, 0, r * 0.4):
        sx = cx + dx
        sy = cy + r * 0.55
        d.polygon(
            [(sx, sy - r * 0.05), (sx - r * 0.1, sy + r * 0.25), (sx + r * 0.1, sy + r * 0.25)],
            fill=color,
        )


def icon_smile(d, cx, cy, r, color=ACCENT_AMBER):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    eye_r = max(3, r // 8)
    d.ellipse(
        (cx - r * 0.35 - eye_r, cy - r * 0.2 - eye_r, cx - r * 0.35 + eye_r, cy - r * 0.2 + eye_r),
        fill=(20, 20, 24),
    )
    d.ellipse(
        (cx + r * 0.35 - eye_r, cy - r * 0.2 - eye_r, cx + r * 0.35 + eye_r, cy - r * 0.2 + eye_r),
        fill=(20, 20, 24),
    )
    d.arc(
        (cx - r * 0.55, cy - r * 0.1, cx + r * 0.55, cy + r * 0.55),
        start=20,
        end=160,
        fill=(20, 20, 24),
        width=max(3, r // 8),
    )


def icon_play(d, cx, cy, r, color=WHITE):
    d.polygon(
        [(cx - r * 0.45, cy - r * 0.7), (cx - r * 0.45, cy + r * 0.7), (cx + r * 0.75, cy)],
        fill=color,
    )


def icon_pause(d, cx, cy, r, color=(8, 8, 10)):
    w = max(3, int(r * 0.25))
    h = int(r * 1.3)
    d.rounded_rectangle((cx - r * 0.45 - w / 2, cy - h / 2, cx - r * 0.45 + w / 2, cy + h / 2), radius=3, fill=color)
    d.rounded_rectangle((cx + r * 0.45 - w / 2, cy - h / 2, cx + r * 0.45 + w / 2, cy + h / 2), radius=3, fill=color)


def icon_note(d, cx, cy, r, color=ACCENT_BLUE):
    # quarter note silhouette
    head_r = int(r * 0.5)
    hx = cx - r * 0.3
    hy = cy + r * 0.3
    d.ellipse((hx - head_r, hy - head_r * 0.8, hx + head_r, hy + head_r * 0.8), fill=color)
    d.rectangle((hx + head_r - 6, hy - r * 1.1, hx + head_r, hy), fill=color)


def icon_down_arrow(d, cx, cy, r, color=ACCENT_GREEN):
    d.line((cx, cy - r * 0.6, cx, cy + r * 0.6), fill=color, width=6)
    d.polygon(
        [(cx - r * 0.4, cy + r * 0.15), (cx + r * 0.4, cy + r * 0.15), (cx, cy + r * 0.7)],
        fill=color,
    )


def icon_clock(d, cx, cy, r, color=ACCENT_AMBER, width=5):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=width)
    d.line((cx, cy, cx, cy - r * 0.55), fill=color, width=width)
    d.line((cx, cy, cx + r * 0.45, cy + r * 0.1), fill=color, width=width)


def icon_user(d, cx, cy, r, color=WHITE, width=4):
    d.ellipse((cx - r * 0.4, cy - r * 0.85, cx + r * 0.4, cy - r * 0.05), outline=color, width=width)
    d.arc((cx - r * 0.85, cy - r * 0.1, cx + r * 0.85, cy + r * 1.4), start=180, end=360, fill=color, width=width)


def icon_search(d, cx, cy, r, color=MUTED, width=4):
    d.ellipse((cx - r * 0.85, cy - r * 0.85, cx + r * 0.25, cy + r * 0.25), outline=color, width=width)
    d.line((cx + r * 0.05, cy + r * 0.05, cx + r * 0.7, cy + r * 0.7), fill=color, width=width)


def icon_plus(d, cx, cy, r, color=WHITE, width=5):
    d.line((cx - r * 0.7, cy, cx + r * 0.7, cy), fill=color, width=width)
    d.line((cx, cy - r * 0.7, cx, cy + r * 0.7), fill=color, width=width)


def icon_home(d, cx, cy, r, color=WHITE, width=4):
    pts = [(cx - r * 0.8, cy + r * 0.2), (cx, cy - r * 0.7), (cx + r * 0.8, cy + r * 0.2)]
    d.line(pts, fill=color, width=width)
    d.rectangle((cx - r * 0.6, cy + r * 0.2, cx + r * 0.6, cy + r * 0.8), outline=color, width=width)


def icon_library(d, cx, cy, r, color=WHITE, width=4):
    for i, dx in enumerate((-r * 0.5, -r * 0.15, r * 0.2)):
        d.rectangle((cx + dx - r * 0.08, cy - r * 0.65, cx + dx + r * 0.08, cy + r * 0.7), outline=color, width=width)


# --------------------------------------------------------------- backgrounds


def make_background(w, h, accent=ACCENT_PURPLE) -> Image.Image:
    """Light champagne-cream background with a soft accent tint glow.

    The phone mockup is dark, so the cream backdrop gives strong contrast.
    Accent glow is intentionally desaturated to read as warmth, not color.
    """
    base = vertical_gradient((w, h), BG_TOP, BG_BOTTOM).convert("RGBA")
    # Desaturate accent for use on a light surface (avoid neon over cream).
    soft_accent = (
        min(255, int(accent[0] * 0.55 + 200 * 0.45)),
        min(255, int(accent[1] * 0.55 + 200 * 0.45)),
        min(255, int(accent[2] * 0.55 + 200 * 0.45)),
    )
    glow = radial_glow((w, h), soft_accent, intensity=110, radius_ratio=0.7)
    offset = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    offset.alpha_composite(glow, dest=(0, -int(h * 0.18)))
    base.alpha_composite(offset)
    glow2 = radial_glow((w, h), soft_accent, intensity=50, radius_ratio=0.5)
    offset2 = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    offset2.alpha_composite(glow2, dest=(0, int(h * 0.3)))
    base.alpha_composite(offset2)
    return base


# -------------------------------------------------- phone frame + screen ----


def phone_frame(width: int, height: int) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """Return (frame_image_RGBA, inner_screen_bbox_within_returned_image).

    The returned image is exactly (width, height); shadow is rendered into a
    separate larger canvas via `phone_with_shadow`.
    """
    bezel = max(14, width // 70)
    radius = max(60, width // 11)
    inner_radius = radius - bezel // 2

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Phone body (dark with extremely subtle inner highlight)
    d.rounded_rectangle((0, 0, width, height), radius=radius, fill=(14, 14, 18, 255))
    # Subtle outer rim — slightly darker than body so it reads as material edge
    d.rounded_rectangle(
        (0, 0, width, height),
        radius=radius,
        outline=(40, 40, 46, 255),
        width=2,
    )
    # Screen area (will be replaced by screen content)
    inner = (bezel, bezel, width - bezel, height - bezel)
    d.rounded_rectangle(inner, radius=inner_radius, fill=(0, 0, 0, 255))

    return img, inner


def phone_with_shadow(frame_img: Image.Image) -> tuple[Image.Image, tuple[int, int]]:
    """Place the frame on a canvas with a centered soft drop shadow.

    Returns the canvas and the (x, y) offset of the frame within it.
    """
    fw, fh = frame_img.size
    pad = 80
    canvas = Image.new("RGBA", (fw + pad * 2, fh + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    radius = max(60, fw // 11)
    sd.rounded_rectangle(
        (pad, pad + 30, pad + fw, pad + fh + 30), radius=radius, fill=(0, 0, 0, 180)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(frame_img, dest=(pad, pad))
    return canvas, (pad, pad)


def draw_status_bar(draw, x, y, w, fnt_small):
    color = WHITE
    draw.text((x + 36, y + 4), "9:41", font=fnt_small, fill=color)
    rx = x + w - 36
    bw, bh = 56, 22
    bx = rx - bw
    by = y + 14
    draw.rounded_rectangle((bx, by, bx + bw, by + bh), radius=6, outline=color, width=2)
    draw.rectangle((bx + bw + 2, by + 6, bx + bw + 6, by + bh - 6), fill=color)
    draw.rounded_rectangle((bx + 3, by + 3, bx + bw - 6, by + bh - 3), radius=3, fill=color)
    # Wifi
    wx = bx - 48
    wy = by + 4
    for r in (16, 11, 6):
        draw.arc((wx - r, wy - r // 2, wx + r, wy + r), start=210, end=330, fill=color, width=3)
    draw.ellipse((wx - 3, wy + 6, wx + 3, wy + 12), fill=color)
    # Signal bars
    sx = wx - 60
    sy = by
    for i in range(4):
        h = 5 + i * 5
        draw.rounded_rectangle(
            (sx + i * 9, sy + (bh - h) - 2, sx + i * 9 + 6, sy + bh - 2),
            radius=2,
            fill=color,
        )


def draw_bottom_nav(draw, w, h, active="home"):
    # tab bar height ~ 110
    nav_h = int(h * 0.07)
    nav_y = h - nav_h - int(h * 0.015)
    items = [("home", icon_home, "Home"), ("search", icon_search, "Search"), ("create", icon_plus, "Create"), ("library", icon_library, "Library"), ("profile", icon_user, "Profile")]
    fnt = font(int(w * 0.025), bold=True)
    col_w = w // len(items)
    for i, (key, fn, label) in enumerate(items):
        cx = col_w * i + col_w // 2
        cy = nav_y + nav_h // 2 - int(w * 0.018)
        color = WHITE if active == key else MUTED
        fn(draw, cx, cy, int(w * 0.03), color=color, width=4)
        tw = text_w(draw, label, fnt)
        draw.text((cx - tw // 2, cy + int(w * 0.04)), label, font=fnt, fill=color)


# --------------------------------------------------- app screen renderers ----


def _new_screen(w, h, top_color, bottom_color):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    grad = vertical_gradient((w, h), top_color, bottom_color).convert("RGBA")
    img.alpha_composite(grad)
    return img


def screen_player(w, h) -> Image.Image:
    img = _new_screen(w, h, (24, 16, 38), (4, 4, 8))
    d = ImageDraw.Draw(img)

    fnt_small = font(28, bold=False)
    draw_status_bar(d, 0, 8, w, fnt_small)

    pad = int(w * 0.07)

    # AI MUSIC label with drawn sparkle
    fnt_label = font(30, bold=True)
    label_text = "AI MUSIC"
    label_w = text_w(d, label_text, fnt_label)
    icon_sparkle(d, w // 2 - label_w // 2 - 30, 94, 20)
    d.text((w // 2 - label_w // 2 + 12, 78), label_text, font=fnt_label, fill=WHITE)

    # AI GENERATED pill
    badge_text = "AI GENERATED"
    fnt_badge = font(22, bold=True)
    bw_ = text_w(d, badge_text, fnt_badge) + 50
    bh_ = 50
    bx = (w - bw_) // 2
    by = 145
    d.rounded_rectangle((bx, by, bx + bw_, by + bh_), radius=bh_ // 2, fill=(80, 60, 130, 255), outline=(200, 180, 255), width=2)
    d.text((bx + 25, by + 13), badge_text, font=fnt_badge, fill=WHITE)

    # Album art
    art_size = w - pad * 2
    art_x = pad
    art_y = 230
    art = Image.new("RGB", (art_size, art_size), (0, 0, 0))
    ag = ImageDraw.Draw(art)
    # moody forest gradient
    for y in range(art_size):
        t = y / art_size
        r = int(30 + 40 * (1 - t))
        g = int(38 + 60 * (1 - t))
        b = int(35 + 30 * (1 - t))
        ag.line((0, y, art_size, y), fill=(r, g, b))
    # silhouette
    for x in range(art_size):
        nx = x / art_size
        h_tree = int(art_size * (0.55 + 0.25 * math.sin(nx * 12 + 2)))
        ag.line((x, art_size - h_tree, x, art_size), fill=(6, 10, 12))
    overlay = Image.new("RGBA", (art_size, art_size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.ellipse(
        (art_size * 0.25, art_size * 0.1, art_size * 0.75, art_size * 0.55),
        fill=(255, 200, 120, 120),
    )
    overlay = overlay.filter(ImageFilter.GaussianBlur(80))
    art.paste(overlay, (0, 0), overlay)
    mask = Image.new("L", (art_size, art_size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, art_size, art_size), radius=40, fill=255)
    art_rgba = Image.new("RGBA", (art_size, art_size))
    art_rgba.paste(art, (0, 0))
    art_rgba.putalpha(mask)
    img.alpha_composite(art_rgba, dest=(art_x, art_y))

    title_y = art_y + art_size + 50
    fnt_title = font(72, bold=True)
    d.text((pad, title_y), "Forest Whisper", font=fnt_title, fill=WHITE)
    fnt_sub = font(34, bold=False)
    d.text((pad, title_y + 92), "AI Music", font=fnt_sub, fill=MUTED)
    # heart
    icon_heart(d, w - pad - 30, title_y + 50, 36, color=ACCENT_PINK, filled=True)

    # waveform
    wfy = title_y + 200
    wfh = 60
    wfx = pad
    wf_w = w - pad * 2
    bars = 56
    for i in range(bars):
        nx = i / bars
        amp = (math.sin(nx * 22) + math.sin(nx * 8 + 1.2)) * 0.5 + 1.0
        bar_h = int(8 + amp * (wfh - 10))
        cx_ = wfx + int(nx * wf_w)
        col = WHITE if i < bars * 0.45 else (130, 130, 140)
        d.rounded_rectangle(
            (cx_, wfy + (wfh - bar_h) // 2, cx_ + 6, wfy + (wfh + bar_h) // 2),
            radius=3,
            fill=col,
        )

    fnt_time = font(28, bold=False)
    d.text((pad, wfy + wfh + 16), "1:08", font=fnt_time, fill=MUTED)
    rtxt = "3:12"
    rtw = text_w(d, rtxt, fnt_time)
    d.text((w - pad - rtw, wfy + wfh + 16), rtxt, font=fnt_time, fill=MUTED)

    # Controls
    ctrl_y = wfy + wfh + 140
    cx = w // 2
    pr = 72
    d.ellipse((cx - pr, ctrl_y - pr, cx + pr, ctrl_y + pr), fill=WHITE)
    icon_pause(d, cx, ctrl_y, pr)
    # prev / next
    for sign, dx in [(-1, -160), (1, 160)]:
        bx = cx + dx
        if sign < 0:
            d.polygon(
                [(bx + 18, ctrl_y - 26), (bx + 18, ctrl_y + 26), (bx - 18, ctrl_y)],
                fill=WHITE,
            )
            d.rounded_rectangle(
                (bx - 26, ctrl_y - 26, bx - 18, ctrl_y + 26), radius=2, fill=WHITE
            )
        else:
            d.polygon(
                [(bx - 18, ctrl_y - 26), (bx - 18, ctrl_y + 26), (bx + 18, ctrl_y)],
                fill=WHITE,
            )
            d.rounded_rectangle(
                (bx + 18, ctrl_y - 26, bx + 26, ctrl_y + 26), radius=2, fill=WHITE
            )
    # Shuffle / repeat — simple X-ish shape
    for dx in (-280, 280):
        bx = cx + dx
        d.line((bx - 18, ctrl_y - 8, bx + 18, ctrl_y + 8), fill=MUTED, width=4)
        d.line((bx - 18, ctrl_y + 8, bx + 18, ctrl_y - 8), fill=MUTED, width=4)

    # Vibe chip
    chip_y = ctrl_y + 150
    chip_w = int(w * 0.7)
    chip_x = (w - chip_w) // 2
    d.rounded_rectangle(
        (chip_x, chip_y, chip_x + chip_w, chip_y + 80),
        radius=40,
        fill=PANEL_LIGHT,
        outline=GLASS,
        width=2,
    )
    icon_cloud(d, chip_x + 50, chip_y + 40, 22, color=ACCENT_BLUE)
    fnt_chip = font(30, bold=True)
    d.text((chip_x + 95, chip_y + 22), "Vibe: Chill", font=fnt_chip, fill=WHITE)
    # caret
    d.polygon(
        [
            (chip_x + chip_w - 50, chip_y + 32),
            (chip_x + chip_w - 30, chip_y + 32),
            (chip_x + chip_w - 40, chip_y + 50),
        ],
        fill=MUTED,
    )

    draw_bottom_nav(d, w, h, active="home")
    return img


def screen_vibe_grid(w, h) -> Image.Image:
    img = _new_screen(w, h, (16, 20, 36), (4, 4, 10))
    d = ImageDraw.Draw(img)

    fnt_small = font(28, bold=False)
    draw_status_bar(d, 0, 8, w, fnt_small)

    pad = int(w * 0.07)

    fnt_h = font(74, bold=True)
    d.text((pad, 110), "Create a vibe", font=fnt_h, fill=WHITE)
    fnt_sub = font(34, bold=False)
    d.text((pad, 200), "Tell our AI how you want to feel.", font=fnt_sub, fill=MUTED)

    cards = [
        ("Focus", ACCENT_GREEN, icon_target),
        ("Workout", ACCENT_AMBER, icon_bolt),
        ("Chill", ACCENT_BLUE, icon_cloud),
        ("Energize", ACCENT_PINK, icon_sparkle),
        ("Happy", ACCENT_AMBER, icon_smile),
        ("Romantic", ACCENT_PINK, icon_heart),
        ("Sad", ACCENT_BLUE, icon_rain),
        ("Sleep", ACCENT_PURPLE, icon_moon),
    ]
    cols = 2
    gap = 28
    card_w = (w - pad * 2 - gap) // cols
    card_h = int(card_w * 0.55)
    start_y = 290
    for i, (label, color, fn) in enumerate(cards):
        col = i % cols
        row = i // cols
        cx = pad + col * (card_w + gap)
        cy = start_y + row * (card_h + gap)
        d.rounded_rectangle(
            (cx, cy, cx + card_w, cy + card_h),
            radius=28,
            fill=PANEL,
            outline=(50, 50, 56),
            width=2,
        )
        icon_size = 36
        ic_x = cx + 60
        ic_y = cy + card_h // 2
        fn(d, ic_x, ic_y, icon_size, color=color)
        fnt_label = font(40, bold=True)
        d.text((cx + 130, cy + card_h // 2 - 26), label, font=fnt_label, fill=WHITE)

    # Surprise me button below grid
    last_y = start_y + 4 * (card_h + gap)
    sy = last_y + 10
    sw = w - pad * 2
    sx = pad
    sh = 100
    d.rounded_rectangle(
        (sx, sy, sx + sw, sy + sh),
        radius=50,
        fill=PANEL_LIGHT,
        outline=(70, 70, 80),
        width=2,
    )
    icon_sparkle(d, sx + 80, sy + sh // 2, 18, color=WHITE)
    fnt_btn = font(36, bold=True)
    btn_text = "Surprise me"
    tw = text_w(d, btn_text, fnt_btn)
    d.text(((w - tw) / 2 + 10, sy + 28), btn_text, font=fnt_btn, fill=WHITE)
    fnt_btn_sub = font(22, bold=False)
    sub_text = "AI will create something amazing"
    tw2 = text_w(d, sub_text, fnt_btn_sub)
    d.text(((w - tw2) / 2, sy + sh + 18), sub_text, font=fnt_btn_sub, fill=MUTED)

    # Trending vibes row — fills the rest of the screen
    section_y = sy + sh + 80
    fnt_sec = font(38, bold=True)
    d.text((pad, section_y), "Trending vibes", font=fnt_sec, fill=WHITE)
    cards2 = [
        ("Lo-fi study", ACCENT_BLUE),
        ("Deep house", ACCENT_PURPLE),
        ("Rainy mornings", ACCENT_CYAN),
    ]
    cy2 = section_y + 70
    cw2 = (w - pad * 2 - gap * 2) // 3
    ch2 = int(cw2 * 1.05)
    for i, (label, color) in enumerate(cards2):
        cx2 = pad + i * (cw2 + gap)
        # Card gradient art
        art = Image.new("RGB", (cw2, ch2), (10, 10, 14))
        ag = ImageDraw.Draw(art)
        for yy in range(ch2):
            t = yy / ch2
            r2 = int(color[0] * (0.3 + 0.5 * (1 - t)))
            g2 = int(color[1] * (0.3 + 0.5 * (1 - t)))
            b2 = int(color[2] * (0.5 + 0.4 * t))
            ag.line((0, yy, cw2, yy), fill=(r2, g2, b2))
        m2 = Image.new("L", (cw2, ch2), 0)
        md2 = ImageDraw.Draw(m2)
        md2.rounded_rectangle((0, 0, cw2, ch2), radius=24, fill=255)
        art_rgba = Image.new("RGBA", (cw2, ch2))
        art_rgba.paste(art, (0, 0))
        art_rgba.putalpha(m2)
        img.alpha_composite(art_rgba, dest=(cx2, cy2))
        fnt_l = font(28, bold=True)
        # multi-line label
        d.text((cx2 + 20, cy2 + ch2 - 60), label, font=fnt_l, fill=WHITE)

    draw_bottom_nav(d, w, h, active="create")
    return img


def screen_generating(w, h) -> Image.Image:
    img = _new_screen(w, h, (18, 16, 36), (4, 4, 10))
    d = ImageDraw.Draw(img)

    fnt_small = font(28, bold=False)
    draw_status_bar(d, 0, 8, w, fnt_small)

    fnt_h = font(64, bold=True)
    title = "Creating your music"
    tw = text_w(d, title, fnt_h)
    d.text(((w - tw) / 2, 260), title, font=fnt_h, fill=WHITE)
    fnt_sub = font(32, bold=False)
    sub = "Our AI is generating the perfect mix..."
    tw = text_w(d, sub, fnt_sub)
    d.text(((w - tw) / 2, 350), sub, font=fnt_sub, fill=MUTED)

    cx, cy = w // 2, int(h * 0.5)
    for ring, r_ratio, color in [
        (0, 0.42, ACCENT_GREEN),
        (1, 0.33, ACCENT_BLUE),
        (2, 0.24, ACCENT_PURPLE),
    ]:
        r = int(w * r_ratio)
        n = 56 - ring * 10
        for i in range(n):
            a = (i / n) * 2 * math.pi + ring * 0.5
            x = cx + r * math.cos(a)
            y = cy + r * math.sin(a)
            size = 3 + (i % 4)
            d.ellipse((x - size, y - size, x + size, y + size), fill=color)

    # center sparkle (drawn)
    icon_sparkle(d, cx, cy, 70, color=WHITE)

    # Vibe chips at bottom — opaque tinted glass look
    chips_y = int(h * 0.78)
    chips = ["Atmospheric", "Chill", "Melodic"]
    fnt_chip = font(30, bold=True)
    spacing = 24
    widths = [text_w(d, c, fnt_chip) + 60 for c in chips]
    total = sum(widths) + spacing * (len(chips) - 1)
    cx0 = (w - total) // 2
    for label, cw in zip(chips, widths):
        d.rounded_rectangle(
            (cx0, chips_y, cx0 + cw, chips_y + 70),
            radius=35,
            fill=(40, 40, 56, 255),
            outline=(110, 110, 130, 255),
            width=2,
        )
        d.text((cx0 + 30, chips_y + 18), label, font=fnt_chip, fill=WHITE)
        cx0 += cw + spacing

    # cancel
    cy0 = int(h * 0.89)
    bw = int(w * 0.62)
    bx = (w - bw) // 2
    d.rounded_rectangle(
        (bx, cy0, bx + bw, cy0 + 100),
        radius=50,
        fill=PANEL_LIGHT,
        outline=GLASS,
        width=2,
    )
    fnt_btn = font(34, bold=True)
    txt = "Cancel"
    tw = text_w(d, txt, fnt_btn)
    d.text(((w - tw) / 2, cy0 + 30), txt, font=fnt_btn, fill=WHITE)
    return img


def screen_for_you(w, h) -> Image.Image:
    img = _new_screen(w, h, (22, 14, 30), (4, 4, 8))
    d = ImageDraw.Draw(img)

    fnt_small = font(28, bold=False)
    draw_status_bar(d, 0, 8, w, fnt_small)

    pad = int(w * 0.07)

    # AI MUSIC eyebrow with drawn sparkle
    icon_sparkle(d, pad + 22, 118, 22)
    fnt_label = font(28, bold=True)
    d.text((pad + 60, 102), "AI MUSIC", font=fnt_label, fill=WHITE)

    fnt_h = font(86, bold=True)
    d.text((pad, 160), "For You", font=fnt_h, fill=WHITE)
    fnt_sub = font(34, bold=False)
    d.text((pad, 270), "Music made for your taste.", font=fnt_sub, fill=MUTED)

    cy = 360
    card_w = w - pad * 2
    card_h = 280
    art_grad = Image.new("RGB", (card_w, card_h), (10, 10, 14))
    ag = ImageDraw.Draw(art_grad)
    for x in range(card_w):
        t = x / card_w
        r = int(40 + 110 * t)
        g = int(15 + 30 * t)
        b = int(50 + 100 * (1 - t))
        ag.line((x, 0, x, card_h), fill=(r, g, b))
    for x in range(card_w):
        nx = x / card_w
        y = card_h // 2 + int(40 * math.sin(nx * 18))
        ag.line((x, y - 2, x, y + 2), fill=(255, 200, 220))
    mask = Image.new("L", (card_w, card_h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, card_w, card_h), radius=30, fill=255)
    art_rgba = Image.new("RGBA", (card_w, card_h))
    art_rgba.paste(art_grad, (0, 0))
    art_rgba.putalpha(mask)
    img.alpha_composite(art_rgba, dest=(pad, cy))

    fnt_t = font(50, bold=True)
    d.text((pad + 40, cy + card_h - 115), "Daily Mix", font=fnt_t, fill=WHITE)
    fnt_t2 = font(28, bold=False)
    d.text((pad + 40, cy + card_h - 55), "Endless mix", font=fnt_t2, fill=DIM_WHITE)
    pr = 42
    pcx = pad + card_w - 80
    pcy = cy + card_h - 80
    d.ellipse((pcx - pr, pcy - pr, pcx + pr, pcy + pr), fill=WHITE)
    icon_play(d, pcx + 4, pcy, pr, color=(8, 8, 10))

    fnt_sec = font(40, bold=True)
    d.text((pad, cy + card_h + 55), "Keep listening", font=fnt_sec, fill=WHITE)

    items = [
        ("Focus Flow", "AI Mix", ACCENT_GREEN),
        ("Late Night Drive", "AI Mix", ACCENT_PURPLE),
        ("Energy Boost", "AI Mix", ACCENT_AMBER),
        ("Sunset Memories", "AI Mix", ACCENT_PINK),
    ]
    iy = cy + card_h + 135
    for name, sub, accent in items:
        ts = 110
        thumb = Image.new("RGB", (ts, ts), (15, 15, 22))
        td = ImageDraw.Draw(thumb)
        for yy in range(ts):
            t = yy / ts
            r = int(accent[0] * (0.25 + 0.5 * t))
            g = int(accent[1] * (0.25 + 0.5 * t))
            b = int(accent[2] * (0.35 + 0.4 * (1 - t)))
            td.line((0, yy, ts, yy), fill=(r, g, b))
        tmask = Image.new("L", (ts, ts), 0)
        tmd = ImageDraw.Draw(tmask)
        tmd.rounded_rectangle((0, 0, ts, ts), radius=18, fill=255)
        thumb_rgba = Image.new("RGBA", (ts, ts))
        thumb_rgba.paste(thumb, (0, 0))
        thumb_rgba.putalpha(tmask)
        img.alpha_composite(thumb_rgba, dest=(pad, iy))

        fnt_n = font(36, bold=True)
        d.text((pad + ts + 30, iy + 18), name, font=fnt_n, fill=WHITE)
        fnt_s2 = font(28, bold=False)
        d.text((pad + ts + 30, iy + 64), sub, font=fnt_s2, fill=MUTED)
        pr2 = 28
        ppx = w - pad - 40
        ppy = iy + ts // 2
        d.ellipse(
            (ppx - pr2, ppy - pr2, ppx + pr2, ppy + pr2),
            outline=(255, 255, 255, 220),
            width=3,
        )
        icon_play(d, ppx + 3, ppy, pr2, color=WHITE)
        iy += ts + 30

    draw_bottom_nav(d, w, h, active="home")
    return img


def screen_library(w, h) -> Image.Image:
    img = _new_screen(w, h, (14, 18, 30), (4, 4, 8))
    d = ImageDraw.Draw(img)

    fnt_small = font(28, bold=False)
    draw_status_bar(d, 0, 8, w, fnt_small)

    pad = int(w * 0.07)
    fnt_h = font(80, bold=True)
    d.text((pad, 110), "Library", font=fnt_h, fill=WHITE)

    av_size = 92
    av_x = w - pad - av_size
    av_y = 130
    d.ellipse(
        (av_x, av_y, av_x + av_size, av_y + av_size),
        fill=(60, 50, 70),
        outline=(120, 100, 140),
        width=3,
    )
    icon_user(d, av_x + av_size // 2, av_y + av_size // 2 + 4, av_size // 2 - 12, color=WHITE, width=4)

    tabs = ["Songs", "Playlists", "Vibes", "Downloads"]
    ty = 240
    fnt_tab = font(32, bold=True)
    tx = pad
    for i, t in enumerate(tabs):
        tw = text_w(d, t, fnt_tab)
        bw = tw + 50
        if i == 0:
            d.rounded_rectangle((tx, ty, tx + bw, ty + 64), radius=32, fill=WHITE)
            d.text((tx + 25, ty + 14), t, font=fnt_tab, fill=(10, 10, 14))
        else:
            d.text((tx + 25, ty + 14), t, font=fnt_tab, fill=MUTED)
        tx += bw + 30

    items = [
        (icon_heart, "Liked Songs", "312 songs", ACCENT_PINK),
        (icon_sparkle, "Your Vibes", "8 vibes", ACCENT_PURPLE),
        (icon_note, "Playlists", "24 playlists", ACCENT_BLUE),
        (icon_down_arrow, "Downloads", "120 songs", ACCENT_GREEN),
        (icon_clock, "Recent", "50 songs", ACCENT_AMBER),
    ]
    iy = ty + 110
    for fn, name, sub, color in items:
        ts = 100
        d.rounded_rectangle(
            (pad, iy, pad + ts, iy + ts),
            radius=20,
            fill=(color[0] // 4, color[1] // 4, color[2] // 4, 255),
        )
        fn(d, pad + ts // 2, iy + ts // 2, ts // 3, color=color)
        fnt_n = font(38, bold=True)
        d.text((pad + ts + 30, iy + 18), name, font=fnt_n, fill=WHITE)
        fnt_s = font(28, bold=False)
        d.text((pad + ts + 30, iy + 62), sub, font=fnt_s, fill=MUTED)
        iy += ts + 24

    fnt_sec = font(36, bold=True)
    d.text((pad, iy + 24), "Recently played", font=fnt_sec, fill=WHITE)
    fnt_see = font(28, bold=False)
    see_text = "See all"
    sw = text_w(d, see_text, fnt_see)
    d.text((w - pad - sw, iy + 32), see_text, font=fnt_see, fill=ACCENT_PURPLE)

    # Recent rows (smaller)
    iy += 110
    recents = [
        ("Ocean Drive", "AI Music", ACCENT_BLUE),
        ("Deep Focus", "AI Music", ACCENT_GREEN),
        ("Sunset Memories", "AI Music", ACCENT_PINK),
        ("Midnight Reverie", "AI Music", ACCENT_PURPLE),
    ]
    for name, sub, accent in recents:
        ts = 90
        thumb = Image.new("RGB", (ts, ts), (15, 15, 22))
        td = ImageDraw.Draw(thumb)
        for yy in range(ts):
            t = yy / ts
            r = int(accent[0] * (0.25 + 0.45 * t))
            g = int(accent[1] * (0.25 + 0.45 * t))
            b = int(accent[2] * (0.35 + 0.4 * (1 - t)))
            td.line((0, yy, ts, yy), fill=(r, g, b))
        tmask = Image.new("L", (ts, ts), 0)
        tmd = ImageDraw.Draw(tmask)
        tmd.rounded_rectangle((0, 0, ts, ts), radius=16, fill=255)
        thumb_rgba = Image.new("RGBA", (ts, ts))
        thumb_rgba.paste(thumb, (0, 0))
        thumb_rgba.putalpha(tmask)
        img.alpha_composite(thumb_rgba, dest=(pad, iy))
        fnt_n = font(32, bold=True)
        d.text((pad + ts + 24, iy + 12), name, font=fnt_n, fill=WHITE)
        fnt_s = font(26, bold=False)
        d.text((pad + ts + 24, iy + 52), sub, font=fnt_s, fill=MUTED)
        pr2 = 26
        ppx = w - pad - 36
        ppy = iy + ts // 2
        d.ellipse((ppx - pr2, ppy - pr2, ppx + pr2, ppy + pr2), outline=WHITE, width=3)
        icon_play(d, ppx + 2, ppy, pr2, color=WHITE)
        iy += ts + 18

    draw_bottom_nav(d, w, h, active="library")
    return img


def screen_hero_logo(w, h) -> Image.Image:
    img = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    grad = vertical_gradient((w, h), (18, 18, 26), (0, 0, 0)).convert("RGBA")
    img.alpha_composite(grad)
    glow = radial_glow((w, h), (180, 170, 160), intensity=110, radius_ratio=0.6)
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)
    fnt_small = font(28, bold=False)
    draw_status_bar(d, 0, 8, w, fnt_small)

    logo = Image.open(LOGO_PATH).convert("RGBA")
    lsize = int(w * 0.6)
    logo = logo.resize((lsize, lsize), Image.LANCZOS)
    img.alpha_composite(logo, dest=((w - lsize) // 2, int(h * 0.24)))

    fnt_word = font(96, bold=True)
    word = "BOULEVARD"
    tw = text_w(d, word, fnt_word)
    d.text(((w - tw) / 2, int(h * 0.6)), word, font=fnt_word, fill=WHITE)

    fnt_tag = font(34, bold=False)
    tag = "AI music, made for you"
    tw = text_w(d, tag, fnt_tag)
    d.text(((w - tw) / 2, int(h * 0.685)), tag, font=fnt_tag, fill=DIM_WHITE)

    bw_ = int(w * 0.7)
    bx = (w - bw_) // 2
    by = int(h * 0.82)
    bh = 110
    d.rounded_rectangle((bx, by, bx + bw_, by + bh), radius=bh // 2, fill=WHITE)
    fnt_btn = font(40, bold=True)
    btn = "Start listening"
    tw = text_w(d, btn, fnt_btn)
    d.text(((w - tw) / 2, by + 32), btn, font=fnt_btn, fill=(8, 8, 10))
    return img


# ----------------------------------------------------- mockup composition ----


SCREEN_RENDERERS = {
    "player": screen_player,
    "vibe_grid": screen_vibe_grid,
    "generating": screen_generating,
    "for_you": screen_for_you,
    "library": screen_library,
    "hero": screen_hero_logo,
}


# Fixed reference resolution for all in-phone screen content. Screens are
# always laid out at this size, then resized to the actual phone's inner
# dimensions. This keeps layout identical between 1290x2796 and 1080x1920
# canvases (phone aspect is the same 9:19.5 → inner ~ 1116x2596).
REFERENCE_INNER = (1116, 2596)


def render_screen(screen_name: str, inner_size: tuple[int, int]) -> Image.Image:
    rw, rh = REFERENCE_INNER
    raw = SCREEN_RENDERERS[screen_name](rw, rh)
    flat = Image.new("RGBA", (rw, rh), (0, 0, 0, 255))
    flat.alpha_composite(raw)
    if inner_size != (rw, rh):
        flat = flat.resize(inner_size, Image.LANCZOS)
    return flat


def build_screenshot(
    canvas_w: int,
    canvas_h: int,
    headline_lines: Iterable[str],
    screen_name: str,
    accent=ACCENT_PURPLE,
    sub_line: str | None = None,
) -> Image.Image:
    bg = make_background(canvas_w, canvas_h, accent=accent)
    d = ImageDraw.Draw(bg)

    # Logo top-left
    logo = Image.open(LOGO_PATH).convert("RGBA")
    lsize = int(canvas_w * 0.095)
    logo = logo.resize((lsize, lsize), Image.LANCZOS)
    margin_x = int(canvas_w * 0.06)
    margin_y = int(canvas_h * 0.025)
    bg.alpha_composite(logo, dest=(margin_x, margin_y))
    fnt_word = font(int(canvas_w * 0.034), bold=True)
    d.text(
        (margin_x + lsize + 24, margin_y + lsize // 2 - int(canvas_w * 0.022)),
        "BOULEVARD",
        font=fnt_word,
        fill=LOGO_TEXT_DARK,
    )

    # Headline — shrink slightly when there are 3+ lines so it still fits
    line_count = len(list(headline_lines))
    base_ratio = 0.085 if line_count <= 2 else 0.072
    headline_size = int(canvas_w * base_ratio)
    fnt_h = font(headline_size, bold=True)
    headline_y = margin_y + lsize + int(canvas_w * 0.045)
    end_y = draw_multiline_centered(
        d,
        list(headline_lines),
        headline_y,
        fnt_h,
        fill=HEADLINE_DARK,
        canvas_w=canvas_w,
        line_gap=8,
    )
    if sub_line:
        fnt_sub = font(int(canvas_w * 0.032), bold=False)
        draw_centered_text(d, sub_line, end_y + 18, fnt_sub, fill=SUB_DARK, canvas_w=canvas_w)
        end_y += int(canvas_w * 0.05)

    # Phone
    phone_top = end_y + int(canvas_w * 0.05)
    phone_w = int(canvas_w * 0.78)
    phone_h = int(phone_w * 2.16)
    available_h = canvas_h - phone_top - int(canvas_w * 0.04)
    if phone_h > available_h:
        phone_h = available_h
        phone_w = int(phone_h / 2.16)

    frame, inner = phone_frame(phone_w, phone_h)
    inner_w = inner[2] - inner[0]
    inner_h = inner[3] - inner[1]
    screen_img = render_screen(screen_name, (inner_w, inner_h))
    mask = Image.new("L", (inner_w, inner_h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, inner_w, inner_h), radius=max(40, phone_w // 13), fill=255)
    screen_rgba = Image.new("RGBA", (inner_w, inner_h))
    screen_rgba.paste(screen_img.convert("RGB"), (0, 0))
    screen_rgba.putalpha(mask)
    frame.alpha_composite(screen_rgba, dest=(inner[0], inner[1]))

    # Dynamic island on top
    di_w = phone_w // 3
    di_h = max(36, phone_w // 28)
    di_x = inner[0] + (inner_w - di_w) // 2
    di_y = inner[1] + max(20, phone_w // 60)
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((di_x, di_y, di_x + di_w, di_y + di_h), radius=di_h // 2, fill=(0, 0, 0, 255))

    # Add shadow
    framed, _ = phone_with_shadow(frame)
    fw, fh = framed.size
    fx = (canvas_w - fw) // 2
    fy = phone_top - 60
    bg.alpha_composite(framed, dest=(fx, fy))
    return bg


# ----------------------------------------------------- screenshot specs ----

SCREENSHOT_SPECS = [
    {
        "name": "1_side_effect",
        "headline": ["SIDE EFFECT:", "YOU MIGHT QUIT", "SPOTIFY."],
        "sub": "Don't say we didn't warn you.",
        "screen": "for_you",
        "accent": ACCENT_PURPLE,
    },
    {
        "name": "2_tell_the_ai",
        "headline": ["TELL THE AI", "HOW YOU FEEL."],
        "sub": "It'll write the song. Right now.",
        "screen": "vibe_grid",
        "accent": ACCENT_BLUE,
    },
    {
        "name": "3_scary_good",
        "headline": ["YOUR SONG, BUILT", "IN SECONDS."],
        "sub": "It's scary how good this is.",
        "screen": "generating",
        "accent": ACCENT_GREEN,
    },
    {
        "name": "4_fake_artists",
        "headline": ["YOU'LL FALL FOR", "ARTISTS WHO", "AREN'T REAL."],
        "sub": "Forest Whisper doesn't exist. You'll still love them.",
        "screen": "player",
        "accent": ACCENT_PINK,
    },
    {
        "name": "5_forget_drake",
        "headline": ["YOU'LL FORGET", "DRAKE EXISTS."],
        "sub": "Taylor too. Sorry.",
        "screen": "library",
        "accent": ACCENT_AMBER,
    },
    {
        "name": "6_dont_blame_us",
        "headline": ["WE'RE NOT SAYING", "YOU SHOULD", "DOWNLOAD IT."],
        "sub": "But the music was too good not to release.",
        "screen": "hero",
        "accent": (180, 170, 155),
    },
]


def generate_ios():
    W, H = 1290, 2796
    for spec in SCREENSHOT_SPECS:
        img = build_screenshot(W, H, spec["headline"], spec["screen"], accent=spec["accent"], sub_line=spec["sub"])
        out = OUT / f"ios_{spec['name']}.png"
        img.convert("RGB").save(out, "PNG", optimize=True)
        print(f"wrote {out}")


def generate_play():
    W, H = 1080, 1920
    for spec in SCREENSHOT_SPECS:
        img = build_screenshot(W, H, spec["headline"], spec["screen"], accent=spec["accent"], sub_line=spec["sub"])
        out = OUT / f"play_{spec['name']}.png"
        img.convert("RGB").save(out, "PNG", optimize=True)
        print(f"wrote {out}")


def build_screenshot_landscape(
    canvas_w: int,
    canvas_h: int,
    headline_lines: Iterable[str],
    screen_name: str,
    accent=ACCENT_PURPLE,
    sub_line: str | None = None,
) -> Image.Image:
    """16:9 landscape variant. Phone sits on the right; copy on the left."""
    bg = make_background(canvas_w, canvas_h, accent=accent)
    d = ImageDraw.Draw(bg)

    # Top-left lockup
    logo = Image.open(LOGO_PATH).convert("RGBA")
    lsize = int(canvas_h * 0.085)
    logo = logo.resize((lsize, lsize), Image.LANCZOS)
    margin = int(canvas_h * 0.04)
    bg.alpha_composite(logo, dest=(margin, margin))
    fnt_word = font(int(canvas_h * 0.028), bold=True)
    d.text(
        (margin + lsize + 20, margin + lsize // 2 - int(canvas_h * 0.018)),
        "BOULEVARD",
        font=fnt_word,
        fill=LOGO_TEXT_DARK,
    )

    # Phone — sized to fit the canvas height with some padding
    phone_h = int(canvas_h * 0.86)
    phone_w = int(phone_h / 2.16)
    frame, inner = phone_frame(phone_w, phone_h)
    inner_w = inner[2] - inner[0]
    inner_h = inner[3] - inner[1]
    screen_img = render_screen(screen_name, (inner_w, inner_h))
    mask = Image.new("L", (inner_w, inner_h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, inner_w, inner_h), radius=max(40, phone_w // 13), fill=255)
    screen_rgba = Image.new("RGBA", (inner_w, inner_h))
    screen_rgba.paste(screen_img.convert("RGB"), (0, 0))
    screen_rgba.putalpha(mask)
    frame.alpha_composite(screen_rgba, dest=(inner[0], inner[1]))
    di_w = phone_w // 3
    di_h = max(36, phone_w // 28)
    di_x = inner[0] + (inner_w - di_w) // 2
    di_y = inner[1] + max(20, phone_w // 60)
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle((di_x, di_y, di_x + di_w, di_y + di_h), radius=di_h // 2, fill=(0, 0, 0, 255))
    framed, _ = phone_with_shadow(frame)
    fw, fh = framed.size
    # Place phone on the right with a generous right margin
    phone_right_margin = int(canvas_w * 0.06)
    fx = canvas_w - fw - phone_right_margin
    fy = (canvas_h - fh) // 2
    bg.alpha_composite(framed, dest=(fx, fy))

    # Copy on the left
    copy_left = int(canvas_w * 0.07)
    copy_right_limit = fx - int(canvas_w * 0.04)
    copy_width = copy_right_limit - copy_left

    line_count = len(list(headline_lines))
    base_ratio = 0.095 if line_count <= 2 else 0.078
    headline_size = int(canvas_h * base_ratio)
    fnt_h = font(headline_size, bold=True)
    line_h_bb = d.textbbox((0, 0), "Ag", font=fnt_h)
    line_h = line_h_bb[3] - line_h_bb[1]
    gap = 8
    total_h = line_count * (line_h + gap)
    # Stack vertically centered in the copy column
    start_y = (canvas_h - total_h) // 2 - int(canvas_h * 0.04)
    cy = start_y
    for line in headline_lines:
        d.text((copy_left, cy), line, font=fnt_h, fill=HEADLINE_DARK)
        cy += line_h + gap
    if sub_line:
        fnt_sub = font(int(canvas_h * 0.034), bold=False)
        d.text((copy_left, cy + 18), sub_line, font=fnt_sub, fill=SUB_DARK)
    return bg


def generate_chromebook():
    """1920x1080 landscape — fits Chromebook spec (1080-7680px per side)."""
    W, H = 1920, 1080
    for spec in SCREENSHOT_SPECS:
        img = build_screenshot_landscape(W, H, spec["headline"], spec["screen"], accent=spec["accent"], sub_line=spec["sub"])
        out = OUT / f"chromebook_{spec['name']}.png"
        img.convert("RGB").save(out, "PNG", optimize=True)
        print(f"wrote {out}")


def generate_android_xr():
    """Android XR landscape — same 16:9 layout."""
    W, H = 1920, 1080
    for spec in SCREENSHOT_SPECS:
        img = build_screenshot_landscape(W, H, spec["headline"], spec["screen"], accent=spec["accent"], sub_line=spec["sub"])
        out = OUT / f"xr_{spec['name']}.png"
        img.convert("RGB").save(out, "PNG", optimize=True)
        print(f"wrote {out}")


def generate_feature_graphic():
    W, H = 1024, 500
    bg = make_background(W, H, accent=ACCENT_PURPLE)
    d = ImageDraw.Draw(bg)
    logo = Image.open(LOGO_PATH).convert("RGBA")
    ls = 320
    logo = logo.resize((ls, ls), Image.LANCZOS)
    bg.alpha_composite(logo, dest=(60, (H - ls) // 2))
    fnt_word = font(80, bold=True)
    d.text((420, 110), "BOULEVARD", font=fnt_word, fill=LOGO_TEXT_DARK)
    fnt_tag = font(32, bold=False)
    d.text((422, 210), "AI music. Scary good.", font=fnt_tag, fill=SUB_DARK)
    fnt_hook = font(26, bold=True)
    d.text((422, 270), "Side effect: you might quit Spotify.", font=fnt_hook, fill=HEADLINE_DARK)
    pills = ["Personal mixes", "Vibe in seconds", "Endless music"]
    fnt_p = font(22, bold=True)
    px = 422
    py = 340
    for p in pills:
        pw = text_w(d, p, fnt_p) + 50
        if px + pw > W - 30:
            px = 422
            py += 70
        d.rounded_rectangle(
            (px, py, px + pw, py + 54),
            radius=27,
            fill=(18, 18, 22, 255),
            outline=(60, 60, 70, 255),
            width=2,
        )
        icon_sparkle(d, px + 20, py + 27, 11, color=WHITE)
        d.text((px + 38, py + 13), p, font=fnt_p, fill=WHITE)
        px += pw + 14
    out = OUT / "play_feature_graphic.png"
    bg.convert("RGB").save(out, "PNG", optimize=True)
    print(f"wrote {out}")


def generate_play_icon():
    logo = Image.open(LOGO_PATH).convert("RGB")
    logo = logo.resize((512, 512), Image.LANCZOS)
    out = OUT / "play_icon_512.png"
    logo.save(out, "PNG", optimize=True)
    print(f"wrote {out}")


def export_logo_files():
    """Save the Boulevard logo at sizes commonly requested by stores and PR."""
    src = Image.open(LOGO_PATH).convert("RGB")
    for size in (1024, 512, 256, 128):
        resized = src.resize((size, size), Image.LANCZOS)
        out = OUT / f"boulevard_logo_{size}.png"
        resized.save(out, "PNG", optimize=True)
        print(f"wrote {out}")


if __name__ == "__main__":
    generate_ios()
    generate_play()
    generate_chromebook()
    generate_android_xr()
    generate_feature_graphic()
    generate_play_icon()
    export_logo_files()
