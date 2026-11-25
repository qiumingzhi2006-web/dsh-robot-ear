/**
 * dsh-robot-ear 的执行体：抽音轨 + 转写。
 *
 * 独立进程跑（宿主用 ELECTRON_RUN_AS_NODE 复用自带 node），因此这里不依赖任何
 * 宿主导出的服务，命令行单独跑也一样：node runner.mjs --run <链接|路径>
 *
 * 抽音轨用 ffmpeg（m3u8/mp4/本地文件都能直接喂），转写用两种后端：
 *   local  —— @xenova/transformers 跑 Whisper，纯本地、不联网、不花钱
 *   openai —— 任意 OpenAI 兼容 /v1/audio/transcriptions（硅基流动、Groq、OpenAI…）
 * auto 会优先用配好 key 的 openai，否则退回 local。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const HOME_DIR = process.env.ROBOT_EAR_HOME || path.join(os.homedir(), '.dsh', 'robot-ear')
const CONFIG_FILE = path.join(HOME_DIR, 'config.json')
const CACHE_DIR = path.join(HOME_DIR, 'cache')

const DEFAULTS = {
  backend: 'auto',
  language: 'zh',
  ffmpegPath: '',
  headerReferer: '',
  maxSeconds: 900,
  keepWav: false,
  simplify: true,
  squeezeRepeats: true,
  openai: { baseUrl: '', apiKey: '', model: 'FunAudioLLM/SenseVoiceSmall' },
  local: { model: 'onnx-community/whisper-base', mirror: 'https://hf-mirror.com' },
}

function log(...a) {
  console.error(new Date().toISOString().slice(11, 19), ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))
}

function emit(obj) {
  process.stdout.write('RESULT:' + JSON.stringify(obj) + '\n')
}

function loadConfig() {
  let file = {}
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { /* 首次运行没有配置文件 */ }
  const merged = { ...DEFAULTS, ...file }
  merged.openai = { ...DEFAULTS.openai, ...(file.openai || {}) }
  merged.local = { ...DEFAULTS.local, ...(file.local || {}) }
  return merged
}

/** ffmpeg 查找：配置路径 → 本机 tools 目录 → PATH */
function findFfmpeg(cfg) {
  const candidates = [
    cfg.ffmpegPath,
    process.env.ROBOT_EAR_FFMPEG,
    'C:\\Users\\0\\tools\\ffmpeg\\ffmpeg.exe',
    path.join(HOME_DIR, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* 继续找 */ }
  }
  return 'ffmpeg'
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(cmd, args, { windowsHide: true }) } catch (e) {
      resolve({ ok: false, code: -1, stderr: String(e && e.message ? e.message : e), stdout: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, timeoutMs || 600000)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, stderr: stderr + String(e && e.message ? e.message : e), stdout }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stderr, stdout })
    })
  })
}

function cacheName(src) {
  const hash = createHash('sha1').update(String(src)).digest('hex').slice(0, 16)
  return hash + '.wav'
}

/** 把任意音视频源抽成 16k 单声道 wav，返回 { ok, wav, seconds, error } */
async function extractWav(cfg, src, ffmpeg) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const wav = path.join(CACHE_DIR, cacheName(src))
  const isRemote = /^https?:\/\//i.test(src)
  // 抖音的播放直链会校验来源，没带 Referer 一律 403；别让用户自己配这个
  const referer = cfg.headerReferer || (/douyin|douyinvod|zjcdn|amemv|snssdk|byteimg|ibytedtos/i.test(src) ? 'https://www.douyin.com/' : '')
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (isRemote && referer) {
    args.push('-headers', `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36\r\n`)
  }
  args.push('-t', String(Number(cfg.maxSeconds) || 900))
  args.push('-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wav)
  const r = await run(ffmpeg, args, 15 * 60 * 1000)
  if (!r.ok || !fs.existsSync(wav) || fs.statSync(wav).size < 1024) {
    return { ok: false, wav: '', seconds: 0, error: (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || 'ffmpeg 没产出音频（源可能不是音视频，或需要登录）' }
  }
  const bytes = fs.statSync(wav).size
  return { ok: true, wav, seconds: Math.max(0, Math.round((bytes - 44) / 32000)), error: '' }
}

/** 读 wav 成 Float32Array（16k 单声道 16bit） */
function readWav(file) {
  const buf = fs.readFileSync(file)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const end = Math.min(buf.length, start + size)
      const samples = new Float32Array((end - start) >> 1)
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(start + i * 2) / 32768
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  const samples = new Float32Array((buf.length - 44) >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(44 + i * 2) / 32768
  return samples
}

const LANG_NAMES = { zh: 'chinese', en: 'english', ja: 'japanese', ko: 'korean', auto: '' }

/** Whisper 的中文默认吐繁体，这里统一转成简体（opencc-js 缺失时原样返回） */
async function toSimplified(text) {
  if (!text) return text
  try {
    const mod = await import('opencc-js')
    const OpenCC = mod.default || mod
    const factory = OpenCC.Converter || mod.Converter
    if (typeof factory !== 'function') return text
    const convert = factory({ from: 'tw', to: 'cn' })
    return convert(text)
  } catch {
    return text
  }
}

/**
 * whisper 遇到长音轨容易陷进「我的心里我的心里我的心里」这种循环重复；
 * 把「同一小段连续重复 ≥2 次」折叠成一次，只影响读感、不影响信息量。
 */
function squeezeRepeats(text) {
  if (!text) return text
  let out = text
  for (let round = 0; round < 8; round++) {
    let changed = false
    for (let len = 2; len <= 32; len++) {
      const unit = `[\\u4e00-\\u9fa5A-Za-z0-9，。、！？,.!?]{${len}}`
      const re = new RegExp(`(${unit})(?:\\1)+`, 'g')
      out = out.replace(re, (_m, g1) => { changed = true; return g1 })
    }
    if (!changed) break
  }
  return out
}

const TRANSFORMER_LIBS = ['@huggingface/transformers', '@xenova/transformers']

/** 装哪个库都行：新版 @huggingface/transformers 与旧的 @xenova/transformers 都能跑 Whisper */
async function loadTransformers() {
  let lastErr = null
  for (const lib of TRANSFORMER_LIBS) {
    try {
      const mod = await import(lib)
      return { ok: true, mod, lib }
    } catch (e) {
      lastErr = e
    }
  }
  return { ok: false, error: lastErr ? (lastErr && lastErr.message ? lastErr.message : String(lastErr)) : '没有可用的 transformers 库' }
}

async function transcribeLocal(cfg, wav) {
  const loaded = await loadTransformers()
  if (!loaded.ok) {
    return { ok: false, text: '', engine: 'local', error: '本地转写组件没装好（npm install 没跑过？）：' + loaded.error }
  }
  const { pipeline, env } = loaded.mod
  try {
    env.cacheDir = path.join(HOME_DIR, 'models')
    env.allowLocalModels = false
    if (cfg.local.mirror) {
      if ('remoteHost' in env) env.remoteHost = cfg.local.mirror
      if ('remoteURL' in env) env.remoteURL = cfg.local.mirror
    }
  } catch { /* 老版本 env 字段不同，用默认 */ }

  let model = String(cfg.local.model || '').trim() || 'onnx-community/whisper-base'
  if (loaded.lib === '@xenova/transformers' && model.startsWith('onnx-community/')) {
    model = model.replace('onnx-community/', 'Xenova/')
  }

  let asr
  try {
    log('加载本地模型', model, '（首次会下载，质量与体积成正比）')
    asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' })
  } catch {
    try {
      asr = await pipeline('automatic-speech-recognition', model, { quantized: true })
    } catch (e) {
      return { ok: false, text: '', engine: 'local', error: '本地模型加载失败：' + (e && e.message ? e.message : String(e)) }
    }
  }

  const audio = readWav(wav)
  const lang = LANG_NAMES[cfg.language] || ''
  const t0 = Date.now()
  try {
    const out = await asr(audio, {
      ...(lang ? { language: lang, task: 'transcribe' } : { task: 'transcribe' }),
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    return { ok: true, text: String((out && out.text) || '').trim(), engine: 'local', error: '', ms: Date.now() - t0, model }
  } catch (e) {
    return { ok: false, text: '', engine: 'local', error: '本地转写出错：' + (e && e.message ? e.message : String(e)) }
  }
}

function normalizeBase(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  return /\/v\d+$/.test(s) ? s : s + '/v1'
}

async function transcribeOpenAI(cfg, wav) {
  const o = cfg.openai || {}
  const base = normalizeBase(o.baseUrl)
  if (!base || !o.apiKey) return { ok: false, text: '', engine: 'openai', error: '没配 OpenAI 兼容的 baseUrl / apiKey' }
  const buf = fs.readFileSync(wav)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', o.model || 'whisper-1')
  if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language)
  form.append('response_format', 'json')
  const t0 = Date.now()
  try {
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + o.apiKey },
      body: form,
    })
    const body = await res.text()
    if (!res.ok) return { ok: false, text: '', engine: 'openai', error: `接口返回 ${res.status}：${body.slice(0, 300)}` }
    let text = body
    try {
      const j = JSON.parse(body)
      text = j.text || j.data?.text || ''
    } catch { /* 有的服务直接回纯文本 */ }
    return { ok: true, text: String(text).trim(), engine: 'openai', error: '', ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, text: '', engine: 'openai', error: '请求失败：' + (e && e.message ? e.message : String(e)) }
  }
}

async function doRun(src) {
  if (!src) {
    emit({ ok: false, error: '没给音频或视频源' })
    return
  }
  const cfg = loadConfig()
  const ffmpeg = findFfmpeg(cfg)
  log('ffmpeg:', ffmpeg)
  const ex = await extractWav(cfg, src, ffmpeg)
  if (!ex.ok) {
    emit({ ok: false, stage: 'extract', error: ex.error, ffmpeg })
    return
  }
  log(`音轨抽好：${ex.wav} 约 ${ex.seconds}s`)

  let backend = cfg.backend || 'auto'
  if (backend === 'auto') backend = cfg.openai.apiKey && cfg.openai.baseUrl ? 'openai' : 'local'
  log('转写后端:', backend)

  let r = backend === 'openai' ? await transcribeOpenAI(cfg, ex.wav) : await transcribeLocal(cfg, ex.wav)
  if (!r.ok && backend === 'openai' && cfg.backend === 'auto') {
    log('云端失败，退回本地：' + r.error)
    const fallback = await transcribeLocal(cfg, ex.wav)
    if (fallback.ok) r = { ...fallback, fallbackFrom: r.error }
  }
  if (!cfg.keepWav && r.ok) {
    try { fs.unlinkSync(ex.wav) } catch { /* 留着也无妨 */ }
  }
  if (r.ok && r.text && cfg.simplify !== false && /[\u4e00-\u9fa5]/.test(r.text)) {
    r.text = await toSimplified(r.text)
  }
  if (r.ok && r.text && cfg.squeezeRepeats !== false) {
    r.text = squeezeRepeats(r.text)
  }
  emit({
    ok: r.ok,
    text: r.text || '',
    chars: (r.text || '').length,
    engine: r.engine,
    seconds: ex.seconds,
    ms: r.ms || 0,
    wav: cfg.keepWav ? ex.wav : '',
    error: r.error || '',
    fallbackFrom: r.fallbackFrom || '',
    source: src,
  })
}

async function doHealth() {
  const cfg = loadConfig()
  const ffmpeg = findFfmpeg(cfg)
  const r = await run(ffmpeg, ['-hide_banner', '-version'], 20000)
  let localModel = { installed: false, note: '' }
  const loaded = await loadTransformers()
  if (loaded.ok) {
    localModel.installed = true
    localModel.lib = loaded.lib
  } else {
    localModel.note = String(loaded.error || '').slice(0, 160)
  }
  const modelDir = path.join(HOME_DIR, 'models')
  let modelFiles = 0
  const walk = (dir) => {
    let n = 0
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += walk(path.join(dir, e.name))
      else n += 1
    }
    return n
  }
  try { modelFiles = walk(modelDir) } catch { modelFiles = 0 }
  emit({
    ok: r.ok,
    ffmpeg,
    ffmpegVersion: (r.stdout || r.stderr || '').split(/\r?\n/)[0] || '',
    backend: cfg.backend,
    openaiReady: !!(cfg.openai.apiKey && cfg.openai.baseUrl),
    openaiBase: normalizeBase(cfg.openai.baseUrl),
    openaiModel: cfg.openai.model,
    localModel: localModel.installed,
    localModelNote: localModel.note,
    localModelName: cfg.local.model,
    modelFiles,
    home: HOME_DIR,
  })
}

function doConfig() {
  emit({ ok: true, config: loadConfig(), home: HOME_DIR })
}

const argv = process.argv.slice(2)
try {
  const get = (k, def) => {
    const i = argv.indexOf('--' + k)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
  }
  if (argv.includes('--health')) await doHealth()
  else if (argv.includes('--config')) doConfig()
  else {
    const src = get('run', argv.find((a) => !a.startsWith('--')) || '')
    await doRun(src)
  }
} catch (e) {
  log('异常: ' + (e && e.stack ? e.stack : e))
  emit({ ok: false, error: e && e.message ? e.message : String(e) })
}
