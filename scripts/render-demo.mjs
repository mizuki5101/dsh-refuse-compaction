/**
 * 把 lib/client.js 的真实组件（RefuseGauge / RefusePromptBar）渲染成静态演示页。
 *
 * 用 React→HTML 影子实现（createElement/useState/useEffect/useRef 的最小替身 +
 * createElement 树到 HTML 字符串的展开，内联 style/className/aria/disabled 全部
 * 保留），组件代码零改动——演示页的 DOM 与真实对话流里的 DOM 同构。
 *
 * 产出 demo.html：注入的 <style>（真实动画 keyframes）+ 各状态快照 + 少量原生
 * JS（档位按钮点选切高亮，模拟乐观更新的过渡效果）。
 *
 * 运行：node scripts/render-demo.mjs  （产物写到插件根目录 demo.html）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/* ---------------------------------- React 影子 ---------------------------------- */

const UNITLESS = new Set(['opacity', 'lineHeight', 'flexShrink', 'fontWeight', 'flexGrow', 'zIndex', 'flex'])

function styleToStr(style) {
  const parts = []
  for (const [key, value] of Object.entries(style ?? {})) {
    if (value === undefined || value === null) continue
    const cssKey = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    const cssValue = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value)
    parts.push(`${cssKey}:${cssValue}`)
  }
  return parts.join(';')
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const SVG_ATTR_MAP = { strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap', strokeDasharray: 'stroke-dasharray', strokeDashoffset: 'stroke-dashoffset' }
const SKIP_PROPS = new Set(['key', 'onClick', 'onChange', 'onBlur', 'onKeyDown', 'className', 'style', 'children'])

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node.tag === 'function') return renderNode(node.tag(node.props)) // 函数组件就地展开
  if (typeof node.tag !== 'string') return ''
  const attrs = []
  if (node.props.className !== undefined) attrs.push(`class="${esc(node.props.className)}"`)
  for (const [key, value] of Object.entries(node.props)) {
    if (SKIP_PROPS.has(key)) continue
    if (value === undefined || value === null || value === false) continue
    const name = SVG_ATTR_MAP[key] ?? key
    attrs.push(key === 'disabled' ? name : `${name}="${esc(value)}"`)
  }
  if (node.props.value !== undefined) attrs.push(`value="${esc(node.props.value)}"`)
  const style = styleToStr(node.props.style)
  if (style !== '') attrs.push(`style="${esc(style)}"`)
  const inner = renderNode(node.props.children ?? node.children)
  if (['circle', 'br', 'input'].includes(node.tag)) return `<${node.tag} ${attrs.join(' ')} />`
  return `<${node.tag} ${attrs.join(' ')}>${inner}</${node.tag}>`
}

/** useState：每次渲染前可重置/预置的格子序列（组件按 hook 序号取格子，序号独立于预置长度）。 */
function createDemoReact() {
  let cells = []
  let counter = 0
  return {
    createElement(tag, props, ...children) {
      return { tag, props: props ?? {}, children: children.length <= 1 ? children[0] : children }
    },
    useState(init) {
      const index = counter++
      if (cells[index] === undefined) cells[index] = typeof init === 'function' ? init() : init
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
    },
    useEffect() { return undefined },
    useRef(init) { return { current: init } },
    __preseed(list) { cells = [...list]; counter = 0 },
  }
}

const DemoReact = createDemoReact()

/* ---------------------------------- 加载真实组件 ---------------------------------- */

let styleText = ''
const documentStub = {
  head: { appendChild(el) { if (el.id === 'refuse-compaction-style') styleText = el.textContent } },
  createElement() { return { id: '', textContent: '' } },
  getElementById() { return null },
}

let loadOpts
const sandbox = { window: { __ModuleLoader__: { load(o) { loadOpts = o } } }, document: documentStub }
vm.runInNewContext(source, sandbox, { filename: 'client.js' })
const exports = loadOpts.factory((name) => {
  if (name === 'react') return DemoReact
  throw new Error(`unexpected require: ${name}`)
})
const t = (key) => exports.MESSAGES.zh[key] ?? key

// 走一次 apply（stub ctx）触发 ensureGaugeStyle，捕获注入的真实动画 CSS
exports.apply({ slots: { inject() {} } })

/** 预置 useState 格子后渲染一个组件实例。 */
function render(preseededCells, component, props) {
  DemoReact.__preseed(preseededCells)
  return renderNode(component(props))
}

/* ---------------------------------- 状态快照 ---------------------------------- */

/** 活尾回合的数据形态：currentTurn = tail回合 + 1。 */
function gaugeData({ occupancyTokens, contextWindow, compactionPoint, globalTier = 'off' }) {
  return {
    currentTurn: 7,
    occupancy: occupancyTokens / contextWindow,
    effectiveRatio: compactionPoint / contextWindow,
    occupancyTokens,
    contextWindow,
    compactionPoint,
    globalTier,
  }
}
const gaugeProps = (data) => ({
  t,
  sessionId: 'demo',
  form: { getSnapshot: () => ({ status: 'ready', value: { revealAhead: 0.2 }, user: {}, writable: true }) },
  turn: { turn: 6, status: 'closed', steps: [] },
})
const renderGauge = (data) => render([data], exports.RefuseGauge, gaugeProps(data))
const renderBar = (state) => render([state, ''], exports.RefusePromptBar, {
  t,
  sessionId: 'demo',
  turn: { turn: 6, status: 'closed', steps: [] },
})

/* ---------------------------------- 组装 HTML ---------------------------------- */

const demoHtml = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-refuse-compaction 特效演示</title>
<style>
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 32px 24px 48px; background: #14161a; color: #e8e8ea; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .sub { font-size: 13px; opacity: 0.65; margin-bottom: 28px; line-height: 1.7; }
  h2 { font-size: 14px; opacity: 0.85; margin: 30px 0 10px; border-left: 3px solid rgba(110,150,235,0.6); padding-left: 8px; }
  .stage { max-width: 720px; }
  .hint { font-size: 12px; opacity: 0.55; margin: 4px 0 10px; }
  ${styleText}
</style>
</head>
<body>
<div class="stage">
  <h1>dsh-refuse-compaction 特效演示</h1>
  <div class="sub">以下每一行都是 <code>lib/client.js</code> 真实组件的渲染产物（同构 DOM + 同一份动画 CSS）。动画是真实动效——呼吸脉冲与入场滑入现在就在播放；档位按钮可点，高亮迁移带过渡。</div>

  <h2>占用仪表 · 蓝色常态（压缩点进度 82%）</h2>
  <div class="hint">revealAhead 默认 0.2：占用过阈值（窗口 60%）亮出；文本与环形同为"已用 / 压缩点"口径，总窗口占比交给 dsh 自带显示。</div>
  ${renderGauge(gaugeData({ occupancyTokens: 161218, contextWindow: 262144, compactionPoint: 196608 }))}

  <h2>占用仪表 · 近压缩（压缩点进度 96%，橙色 + 呼吸脉冲）</h2>
  <div class="hint">progress ≥ 85% 后描边转橙、边框脉冲。档位快切可点（乐观更新：按钮即时翻高亮）。</div>
  ${renderGauge(gaugeData({ occupancyTokens: 188700, contextWindow: 262144, compactionPoint: 196608, globalTier: 'manual' }))}

  <h2>提示条 · 手动拒绝询问（ask，呼吸脉冲 + 四按钮 + 拦截计数）</h2>
  ${renderBar({ phase: 'ask', eventTurn: 6, event: { why: 'manual-ask' }, occupancy: 0.62, repeatCount: 4 })}

  <h2>提示条 · 忙碌批准回落（queued，calm 灰态，无按钮）</h2>
  <div class="hint">v0.2.7：回合中点「立即压缩」不再静默丢弃——批准落到下一个压缩检查点，在引擎自己的 step 边界自动执行。</div>
  ${renderBar({ phase: 'queued', eventTurn: 6, event: { kind: 'queued' }, occupancy: 0.62, repeatCount: 4 })}

  <h2>提示条 · 临时拒绝拦截（blocked，还剩2回合）</h2>
  ${renderBar({ phase: 'blocked', eventTurn: 6, event: { why: 'temporary', expiresAtTurn: 8, turn: 6 }, currentTurn: 7, occupancy: 0.66 })}

  <h2>提示条 · 禁止档拦截（blocked，仅「立即压缩」）</h2>
  ${renderBar({ phase: 'blocked', eventTurn: 6, event: { why: 'forbid' }, occupancy: 0.71 })}

  <h2>提示条 · 联动保持（blocked，精简落盘前）</h2>
  ${renderBar({ phase: 'blocked', eventTurn: 6, event: { why: 'link-hold' }, occupancy: 0.58 })}

  <h2>提示条 · 已放行 / 已手动压缩（calm 灰态）</h2>
  ${renderBar({ phase: 'allowed', eventTurn: 6, event: { kind: 'allow-once' }, occupancy: 0.5 })}
  ${renderBar({ phase: 'compacted', eventTurn: 6, event: { kind: 'compacted' }, occupancy: 0.44 })}
</div>
<script>
  // 档位按钮演示：点击 → 高亮迁移（CSS transition 可见）
  document.querySelectorAll('.refuse-compaction-gauge').forEach(function (gauge) {
    var buttons = gauge.querySelectorAll('button')
    if (buttons.length !== 4) return
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (other) {
          other.style.background = 'transparent'
          other.style.borderColor = 'rgba(128,128,128,0.4)'
        })
        btn.style.background = 'rgba(110,150,235,0.22)'
        btn.style.borderColor = 'rgba(110,150,235,0.65)'
      })
    })
  })
</script>
</body>
</html>
`

writeFileSync(path.join(here, '..', 'demo.html'), demoHtml)
console.log(`demo.html written (${demoHtml.length} chars); animation CSS captured: ${styleText.length} chars`)
