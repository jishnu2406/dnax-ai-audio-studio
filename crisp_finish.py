"""CrispVoice's optional podcast/natural mastering, adapted for stereo output.

Filter parameters are adapted from vendor/crispvoice/enhance.py (MIT license).
This stage does not run CrispVoice's Resemble Enhance generative model.
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

FFMPEG = Path(__file__).parent / "vendor" / "rvc" / "ffmpeg.exe"
TONE = (
    "bass=g=3.5:f=160,"
    "equalizer=f=400:t=q:w=1.2:g=1.5,"
    "equalizer=f=280:t=q:w=0.9:g=-1.5,"
    "treble=g=2.5:f=9000,"
    "treble=g=1:f=10000,"
    "deesser,"
)
PRESETS = {
    "podcast": TONE + "acompressor=threshold=-22dB:ratio=2:attack=10:release=180:makeup=3,"
    "alimiter=limit=0.89:level=false,loudnorm=I=-19:TP=-1.5:LRA=6,aresample=48000",
    "natural": TONE + "acompressor=threshold=-20dB:ratio=1.7:attack=12:release=220:makeup=2,"
    "alimiter=limit=0.89:level=false,loudnorm=I=-19:TP=-1.5:LRA=7,aresample=48000",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--preset", choices=PRESETS, default="podcast")
    args = parser.parse_args()
    source, output = Path(args.input), Path(args.output)
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                    "-af", PRESETS[args.preset], "-ar", "48000", "-ac", "2",
                    "-c:a", "pcm_s24le", str(output)], check=True)
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(output),
                    "-ac", "2", "-c:a", "libmp3lame", "-b:a", "256k",
                    str(output.with_suffix(".mp3"))], check=True)


if __name__ == "__main__":
    main()
