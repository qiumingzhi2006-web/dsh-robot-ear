/**
 * dsh-robot-ear（机器人耳朵）—— 给 DSH 装一对耳朵。
 *
 * 一个视频或音频喂进来，先把音轨抽出来（ffmpeg），再转成文字：
 * 要么用本机的 Whisper 模型（不联网、不花钱），要么走任意 OpenAI 兼容的
 * /v1/audio/transcriptions 接口。结果直接回给会话，不落盘（除非开了 keepWav）。
 *
 * 执行体在同目录的 runner.mjs，跑在独立 node 进程里；配置和模型都在
 * ~/.dsh/robot-ear 下，面板（client.js）通过 /api/robot-ear 读写同一份配置。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-robot-ear'

export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, 'runner.mjs')
const HOME_DIR = process.env.ROBOT_EAR_HOME || path.join(os.homedir(), '.dsh', 'robot-ear')
const CONFIG_FILE = path.join(HOME_DIR, 'config.json')

const DEFAULTS = {
  backend: 'auto',
  language: 'zh',
  ffmpegPath: '',
  headerReferer: '',
  maxSeconds: 900,
  keepWav: false,
  openai: { baseUrl: '', apiKey: '', model: 'FunAudioLLM/SenseVoiceSmall' },
  local: { model: 'onnx-community/whisper-base', mirror: 'https://hf-mirror.com' },
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function loadConfig() {
  const file = readJson(CONFIG_FILE, {}) || {}
  const merged = { ...DEFAULTS, ...file }
  merged.openai = { ...DEFAULTS.openai, ...(file.openai || {}) }
  merged.local = { ...DEFAULTS.local, ...(file.local || {}) }
  return merged
}

function saveConfig(next) {
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 面板/工具都只能改这几个键，其余一律忽略 */
function sanitizePatch(body) {
  const out = {}
  if (typeof body.backend === 'string' && ['auto', 'local', 'openai'].includes(body.backend)) out.backend = body.backend
  if (typeof body.language === 'string') out.language = body.language.trim().slice(0, 12) || 'zh'
  if (typeof body.ffmpegPath === 'string') out.ffmpegPath = body.ffmpegPath.trim().slice(0, 400)
  if (typeof body.headerReferer === 'string') out.headerReferer = body.headerReferer.trim().slice(0, 400)
  const max = num(body.maxSeconds)
  if (max !== undefined) out.maxSeconds = Math.min(Math.max(Math.round(max), 5), 3600)
  if (typeof body.keepWav === 'boolean') out.keepWav = body.keepWav
  if (body.openai && typeof body.openai === 'object') {
    out.openai = {
      baseUrl: String(body.openai.baseUrl ?? '').trim().slice(0, 400),
      apiKey: String(body.openai.apiKey ?? '').trim().slice(0, 400),
      model: String(body.openai.model ?? '').trim().slice(0, 120),
    }
  }
  if (body.local && typeof body.local === 'object') {
    out.local = {
      model: String(body.local.model ?? '').trim().slice(0, 120),
      mirror: String(body.local.mirror ?? '').trim().slice(0, 400),
    }
  }
  return out
}

/** 跑一次 runner.mjs，返回 { ok, result, logs } */
function runRunner(args, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(RUNNER)) {
      resolve({ ok: false, result: { ok: false, error: 'runner.mjs 缺失：' + RUNNER }, logs: '' })
      return
    }
    const env = { ...process.env, ROBOT_EAR_HOME: HOME_DIR, ELECTRON_RUN_AS_NODE: '1' }
    let child
    try {
      child = spawn(process.execPath, [RUNNER, ...args], { env, cwd: HERE, windowsHide: true })
    } catch (error) {
      resolve({ ok: false, result: { ok: false, error: '启动失败：' + error.message }, logs: '' })
      return
    }
    let out = ''
    let logs = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { logs += d.toString() })
    child.on('error', (e) => resolve({ ok: false, result: { ok: false, error: String(e && e.message ? e.message : e) }, logs }))
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, timeoutMs || 20 * 60 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).pop()
      let result = { ok: false, error: '没有拿到结果' }
      if (line) {
        try { result = JSON.parse(line.slice('RESULT:'.length)) } catch { result = { ok: false, error: '结果解析失败' } }
      }
      resolve({ ok: !!result.ok, result, logs })
    })
  })
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function tools() {
  return [
    {
      name: 'ear_transcribe',
      description: '把一段视频或音频里说的话转成文字。source 可以是 http(s) 直链（m3u8 / mp4 都行，抖音视频直链也可）、'
        + '本地文件绝对路径，或 file:// URL。先抽音轨再转写，用的是本机配置的后端（本地 Whisper 或 OpenAI 兼容接口）。'
        + '当用户给了一个视频链接/文件、问「里面讲了什么」「说了什么」「有没有提到 X」时调用；纯音乐或没有对白的源返回空文本是正常的。',
      parameters: {
        source: { type: 'string', description: '视频/音频源：http(s) 直链、本地绝对路径或 file:// URL', required: true },
        language: { type: 'string', description: '语言代码 zh/en/ja/ko，或 auto 让它自己判断；不给就用配置里的默认' },
        backend: { type: 'string', description: 'local（本机 Whisper）或 openai（云端接口）；不给就用配置里的默认' },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: async (args) => {
        const src = String((args && args.source) || '').trim()
        if (!src) return { ok: false, message: '没给音频或视频源。' }
        const cfg = loadConfig()
        if (typeof args.language === 'string' && args.language.trim()) cfg.language = args.language.trim()
        if (typeof args.backend === 'string' && ['local', 'openai'].includes(args.backend.trim())) cfg.backend = args.backend.trim()
        saveConfig(cfg)

        const r = await runRunner(['--run', src], 25 * 60 * 1000)
        const res = r.result || {}
        if (!res.ok) {
          const hint = res.stage === 'extract'
            ? '抽音轨失败（ffmpeg 没读到音频流）。如果是抖音/网页里的播放地址，先拿到直链再喂给它；需要登录的内容抽不出来。'
            : ''
          return { ok: false, message: '转写失败：' + (res.error || '未知原因') + (hint ? '\n' + hint : '') }
        }
        if (!res.text) {
          return { ok: true, message: `音轨抽到了（约 ${res.seconds} 秒），但没识别出文字——可能没有对白，或只有音乐。\n引擎：${res.engine}` }
        }
        const head = `听完了（约 ${res.seconds} 秒，${res.engine}${res.ms ? `，用时 ${Math.round(res.ms / 1000)}s` : ''}）：`
        return {
          ok: true,
          message: head + '\n\n' + res.text,
          text: res.text,
          seconds: res.seconds,
          engine: res.engine,
        }
      },
    },
    {
      name: 'ear_health',
      description: '检查机器人耳朵是否可用：ffmpeg 在不在、本地 Whisper 组件装没装、云端接口配没配。'
        + '用户问「能不能听」「为什么转写不了」时先跑这个，再决定是装引擎还是让用户填 key。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: async () => {
        const r = await runRunner(['--health'], 60000)
        const res = r.result || {}
        const lines = []
        lines.push(`ffmpeg：${res.ok ? '可用' : '不可用'}${res.ffmpeg ? `（${res.ffmpeg}）` : ''}`)
        lines.push(`本地 Whisper：${res.localModel ? '组件已装' : '组件缺失' + (res.localModelNote ? '（' + clip(res.localModelNote, 90) + '）' : '')}，模型 ${res.localModelName || '未设置'}${res.modelFiles ? `，已下载 ${res.modelFiles} 个文件` : '，还没下载模型'}`)
        lines.push(`云端接口：${res.openaiReady ? '已配置 ' + res.openaiBase : '没配 key'}${res.openaiModel ? '（模型 ' + res.openaiModel + '）' : ''}`)
        lines.push(`当前后端：${res.backend}（auto = 有 key 就云端，没有就本地）`)
        return { ok: !!res.ok, message: lines.join('\n'), raw: res }
      },
    },
    {
      name: 'ear_config',
      description: '读取或修改机器人耳朵的设置：后端选择（auto/local/openai）、识别语言、ffmpeg 路径、'
        + '云端 baseUrl/apiKey/model、本地模型名与镜像、最长处理时长、是否保留抽取出的 wav。不传 patch 就是只读。',
      parameters: {
        patch: { type: 'object', description: '要改的字段（可部分给）：backend / language / ffmpegPath / headerReferer / maxSeconds / keepWav / openai{baseUrl,apiKey,model} / local{model,mirror}' },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: async (args) => {
        const cur = loadConfig()
        if (!args || !args.patch || typeof args.patch !== 'object') {
          const masked = { ...cur, openai: { ...cur.openai, apiKey: cur.openai.apiKey ? '已设置' : '' } }
          return { ok: true, message: '当前设置：\n' + JSON.stringify(masked, null, 2) }
        }
        const patch = sanitizePatch(args.patch)
        const next = { ...cur }
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'openai' || k === 'local') next[k] = { ...(cur[k] || {}), ...v }
          else next[k] = v
        }
        saveConfig(next)
        const masked = { ...next, openai: { ...next.openai, apiKey: next.openai.apiKey ? '已设置' : '' } }
        return { ok: true, message: '已保存：\n' + JSON.stringify(masked, null, 2) }
      },
    },
  ]
}

function sendJson(res, status, body) {
  try {
    const data = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(data)
  } catch (error) {
    try { res.statusCode = 500; res.end('{}') } catch { /* 连接已断 */ }
  }
}

function collectBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c.toString(); if (raw.length > 1_000_000) req.destroy() })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

async function apiHandler(req, res) {
  let pathname = '/'
  try {
    pathname = (new URL(req.url || '/', 'http://127.0.0.1').pathname || '').replace(/^\/api\/robot-ear/, '') || '/'
  } catch { /* 保留 '/' */ }

  if (pathname === '/config' && req.method === 'GET') {
    const cur = loadConfig()
    const masked = { ...cur, openai: { ...cur.openai, apiKey: cur.openai.apiKey ? '已设置' : '' } }
    sendJson(res, 200, { ok: true, config: masked, hasKey: !!cur.openai.apiKey, home: HOME_DIR })
    return
  }

  if (pathname === '/config' && req.method === 'POST') {
    const body = await collectBody(req)
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { ok: false, error: '请求体不是 JSON 对象' })
      return
    }
    const patch = sanitizePatch(body)
    const cur = loadConfig()
    const next = { ...cur }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'openai' || k === 'local') next[k] = { ...(cur[k] || {}), ...v }
      else next[k] = v
    }
    try { saveConfig(next) } catch (error) {
      sendJson(res, 500, { ok: false, error: '写配置失败：' + error.message })
      return
    }
    const masked = { ...next, openai: { ...next.openai, apiKey: next.openai.apiKey ? '已设置' : '' } }
    sendJson(res, 200, { ok: true, config: masked })
    return
  }

  if (pathname === '/health' && req.method === 'GET') {
    const r = await runRunner(['--health'], 60000)
    sendJson(res, 200, { ok: !!r.ok, ...(r.result || {}) })
    return
  }

  sendJson(res, 404, { ok: false, error: 'unknown route: ' + pathname })
}

export function apply(ctx) {
  const specs = tools()
  const registerAll = () => {
    for (const spec of specs) {
      try {
        ctx.tools.register(defineTool(spec))
      } catch (error) {
        const msg = `[dsh-robot-ear] ${spec.name} 注册失败：${error && error.message ? error.message : String(error)}`
        console.error(msg)
        try { if (ctx.logger && typeof ctx.logger.error === 'function') ctx.logger.error(msg) } catch { /* logger 缺席不影响其他工具 */ }
      }
    }
    console.log('[dsh-robot-ear] 工具已注册：ear_transcribe / ear_health / ear_config')
  }

  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['tools'], registerAll) } catch { registerAll() }
    try {
      ctx.inject(['webServer'], (scoped) => {
        const server = scoped && scoped.webServer
        if (!server || typeof server.register !== 'function') return
        scoped.effect(
          () => server.register({ kind: 'prefix', path: '/api/robot-ear', handler: apiHandler }),
          'dsh-robot-ear: settings api',
        )
        console.log('[dsh-robot-ear] 设置面板数据口已挂载：/api/robot-ear')
      })
    } catch (error) {
      console.error('[dsh-robot-ear] 设置面板挂载失败：' + (error && error.message ? error.message : String(error)))
    }
  } else {
    registerAll()
  }
}

