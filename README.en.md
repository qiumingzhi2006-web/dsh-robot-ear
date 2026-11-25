# Robot Ear · dsh-robot-ear

A pair of ears for DeepSeek Harness (DSH): **hand it a video or an audio source and get back what it says**.

The audio track is pulled out with ffmpeg (m3u8 / mp4 / local files all work directly; douyin playback links get the Referer they demand), then transcribed one of two ways:

| Backend | How | Cost |
| --- | --- | --- |
| **Local Whisper** (default) | `@huggingface/transformers` runs Whisper on your machine, quantized model ~74MB | Offline, no key, no limits; roughly 7× realtime on CPU (10 min audio ≈ 80 s) |
| **Cloud endpoint** | Any OpenAI-compatible `/v1/audio/transcriptions` (SiliconFlow, Groq, OpenAI…) | Faster and sharper; needs baseUrl + key, billed per use |

`auto` means: use the cloud when a key is configured, otherwise stay local. A cloud failure falls back to local automatically.

## Install

```bash
dsh plugin --profile desktop add github:qiumingzhi2006-web/dsh-robot-ear
```

Restart DSH (or refresh the web UI) and a "Robot Ear" item shows up in the sidebar.

The first local transcription downloads the Whisper model into `~/.dsh/robot-ear/models`. It uses `hf-mirror.com` by default (huggingface.co is often unreachable from mainland China); the mirror is editable in the panel.

## You also need ffmpeg

Transcription is pure JS, but **pulling the audio track needs ffmpeg**. The plugin looks for it in this order:

1. the path set in the panel
2. `ROBOT_EAR_FFMPEG`
3. `C:\Users\0\tools\ffmpeg\ffmpeg.exe`
4. `~/.dsh/robot-ear/bin/ffmpeg(.exe)`
5. the system PATH

On Windows, a single static binary is enough (~30MB compressed, 82MB unpacked):

```
https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz
```

Unpack it to `C:\Users\0\tools\ffmpeg\ffmpeg.exe`. Nothing gets registered, nothing gets installed system-wide. `ear_health` tells the model exactly what is missing when it is not there.

## Three tools

**`ear_transcribe`** — listen to one source

- `source`: http(s) direct link (m3u8 / mp4), absolute local path, or `file://` URL
- `language`: `zh` / `en` / `ja` / `ko` / `auto`
- `backend`: `local` / `openai`

**`ear_health`** — is it able to listen at all

Reports ffmpeg, the local runtime, how many model files are downloaded, and whether the cloud side is configured.

**`ear_config`** — read or write settings

`backend` / `language` / `ffmpegPath` / `headerReferer` / `maxSeconds` / `keepWav` / `simplify` / `openai{baseUrl,apiKey,model}` / `local{model,mirror}`. Omit `patch` for a read-only dump.

## Panel

Sidebar → Robot Ear: engine status, backend, language, ffmpeg path, cloud credentials, local model and mirror, max seconds, keep-wav switch. Saves straight into `~/.dsh/robot-ear/config.json`, effective on the next transcription.

## Measured

One 10-minute douyin food-vlog, audio-only stream link:

```
audio extracted: ~602s
backend: local (onnx-community/whisper-base, q8)
result: 2235 Chinese characters in 83 s
```

Whisper emits traditional Chinese by default; the plugin converts to simplified with opencc-js. `onnx-community/whisper-small` is sharper if you can afford the slower CPU run.

## Privacy

- Local backend never leaves the machine: audio lands in `~/.dsh/robot-ear/cache` and is deleted after transcription unless "keep wav" is on.
- Cloud backend uploads the extracted wav to the endpoint you configured.
- No telemetry, no callbacks, no account.

## Known limits

- `whisper-base` is the "good enough" tier: clean speech is near-perfect, noisy or overlapping speech and heavy accents produce errors. Use `whisper-small` or the cloud backend when that matters.
- Content behind a login cannot be extracted; the plugin only handles streams it can fetch directly.
- 900 s per source by default (up to 3600 s), anything longer is cut so one long video cannot stall the machine.

## License

MIT
