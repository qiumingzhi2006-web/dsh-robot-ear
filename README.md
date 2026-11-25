# 机器人耳朵 · dsh-robot-ear

给 DeepSeek Harness（DSH）装一对耳朵：**给一段视频或音频，拿回它说的话**。

先抽音轨，再转成文字。抽音轨用 ffmpeg（m3u8 / mp4 / 本地文件都能直接喂，抖音的播放直链会自动带上需要的 Referer），转写有两条路：

| 后端 | 怎么用 | 代价 |
| --- | --- | --- |
| **本地 Whisper**（默认） | `@huggingface/transformers` 在本机跑 Whisper，量化模型约 74MB | 不联网、不要 key、不限条数；CPU 下大约 7 倍速（10 分钟音频约 80 秒） |
| **云端接口** | 任意 OpenAI 兼容 `/v1/audio/transcriptions`（硅基流动、Groq、OpenAI…） | 更快更准，需要填 baseUrl + key，按量计费 |

`auto` 的含义：配了 key 就走云端，没配就走本地。云端出错会自动退回本地。

## 安装

```bash
dsh plugin --profile desktop add github:qiumingzhi2006-web/dsh-robot-ear
```

装完重启 DSH（或者刷新 Web UI），侧栏会多出一个「机器人耳朵」。

第一次用到本地后端时，会把 Whisper 模型下到 `~/.dsh/robot-ear/models`。默认走 `hf-mirror.com`（huggingface.co 在国内经常连不上），可在面板里改。

## 还需要 ffmpeg

转写本身是纯 JS，但**抽音轨必须有 ffmpeg**。插件按这个顺序找：

1. 面板里填的路径
2. 环境变量 `ROBOT_EAR_FFMPEG`
3. `C:\Users\0\tools\ffmpeg\ffmpeg.exe`
4. `~/.dsh/robot-ear/bin/ffmpeg(.exe)`
5. 系统 PATH

Windows 上想省事，从国内镜像拿单文件即可（约 30MB，解压后 82MB）：

```
https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz
```

解压到 `C:\Users\0\tools\ffmpeg\ffmpeg.exe` 就行，不需要装任何东西、不写注册表。没装的时候 `ear_health` 会直接告诉你缺什么。

## 三个工具

**`ear_transcribe`** —— 听一段音视频

- `source`：http(s) 直链（m3u8 / mp4 都行）、本地绝对路径、`file://` URL
- `language`：`zh` / `en` / `ja` / `ko` / `auto`
- `backend`：`local` / `openai`

例：用户说「这个视频里讲了啥」，把视频直链或文件路径喂给它，回来就是逐字稿。纯音乐、没有人声的源会返回空文本，这是正常的。

**`ear_health`** —— 检查能不能听

报告 ffmpeg 在不在、本地组件装没装、模型下了几个文件、云端配没配。用户说「怎么听不了」时先跑这个。

**`ear_config`** —— 读写设置

`backend` / `language` / `ffmpegPath` / `headerReferer` / `maxSeconds` / `keepWav` / `simplify` / `openai{baseUrl,apiKey,model}` / `local{model,mirror}`。不传 `patch` 就是只读。

## 面板

侧栏 → 机器人耳朵：引擎状态、后端选择、语言、ffmpeg 路径、云端凭据、本地模型与镜像、最长处理秒数、是否保留抽出来的 wav。改完即存，写的是 `~/.dsh/robot-ear/config.json`，下一次转写直接生效。

## 实测

一条 10 分钟的抖音探店视频，纯音频流直链：

```
音轨抽好：约 602s
转写后端：local（onnx-community/whisper-base，q8）
结果：2235 字中文逐字稿，用时 83 秒
```

中文默认吐繁体，插件会自动转成简体（opencc-js）。想要更准可以换 `onnx-community/whisper-small`（模型更大，CPU 上更慢）。

## 隐私

- 本地后端全程不出机器：音频只落在 `~/.dsh/robot-ear/cache`，转完就删（除非打开「保留 wav」）
- 云端后端会把抽出来的 wav 发到你填的那个接口
- 没有遥测、没有回传、没有账号

## 已知限制

- `whisper-base` 是「够用」的档位：口播清晰时很准，嘈杂、多人抢话、方言会有错字。要更高准确率，要么换 `whisper-small`，要么走云端。
- 需要登录才能看的内容抽不出来：插件只处理能直接下载的音视频流。
- 单次最长处理 900 秒（可调到 3600），超出的部分直接切掉，避免一个长视频把机器拖死。

## License

MIT
