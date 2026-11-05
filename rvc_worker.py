"""Run the pinned RVC engine without starting its Gradio interface.

The upstream webui.py defines its training and inference functions before the
top-level `with gr.Blocks(...)` UI.  This worker executes that engine section
from the vendored commit, then calls the same functions as the original UI.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback


ROOT = Path(__file__).resolve().parent
RVC = ROOT / "vendor" / "rvc"


def event(**data):
    print("__RVC_EVENT__" + json.dumps(data, ensure_ascii=False), flush=True)


def load_rvc_core():
    os.chdir(RVC)
    sys.path.insert(0, str(RVC))
    # Upstream training launches child scripts from train/; they need the
    # repository root on PYTHONPATH to resolve packages such as infer.
    previous_path = os.environ.get("PYTHONPATH", "")
    os.environ["PYTHONPATH"] = str(RVC) + (os.pathsep + previous_path if previous_path else "")
    # train/train.py otherwise shadows the train package when an upstream
    # child script is launched by filename (Python normally prepends train/).
    os.environ["PYTHONSAFEPATH"] = "1"
    # Config parses argv while webui.py initializes, so pass only its options.
    sys.argv = [str(RVC / "webui.py"), "--noautoopen"]
    source = (RVC / "webui.py").read_text(encoding="utf-8")
    marker = "\nwith gr.Blocks("
    if source.count(marker) != 1:
        raise RuntimeError("The pinned RVC webui.py layout changed; update the headless adapter.")
    engine = source.split(marker, 1)[0]
    namespace = {"__name__": "rvc_headless", "__file__": str(RVC / "webui.py")}
    exec(compile(engine, str(RVC / "webui.py"), "exec"), namespace)
    return namespace


def train(args, core):
    samples = Path(args.samples).resolve()
    if not samples.is_dir() or not any(samples.iterdir()):
        raise RuntimeError("No voice recordings were uploaded.")
    generator = RVC / "assets/pretrained_v2/f0G40k.pth"
    discriminator = RVC / "assets/pretrained_v2/f0D40k.pth"
    if not generator.is_file() or not discriminator.is_file():
        raise RuntimeError("Pretrained RVC v2 40k models are missing. Run setup.ps1.")
    gpu = "0" if core["if_gpu_ok"] else ""
    f0_method = "rmvpe" if gpu else "pm"
    event(stage="Preparing recordings")
    last_stage = ""
    last_status = ""
    for result in core["train1key"](
        args.voice_id, "40k", True, str(samples), 0,
        min(4, max(1, core["config"].n_cpu)), f0_method,
        10, args.epochs, args.batch,
        core["i18n"]("是"),
        str(generator.relative_to(RVC)).replace("\\", "/"),
        str(discriminator.relative_to(RVC)).replace("\\", "/"),
        gpu, core["i18n"]("否"), core["i18n"]("否"),
        "v2", gpu, None,
    ):
        status = str(result[0])
        stage = next((label for token, label in (
            ("Index training", "Building voice index"),
            ("索引训练", "Building voice index"),
            ("Model training", "Training voice model"),
            ("模型训练", "Training voice model"),
            ("F0 and HuBERT feature extraction", "Extracting voice features"),
            ("F0与HuBERT特征提取", "Extracting voice features"),
            ("Data slicing", "Preparing recordings"),
            ("数据切分", "Preparing recordings"),
        ) if token in status), "Training")
        if stage != last_stage:
            event(stage=stage)
            last_stage = stage
        if status != last_status:
            tail = status.strip().splitlines()[-1] if status.strip() else ""
            if tail:
                print(tail[-1000:], flush=True)
            last_status = status
    if any(text in last_status for text in ("Status：Failed", "Status：Stopped", "状态：失败", "状态：已停止")):
        raise RuntimeError(last_status[-2000:] or "RVC training failed or stopped.")
    model = RVC / "assets/weights" / f"{args.voice_id}.pth"
    if not model.is_file():
        raise RuntimeError("RVC training ended without creating a voice model.")
    event(stage="Complete")


def infer_audio(args, core, input_path):
    import soundfile as sf

    model = RVC / "assets/weights" / f"{args.voice_id}.pth"
    if not model.is_file():
        raise RuntimeError("This voice has no trained RVC model yet.")
    event(stage="Loading voice model")
    core["vc"].get_vc(model.name)
    index = core["get_index_path_from_model"](model.name, 0)
    if index:
        event(stage="Converting audio with voice index")
    else:
        event(stage="Converting audio")
    info, audio = core["vc"].vc_single(
        0, str(input_path), args.pitch, args.method, index,
        args.index_rate if index else 0, 0, 0.25, 0.33,
    )
    if not audio or audio[0] is None or audio[1] is None:
        raise RuntimeError(str(info))
    return info, audio


def convert(args, core):
    import soundfile as sf
    from audio_fx import process_audio, validated_settings

    info, audio = infer_audio(args, core, args.input)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    settings = validated_settings(json.loads(args.fx_json))
    if settings["enabled"]:
        raw_path = str(Path(args.output).with_suffix(".raw.wav"))
        try:
            sf.write(raw_path, audio[1], audio[0], subtype="PCM_16")
            event(stage="Applying production effects")
            process_audio(raw_path, args.output, settings)
        finally:
            Path(raw_path).unlink(missing_ok=True)
    else:
        sf.write(args.output, audio[1], audio[0], subtype="PCM_16")
    print(str(info).splitlines()[-1], flush=True)
    event(stage="Complete")


def preview(args, core):
    import soundfile as sf

    ffmpeg = RVC / "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    with tempfile.TemporaryDirectory(prefix="rvc-preview-") as temp:
        segment = Path(temp) / "segment.wav"
        event(stage="Preparing preview segment")
        command = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin",
                   "-ss", str(args.start), "-i", args.input,
                   "-t", str(args.duration), "-ac", "1", "-ar", "16000",
                   "-c:a", "pcm_s16le", "-y", str(segment)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError("Could not prepare preview audio: " + result.stderr[-700:])
        if not segment.is_file() or segment.stat().st_size < 32000:
            raise RuntimeError("The selected preview range contains too little audio. Choose an earlier start time.")
        info, audio = infer_audio(args, core, segment)
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        sf.write(args.output, audio[1], audio[0], subtype="PCM_16")
        print(str(info).splitlines()[-1], flush=True)
    event(stage="Preview voice ready")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    training = sub.add_parser("train")
    training.add_argument("--voice-id", required=True)
    training.add_argument("--samples", required=True)
    training.add_argument("--epochs", type=int, required=True)
    training.add_argument("--batch", type=int, required=True)
    conversion = sub.add_parser("convert")
    conversion.add_argument("--voice-id", required=True)
    conversion.add_argument("--input", required=True)
    conversion.add_argument("--output", required=True)
    conversion.add_argument("--pitch", type=int, default=0)
    conversion.add_argument("--index-rate", type=float, default=0.75)
    conversion.add_argument("--method", choices=("rmvpe", "pm", "fcpe"), default="rmvpe")
    conversion.add_argument("--fx-json", default="{}")
    sampling = sub.add_parser("preview")
    sampling.add_argument("--voice-id", required=True)
    sampling.add_argument("--input", required=True)
    sampling.add_argument("--output", required=True)
    sampling.add_argument("--pitch", type=int, default=0)
    sampling.add_argument("--index-rate", type=float, default=0.75)
    sampling.add_argument("--method", choices=("rmvpe", "pm", "fcpe"), default="rmvpe")
    sampling.add_argument("--start", type=float, default=0)
    sampling.add_argument("--duration", type=float, default=8)
    args = parser.parse_args()
    try:
        core = load_rvc_core()
        if args.action == "train":
            train(args, core)
        elif args.action == "preview":
            preview(args, core)
        else:
            convert(args, core)
    except Exception as exc:
        traceback.print_exc()
        event(error=str(exc))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
