/**
 * dsh-robot-ear 的面板：显示引擎健康状况，改后端与凭据。
 *
 * 所有读写都走 /api/robot-ear（index.js 挂的），落盘的是分支里 runner.mjs
 * 启动时读的那同一个 config.json —— 面板上改完，下一次转写就用新设置。
 */
window.__ModuleLoader__.load({
  id: 'dsh-robot-ear',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-robot-ear'
    const PANEL_ID = 'dsh-robot-ear-settings'
    let boundT = null

    const ZH = {
      panel: '机器人耳朵',
      title: '机器人耳朵 · 设置',
      lead: '把视频或音频喂给它，先抽音轨再转成文字。这里选的是「用哪只耳朵听」：本机 Whisper 不联网不花钱，云端接口更快更准。',
      engine: '引擎状态',
      backend: '转写后端',
      backendAuto: '自动（有 key 走云端，没有就走本地）',
      backendLocal: '仅本地 Whisper',
      backendOpenAI: '仅云端接口',
      language: '识别语言',
      langAuto: '自动判断',
      ffmpeg: 'ffmpeg 路径',
      ffmpegHint: '留空就按默认位置找：C:\\Users\\0\\tools\\ffmpeg\\ffmpeg.exe',
      cloud: '云端接口（OpenAI 兼容）',
      baseUrl: '接口地址',
      baseUrlHint: '例如 https://api.siliconflow.cn（会自动补 /v1）',
      apiKey: 'API Key',
      apiKeyHint: '留空表示没有；本地后端不需要它',
      model: '模型名',
      modelHint: '例如 FunAudioLLM/SenseVoiceSmall 或 whisper-1',
      localTitle: '本地模型',
      localModel: '模型',
      localModelHint: 'onnx-community/whisper-base 约 145MB，whisper-small 更准但更大',
      mirror: '模型下载镜像',
      mirrorHint: 'huggingface.co 在国内常连不上，默认用 hf-mirror.com',
      limits: '处理范围',
      maxSeconds: '最长处理秒数',
      maxSecondsHint: '超过的部分直接切掉，避免一个长视频把机器拖死',
      keepWav: '保留抽出来的 wav',
      keepWavHint: '开了以后音频留在 cache 目录，方便复查',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败：{msg}',
      reload: '重新检查',
      loading: '读取中…',
      loadFailed: '读不到设置：{msg}',
      ffmpegOk: 'ffmpeg 可用',
      ffmpegBad: 'ffmpeg 不可用',
      localOk: '本地组件已装',
      localBad: '本地组件未装',
      modelFiles: '已下载 {n} 个模型文件',
      noModelFiles: '还没下载模型',
      cloudOk: '云端已配置',
      cloudBad: '云端没配 key',
      backendMissing: '面板通过 /api/robot-ear 读写设置；宿主没提供数据口时只能看不能存。',
      on: '开',
      off: '关',
    }

    const EN = {
      panel: 'Robot Ear',
      title: 'Robot Ear · settings',
      lead: 'Feed it a video or audio source and it pulls the audio track, then transcribes it. This page picks which ear to listen with: local Whisper (offline, free) or a cloud endpoint (faster, sharper).',
      engine: 'Engine status',
      backend: 'Transcription backend',
      backendAuto: 'Auto (cloud when a key exists, otherwise local)',
      backendLocal: 'Local Whisper only',
      backendOpenAI: 'Cloud endpoint only',
      language: 'Language',
      langAuto: 'Detect automatically',
      ffmpeg: 'ffmpeg path',
      ffmpegHint: 'Empty means the default locations are searched',
      cloud: 'Cloud endpoint (OpenAI compatible)',
      baseUrl: 'Base URL',
      baseUrlHint: 'e.g. https://api.siliconflow.cn (/v1 is appended)',
      apiKey: 'API key',
      apiKeyHint: 'Empty means none; the local backend does not need it',
      model: 'Model',
      modelHint: 'e.g. FunAudioLLM/SenseVoiceSmall or whisper-1',
      localTitle: 'Local model',
      localModel: 'Model',
      localModelHint: 'onnx-community/whisper-base is ~145MB; whisper-small is sharper but bigger',
      mirror: 'Model mirror',
      mirrorHint: 'huggingface.co is often unreachable from mainland China; hf-mirror.com by default',
      limits: 'Limits',
      maxSeconds: 'Max seconds to process',
      maxSecondsHint: 'Anything longer is cut off, so one long video cannot stall the machine',
      keepWav: 'Keep the extracted wav',
      keepWavHint: 'When on, the audio stays in the cache directory for re-checks',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed: {msg}',
      reload: 'Re-check',
      loading: 'Loading…',
      loadFailed: 'Could not load settings: {msg}',
      ffmpegOk: 'ffmpeg available',
      ffmpegBad: 'ffmpeg missing',
      localOk: 'local runtime installed',
      localBad: 'local runtime missing',
      modelFiles: '{n} model files downloaded',
      noModelFiles: 'no model downloaded yet',
      cloudOk: 'cloud configured',
      cloudBad: 'no cloud key',
      backendMissing: 'The panel reads and writes through /api/robot-ear; without a host data port it is read-only.',
      on: 'on',
      off: 'off',
    }

    const API = new URL('api/robot-ear', document.baseURI).pathname

    function getJson(url, options) {
      return fetch(url, options).then(async (res) => {
        const body = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }))
        if (!res.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + res.status)
        return body
      })
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'reRow' },
        h('div', { className: 'reRowLabel' },
          h('span', null, label),
          hint ? h('small', null, hint) : null),
        h('div', { className: 'reRowControl' }, children))
    }

    function SettingsPage() {
      const tt = (key, vars) => {
        if (boundT) return boundT(key, vars)
        let s = ZH[key] || EN[key] || key
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', String(v))
        return s
      }
      const [cfg, setCfg] = React.useState(null)
      const [health, setHealth] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [err, setErr] = React.useState('')

      const load = React.useCallback(() => {
        setErr('')
        Promise.all([
          getJson(API + '/config').catch((e) => { setErr(tt('loadFailed', { msg: e.message })); return null }),
          getJson(API + '/health').catch(() => null),
        ]).then(([c, h2]) => {
          if (c && c.config) setCfg(c.config)
          if (h2 && h2.ok !== false) setHealth(h2)
        })
      }, [])

      React.useEffect(() => { load() }, [load])

      const merge = (patch) => setCfg((cur) => (cur ? { ...cur, ...patch } : cur))
      const mergeNested = (key) => (patch) => setCfg((cur) => (cur ? { ...cur, [key]: { ...(cur[key] || {}), ...patch } } : cur))

      const save = () => {
        if (!cfg) return
        setBusy(true)
        setNotice('')
        getJson(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cfg),
        }).then((body) => {
          setCfg(body.config)
          setNotice(tt('saved'))
        }).catch((e) => setNotice(tt('failed', { msg: e.message })))
          .finally(() => setBusy(false))
      }

      if (!cfg) {
        return h('div', { className: 'rePage' },
          h('h2', null, tt('title')),
          h('p', { className: 'reMuted' }, err || tt('loading')),
          h('button', { type: 'button', className: 'reButton', onClick: load }, tt('reload')))
      }

      const status = []
      if (health) {
        status.push(health.ok ? tt('ffmpegOk') : tt('ffmpegBad'))
        status.push(health.localModel ? tt('localOk') : tt('localBad'))
        status.push(health.modelFiles ? tt('modelFiles', { n: health.modelFiles }) : tt('noModelFiles'))
        status.push(health.openaiReady ? tt('cloudOk') : tt('cloudBad'))
      } else {
        status.push(tt('loading'))
      }

      return h('div', { className: 'rePage' },
        h('h2', null, tt('title')),
        h('p', { className: 'reMuted' }, tt('lead')),

        h('div', { className: 'reCard' },
          h('p', { className: 'reCardTitle' }, tt('engine')),
          h('p', { className: 'reStatus' }, status.join(' · ')),
          health && health.ffmpeg ? h('p', { className: 'reMono' }, health.ffmpeg) : null),

        h('div', { className: 'reCard' },
          h('p', { className: 'reCardTitle' }, tt('backend')),
          h(Row, { label: tt('backend'), hint: '' },
            h('select', {
              className: 'reSelect',
              value: cfg.backend || 'auto',
              onChange: (e) => merge({ backend: e.target.value }),
            },
            h('option', { value: 'auto' }, tt('backendAuto')),
            h('option', { value: 'local' }, tt('backendLocal')),
            h('option', { value: 'openai' }, tt('backendOpenAI')))),
          h(Row, { label: tt('language'), hint: '' },
            h('select', {
              className: 'reSelect',
              value: cfg.language || 'zh',
              onChange: (e) => merge({ language: e.target.value }),
            },
            h('option', { value: 'zh' }, '中文'),
            h('option', { value: 'en' }, 'English'),
            h('option', { value: 'ja' }, '日本語'),
            h('option', { value: 'ko' }, '한국어'),
            h('option', { value: 'auto' }, tt('langAuto')))),
          h(Row, { label: tt('ffmpeg'), hint: tt('ffmpegHint') },
            h('input', {
              className: 'reText', type: 'text',
              value: cfg.ffmpegPath || '',
              onChange: (e) => merge({ ffmpegPath: e.target.value }),
            }))),

        h('div', { className: 'reCard' },
          h('p', { className: 'reCardTitle' }, tt('cloud')),
          h(Row, { label: tt('baseUrl'), hint: tt('baseUrlHint') },
            h('input', {
              className: 'reText', type: 'text', placeholder: 'https://api.siliconflow.cn',
              value: (cfg.openai && cfg.openai.baseUrl) || '',
              onChange: (e) => mergeNested('openai')({ baseUrl: e.target.value }),
            })),
          h(Row, { label: tt('apiKey'), hint: tt('apiKeyHint') },
            h('input', {
              className: 'reText', type: 'password', placeholder: 'sk-...',
              value: (cfg.openai && cfg.openai.apiKey) || '',
              onChange: (e) => mergeNested('openai')({ apiKey: e.target.value }),
            })),
          h(Row, { label: tt('model'), hint: tt('modelHint') },
            h('input', {
              className: 'reText', type: 'text', placeholder: 'FunAudioLLM/SenseVoiceSmall',
              value: (cfg.openai && cfg.openai.model) || '',
              onChange: (e) => mergeNested('openai')({ model: e.target.value }),
            }))),

        h('div', { className: 'reCard' },
          h('p', { className: 'reCardTitle' }, tt('localTitle')),
          h(Row, { label: tt('localModel'), hint: tt('localModelHint') },
            h('input', {
              className: 'reText', type: 'text', placeholder: 'onnx-community/whisper-base',
              value: (cfg.local && cfg.local.model) || '',
              onChange: (e) => mergeNested('local')({ model: e.target.value }),
            })),
          h(Row, { label: tt('mirror'), hint: tt('mirrorHint') },
            h('input', {
              className: 'reText', type: 'text', placeholder: 'https://hf-mirror.com',
              value: (cfg.local && cfg.local.mirror) || '',
              onChange: (e) => mergeNested('local')({ mirror: e.target.value }),
            }))),

        h('div', { className: 'reCard' },
          h('p', { className: 'reCardTitle' }, tt('limits')),
          h(Row, { label: tt('maxSeconds'), hint: tt('maxSecondsHint') },
            h('input', {
              className: 'reNumber', type: 'number', min: 5, max: 3600,
              value: cfg.maxSeconds === undefined ? 900 : cfg.maxSeconds,
              onChange: (e) => merge({ maxSeconds: Number(e.target.value) }),
            })),
          h(Row, { label: tt('keepWav'), hint: tt('keepWavHint') },
            h('label', { className: 'reSwitch' },
              h('input', {
                type: 'checkbox', checked: cfg.keepWav === true,
                onChange: (e) => merge({ keepWav: e.target.checked }),
              }),
              h('span', null, cfg.keepWav ? tt('on') : tt('off'))))),

        h('div', { className: 'reFooter' },
          notice ? h('span', { className: 'reNotice' }, notice) : null,
          h('button', { type: 'button', className: 'reButton', onClick: load, disabled: busy }, tt('reload')),
          h('button', { type: 'button', className: 'reButton reButtonPrimary', onClick: save, disabled: busy },
            busy ? tt('saving') : tt('save'))))
    }

    function PanelIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      },
      h('path', {
        d: 'M4 10v4a1 1 0 0 0 1 1h2l4 3V6l-4 3H5a1 1 0 0 0-1 1z',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    const STYLES = [
      '.rePage{display:flex;flex:1;flex-direction:column;min-height:0;max-height:100vh;box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:20px clamp(16px,3vw,24px) 16px;gap:12px;font-size:13px}',
      '.rePage > *{flex:0 0 auto}',
      '.rePage h2{margin:0;font-size:16px;font-weight:600}',
      '.reMuted{margin:0;opacity:.7;line-height:1.5}',
      '.reCard{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}',
      '.reCardTitle{margin:0;font-weight:600}',
      '.reStatus{margin:0;opacity:.8;line-height:1.5}',
      '.reMono{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.6;word-break:break-all}',
      '.reRow{display:flex;flex-direction:column;gap:4px}',
      '.reRowLabel{display:flex;flex-direction:column;gap:2px}',
      '.reRowLabel small{opacity:.6;font-size:11px;line-height:1.4}',
      '.reText,.reSelect,.reNumber{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font-size:13px}',
      '.reSwitch{display:flex;align-items:center;gap:6px;opacity:.9}',
      '.reFooter{display:flex;align-items:center;gap:8px;justify-content:flex-end;position:sticky;bottom:0;padding:10px 0 4px;margin-top:auto;background:linear-gradient(to top,rgba(20,22,30,.94),rgba(20,22,30,0))}',
      '.reNotice{opacity:.75;margin-right:auto}',
      '.reButton{padding:6px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font-size:13px}',
      '.reButtonPrimary{border-color:transparent;background:rgba(90,140,255,.18);font-weight:600}',
      '.reButton:disabled{opacity:.5;cursor:default}',
    ].join('')

    function insertStyles(css) {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-robot-ear-styles', '')
      element.textContent = css
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        boundT = t
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-robot-ear: dictionaries')
        ctx.effect(() => insertStyles(STYLES), 'dsh-robot-ear: styles')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, SettingsPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          locale: NS,
          label: () => t('panel'),
        }, PanelIcon))
      },
    }
  },
})

