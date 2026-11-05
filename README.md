# DNAX.ai Audio Studio

A local web app for training an [RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) voice model from recordings of your own voice, then converting a source recording to that voice. The RVC engine is pinned as a Git submodule at `vendor/rvc` (commit `81eed5e`). The app uses the upstream one-click training flow and inference functions; it does not host your recordings online.

## Requirements

- Windows 10/11, Node.js 20+, `uv`, disk space for RVC dependencies and model weights.
- NVIDIA RTX 20/30/40 GPU recommended. The included setup uses CUDA 11.8 for those GPUs. Use `setup.ps1 -Cpu` for CPU mode; training will be much slower.
- About 10 minutes of clean, single-speaker voice recordings is recommended by the RVC project. WAV or FLAC is ideal. Remove background music and other speakers.

## Start

Clone this repository with Git, then run these commands in PowerShell. `setup.ps1` initializes the pinned RVC submodule if necessary. A GitHub ZIP download does not include submodule contents.

```powershell
git clone https://github.com/jishnu2406/dnax-ai-audio-studio.git
Set-Location dnax-ai-audio-studio
.\setup.ps1
.\start.ps1
```

Open <http://127.0.0.1:4317>. `npm start` also runs the server. The UI opens before setup finishes, but training and conversion require the RVC environment and model files. Setup downloads Python 3.12, RVC dependencies, and model weights into this project; the downloads can be several gigabytes.

To use another Python environment, set `RVC_PYTHON` to its Python executable before starting the server. To change the web port, set `PORT`.

## Use

The app has four tabs:

1. **Video to Audio:** Upload MP4, MOV, MKV, AVI, WebM, or M4V (up to 1 GB). Extract the first audio stream as 48 kHz, two channel WAV, MP3, or AAC. MP3 and AAC offer 64–320 kb/s. Use the result immediately as the Voice Cloner source or retrieve it from Resources later.
2. **Voice Cloner:** Manage voice profiles, upload reference recordings, train RVC, upload or select source audio, and convert it. The existing optional Audacity-derived production controls and 5–10 second previews remain here.
3. **Audio Enhancer:** Work with the latest completed clone. Compare the original with optional DeepFilterNet/Demucs cleanup, render the full mix, and optionally apply the CrispVoice podcast or natural mastering stage. Download the result as 48 kHz, two channel WAV and MP3.
4. **Resources:** Find saved reference recordings, video soundtracks, recent cloned outputs, and job activity. Soundtracks and cloned outputs can be loaded back into Voice Cloner.

Use the sidebar button to switch between the square-edged monochrome light and dark themes. The selection is saved in this browser.

### Voice Cloner steps

1. Create a voice profile.
2. Upload one or more recordings of your voice. The recordings stay in `data/voices`.
3. Train the model. The default is 40 epochs with batch size 4; reduce batch size if an 8 GB GPU runs out of memory. Training writes models and indexes under `vendor/rvc/assets` and `vendor/rvc/logs`.
4. Upload a source audio file in Voice Cloner, or choose **Use as Voice Cloner source** after extracting a video's soundtrack. Select the trained voice. A short 5, 8, or 10 second preview is generated automatically; you can move its start point or rebuild it manually. Preview WAVs stay in `data/previews`.
5. Optionally turn on Production Finish. Choose Professional, Podcast, Narration, Explanation, Cinematic, or Broadcast; then adjust bass, low-mid body, presence, treble, compression, reverb, and output level. Effects are off by default. Optional auto tune corrects voiced notes toward a chosen key and scale.
6. Adjusting production settings refreshes the cached converted preview. Changing the voice pitch, voice similarity, pitch detector, or preview range reruns RVC for the preview. Press **Convert to my voice** for the full file with the same production settings. Results are WAV files in `data/outputs`.
7. In Audio Enhancer, the app prepares stereo WAV (24 bit PCM) and stereo MP3 (256 kb/s) downloads. You can download the original directly. Optionally turn on **Enhance speech**, choose cleanup strength and whether to separate music, then run the local AI models. Switch between Original and Enhanced to compare. Adjust Speech, Music, and Background levels; each change renders an eight second audition from the selected start time. Press **Render full mix for download** to export the final stereo WAV and MP3. You can also prepare the three separate tracks for individual WAV and MP3 downloads. The latest enhanced mix is restored after a page reload. **Apply CrispVoice finish** adds optional EQ, de-essing, compression, limiting, and loudness to the cloned or fully rendered enhanced WAV.

RVC **converts the voice in existing audio**. It keeps the source words and approximate timing. It does not generate speech from text or clone a voice from a single untrained reference clip. For best results, use a clean vocal source. Music separation is optional and takes longer on the first enhancement pass.

The server listens on `127.0.0.1` by default. Keep it local because the app has no accounts or authentication. Only use recordings and source material that you have permission to process. The public Git repository excludes `data/`, trained voice models, source recordings, exports, model checkpoints, and local Python environments.

## Implementation

The interface and local API use Node's built-in HTTP server, so there is no frontend build step. Each training or conversion job runs `rvc_worker.py` in the RVC Python environment. The worker executes the upstream `webui.py` engine section before its Gradio UI declaration, then calls its `train1key` or `VC.vc_single` functions. This adapter is tied to the vendored commit and checks that layout on startup. The upstream MIT license remains in `vendor/rvc/LICENSE`.

The Audacity repository is pinned as an optional source submodule at `vendor/audacity` (audacity3 branch, commit `e168e5f`). The bass and treble coefficient equations, cutoff frequencies, and shelf slope in `audio_fx.py` are adapted from its `libraries/lib-builtin-effects/BassTrebleBase.cpp`. Other effects are local implementations. The app does not start or script the Audacity desktop editor. Audacity's [scripting documentation](https://manual.audacityteam.org/man/scripting.html) says its named-pipe interface is unsuitable for a web server. The local effects run on the already converted RVC WAV, both for preview and final output. First preview creation requires an RVC inference pass, while subsequent production adjustments reuse its cached WAV.

The Audacity-derived implementation is distributed under GPL-3.0-or-later. The repository includes the full [GPL-3.0 text](LICENSE), [attribution](LICENSE.md), and the other upstream licenses in `licenses/`. To inspect all pinned upstream source, run `git submodule update --init --recursive`.

### Video extraction and CrispVoice mastering

The [Video-to-Audio repository](https://github.com/NSTechBytes/Video-to-Audio) is pinned as an optional source submodule at `vendor/video-to-audio` (commit `ef7505e0c8a7fe08b8877ffbef453810bd647794`). Its PyQt desktop UI uses MoviePy/FFmpeg and exposes MP3, WAV, AAC, and bitrate choices. DNAX.ai Audio Studio adapts that conversion workflow as a local web endpoint using the FFmpeg already bundled with RVC. It does not run the PyQt interface. Extracted soundtracks and metadata are saved in `data/extracted`; the uploaded video is removed after conversion. The upstream code is Apache 2.0 licensed.

[CrispVoice](https://github.com/Francium-Tech/CrispVoice) is pinned as an optional source submodule at `vendor/crispvoice` (commit `ac42fbc506b5d7b84b6bffa6bfe5953d8bb84f46`). `crisp_finish.py` adapts its `enhance.py` podcast and natural mastering filter settings to run on local FFmpeg and export stereo WAV and MP3. This is **the CrispVoice mastering stage only**. Its separate ClearerVoice/Resemble Enhance/DeepFilterNet model pipeline is not installed or run by this Windows app; that upstream pipeline targets macOS/Linux and requires several gigabytes of additional checkpoints. The optional local AI cleanup already available here is described below. CrispVoice retains its MIT license.

## Optional final enhancement

`audio_enhance.py` uses [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) for speech denoising through the [deepfilternet-rs](https://github.com/di-osc/DeepFilterNet-rs) Windows binding. Optional [Demucs inference](https://github.com/openmirlab/demucs-infer) separates vocals from music. The app stores speech, music, and residual background tracks locally so changing their levels renders a short preview without rerunning the models. Speech mastering adds a high-pass filter, presence, and leveling. Both original and enhanced exports are resampled to 48 kHz stereo WAV and encoded as stereo MP3. These controls resemble Adobe Podcast's current speech, music, and background workflow, but the proprietary Adobe model and its exact output are unavailable locally. Separation can leave artifacts, especially with overlapping voices or dense music.

The Demucs checkpoint downloads on first use and may take several minutes. The enhanced track and intermediate stems are stored in `data/outputs` and `data/enhancements`. The app does not transmit recordings to Adobe or any other processing service.

The user-supplied [AdobePodcast-Desktop repository](https://github.com/gislenereismendes6/AdobePodcast-Desktop---Adobe-Podcast-AI-2026) provides a ZIP download and promotional documentation, but no inspectable enhancement source or supported API to integrate. Its README directs readers to bypass Windows SmartScreen. DNAX.ai Audio Studio does not download or execute that package. To use Adobe's actual cloud enhancement, download the converted WAV and upload it yourself through [Adobe Podcast Enhance Speech](https://podcast.adobe.com/enhance).
