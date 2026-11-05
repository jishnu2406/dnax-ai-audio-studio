"""Download only the RVC model files needed by Voice Studio."""

from pathlib import Path
import shutil
import zipfile

from huggingface_hub import hf_hub_download


ROOT = Path(__file__).resolve().parent
RVC = ROOT / "vendor" / "rvc"
REPO = "lj1995/VoiceConversionWebUI"


def download(remote, destination):
    target = RVC / destination
    if target.is_file() and target.stat().st_size > 0:
        print(f"Ready: {destination}", flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading: {destination}", flush=True)
    source = hf_hub_download(repo_id=REPO, filename=remote)
    shutil.copy2(source, target)


def main():
    for filename in (
        "hubert_base/config.json",
        "hubert_base/preprocessor_config.json",
        "hubert_base/pytorch_model.bin",
        "pretrained_v2/f0G40k.pth",
        "pretrained_v2/f0D40k.pth",
    ):
        download(filename, f"assets/{filename}")
    download("rmvpe.pt", "assets/rmvpe/rmvpe.pt")
    download("ffmpeg.exe", "ffmpeg.exe")
    download("ffprobe.exe", "ffprobe.exe")
    mute = RVC / "logs/mute/0_gt_wavs/mute40k.wav"
    if not mute.is_file():
        archive = Path(hf_hub_download(repo_id=REPO, filename="mute.zip"))
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                resolved = (RVC / "logs" / member.filename).resolve()
                if not resolved.is_relative_to((RVC / "logs").resolve()):
                    raise RuntimeError("Invalid path in mute.zip")
            bundle.extractall(RVC / "logs")
    if not mute.is_file():
        raise RuntimeError("Training silence sample is missing after extraction.")
    print("RVC models are ready.", flush=True)


if __name__ == "__main__":
    main()
