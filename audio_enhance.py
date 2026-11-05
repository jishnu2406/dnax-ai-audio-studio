"""Local speech enhancement, source separation, remixing, and stereo export."""
from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfiltfilt

SAMPLE_RATE = 48000
FFMPEG = Path(__file__).parent / "vendor" / "rvc" / "ffmpeg.exe"


def stereo(audio: np.ndarray) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if audio.shape[1] == 1:
        return np.repeat(audio, 2, axis=1)
    return audio[:, :2].copy()


def fit(audio: np.ndarray, frames: int) -> np.ndarray:
    if len(audio) < frames:
        return np.pad(audio, ((0, frames - len(audio)), (0, 0)))
    return audio[:frames]


def read_stereo(path: Path) -> np.ndarray:
    data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    if not len(data):
        raise ValueError("Input audio is empty.")
    if sample_rate != SAMPLE_RATE:
        divisor = math.gcd(sample_rate, SAMPLE_RATE)
        data = resample_poly(data, SAMPLE_RATE // divisor, sample_rate // divisor, axis=0).astype(np.float32)
    return stereo(data)


def deepfilter(audio: np.ndarray) -> np.ndarray:
    from deepfilternet_rs import DeepFilterNetRealtime
    model = DeepFilterNetRealtime(log_level="error", compensate_delay=True)
    mono = np.mean(audio, axis=1).astype(np.float32)
    hop = model.frame_length
    padded = np.pad(mono, (0, (-len(mono)) % hop))
    parts = []
    for start in range(0, len(padded), hop * 200):
        parts.append(model.process_chunk(np.ascontiguousarray(padded[start:start + hop * 200])))
    parts.append(model.finalize())
    cleaned = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    cleaned = np.pad(cleaned, (0, max(0, len(mono) - len(cleaned))))[:len(mono)]
    return np.column_stack((
        cleaned + (audio[:, 0] - mono) * 0.15,
        cleaned + (audio[:, 1] - mono) * 0.15
    )).astype(np.float32)


def separate(audio: np.ndarray, enabled: bool) -> tuple[np.ndarray, np.ndarray]:
    if not enabled:
        return audio, np.zeros_like(audio)
    import torch
    from demucs_infer import DemucsSeparator
    separator = DemucsSeparator(model="htdemucs", device="cuda" if torch.cuda.is_available() else "cpu")
    try:
        mixture, stems = separator(torch.from_numpy(audio.T.copy()), sample_rate=SAMPLE_RATE)
        model_rate = round(SAMPLE_RATE * mixture.shape[1] / len(audio))
        vocal = stereo(stems["vocals"].detach().cpu().numpy().T)
        if model_rate != SAMPLE_RATE:
            divisor = math.gcd(model_rate, SAMPLE_RATE)
            vocal = resample_poly(vocal, SAMPLE_RATE // divisor, model_rate // divisor, axis=0).astype(np.float32)
        vocal = fit(vocal, len(audio))
        return vocal, audio - vocal
    finally:
        separator.close()


def master_speech(audio: np.ndarray, strength: float) -> np.ndarray:
    amount = strength / 100.0
    if amount <= 0:
        return audio
    signal = sosfiltfilt(butter(2, 72, fs=SAMPLE_RATE, btype="highpass", output="sos"), audio, axis=0).astype(np.float32)
    high = sosfiltfilt(butter(2, 2600, fs=SAMPLE_RATE, btype="highpass", output="sos"), signal, axis=0)
    signal += (0.24 * amount * high).astype(np.float32)
    rms = float(np.sqrt(np.mean(signal.astype(np.float64) ** 2)))
    if rms > 1e-5:
        gain = min(4.0, 10 ** (-19.0 / 20.0) / rms)
        signal *= 1.0 + (gain - 1.0) * amount
    drive = 1.0 + 0.55 * amount
    return (np.tanh(signal * drive) / math.tanh(drive)).astype(np.float32)


def analyze(input_path: Path, stem_dir: Path, strength: float, separate_music: bool) -> dict:
    source = read_stereo(input_path)
    vocal, music = separate(source, separate_music)
    cleaned = deepfilter(vocal)
    speech = master_speech(vocal * (1 - strength / 100.0) + cleaned * (strength / 100.0), strength)
    background = vocal - cleaned
    stem_dir.mkdir(parents=True, exist_ok=False)
    for name, data in (("speech", speech), ("music", music), ("background", background)):
        sf.write(stem_dir / f"{name}.wav", data, SAMPLE_RATE, subtype="FLOAT")
    info = {"duration": len(source) / SAMPLE_RATE, "musicSeparated": separate_music}
    (stem_dir / "meta.json").write_text(json.dumps(info), encoding="utf-8")
    return info


def render(stem_dir: Path, output_path: Path, speech: float, music: float, background: float,
           preview_seconds: float = 0, preview_start: float = 0) -> None:
    levels = (speech, music, background)
    if any(not math.isfinite(value) or value < 0 or value > 100 for value in levels):
        raise ValueError("Mix levels must be from 0 to 100.")
    tracks = [sf.read(stem_dir / f"{name}.wav", dtype="float32", always_2d=True)[0]
              for name in ("speech", "music", "background")]
    if preview_seconds:
        start = int(SAMPLE_RATE * preview_start)
        tracks = [track[start:start + int(SAMPLE_RATE * preview_seconds)] for track in tracks]
    mix = sum((track * (level / 100.0) for track, level in zip(tracks, levels)),
              np.zeros_like(tracks[0]))
    peak = float(np.max(np.abs(mix))) if len(mix) else 0.0
    if peak > 0.97:
        mix *= 0.97 / peak
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, mix, SAMPLE_RATE, subtype="PCM_24")
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i",
                    str(output_path), "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "256k",
                    str(output_path.with_suffix(".mp3"))], check=True)


def export_original(input_path: Path, output_path: Path) -> None:
    sf.write(output_path, read_stereo(input_path), SAMPLE_RATE, subtype="PCM_24")
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i",
                    str(output_path), "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "256k",
                    str(output_path.with_suffix(".mp3"))], check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output", required=True)
    parser.add_argument("--stems-dir")
    parser.add_argument("--strength", type=float, default=100)
    parser.add_argument("--speech", type=float, default=100)
    parser.add_argument("--music", type=float, default=10)
    parser.add_argument("--background", type=float, default=10)
    parser.add_argument("--separate-music", action="store_true")
    parser.add_argument("--mix-only", action="store_true")
    parser.add_argument("--original", action="store_true")
    parser.add_argument("--export-stems", action="store_true")
    parser.add_argument("--preview-seconds", type=float, default=0)
    parser.add_argument("--preview-start", type=float, default=0)
    args = parser.parse_args()
    if not 0 <= args.strength <= 100 or not math.isfinite(args.strength):
        parser.error("Strength must be from 0 to 100.")
    output = Path(args.output)
    if args.export_stems:
        stems = Path(args.stems_dir)
        for name in ("speech", "music", "background"):
            export_original(stems / f"{name}.wav", stems / f"{name}-download.wav")
        return
    if args.original:
        export_original(Path(args.input), output)
        return
    stems = Path(args.stems_dir)
    if not args.mix_only:
        analyze(Path(args.input), stems, args.strength, args.separate_music)
    render(stems, output, args.speech, args.music, args.background, args.preview_seconds, args.preview_start)


if __name__ == "__main__":
    main()
