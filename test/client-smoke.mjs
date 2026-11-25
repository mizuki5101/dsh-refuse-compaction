/**
 * dsh-refuse-compaction client 侧冒烟测试：在 vm 沙箱里加载 lib/client.js
 * （stub window.__ModuleLoader__ / React / ctx），验证设置区块与对话内提示条的
 * 注册、渲染与按钮动作路径。
 *
 * 运行：node --test test/client-smoke.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/** 极简 React 替身：createElement 记录调用；useState 按 initialStates 序号取值。
 *  captureSetters=true 时记录 setState 的入参（函数式更新可离线求值）。 */
function fakeReact({ initialStates = [], captureSetters = false } = {}) {
  const calls = []
  const setters = []
  let stateIndex = 0
  const React = {
    createElement(tag, props, ...children) {
      const node = { tag, props: props ?? {}, children }
      calls.push(node)
      return node
    },
    useState(init) {
      const i = stateIndex++
      const provided = initialStates[i]
      const value = provided !== undefined ? provided : (typeof init === 'function' ? init() : init)
      const cell = { calls: [] }
      setters[i] = cell
      return [value, (update) => { if (captureSetters) cell.calls.push(update) }]
    },
    useRef(init) {
      return { current: init }
    },
    useEffect(fn, deps) {
      // 渲染期不执行副作用；返回 undefined 等价无清理
      return undefined
    },
  }
  return { React, calls, setters }
}

/** 加载 client.js，返回 { exports, loadOpts, sandbox }。 */
function loadClient(reactOptions) {
  let loadOpts
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(opts) {
          loadOpts = opts
        },
      },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(loadOpts, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(loadOpts.id, 'dsh-refuse-compaction', 'ModuleLoader id 必须等于包名（否则重复工厂注册 → web boot 崩）')
  const { React, calls, setters } = fakeReact(reactOptions)
  const exports = loadOpts.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { exports, calls, sandbox, setters }
}

/** 组装 fake ctx，捕获 settings.section 与 conversation.chat.turnTail 注册。 */
function fakeCtx({ ns = 'refuse-compaction' } = {}) {
  const registeredLocales = []
  const slotRegistrations = []
  const slotInjects = []
  const setCalls = []
  const unsetCalls = []
  const form = {
    getSnapshot: () => READY,
    subscribe: () => () => {},
    set: (id, value) => setCalls.push([id, value]),
    unset: (id) => unsetCalls.push(id),
  }
  const slots = {
    inject(name, fn) {
      slotInjects.push(name)
      fn()
    },
    register(def, component) {
      slotRegistrations.push({ def, component })
      return () => {}
    },
  }
  const ctx = {
    locale: {
      bind: (nsBound) => (key) => `${nsBound}.${key}`,
      register: (ns, id, dict) => {
        registeredLocales.push({ ns, id, dict })
        return () => {}
      },
    },
    configForms: {
      get: (nsGot) => {
        assert.equal(nsGot, ns)
        return form
      },
      whileServed: (ids, cb) => {
        assert.deepEqual([...ids], [ns])
        cb()
        return () => {}
      },
    },
    slots,
    effect(fn) {
      fn()
    },
  }
  return {
    ctx,
    registeredLocales,
    slotInjects,
    setCalls,
    unsetCalls,
    get slotRegistrations() { return slotRegistrations },
    get settingsSlot() { return slotRegistrations.find(r => r.def.name === 'settings.section') },
    get turnTailSlot() { return slotRegistrations.find(r => r.def.name === 'conversation.chat.turnTail') },
    form,
  }
}

const READY = {
  status: 'ready',
  value: { tier: 'off', spareOverflow: false, promptBar: true, revealAhead: 0.3 },
  user: { tier: 'manual' },
  writable: true,
  revision: 1,
}

/** 渲染节点树：收集 aria-label、按钮（含扁平文本）、select、input、字符串。 */
function collect(node) {
  const ids = new Set()
  const buttons = []
  const selects = []
  const inputs = []
  const texts = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string') {
      texts.push(n)
      return
    }
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n !== 'object') return
    if (typeof n.tag === 'function') return walk(n.tag(n.props))
    if (n.props?.['aria-label']) ids.add(n.props['aria-label'])
    if (n.tag === 'button') {
      const inner = []
      const grab = (c) => {
        if (typeof c === 'string') inner.push(c)
        else if (Array.isArray(c)) c.forEach(grab)
        else if (c && typeof c === 'object' && typeof c.tag === 'function') grab(c.tag(c.props))
        else if (c && typeof c === 'object' && c.children !== undefined) grab(c.children)
      }
      grab(n.children)
      buttons.push({ label: inner.join(''), node: n })
    }
    if (n.tag === 'select') selects.push(n)
    if (n.tag === 'input') {
      inputs.push({ label: n.props['aria-label'], node: n })
    }
    if (n.children !== undefined) walk(n.children)
  }
  walk(node)
  return { ids, buttons, selects, inputs, texts: texts.join('') }
}

test('client 加载：id=包名，导出 apply/inject/MESSAGES/barText', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'configForms', 'locale'])
  assert.ok(exports.MESSAGES.zh && exports.MESSAGES.en)
  assert.equal(typeof exports.barText, 'function')
  assert.equal(typeof exports.RefusePromptBar, 'function')
})

test('apply 注册双语词典 + settings.section（order 57 紧跟 exa-distill）+ turnTail', () => {
  const { exports } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  assert.deepEqual(harness.registeredLocales.map(l => l.id).sort(), ['en', 'zh'])
  assert.equal(harness.registeredLocales[0].ns, 'refuse-compaction')
  assert.equal(harness.settingsSlot.def.id, 'refuse-compaction')
  assert.equal(harness.settingsSlot.def.name, 'settings.section')
  assert.equal(harness.settingsSlot.def.order, 57)
  assert.ok(harness.slotInjects.includes('conversation.chat.turnTail'), '应注入 conversation.chat.turnTail 槽')
  assert.equal(harness.turnTailSlot.def.id, 'refuse-compaction-prompt')
  assert.equal(harness.turnTailSlot.def.inject('session-x').sessionId, 'session-x', 'session 作用域注入 sessionId')
})

test('Section 就绪态渲染 8 个字段；档位 / 自动恢复 / 输出守门三个下拉', () => {
  const { exports } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  const props = harness.settingsSlot.def.inject()
  const node = harness.settingsSlot.component(props)
  const found = collect(node)
  for (const key of [
    'tierLabel', 'spareOverflowLabel', 'promptBarLabel', 'revealAheadLabel',
    'autoResumeLabel', 'autoResumeMaxLabel', 'autoResumeMinTailLabel', 'outputGuardLabel',
  ]) {
    assert.ok(found.ids.has(`refuse-compaction.${key}`), `缺少字段 ${key}`)
  }
  assert.equal(found.selects.length, 3, '档位 / 自动恢复 / 输出守门都是下拉选择')
  // h('select', props, options.map(...)) 的 children 是嵌套一层的数组
  const options = found.selects[0].children.flat(Infinity).filter(c => c && c.tag === 'option')
  assert.deepEqual(options.map(o => o.props.value), ['off', 'temporary', 'manual', 'forbid'])
  const resumeOptions = found.selects[1].children.flat(Infinity).filter(c => c && c.tag === 'option')
  assert.deepEqual(resumeOptions.map(o => o.props.value), ['off', 'continue', 'recover'])
  const guardOptions = found.selects[2].children.flat(Infinity).filter(c => c && c.tag === 'option')
  assert.deepEqual(guardOptions.map(o => o.props.value), ['auto', 'off'])
})

test('Section 交互：下拉改档写 form.set(tier)；开关切换写 form.set', () => {
  const { exports } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  const props = harness.settingsSlot.def.inject()
  const node = harness.settingsSlot.component(props)
  const found = collect(node)
  // 档位下拉：改成 forbid
  const select = found.selects[0]
  select.props.onChange({ currentTarget: { value: 'forbid' } })
  assert.deepEqual(harness.setCalls.at(-1), ['tier', 'forbid'])
  // 开关：spareOverflow false → true
  const sw = found.buttons.find(b => b.node.props['aria-label'] === 'refuse-compaction.spareOverflowLabel')
  assert.ok(sw, 'spareOverflow 开关存在')
  sw.node.props.onClick()
  assert.deepEqual(harness.setCalls.at(-1), ['spareOverflow', true])
})

test('Section 加载态 / 不可用态给出提示', () => {
  const { exports } = loadClient()
  const loading = fakeCtx()
  loading.form.getSnapshot = () => ({ status: 'loading' })
  exports.apply(loading.ctx)
  const node = loading.settingsSlot.component(loading.settingsSlot.def.inject())
  assert.match(collect(node).texts, /loading/)

  const unavail = fakeCtx()
  unavail.form.getSnapshot = () => ({ status: 'unavailable' })
  exports.apply(unavail.ctx)
  const node2 = unavail.settingsSlot.component(unavail.settingsSlot.def.inject())
  assert.match(collect(node2).texts, /unavailable/)
})

/* -------------------------------------------------------------------------- */
/* 提示条：文本 / 渲染 / 按钮                                                    */
/* -------------------------------------------------------------------------- */

const zh = loadClient().exports.MESSAGES.zh
const t = (key) => zh[key] ?? key

test('barText：ask/blocked/refused/allowed/compacted 形态 + 占用率格式', () => {
  const { barText } = loadClient().exports
  const ask = barText({ phase: 'ask', event: { why: 'manual-ask' }, occupancy: 0.6234 }, t)
  assert.match(ask, /已拦截自动压缩/)
  assert.match(ask, /手动拒绝/)
  assert.match(ask, /62%/)
  const link = barText({ phase: 'blocked', event: { why: 'link-hold' }, occupancy: null }, t)
  assert.match(link, /等待精简结果落盘/)
  assert.match(link, /占用率未知/)
  const allowed = barText({ phase: 'allowed', event: { kind: 'allow-once' }, occupancy: 0.5 }, t)
  assert.match(allowed, /本回合已放行/)
  const refused = barText({ phase: 'refused', event: { kind: 'refused' }, occupancy: 0.5 }, t)
  assert.match(refused, /已拒绝本回合自动压缩/)
  assert.match(refused, /下一回合再次询问/)
  const compacted = barText({ phase: 'compacted', event: { kind: 'compacted' }, occupancy: 0.4 }, t)
  assert.match(compacted, /已手动压缩上下文/)
  const queued = barText({ phase: 'queued', event: { kind: 'queued' }, occupancy: 0.55 }, t)
  assert.match(queued, /已批准：下一个压缩检查点自动执行压缩/)
  assert.match(queued, /55%/)
  const temp = barText({ phase: 'blocked', event: { why: 'temporary', expiresAtTurn: 3, turn: 1 }, currentTurn: 2, occupancy: 0.51 }, t)
  assert.match(temp, /临时拒绝（还剩2回合）/, '事件回合 1、过期 3 → 该回合后剩 2（3−1）')
  assert.match(temp, /51%/)
  // 0.2.10 中断回合回归：倒数以事件自身回合冻结——currentTurn 已推进到 7 也不影响
  // （活口径会算 8−7+1=2，事件口径 8−6=2 一致；事件回合 6、过期 8 → 还剩2）
  const frozen = barText({ phase: 'blocked', event: { why: 'temporary', expiresAtTurn: 8, turn: 6 }, currentTurn: 7, occupancy: 0.5 }, t)
  assert.match(frozen, /临时拒绝（还剩2回合）/)
  // 旧条冻结：currentTurn 推进到 9 后，turn 5 的老条仍是它当时的真实剩余
  const stale = barText({ phase: 'blocked', event: { why: 'temporary', expiresAtTurn: 8, turn: 5 }, currentTurn: 9, occupancy: 0.5 }, t)
  assert.match(stale, /临时拒绝（还剩3回合）/, '事件口径冻结（8−5=3），老条不漂移')
  // 事件缺 turn（旧宿主数据）→ 不显示倒数，退化为"临时拒绝"
  const noTurn = barText({ phase: 'blocked', event: { why: 'temporary', expiresAtTurn: 3 }, currentTurn: 2, occupancy: 0.51 }, t)
  assert.match(noTurn, /临时拒绝 · /)
  assert.doesNotMatch(noTurn, /还剩/)
})

test('whyLabel：未知原因回空串（文本退化为两段）', () => {
  const { whyLabel, barText } = loadClient().exports
  assert.equal(whyLabel('forbid-overflow', t), '禁止（含溢出兜底）')
  assert.equal(whyLabel('temporary', t, 3), '临时拒绝（还剩3回合）')
  assert.equal(whyLabel('temporary', t, undefined), '临时拒绝')
  assert.equal(whyLabel('mystery', t), '')
  const text = barText({ phase: 'blocked', event: { why: 'mystery' }, occupancy: 0.3 }, t)
  assert.match(text, /已拦截自动压缩 · 占用 30%/)
})

test('提示条渲染：ask 四按钮；blocked 只带「立即压缩」；calm 态无按钮', () => {
  const { RefusePromptBar } = loadClient().exports
  // 真实形状：turnTail 条目的 props.turn 是 TurnLocation（.turn 为回合号）
  const props = () => ({
    t,
    sessionId: 's1',
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  const askNode = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, occupancy: 0.6 }, ''] }).exports.RefusePromptBar(props())
  const ask = collect(askNode)
  assert.equal(askNode.props.className, 'refuse-compaction-prompt-bar ask', 'ask 形态带动画类名')
  assert.deepEqual(ask.buttons.map(b => b.label), ['立即压缩', '拒绝压缩', '三回合内不再询问', '不再询问'])

  const blockedNode = loadClient({ initialStates: [{ phase: 'blocked', eventTurn: 3, event: { why: 'forbid' }, occupancy: 0.7 }, ''] }).exports.RefusePromptBar(props())
  assert.deepEqual(collect(blockedNode).buttons.map(b => b.label), ['立即压缩'])

  const allowedNode = loadClient({ initialStates: [{ phase: 'allowed', eventTurn: 3, event: { kind: 'allow-once' }, occupancy: 0.7 }, ''] }).exports.RefusePromptBar(props())
  assert.deepEqual(collect(allowedNode).buttons.map(b => b.label), [])

  const refusedNode = loadClient({ initialStates: [{ phase: 'refused', eventTurn: 3, event: { kind: 'refused' }, occupancy: 0.7 }, ''] }).exports.RefusePromptBar(props())
  assert.deepEqual(collect(refusedNode).buttons.map(b => b.label), [])

  const queuedNode = loadClient({ initialStates: [{ phase: 'queued', eventTurn: 3, event: { kind: 'queued' }, occupancy: 0.7 }, ''] }).exports.RefusePromptBar(props())
  const queuedCollected = collect(queuedNode)
  assert.deepEqual(queuedCollected.buttons.map(b => b.label), [], 'queued 形态无按钮（批准已落地）')
  assert.match(queuedCollected.texts, /已批准：下一个压缩检查点自动执行压缩/)
  assert.equal(queuedNode.props.className, 'refuse-compaction-prompt-bar', 'queued 是 calm 态（无 ask 动画类名）')
})

test('拦截计数：repeatCount ≥2 显示"本回合已拦 N 次"，1/缺省不显示', () => {
  const { RefusePromptBar } = loadClient().exports
  const props = () => ({ t, sessionId: 's1', turn: { turn: 3, status: 'closed', steps: [] } })
  const withCount = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, occupancy: 0.6, repeatCount: 3 }, ''] }).exports.RefusePromptBar(props())
  assert.match(collect(withCount).texts, /本回合已拦 3 次自动压缩/)
  const once = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, occupancy: 0.6, repeatCount: 1 }, ''] }).exports.RefusePromptBar(props())
  assert.doesNotMatch(collect(once).texts, /本回合已拦/, '计数 1 = 这条询问本身，不复述')
  const absent = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, occupancy: 0.6 }, ''] }).exports.RefusePromptBar(props())
  assert.doesNotMatch(collect(absent).texts, /本回合已拦/)
})

test('忙碌回落：compact-now 返回 queued:true → 乐观翻 queued 形态且不提示 busy', async () => {
  const barLoad = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, occupancy: 0.6 }, ''], captureSetters: true })
  const node = barLoad.exports.RefusePromptBar({
    t,
    sessionId: 's1',
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  barLoad.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: false, busy: true, queued: true, error: 'idle required' }) })
  const { buttons } = collect(node)
  buttons.find(b => b.label === '立即压缩').node.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  // note（useState 序号 1）：queued 路径不提示 barBusy
  const noteUpdates = barLoad.setters[1].calls
  assert.equal(noteUpdates.at(-1), '', '批准已落地，不再提示"回合结束后可再试"')
  // 主状态（useState 序号 0）：函数式更新把 phase 翻成 queued
  const updater = barLoad.setters[0].calls.at(-1)
  assert.equal(typeof updater, 'function', '乐观更新是函数式 setState')
  const next = updater({ phase: 'ask', event: { why: 'manual-ask' }, occupancy: 0.6 })
  assert.equal(next.phase, 'queued')
  // 对照：宿主对非手动档不回落（无 queued 字段）→ 形态不变且提示 barBusy
  const barLoad2 = loadClient({ initialStates: [{ phase: 'blocked', eventTurn: 3, event: { why: 'forbid' }, occupancy: 0.7 }, ''], captureSetters: true })
  const node2 = barLoad2.exports.RefusePromptBar({
    t,
    sessionId: 's1',
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  barLoad2.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: false, busy: true, error: 'idle required' }) })
  const buttons2 = collect(node2).buttons
  buttons2.find(b => b.label === '立即压缩').node.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  const updater2 = barLoad2.setters[0].calls.at(-1)
  const unchanged = updater2({ phase: 'blocked', event: { why: 'forbid' }, occupancy: 0.7 })
  assert.equal(unchanged.phase, 'blocked', '无 queued 字段 → 形态原样保留')
  assert.equal(barLoad2.setters[1].calls.at(-1), t('barBusy'), '非手动档忙碌维持 barBusy 提示')
})

test('提示条：无状态 / 其它回合的事件 / promptBar=false → null（不渲染）', () => {
  const { RefusePromptBar } = loadClient().exports
  const props = { t, sessionId: 's1', turn: { turn: 3, status: 'closed', steps: [] } }
  assert.equal(loadClient().exports.RefusePromptBar(props), null, '无状态 → null')
  const otherTurn = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 2, event: { why: 'manual-ask' }, occupancy: 0.6 }, ''] }).exports.RefusePromptBar(props)
  assert.equal(otherTurn, null, '事件属于其它回合 → null')
  const off = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, promptBar: false, occupancy: 0.6 }, ''] }).exports.RefusePromptBar(props)
  assert.equal(off, null, 'promptBar=false → null')
})

test('按钮动作：POST 正确路由（compact-now / refuse / quiet×2）', async () => {
  const posts = []
  // fake React 不执行 useEffect（pollRef.current 为 null），点击只发 POST。
  // 组件闭包里的 fetch 解析自其所在 vm 沙箱全局——必须 stub 同一个沙箱。
  const barLoad = loadClient({ initialStates: [{ phase: 'ask', eventTurn: 3, event: { why: 'manual-ask' }, occupancy: 0.6 }, ''] })
  const node = barLoad.exports.RefusePromptBar({
    t,
    sessionId: 'sess 九',
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  barLoad.sandbox.fetch = async (url, opts) => {
    posts.push([url, opts])
    return { ok: true, json: async () => ({ ok: true, turn: 3, expiresAtTurn: 5 }) }
  }
  const { buttons } = collect(node)
  for (const label of ['立即压缩', '拒绝压缩', '三回合内不再询问', '不再询问']) {
    buttons.find(b => b.label === label).node.props.onClick()
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  // vm 沙箱对象的原型来自沙箱 realm，deepStrictEqual 会比对原型身份——用 JSON 比对
  assert.equal(JSON.stringify(posts), JSON.stringify([
    ['/refuse-compaction/compact-now?sessionId=' + encodeURIComponent('sess 九'), { method: 'POST' }],
    ['/refuse-compaction/refuse?sessionId=' + encodeURIComponent('sess 九'), { method: 'POST' }],
    ['/refuse-compaction/quiet?sessionId=' + encodeURIComponent('sess 九') + '&mode=temporary&turn=3', { method: 'POST' }],
    ['/refuse-compaction/quiet?sessionId=' + encodeURIComponent('sess 九') + '&mode=forbid', { method: 'POST' }],
  ]))
})

test('zh 词典的关键 key 完整且 en/zh 键集一致（fallback 链安全）', () => {
  const { exports } = loadClient()
  const dict = exports.MESSAGES.zh
  for (const key of ['sectionLabel', 'intro1', 'intro2', 'tierLabel', 'tierOff', 'tierTemporary', 'tierManual', 'tierForbid', 'spareOverflowLabel', 'promptBarLabel', 'revealAheadLabel', 'reset', 'loading', 'unavailable', 'barAsk', 'barBlocked', 'barAllowed', 'barRefused', 'barCompacted', 'barQueued', 'barRepeat', 'barCompactBtn', 'barRefuseBtn', 'barQuiet3Btn', 'barQuietForeverBtn', 'barBusy', 'whyTemporary', 'whyTemporaryLeft', 'whyForbid', 'whyLinkHold', 'whyManual']) {
    assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `zh 词典缺 ${key}`)
  }
  assert.deepEqual(Object.keys(dict).sort(), Object.keys(exports.MESSAGES.en).sort())
})

/* -------------------------------------------------------------------------- */
/* revealAhead 输入修复：受控 input 草稿态 + onBlur 校验提交                     */
/* -------------------------------------------------------------------------- */

test('normalizeNumberInput：解析 + 范围校验（越界/非法 → undefined）', () => {
  const { normalizeNumberInput } = loadClient().exports
  assert.equal(normalizeNumberInput('0.45', 0.02, 0.95), 0.45)
  assert.equal(normalizeNumberInput(' 0.2 ', 0.02, 0.95), 0.2)
  assert.equal(normalizeNumberInput('0.8', 0.02, 0.95), 0.8, '0.95 上限内放行（特效调试用）')
  assert.equal(normalizeNumberInput('0.99', 0.02, 0.95), undefined, '越上限 → 回滚')
  assert.equal(normalizeNumberInput('0', 0.02, 0.95), undefined, '低于下限 → 回滚')
  assert.equal(normalizeNumberInput('', 0.02, 0.95), undefined, '空串 → Number("")=0 越下限 → 回滚')
  assert.equal(normalizeNumberInput('abc', 0.02, 0.95), undefined)
  assert.equal(normalizeNumberInput('5', undefined, undefined), 5, '无界字段放行')
})

test('Field onBlur：number 型解析提交（form.set 收到数字）', () => {
  const { exports } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  const props = harness.settingsSlot.def.inject()
  const node = harness.settingsSlot.component(props)
  const found = collect(node)
  const revealInput = found.inputs.find(i => i.label === 'refuse-compaction.revealAheadLabel')
  assert.ok(revealInput, 'revealAhead 输入框存在')
  assert.equal(revealInput.node.props.type, 'number', '渲染为 number 输入')
  assert.equal(revealInput.node.props.min, 0.02)
  assert.equal(revealInput.node.props.max, 0.95)
  // 草稿初值 = 当前值；onBlur 直接失焦提交 → form.set('revealAhead', 0.3)
  revealInput.node.props.onBlur()
  assert.deepEqual(harness.setCalls.at(-1), ['revealAhead', 0.3])
})

/* -------------------------------------------------------------------------- */
/* F1 占用仪表 + F3 动画                                                        */
/* -------------------------------------------------------------------------- */

test('F1：注册第二条 turnTail 扩展项（gauge），注入 sessionId + form', () => {
  const { exports } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  const gaugeSlots = harness.slotRegistrations.filter(r => r.def.name === 'conversation.chat.turnTail')
  assert.equal(gaugeSlots.length, 2, '提示条 + 仪表两条')
  const gauge = gaugeSlots.find(r => r.def.id === 'refuse-compaction-gauge')
  assert.ok(gauge, 'gauge 槽已注册')
  assert.equal(typeof gauge.component, 'function')
  const injected = gauge.def.inject('sess-1')
  assert.equal(injected.sessionId, 'sess-1')
  assert.ok(injected.form, '注入设置表单（revealAhead 读取 + 档位写入）')
})

test('F1：gaugeVisible 纯函数（阈值 = effectiveRatio × (1 - revealAhead)）', () => {
  const { gaugeVisible } = loadClient().exports
  const base = { occupancy: 0.62, effectiveRatio: 0.75, occupancyTokens: 162000, compactionPoint: 196608 }
  assert.equal(gaugeVisible(base, 0.2), true, '0.62 ≥ 0.75×0.8=0.6 → 显示')
  assert.equal(gaugeVisible({ ...base, occupancy: 0.55 }, 0.2), false, '0.55 < 0.6 → 隐藏')
  assert.equal(gaugeVisible({ ...base, occupancy: 0.55 }, 0.4), true, '提前量调大 → 显示')
  assert.equal(gaugeVisible({ ...base, effectiveRatio: undefined }, 0.2), false, '压缩点未知 → 隐藏')
  assert.equal(gaugeVisible(null, 0.2), false)
  assert.equal(gaugeVisible({ ...base }, undefined), true, 'revealAhead 缺省 0.2')
  assert.equal(gaugeVisible({ ...base, compactionPoint: 0 }, 0.2), false, '非法压缩点 → 隐藏')
})

test('F1：formatTokens 缩写', () => {
  const { formatTokens } = loadClient().exports
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1234), '1.2k')
  assert.equal(formatTokens(262144), '262k')
  assert.equal(formatTokens(undefined), '—')
})

test('gaugeText：压缩点口径（越过钳 100%），与环形进度同源', () => {
  const { gaugeText } = loadClient().exports
  // 用户例口径：45k 已用 / 39321 压缩点 → 114% → 钳 100%（39321 缩写 39k）
  assert.equal(gaugeText({ occupancyTokens: 45000, compactionPoint: 39321 }, t), '100%（45k / 39k 压缩点）')
  // 蓝色常态：161218 / 196608 = 82%（196608 缩写 197k）
  assert.equal(gaugeText({ occupancyTokens: 161218, compactionPoint: 196608 }, t), '82%（161k / 197k 压缩点）')
  // 点缺失/非正 → 0%（仪表此时本就不渲染，纯函数只兜底；1000 缩写 1.0k）
  assert.equal(gaugeText({ occupancyTokens: 1000, compactionPoint: 0 }, t), '0%（1.0k / 0 压缩点）')
  assert.equal(gaugeText(undefined, t), '0%（0 / 0 压缩点）')
})

test('F1 仪表渲染：环形 + 压缩点口径文本 + 四档快切（高亮会话生效档）', () => {
  const { exports, sandbox } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  const gauge = harness.slotRegistrations.filter(r => r.def.id === 'refuse-compaction-gauge')[0]
  // 真实配对：tail 回合 3 渲染时宿主 currentTurn 已推进到 4（活尾判定 turn+1）
  const data = {
    currentTurn: 4,
    occupancy: 0.62,
    effectiveRatio: 0.75,
    occupancyTokens: 162000,
    contextWindow: 262144,
    compactionPoint: 196608,
    tier: 'off',
    globalTier: 'off',
  }
  // fake React：stateRef ← data，noteRef 无（组件只有 1 个 useState）
  const node = loadClient({ initialStates: [data] }).exports.RefuseGauge({
    t,
    sessionId: 's1',
    form: harness.form,
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  const found = collect(node)
  assert.equal(node.props.className, 'refuse-compaction-gauge')
  assert.match(found.texts, /82%（162k \/ 197k 压缩点）/, '文本 = 已用/压缩点口径（0.2.9，196608 缩写 197k）')
  assert.match(found.texts, /距压缩点 35k tokens/, '第二行距压缩点保留原样（196608−162000=34608→35k，用户要求直观）')
  assert.doesNotMatch(found.texts, /131k/, '不再重复强调总窗口（dsh 自带显示负责）')
  assert.deepEqual(found.buttons.map(b => b.label), ['关闭', '临时', '手动', '禁止'])
  assert.match(found.texts, /档位/)
  // 未达阈值 → null
  const hidden = loadClient({ initialStates: [{ ...data, occupancy: 0.3, occupancyTokens: 80000 }] }).exports.RefuseGauge({
    t,
    sessionId: 's1',
    form: harness.form,
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  assert.equal(hidden, null)
  // 无状态（轮询未命中/探查未通过）→ null
  assert.equal(loadClient().exports.RefuseGauge({ t, sessionId: 's1', form: harness.form, turn: { turn: 3, status: 'closed', steps: [] } }), null)

  // 会话覆盖生效（quiet 临时窗）：高亮跟随生效档"临时"而非全局"手动"，虚线 + 悬停说明
  const overrideData = { ...data, tier: 'temporary', globalTier: 'manual' }
  const overrideNode = loadClient({ initialStates: [overrideData] }).exports.RefuseGauge({
    t,
    sessionId: 's1',
    form: harness.form,
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  const overrideFound = collect(overrideNode)
  const tempBtn = overrideFound.buttons.find(b => b.label === '临时')
  assert.equal(tempBtn.node.props.style.borderStyle, 'dashed', '覆盖生效 → 生效档按钮虚线标记')
  assert.match(String(tempBtn.node.props.title), /会话覆盖生效中/)
  const manualBtn = overrideFound.buttons.find(b => b.label === '手动')
  assert.notEqual(manualBtn.node.props.style.borderStyle, 'dashed', '非生效档不带标记')
})

test('F1 仪表交互：档位按钮写 form.set(tier)；覆盖生效时附带清覆盖 POST + 乐观双翻', async () => {
  const { exports } = loadClient()
  const harness = fakeCtx()
  exports.apply(harness.ctx)
  const { setCalls } = harness
  const gauge = harness.slotRegistrations.filter(r => r.def.id === 'refuse-compaction-gauge')[0]
  const data = {
    currentTurn: 4,
    occupancy: 0.7,
    effectiveRatio: 0.75,
    occupancyTokens: 183000,
    contextWindow: 262144,
    compactionPoint: 196608,
    tier: 'off',
    globalTier: 'off',
  }
  const barLoad = loadClient({ initialStates: [data], captureSetters: true })
  const posts = []
  barLoad.sandbox.fetch = async (url, opts) => {
    posts.push([url, opts])
    return { ok: true, json: async () => ({ ok: true, cleared: true }) }
  }
  const node = barLoad.exports.RefuseGauge({
    t,
    sessionId: 's1',
    form: harness.form,
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  const { buttons } = collect(node)
  buttons.find(b => b.label === '手动').node.props.onClick()
  assert.deepEqual(setCalls.at(-1), ['tier', 'manual'])
  assert.equal(posts.length, 0, '无覆盖时只写全局档')
  buttons.find(b => b.label === '禁止').node.props.onClick()
  assert.deepEqual(setCalls.at(-1), ['tier', 'forbid'])
  // 当前档（tier='off'）重复点击不写
  const before = setCalls.length
  buttons.find(b => b.label === '关闭').node.props.onClick()
  assert.equal(setCalls.length, before)

  // 覆盖生效（temporary 压着 manual）：点"手动" = form.set + clear-override POST
  const overrideLoad = loadClient({
    initialStates: [{ ...data, tier: 'temporary', globalTier: 'manual' }],
    captureSetters: true,
  })
  const overridePosts = []
  overrideLoad.sandbox.fetch = async (url, opts) => {
    overridePosts.push([url, opts])
    return { ok: true, json: async () => ({ ok: true, cleared: true }) }
  }
  const overrideNode = overrideLoad.exports.RefuseGauge({
    t,
    sessionId: 's1',
    form: harness.form,
    turn: { turn: 3, status: 'closed', steps: [] },
  })
  const overrideButtons = collect(overrideNode).buttons
  overrideButtons.find(b => b.label === '手动').node.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(setCalls.at(-1), ['tier', 'manual'])
  assert.equal(overridePosts.length, 1, '覆盖生效 → 附带清覆盖')
  assert.equal(overridePosts[0][0], '/refuse-compaction/clear-override?sessionId=' + encodeURIComponent('s1'))
  // vm 沙箱对象的 realm 原型不同——JSON 比对（deepEqual 会比原型身份）
  assert.equal(JSON.stringify(overridePosts[0][1]), JSON.stringify({ method: 'POST' }))
  // 乐观更新：生效档与全局档一起翻到点击值
  const updater = overrideLoad.setters[0].calls.at(-1)
  const next = updater({ tier: 'temporary', globalTier: 'manual' })
  assert.equal(next.tier, 'manual')
  assert.equal(next.globalTier, 'manual')
})

test('barText：自动恢复三形态（resumed/recovered/exhausted）不复述占用率', () => {
  const { barText } = loadClient().exports
  const resumed = barText({ phase: 'resumed', event: { kind: 'resume', attempt: 1, max: 2 }, occupancy: 0.11 }, t)
  assert.match(resumed, /已自动继续（1\/2）/)
  assert.doesNotMatch(resumed, /11%/, '恢复形态不拼占用率')
  const recovered = barText({ phase: 'recovered', event: { kind: 'resumed', attempt: 2, max: 2 }, occupancy: 0.7 }, t)
  assert.match(recovered, /已压缩历史并自动继续（2\/2）/)
  const exhausted = barText({ phase: 'exhausted', event: { kind: 'resume', attempt: 2, max: 2 }, occupancy: 0.7 }, t)
  assert.match(exhausted, /已达上限（2\/2）/)
})
