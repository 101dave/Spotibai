#!/usr/bin/env python3
"""
gen_covers.py — procedural SVG artwork for the SpotiBai demo catalog.

SVGs are generated (not fetched) so the app renders with zero network access in
the preview sandbox. Each cover is a distinct palette + geometry pair.
"""
import os
import random

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "covers")
os.makedirs(OUT, exist_ok=True)


def wrap(text, width=14):
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


def cover(path, title, subtitle, palette, motif, size=640, seed=1):
    rnd = random.Random(seed)
    bg1, bg2, accent, ink = palette
    w = h = size
    shapes = []

    if motif == "rings":
        for i in range(7):
            r = 90 + i * 62
            shapes.append(
                f'<circle cx="{w*0.72}" cy="{h*0.42}" r="{r}" fill="none" '
                f'stroke="{accent}" stroke-width="{3.5 - i*0.32:.1f}" opacity="{0.55 - i*0.06:.2f}"/>')
    elif motif == "bars":
        for i in range(26):
            bh = rnd.randint(40, 330)
            x = 40 + i * 21
            shapes.append(
                f'<rect x="{x}" y="{h-60-bh}" width="9" height="{bh}" rx="4.5" '
                f'fill="{accent}" opacity="{0.18 + (i % 5) * 0.11:.2f}"/>')
    elif motif == "sun":
        for i in range(9):
            y = 250 + i * 26
            shapes.append(
                f'<path d="M0 {y} Q {w*0.5} {y - 70 - i*4} {w} {y}" fill="none" '
                f'stroke="{accent}" stroke-width="{2.4}" opacity="{0.62 - i*0.055:.2f}"/>')
        shapes.append(f'<circle cx="{w*0.5}" cy="{h*0.42}" r="86" fill="{accent}" opacity="0.16"/>')
        shapes.append(f'<circle cx="{w*0.5}" cy="{h*0.42}" r="86" fill="none" stroke="{accent}" '
                      f'stroke-width="2" opacity="0.6"/>')
    elif motif == "blocks":
        for i in range(16):
            bw = rnd.randint(50, 200)
            bh = rnd.randint(50, 200)
            x = rnd.randint(-40, w - 40)
            y = rnd.randint(-40, h - 40)
            shapes.append(
                f'<rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="10" fill="{accent}" '
                f'opacity="{rnd.uniform(0.05, 0.20):.2f}" transform="rotate({rnd.randint(-18,18)} {x} {y})"/>')
    elif motif == "waves":
        for i in range(11):
            y = 120 + i * 44
            shapes.append(
                f'<path d="M-20 {y} C {w*0.25} {y-52}, {w*0.55} {y+52}, {w+20} {y-24}" '
                f'fill="none" stroke="{accent}" stroke-width="{1.8 + (i%3)}" '
                f'opacity="{0.5 - i*0.035:.2f}"/>')
    elif motif == "grid":
        for i in range(12):
            for j in range(12):
                shapes.append(
                    f'<circle cx="{60 + i*48}" cy="{60 + j*48}" r="{2 + ((i*j) % 4) * 1.4}" '
                    f'fill="{accent}" opacity="{(0.10 + ((i+j) % 6) * 0.045):.2f}"/>')

    lines = wrap(title.upper(), 13)
    title_svg = "".join(
        f'<text x="52" y="{h - 116 - (len(lines) - 1 - i) * 46}" font-family="Inter, '
        f'Helvetica, Arial, sans-serif" font-size="46" font-weight="800" '
        f'letter-spacing="-1.2" fill="{ink}">{l}</text>'
        for i, l in enumerate(lines))

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{bg1}"/>
      <stop offset="100%" stop-color="{bg2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="72%" cy="30%" r="70%">
      <stop offset="0%" stop-color="{accent}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="{accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#bg)"/>
  <rect width="{w}" height="{h}" fill="url(#glow)"/>
  {''.join(shapes)}
  {title_svg}
  <text x="52" y="{h - 66}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="22"
        font-weight="500" letter-spacing="2.4" fill="{accent}" opacity="0.85">{subtitle.upper()}</text>
  <rect width="{w}" height="{h}" filter="url(#grain)" opacity="0.5"/>
</svg>
'''
    with open(os.path.join(OUT, path), "w") as f:
        f.write(svg)
    print(f"  {path}")


def portrait(path, title, subtitle, palette, motif, seed=1):
    """9:16 poster used by the TikTok video panel."""
    rnd = random.Random(seed)
    bg1, bg2, accent, ink = palette
    w, h = 540, 960
    shapes = []
    if motif == "rings":
        for i in range(9):
            shapes.append(
                f'<circle cx="{w*0.5}" cy="{h*0.38}" r="{70 + i*58}" fill="none" '
                f'stroke="{accent}" stroke-width="{3 - i*0.24:.1f}" opacity="{0.6 - i*0.055:.2f}"/>')
    elif motif == "waves":
        for i in range(14):
            y = 220 + i * 46
            shapes.append(
                f'<path d="M-20 {y} C {w*0.3} {y-46}, {w*0.6} {y+46}, {w+20} {y-20}" fill="none" '
                f'stroke="{accent}" stroke-width="{1.6 + (i%3)}" opacity="{0.48 - i*0.026:.2f}"/>')
    elif motif == "bars":
        for i in range(22):
            bh = rnd.randint(60, 420)
            shapes.append(
                f'<rect x="{28 + i*23}" y="{h*0.62 - bh/2}" width="10" height="{bh}" rx="5" '
                f'fill="{accent}" opacity="{0.16 + (i%4)*0.12:.2f}"/>')

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="{bg1}"/><stop offset="100%" stop-color="{bg2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="34%" r="62%">
      <stop offset="0%" stop-color="{accent}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="{accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.06"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#bg)"/>
  <rect width="{w}" height="{h}" fill="url(#glow)"/>
  {''.join(shapes)}
  <text x="42" y="{h-190}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="44"
        font-weight="800" letter-spacing="-1.1" fill="{ink}">SpotiBai</text>
  <text x="42" y="{h-140}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="20"
        font-weight="600" letter-spacing="3" fill="{accent}">{subtitle.upper()}</text>
  <rect width="{w}" height="{h}" filter="url(#grain)" opacity="0.5"/>
</svg>
'''
    with open(os.path.join(OUT, path), "w") as f:
        f.write(svg)
    print(f"  {path}")


ALBUMS = [
    ("album-tangalog-nights.svg", "Tangalog Nights", "Bai-J", ("#1a1030", "#0a1a12", "#1DB954", "#F5F5F5"), "bars", 3),
    ("album-bisaya-sunrise.svg", "Bisaya Sunrise", "ReneBai", ("#2a1206", "#12121f", "#FF8A3D", "#FFF6EC"), "sun", 7),
    ("album-hugot-sessions.svg", "Hugot Sessions", "Lucky7", ("#0b1a2a", "#050b14", "#4FA8FF", "#EAF3FF"), "waves", 11),
    ("album-fyp-vol1.svg", "For You Page Vol. 1", "SpotiBai PH", ("#1c0a18", "#0a0a12", "#FF2E63", "#FFFFFF"), "rings", 17),
]

ARTISTS = [
    ("artist-baij.svg", "Bai-J", "Tagalog Flow", ("#12200f", "#050805", "#1DB954", "#EAFFF1"), "grid", 5),
    ("artist-rene.svg", "ReneBai", "Bedroom Pop", ("#221407", "#0d0a06", "#FFB03D", "#FFF7EA"), "waves", 13),
    ("artist-lucky.svg", "Lucky7", "Open Verse", ("#0a1526", "#04070d", "#5B8CFF", "#EDF3FF"), "blocks", 19),
    ("artist-spotibai.svg", "SpotiBai PH", "@spotibai_ph", ("#1d0a13", "#0a0509", "#FF2E63", "#FFFFFF"), "rings", 23),
    ("playlist-tangalog-heat.svg", "Tangalog Heat", "Playlist", ("#1a0f08", "#100503", "#FF5C1A", "#FFF0E6"), "bars", 29),
]

PORTRAITS = [
    ("tiktok-malupit-na-bai.svg", "Malupit na Bai Spotted On", "OfficialSpotiBaiPH",
     ("#150720", "#06020a", "#FF2E63", "#FFFFFF"), "rings", 31),
    ("tiktok-coron-song.svg", "Coron Song", "Bisaya",
     ("#031712", "#020806", "#1DB954", "#EFFFF7"), "waves", 37),
]

if __name__ == "__main__":
    print("Generating SVG artwork ->", os.path.normpath(OUT))
    for f, t, s, p, m, seed in ALBUMS:
        cover(f, t, s, p, m, seed=seed)
    for f, t, s, p, m, seed in ARTISTS:
        cover(f, t, s, p, m, seed=seed)
    for f, t, s, p, m, seed in PORTRAITS:
        portrait(f, t, s, p, m, seed=seed)
    print("done.")
