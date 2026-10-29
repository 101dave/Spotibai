#!/usr/bin/env python3
"""
gen_audio.py — procedural demo music generator for SpotiBai.

The preview sandbox has no network access, so remote audio URLs would leave the
app silent. This script synthesises short original tracks into /assets/audio as
real MP3s (lameenc, mono, 32 kHz) so the player, scrubber and queue are fully
exercisable offline.

Usage:  python3 tools/gen_audio.py
"""
import math
import os
import struct
import wave

import numpy as np
import lameenc

SR = 32000
MANIFEST = {}
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "audio")
os.makedirs(OUT, exist_ok=True)

# Semitone offsets from C.
NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
        "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def hz(name: str, octave: int) -> float:
    return 440.0 * (2 ** ((NOTE[name] + (octave - 4) * 12 - 9) / 12))


def env(n, attack=0.01, decay=0.3, sustain=0.6, release=0.2):
    """ADSR envelope over n samples (fractions of the buffer)."""
    a, d, r = int(n * attack), int(n * decay), int(n * release)
    s = max(n - a - d - r, 1)
    return np.concatenate([
        np.linspace(0, 1, a, endpoint=False),
        np.linspace(1, sustain, d, endpoint=False),
        np.full(s, sustain),
        np.linspace(sustain, 0, r),
    ])[:n]


def saw(freq, n, detune=0.0, harmonics=7):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        out += np.sin(2 * np.pi * freq * (1 + detune) * k * t) / k
    return out


def pluck(freq, n, bright=0.5):
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * freq * t) + bright * 0.5 * np.sin(4 * np.pi * freq * t)
    return body * np.exp(-t * 7.5)


def pad(freqs, n):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for f in freqs:
        for d in (-0.004, 0.0, 0.004):
            out += np.sin(2 * np.pi * f * (1 + d) * t)
            out += 0.3 * np.sin(2 * np.pi * f * 2 * (1 + d) * t)
    return out / (len(freqs) * 6)


def kick(n):
    t = np.arange(n) / SR
    f = 118 * np.exp(-t * 32) + 46
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 16)


def snare(n, rng):
    t = np.arange(n) / SR
    noise = rng.standard_normal(n) * np.exp(-t * 26)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.5
    return (noise * 0.55 + tone) * 0.8


def hat(n, rng, open_=False):
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # cheap high-pass: first difference emphasises transients
    noise = np.diff(np.concatenate([[0.0], noise]))
    return noise * np.exp(-t * (9 if open_ else 46)) * 0.35


def add(buf, sig, start, gain=1.0):
    end = min(start + len(sig), len(buf))
    if end <= start:
        return
    buf[start:end] += sig[: end - start] * gain


def build(path, *, bpm, bars, prog, melody, seed, swing=0.0,
          intro=2, outro=2, brightness=0.5):
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    step = beat / 4                      # 16th note
    total = int(bars * 4 * beat * SR) + int(2.5 * SR)
    buf = np.zeros(total)

    for bar in range(bars):
        root_name, quality = prog[bar % len(prog)]
        root = hz(root_name, quality[0])
        third = hz(quality[1], quality[0])
        fifth = hz(quality[2], quality[0])
        bar_start = bar * 4 * beat
        section = ("intro" if bar < intro
                   else "outro" if bar >= bars - outro
                   else "body")

        # --- pad / chords ------------------------------------------------
        n = int(4 * beat * SR)
        chord = pad([root, third, fifth], n)
        gain = 0.30 if section != "body" else 0.20
        add(buf, chord * env(n, 0.18, 0.2, 0.85, 0.25), int(bar_start * SR), gain)

        # --- bass --------------------------------------------------------
        if section != "intro":
            for eighth in range(8):
                if eighth % 2 == 1 and rng.random() < 0.4:
                    continue
                t0 = bar_start + eighth * beat / 2
                n = int(beat / 2 * SR * 0.92)
                f = root / 2
                sig = (np.sin(2 * np.pi * f * np.arange(n) / SR)
                       + 0.35 * np.tanh(3 * np.sin(2 * np.pi * f * np.arange(n) / SR)))
                add(buf, sig * env(n, 0.005, 0.25, 0.55, 0.35), int(t0 * SR), 0.34)

        # --- arpeggio / pluck -------------------------------------------
        arp = [root, third, fifth, third]
        for sixteenth in range(16):
            if section == "outro" and sixteenth > 7:
                break
            if rng.random() < 0.28:
                continue
            t0 = bar_start + sixteenth * step + (swing * step if sixteenth % 2 else 0)
            n = int(step * SR * 3.2)
            f = arp[sixteenth % len(arp)] * (2 if sixteenth >= 8 else 1)
            add(buf, pluck(f, n, brightness), int(t0 * SR), 0.20)

        # --- drums -------------------------------------------------------
        if section == "body":
            for b in range(4):
                t0 = bar_start + b * beat
                add(buf, kick(int(0.42 * SR)), int(t0 * SR), 0.72)
                if b in (1, 3):
                    add(buf, snare(int(0.22 * SR), rng), int(t0 * SR), 0.42)
                for h in range(2):
                    add(buf, hat(int(0.07 * SR), rng), int((t0 + h * beat / 2) * SR), 0.5)
            for s in range(16):
                if s % 4 == 2:
                    add(buf, hat(int(0.05 * SR), rng), int((bar_start + s * step) * SR), 0.30)

    # --- lead melody over the back half -----------------------------------
    mstart = intro + 2
    span = max(bars - intro - outro - 1, 1)
    for bar_idx, sixteenths, note in melody:
        for sixteenth in sixteenths:
            bar = mstart + (bar_idx % span)
            t0 = bar * 4 * beat + sixteenth * step
            n = int(step * SR * 4.5)
            sig = saw(hz(note[0], note[1]), n, 0.002, 5) * env(n, 0.02, 0.3, 0.4, 0.4)
            add(buf, sig, int(t0 * SR), 0.16)

    # --- master: gentle fade, soft clip, normalise ------------------------
    fade = int(0.9 * SR)
    buf[:fade] *= np.linspace(0, 1, fade)
    buf[-fade:] *= np.linspace(1, 0, fade)
    buf = np.tanh(buf * 1.15)
    peak = np.max(np.abs(buf)) or 1.0
    buf = buf / peak * 0.89

    pcm = (buf * 32767).astype("<i2").tobytes()
    enc = lameenc.Encoder()
    enc.set_bit_rate(96)
    enc.set_in_sample_rate(SR)
    enc.set_channels(1)
    enc.set_quality(4)
    data = enc.encode(pcm) + enc.flush()

    with open(path, "wb") as f:
        f.write(data)

    seconds = len(buf) / SR
    MANIFEST[os.path.basename(path)] = round(seconds, 1)
    print(f"  {os.path.basename(path):28s} {seconds:6.1f}s  {len(data)/1024:7.1f} KB")


MAJ = (4, "E", "G")   # root octave, third, fifth (names)
MIN = (4, "D#", "G")

TRACKS = [
    # --- Wait A Minute : 132s, warm Am - F - C - G ------------------------
    dict(file="wait-a-minute.mp3", bpm=92, bars=50, seed=11, swing=0.06,
         prog=[("A", MIN), ("F", MAJ), ("C", MAJ), ("G", MAJ)],
         melody=[(0, [0, 3, 6], ("A", 4)), (1, [0, 4, 7], ("C", 5)),
                 (2, [2, 6, 10], ("E", 5)), (3, [0, 2, 4], ("D", 5)),
                 (4, [0, 3, 6], ("C", 5))]),
    # --- Pandemic Ere : 118s, moodier Dm - Bb - F - C ---------------------
    dict(file="pandemic-ere.mp3", bpm=84, bars=45, seed=23, swing=0.04,
         prog=[("D", MIN), ("A#", MAJ), ("F", MAJ), ("C", MAJ)],
         melody=[(0, [0, 2, 5], ("D", 5)), (1, [0, 3], ("F", 5)),
                 (2, [1, 4, 8], ("A", 4)), (3, [0, 6], ("C", 5))]),
    # --- She Got Her Own Thing : 158s, bright C - G - Am - F -------------
    dict(file="she-got-her-own-thing.mp3", bpm=100, bars=58, seed=37, swing=0.08,
         prog=[("C", MAJ), ("G", MAJ), ("A", MIN), ("F", MAJ)],
         melody=[(0, [0, 3, 6, 9], ("G", 5)), (1, [2, 5, 8], ("E", 5)),
                 (2, [0, 4, 7], ("C", 5)), (3, [1, 3, 6], ("D", 5)),
                 (4, [0, 2], ("G", 5))], brightness=0.7),
    # --- Dagat ug Bituon : 150s, dreamy F - Am - Bb - C ------------------
    dict(file="dagat-ug-bituon.mp3", bpm=76, bars=42, seed=41, swing=0.02,
         prog=[("F", MAJ), ("A", MIN), ("A#", MAJ), ("C", MAJ)],
         melody=[(0, [0, 4], ("F", 5)), (1, [2, 6, 9], ("A", 4)),
                 (2, [0, 3, 7], ("C", 5))]),
    # --- Baha (Open Verse) : 125s, driving Em - C - G - D ----------------
    dict(file="baha-open-verse.mp3", bpm=96, bars=45, seed=53, swing=0.0,
         prog=[("E", MIN), ("C", MAJ), ("G", MAJ), ("D", MAJ)],
         melody=[(0, [0, 3, 6], ("B", 4)), (1, [1, 4, 7], ("E", 5)),
                 (2, [0, 2, 5], ("D", 5)), (3, [3, 6], ("G", 5))], brightness=0.8),
    # --- Solo Grind : 144s, minor-key strut Am - G - F - E --------------
    dict(file="solo-grind.mp3", bpm=104, bars=52, seed=67, swing=0.05,
         prog=[("A", MIN), ("G", MAJ), ("F", MAJ), ("E", MAJ)],
         melody=[(0, [0, 2, 5], ("A", 4)), (1, [0, 4], ("G", 4)),
                 (2, [1, 3, 7], ("E", 5)), (3, [0, 5], ("C", 5))], brightness=0.75),
    # --- TikTok clips (shorter, punchier beds) ---------------------------
    dict(file="malupit-na-bai.mp3", bpm=110, bars=16, seed=71, swing=0.09,
         prog=[("A", MIN), ("F", MAJ), ("C", MAJ), ("G", MAJ)],
         melody=[(0, [0, 2, 4, 7], ("A", 5)), (1, [0, 3], ("E", 5))],
         brightness=0.85),
    dict(file="coron-song.mp3", bpm=88, bars=14, seed=83, swing=0.03,
         prog=[("D", MIN), ("A#", MAJ), ("F", MAJ), ("C", MAJ)],
         melody=[(0, [0, 3, 6], ("D", 5)), (1, [2, 5], ("A", 4))],
         brightness=0.6),
]

if __name__ == "__main__":
    print(f"Generating {len(TRACKS)} demo tracks -> {os.path.normpath(OUT)}")
    for spec in TRACKS:
        build(os.path.join(OUT, spec.pop("file")), **spec)
    import json
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(MANIFEST, f, indent=2, sort_keys=True)
    print(json.dumps(MANIFEST, indent=2, sort_keys=True))
    print("done.")
