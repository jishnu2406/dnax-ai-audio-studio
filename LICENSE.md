# DNAX.ai Audio Studio license and attribution

DNAX.ai Audio Studio's `audio_fx.py` adapts bass and treble filter equations from
[Audacity's BassTrebleBase.cpp](https://github.com/audacity/audacity/blob/audacity3/libraries/lib-builtin-effects/BassTrebleBase.cpp),
copyright the Audacity Team. That upstream file is licensed under GPL version 2
or any later version. The adapted filter implementation and DNAX.ai Audio Studio wrapper
are distributed under GPL version 3 or any later version. The complete GPL
license text is included in the root `LICENSE` file. Audacity's full license
and notices remain available in its pinned `vendor/audacity` submodule.

The vendored [RVC project](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
retains its MIT license at `licenses/RVC-MIT.txt`. Other third-party dependencies
retain their own licenses.

Audacity and RVC are independent open-source projects. DNAX.ai Audio Studio is not an
official Audacity or RVC application.

`crisp_finish.py` adapts the mastering filter values from
[CrispVoice's enhance.py](https://github.com/Francium-Tech/CrispVoice/blob/main/enhance.py)
(commit `ac42fbc506b5d7b84b6bffa6bfe5953d8bb84f46`). CrispVoice is MIT
licensed; its complete license is at `licenses/CrispVoice-MIT.txt`. Its separate
generative enhancement models are not part of this application.

The video conversion workflow is adapted from
[NSTechBytes/Video-to-Audio](https://github.com/NSTechBytes/Video-to-Audio)
(commit `ef7505e0c8a7fe08b8877ffbef453810bd647794`). The app uses its
MP3/WAV/AAC and bitrate choices with its own FFmpeg web adapter, rather than
copying or running the upstream PyQt application. The upstream license is
Apache 2.0 and remains in `licenses/Video-to-Audio-Apache-2.0.txt`.

Optional local enhancement uses the DeepFilterNet3 model through the
[deepfilternet-rs](https://github.com/di-osc/DeepFilterNet-rs) package and
[demucs-infer](https://github.com/openmirlab/demucs-infer) with a Demucs checkpoint.
Their upstream packages and checkpoints retain their respective licenses.
DNAX.ai Audio Studio is not affiliated with Adobe, and no Adobe model is bundled.
