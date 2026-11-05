"""Local voice finishing for preview and export.

The bass/treble shelf coefficient equations, slope, and cutoff frequencies are
adapted from Audacity's BassTrebleBase.cpp (audacity3, commit e168e5f),
Copyright Audacity Team, GPL-2.0-or-later. See vendor/audacity/LICENSE.txt.
Other processing in this module is Voice Studio implementation.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import shutil

import numpy as np
import soundfile as sf
from scipy.ndimage import gaussian_filter1d, uniform_filter1d
from scipy.signal import butter, lfilter


DEFAULTS = {
    "enabled": False,
    "preset": "natural",
    "bass": 0.0,
    "body": 0.0,
    "presence": 0.0,
    "treble": 0.0,
    "compression": 0.0,
    "reverb": 0.0,
    "outputGain": 0.0,
    "highpass": 0.0,
    "autoTune": False,
    "tuneStrength": 60.0,
    "tuneKey": "C",
    "tuneScale": "chromatic",
}

KEYS = {name: offset for offset, names in enumerate(
    (("C",), ("C#", "Db"), ("D",), ("D#", "Eb"), ("E",), ("F",),
     ("F#", "Gb"), ("G",), ("G#", "Ab"), ("A",), ("A#", "Bb"), ("B",))
) for name in names}
SCALES = {
    "chromatic": tuple(range(12)),
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),
}


def validated_settings(raw):
    if not isinstance(raw, dict):
        raise ValueError("Audio effects settings must be an object.")
    settings = dict(DEFAULTS)
    settings.update({key: raw[key] for key in DEFAULTS if key in raw})
    for key in ("enabled", "autoTune"):
        if not isinstance(settings[key], bool):
            raise ValueError(f"{key} must be true or false.")
    ranges = {
        "bass": (-12, 12), "body": (-12, 12), "presence": (-12, 12),
        "treble": (-12, 12), "outputGain": (-12, 12),
        "compression": (0, 100), "reverb": (0, 50),
        "highpass": (0, 120), "tuneStrength": (0, 100),
    }
    for key, (low, high) in ranges.items():
        value = settings[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{key} must be between {low} and {high}.")
        settings[key] = float(value)
    if settings["tuneKey"] not in KEYS or settings["tuneScale"] not in SCALES:
        raise ValueError("Unsupported tuning key or scale.")
    if not isinstance(settings["preset"], str) or len(settings["preset"]) > 40:
        raise ValueError("Invalid preset.")
    return settings


def audacity_shelf_coefficients(sample_rate, gain_db, shelf):
    """Audacity BassTrebleBase::Instance::Coefficients, normalized for lfilter."""
    hz = 250.0 if shelf == "bass" else 4000.0
    slope = 0.4
    w = 2 * math.pi * hz / sample_rate
    a = math.exp(math.log(10.0) * gain_db / 40)
    b = math.sqrt((a * a + 1) / slope - (a - 1) ** 2)
    c, s = math.cos(w), math.sin(w)
    if shelf == "bass":
        b0 = a * ((a + 1) - (a - 1) * c + b * s)
        b1 = 2 * a * ((a - 1) - (a + 1) * c)
        b2 = a * ((a + 1) - (a - 1) * c - b * s)
        a0 = (a + 1) + (a - 1) * c + b * s
        a1 = -2 * ((a - 1) + (a + 1) * c)
        a2 = (a + 1) + (a - 1) * c - b * s
    elif shelf == "treble":
        b0 = a * ((a + 1) + (a - 1) * c + b * s)
        b1 = -2 * a * ((a - 1) + (a + 1) * c)
        b2 = a * ((a + 1) + (a - 1) * c - b * s)
        a0 = (a + 1) - (a - 1) * c + b * s
        a1 = 2 * ((a - 1) - (a + 1) * c)
        a2 = (a + 1) - (a - 1) * c - b * s
    else:
        raise ValueError("Unknown shelf type.")
    return np.array([b0, b1, b2]) / a0, np.array([1, a1 / a0, a2 / a0])


def peaking_coefficients(sample_rate, hz, gain_db, q=0.9):
    # Standard peaking biquad for the low-mid body and upper-mid presence.
    a = 10 ** (gain_db / 40)
    w = 2 * math.pi * hz / sample_rate
    alpha = math.sin(w) / (2 * q)
    c = math.cos(w)
    b = np.array([1 + alpha * a, -2 * c, 1 - alpha * a])
    denominator = np.array([1 + alpha / a, -2 * c, 1 - alpha / a])
    return b / denominator[0], denominator / denominator[0]


def nearest_scale_note(midi, key, scale):
    allowed = {(KEYS[key] + step) % 12 for step in SCALES[scale]}
    candidates = [note for note in range(math.floor(midi) - 3, math.ceil(midi) + 4) if note % 12 in allowed]
    return min(candidates, key=lambda note: abs(note - midi))


def pitch_correct_channel(y, sample_rate, settings):
    """Short-window scale correction, used identically in preview and export."""
    import librosa

    if len(y) < int(sample_rate * 0.18):
        return y
    analysis_rate = 16000
    analysis = librosa.resample(y.astype(np.float32), orig_sr=sample_rate, target_sr=analysis_rate)
    hop = 320
    f0 = librosa.yin(analysis, fmin=70, fmax=800, sr=analysis_rate, frame_length=2048, hop_length=hop)
    rms = librosa.feature.rms(y=analysis, frame_length=2048, hop_length=hop)[0]
    count = min(len(f0), len(rms))
    voiced = np.isfinite(f0[:count]) & (rms[:count] > max(0.012, float(np.max(rms)) * 0.08))
    if not np.any(voiced):
        return y
    chunk_size = max(2048, int(sample_rate * 0.55))
    overlap = max(256, int(sample_rate * 0.06))
    step = chunk_size - overlap
    out = np.zeros_like(y, dtype=np.float64)
    weight_sum = np.zeros(len(y), dtype=np.float64)
    for start in range(0, len(y), step):
        end = min(len(y), start + chunk_size)
        chunk = y[start:end]
        f_start = int(start / sample_rate * analysis_rate / hop)
        f_end = min(count, math.ceil(end / sample_rate * analysis_rate / hop))
        valid = voiced[f_start:f_end]
        processed = chunk
        if np.count_nonzero(valid) >= 3:
            local_f0 = float(np.median(f0[f_start:f_end][valid]))
            midi = float(librosa.hz_to_midi(local_f0))
            target = nearest_scale_note(midi, settings["tuneKey"], settings["tuneScale"])
            shift = float(np.clip((target - midi) * settings["tuneStrength"] / 100, -2, 2))
            if abs(shift) >= 0.06:
                processed = librosa.effects.pitch_shift(chunk, sr=sample_rate, n_steps=shift)
                processed = processed[: len(chunk)]
        weights = np.ones(len(chunk), dtype=np.float64)
        fade = min(overlap, len(chunk) // 2)
        if fade:
            ramp = np.sin(np.linspace(0, math.pi / 2, fade, endpoint=False)) ** 2
            if start:
                weights[:fade] = ramp
            if end < len(y):
                weights[-fade:] = ramp[::-1]
        out[start:end] += processed * weights
        weight_sum[start:end] += weights
    return (out / np.maximum(weight_sum, 1e-8)).astype(np.float64)


def process_audio(input_path, output_path, raw_settings):
    settings = validated_settings(raw_settings)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not settings["enabled"]:
        shutil.copyfile(input_path, output_path)
        return
    audio, sample_rate = sf.read(input_path, dtype="float64", always_2d=True)
    if audio.size == 0:
        raise ValueError("Input audio is empty.")
    if settings["autoTune"] and settings["tuneStrength"]:
        for channel in range(audio.shape[1]):
            audio[:, channel] = pitch_correct_channel(audio[:, channel], sample_rate, settings)
    if settings["highpass"]:
        b, a = butter(2, settings["highpass"] / (sample_rate / 2), btype="highpass")
        audio = lfilter(b, a, audio, axis=0)
    for key in ("bass", "treble"):
        if settings[key]:
            b, a = audacity_shelf_coefficients(sample_rate, settings[key], key)
            audio = lfilter(b, a, audio, axis=0)
    for key, frequency in (("body", 280), ("presence", 3200)):
        if settings[key]:
            b, a = peaking_coefficients(sample_rate, frequency, settings[key])
            audio = lfilter(b, a, audio, axis=0)
    if settings["compression"]:
        amount = settings["compression"] / 100
        window = max(1, int(sample_rate * 0.02))
        rms = np.sqrt(np.maximum(uniform_filter1d(audio ** 2, size=window, axis=0), 0))
        level_db = 20 * np.log10(np.maximum(rms, 1e-7))
        threshold = -18 - 12 * amount
        ratio = 1 + 3 * amount
        gain_db = -np.maximum(level_db - threshold, 0) * (1 - 1 / ratio)
        gain_db = gaussian_filter1d(gain_db, sigma=max(1, sample_rate * 0.012), axis=0)
        audio *= 10 ** (gain_db / 20)
    if settings["reverb"]:
        dry = audio.copy()
        wet = settings["reverb"] / 100 * 0.7
        for delay_ms, strength in ((67, 0.45), (113, 0.3), (181, 0.2)):
            delay = int(sample_rate * delay_ms / 1000)
            if delay < len(audio):
                audio[delay:] += dry[:-delay] * wet * strength
    audio *= 10 ** (settings["outputGain"] / 20)
    peak = float(np.max(np.abs(audio)))
    if peak > 0.98:
        audio *= 0.98 / peak
    sf.write(output_path, audio, sample_rate, subtype="PCM_16")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--settings-json", required=True)
    args = parser.parse_args()
    process_audio(args.input, args.output, json.loads(args.settings_json))


if __name__ == "__main__":
    main()
