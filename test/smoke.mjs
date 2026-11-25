/**
 * dsh-refuse-compaction 冒烟测试：mock CompactionEngine + tokenMeter + llm，
 * 直接驱动 apply() 的包装与监听器。
 *
 * mock 引擎实装 basic 引擎的内部调用形态：compactIfNeeded('pressure') 内部
 * this.compactPressure(...)（包装必须幂等穿透），模型切换路径直调
 * engine.compactPressure(..., true)（绕过 compactIfNeeded 的独立拦截面）。
 * compactNow 不被包装——手动 /compact 结构性放行，用调用计数与函数同一性断言。
 *
 * 运行：node --test test/smoke.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 隔离文件追踪：必须先于 lib/index.js 求值设置（ESM import 提升，故用动态 import）
const TEST_TMP = mkdtempSync(path.join(tmpdir(), 'refuse-compaction-test-'))
const TRACE_PATH = path.join(TEST_TMP, 'trace.ndjson')
process.env.DSH_REFUSE_COMPACTION_TRACE = TRACE_PATH
const { apply } = await import('../lib/index.js')

const BRIDGE = Symbol.for('dsh.exa-distill.bridge')

/* -------------------------------------------------------------------------- */
/* 追踪读取                                                                     */
/* -------------------------------------------------------------------------- */

function readTrace() {
  try {
    return readFileSync(TRACE_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

function traceEvents(since = 0) {
  return readTrace().slice(since)
}

/* -------------------------------------------------------------------------- */
/* mock：volatile 配置单元格 / 引擎 / harness                                    */
/* -------------------------------------------------------------------------- */

/** volatile 字段以"活单元格"到达（{get(){}}）——readValue 解包的模拟形态。 */
function cell(value) {
  return { get: () => value }
}

function makeConfig({ tier = 'off', spareOverflow = false, promptBar = true, tierThrows = false, autoResume = 'off', autoResumeMax = 2, autoResumeMinTail = 8192, outputGuard = 'auto' } = {}) {
  return {
    tier: tierThrows ? { get() { throw new Error('cell exploded') } } : cell(tier),
    spareOverflow: cell(spareOverflow),
    promptBar: cell(promptBar),
    autoResume: cell(autoResume),
    autoResumeMax: cell(autoResumeMax),
    autoResumeMinTail: cell(autoResumeMinTail),
    outputGuard: cell(outputGuard),
  }
}

/**
 * mock CompactionEngine：记录三方法调用；compactIfNeeded('pressure') 内部
 * this.compactPressure（与 basic 引擎同款内部形态，检验包装幂等）。
 */
function makeEngine({ result = null, failIfNeeded = false, failNow, failRegion } = {}) {
  const engine = {
    ifNeededCalls: [],
    pressureCalls: [],
    nowCalls: [],
    regionCalls: [],
    summarizeCalls: [],
    result,
    async compactIfNeeded(agent, trigger, signal) {
      engine.ifNeededCalls.push({ trigger })
      if (failIfNeeded) throw new Error('boom from original')
      if (trigger === 'pressure') return engine.compactPressure(agent, { config: { provider: 'test-provider', model: 'test-model' } }, signal, false)
      return engine.result
    },
    async compactPressure(agent, header, signal, requireBelowThreshold) {
      engine.pressureCalls.push({ requireBelowThreshold })
      return engine.result
    },
    async compactNow(agent, signal) {
      engine.nowCalls.push({ agent })
      if (failNow) throw failNow
      return { shadowedSeqs: [1, 2] }
    },
    // 自动恢复走的公开压缩入口（引擎侧 fixed owner='current-turn'）；
    // 内部调用 this.summarize 与 basic 引擎一致，让摘要包装能被真实命中。
    async compactRegion(start, end, agent, signal) {
      engine.regionCalls.push({ start, end })
      if (failRegion) throw failRegion
      await engine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'history' }] }] }, agent, signal)
      return { shadowedSeqs: [start, end], startSeq: start, endSeq: end }
    },
    // protected 摘要钩子（实例属性遮蔽的包装目标）
    async summarize(input, agent, signal) {
      engine.summarizeCalls.push({ input })
      return {
        summary: [{ type: 'text', text: 'default-summary' }],
        rawOutput: [{ type: 'text', text: 'default-summary' }],
        llmStreamCall: true,
        provider: 'test-provider',
        model: 'test-model',
      }
    },
  }
  return engine
}

let sessionCounter = 0

/** 组装 mock harness 并挂载插件。每条测试用唯一 sid，避免模块级状态串扰。 */
function mockHarness({
  contextWindow = 100000,
  tokens = 0,
  tier = 'off',
  spareOverflow = false,
  promptBar = true,
  engine = makeEngine(),
  compactionMissing = false,
  tierThrows = false,
  policyRow,
  fence,
  autoResume = 'off',
  autoResumeMax = 2,
  autoResumeMinTail = 8192,
  outputGuard = 'auto',
  maxTokens,
  surfaceEvents,
  llmStream,
} = {}) {
  const traceStart = readTrace().length
  const listeners = {}
  const routes = new Map()
  const ctx = {
    on(event, fn, opts) {
      listeners[event] = fn
      if (event === 'agent/pre-step') {
        assert.equal(opts?.prepend, true, 'pre-step 监听器必须 prepend（先于引擎自己的监听器安装包装）')
      }
    },
    // 桌面组合没有全局 compaction 服务：引擎按 preset 作用域经 serviceFor 解析
    ...(compactionMissing ? {} : {
      agentPresets: {
        serviceFor: (agent, name) => (name === 'compaction' ? engine : undefined),
      },
    }),
    // loader 入口树（F2：直读 dsh-compaction-policy 行的活配置，零对方改动）
    ...(policyRow === undefined ? {} : {
      loader: {
        store: {
          row1: { options: { id: 'compaction-policy', name: 'dsh-compaction-policy', config: policyRow } },
        },
      },
    }),
    tokenMeter: {
      measure: (session, header) => ({ totalTokens: tokens }),
    },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow } }),
      // 旁路摘要用（自动恢复的 summarizeWithTail）：默认实现为空流，
      // 需要真实摘要的测试显式传 llmStream。
      ...(llmStream === undefined ? {} : { stream: llmStream }),
    },
    logger: {
      info() {},
      warn() {},
    },
    // 宿主连接栅栏（准入测试用）：不传 = 模拟老版 dsh 没有 requestRejection
    ...(fence === undefined ? {} : { connection: fence }),
    get(name) {
      return name === 'connection' && fence !== undefined ? fence : undefined
    },
    inject(deps, cb) {
      assert.deepEqual([...deps], ['webServer'])
      cb({
        webServer: {
          register(def) {
            routes.set(def.path, def.handler)
          },
        },
        effect(fn) {
          fn()
        },
      })
    },
  }
  sessionCounter += 1
  const sid = `session-${sessionCounter}`
  // surface：surfaceEvents 提供 [(seq, type, data)]，默认空表面（不参与自动恢复）
  const eventLog = new Map()
  const surfaceNodes = []
  for (const entry of surfaceEvents ?? []) {
    eventLog.set(entry.seq, entry)
    surfaceNodes.push(entry.seq)
  }
  const session = {
    id: sid,
    header: { id: sid },
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model', ...(maxTokens === undefined ? {} : { maxTokens }) } }),
    surface: { nodes: surfaceNodes, replaceGeneration: 0 },
    eventAt: (seq) => eventLog.get(seq),
    toolHistory: () => undefined,
  }
  const agent = {
    session,
    inbox: { nextTurn: [], nextStep: [] },
    followups: [],
    followup(message) {
      agent.followups.push(message)
      agent.inbox.nextTurn.push(message)
    },
  }
  const config = makeConfig({ tier, spareOverflow, promptBar, tierThrows, autoResume, autoResumeMax, autoResumeMinTail, outputGuard })
  apply(ctx, config)
  // 自动探针：触发一次包装安装（turn=0 → 不记回合、不武装临时窗），
  // 模拟真实时序里 pre-step 先于首次压缩尝试。显式 preStep 调用保持幂等。
  listeners['agent/pre-step']({ agent, messages: [], turn: 0, step: 0, signal: new AbortController().signal, modelSelection: { provider: 'test-provider', model: 'test-model' } }, () => 'next')
  return { ctx, engine, listeners, routes, session, agent, config, traceStart, sid }
}

/* --- 事件驱动辅助（对齐真实触发点：pre-step / turn-stopping / 三调用点） --- */

async function preStep(h, turn, messages = []) {
  assert.ok(h.listeners['agent/pre-step'], 'apply 未注册 agent/pre-step')
  const decision = { kind: 'enter' }
  const returned = await h.listeners['agent/pre-step']({ agent: h.agent, messages, turn, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'test-provider', model: 'test-model' } }, () => decision)
  assert.equal(returned, decision, 'pre-step 监听器必须透传 next() 的决策')
}

function turnEnd(h, turn) {
  assert.ok(h.listeners['agent/turn-stopping'], 'apply 未注册 agent/turn-stopping')
  const returned = h.listeners['agent/turn-stopping']({ agent: h.agent, turn, signal: new AbortController().signal })
  assert.equal(returned, undefined, 'turn-stopping 监听器必须返回 undefined（serial 返回其它值会 bail）')
}

/** 步压力触发点（agent/pre-step 监听器 → compactIfNeeded('pressure')）。 */
function attemptPressure(h) {
  return h.engine.compactIfNeeded(h.agent, 'pressure', new AbortController().signal)
}

/** 模型切换触发点（agent/request prepend → compactPressure 直调，绕过 compactIfNeeded）。 */
function attemptSwitch(h) {
  return h.engine.compactPressure(h.agent, { config: { provider: 'test-provider', model: 'other-model' } }, new AbortController().signal, true)
}

/** 溢出恢复触发点（agent/request-error → compactIfNeeded('context-overflow')）。 */
function attemptOverflow(h) {
  return h.engine.compactIfNeeded(h.agent, 'context-overflow', new AbortController().signal)
}

async function callRoute(h, routePath, { method = 'GET', query = '', headers } = {}) {
  const handler = h.routes.get(routePath)
  assert.ok(handler, `route ${routePath} not registered`)
  const req = { method, url: query === '' ? routePath : `${routePath}?${query}`, ...(headers === undefined ? {} : { headers }) }
  const res = {
    code: 0,
    body: '',
    writeHead(code) {
      this.code = code
    },
    end(body) {
      this.body = body ?? ''
    },
  }
  await handler(req, res)
  return { code: res.code, json: JSON.parse(res.body) }
}

/* -------------------------------------------------------------------------- */
/* 1. 挂载与自禁用                                                              */
/* -------------------------------------------------------------------------- */

test('挂载：mounted trace + 探针自动安装包装（engine-instrumented）', () => {
  const h = mockHarness({ tier: 'off' })
  const events = traceEvents(h.traceStart)
  assert.equal(events.find(e => e.ev === 'mounted')?.tier, 'off')
  assert.ok(events.some(e => e.ev === 'engine-instrumented'), '探针在挂载后安装包装')
  // compactNow 不被包装（函数同一性 = 手动路径结构性免疫）
  assert.equal(typeof h.engine.compactNow, 'function')
})

test('自禁用：agentPresets 服务缺席 → mount-fail，apply 不抛，监听器照常', async () => {
  const h = mockHarness({ compactionMissing: true })
  const events = traceEvents(h.traceStart)
  assert.equal(events[0].ev, 'mount-fail')
  assert.equal(events[0].why, 'agentPresets service missing')
  // 回合追踪/路由等其余功能不受影响；探针/显式 preStep 静默（无引擎可包装）
  assert.ok(h.listeners['agent/pre-step'])
  await preStep(h, 1)
  turnEnd(h, 1)
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'engine-instrumented').length, 0)
})

test('自禁用：preset 引擎缺 compactIfNeeded → 包装失败 mount-fail，apply 不抛', () => {
  const h = mockHarness({ engine: { compactPressure: async () => null } })
  const events = traceEvents(h.traceStart)
  assert.equal(events.find(e => e.ev === 'mounted') !== undefined, true)
  const fail = events.find(e => e.ev === 'mount-fail')
  assert.equal(fail?.why, 'compactIfNeeded missing on preset engine')
})

/* -------------------------------------------------------------------------- */
/* 2. 档位 × 触发点矩阵                                                         */
/* -------------------------------------------------------------------------- */

test('off 档：三个触发点全放行（engine 到达原始方法，结果透传）', async () => {
  const h = mockHarness({ tier: 'off', engine: makeEngine({ result: { shadowedSeqs: [9] } }) })
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [9] })
  assert.deepEqual(await attemptSwitch(h), { shadowedSeqs: [9] })
  assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [9] })
  assert.equal(h.engine.ifNeededCalls.length, 2) // pressure + overflow
  assert.equal(h.engine.pressureCalls.length, 2) // 内部一次 + 模型切换一次
  assert.deepEqual(h.engine.pressureCalls.map(c => c.requireBelowThreshold), [false, true])
})

test('forbid 档：压力/模型切换/溢出全拦（spareOverflow=false），compactNow 直通', async () => {
  const h = mockHarness({ tier: 'forbid', tokens: 90000, engine: makeEngine({ result: { shadowedSeqs: [9] } }) })
  const before = h.engine.compactNow
  assert.equal(await attemptPressure(h), null, '拦截 = 返回 null')
  assert.equal(await attemptSwitch(h), null)
  assert.equal(await attemptOverflow(h), null, 'forbid 默认拦溢出')
  assert.equal(h.engine.ifNeededCalls.length, 0, '被拦截时原始方法不执行')
  assert.equal(h.engine.pressureCalls.length, 0)
  // compactNow 结构性不碰：同一性 + 直通
  assert.equal(h.engine.compactNow, before)
  const now = await h.engine.compactNow(h.agent, new AbortController().signal)
  assert.deepEqual(now, { shadowedSeqs: [1, 2] })
  assert.equal(h.engine.nowCalls.length, 1)
})

test('forbid 档 + spareOverflow：溢出恢复放行（provider 已确认超限的兜底）', async () => {
  const h = mockHarness({ tier: 'forbid', spareOverflow: true, tokens: 90000, engine: makeEngine({ result: { shadowedSeqs: [9] } }) })
  assert.equal(await attemptPressure(h), null)
  assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [9] }, 'spareOverflow 放行溢出')
})

test('temporary 档：压力/模型切换拦、溢出放行（临时/手动档永不拦溢出）', async () => {
  // tokens 85000 = 0.85：压缩点（0.8）之上、90% 切档之下——真实阈值穿越形态；
  // engine result 非空使"拦截返回 null"与"放行返回 result"可区分
  const h = mockHarness({ tier: 'temporary', tokens: 85000, engine: makeEngine({ result: { shadowedSeqs: [1] } }) })
  await preStep(h, 1) // 武装临时窗 [1,3]
  assert.equal(await attemptPressure(h), null, '拦 = null（放行会返回 result）')
  assert.equal(await attemptSwitch(h), null)
  const overflowEngine = makeEngine({ result: { shadowedSeqs: [7] } })
  h.engine.result = { shadowedSeqs: [7] }
  assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [7] }, '溢出放行')
})

test('manual 档：压力拦+问、模型切换拦、溢出放行', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000, engine: makeEngine({ result: { shadowedSeqs: [2] } }) })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null, '本回合首次：拦 + 亮条（result 非空使放行可区分）')
  assert.equal(await attemptSwitch(h), null, '同回合重试：静默拦')
  h.engine.result = { shadowedSeqs: [5] }
  assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [5] }, '溢出放行')
})

test('压力门（v0.2.11）：占用未知（新会话首步）→ 放行，不拦不记事件', async () => {
  // 真机 0.2.10 实锤：新对话第一轮 requestHeader() 未建立 → snapshot null，
  // 旧逻辑把空探查当"压缩尝试"拦下 → 每个新对话第一轮弹假询问条。
  // 引擎自身对这种情况也 no-op（compactIfNeeded 无 header 直接 null），放行 = 无插件时行为。
  const h = mockHarness({ tier: 'manual', engine: makeEngine({ result: { shadowedSeqs: [1] } }) })
  h.session.requestHeader = () => undefined
  await preStep(h, 1)
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [1] }, '放行：原始方法被调用')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked').length, 0, '无拦截 trace')
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s.json.event, null, '无提示条事件（不亮条）')
  // 形态二：meter 给不出有限 totalTokens（模型切换路径带 header 也一样未知）
  h.ctx.tokenMeter.measure = () => ({ totalTokens: undefined })
  assert.deepEqual(await attemptSwitch(h), { shadowedSeqs: [1] }, '模型切换路径同样放行')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked').length, 0)
  // 溢出恢复不看占用率：forbid + 未知占用仍拦溢出（D2 语义不变）
  const h2 = mockHarness({ tier: 'forbid' })
  h2.session.requestHeader = () => undefined
  assert.equal(await attemptOverflow(h2), null, 'forbid 溢出照拦')
})

test('压力门（v0.2.11）：占用已知但低于压缩点 → 放行；越过压缩点恢复拦截', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 50000, contextWindow: 100000, engine: makeEngine({ result: { shadowedSeqs: [2] } }) })
  await preStep(h, 1)
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [2] }, '0.5 < 0.8 压缩点 → 放行（低压力不是压缩尝试）')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked').length, 0, '无拦截 trace')
  // 压力涨到压缩点之上：恢复"尝试"语义，manual 照旧询问
  h.ctx.tokenMeter.measure = () => ({ totalTokens: 90000 })
  assert.equal(await attemptPressure(h), null, '0.9 ≥ 0.8 → 拦截 + 询问')
  const blocked = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].why, 'manual-ask')
  assert.equal(blocked[0].occupancy, 0.9)
})

/* -------------------------------------------------------------------------- */
/* 3. 临时档：3 回合窗口 + 过期回落 + 90% 切档                                    */
/* -------------------------------------------------------------------------- */

test('临时档：武装回合起拦 3 个回合，过期自动切回手动拒绝（tier-expired → manual）', async () => {
  const h = mockHarness({ tier: 'temporary', tokens: 85000 })
  await preStep(h, 5) // 武装：expiresAtTurn = 7
  const armed = traceEvents(h.traceStart).find(e => e.ev === 'tier-armed')
  assert.equal(armed.turn, 5)
  assert.equal(armed.expiresAtTurn, 7)
  assert.equal(await attemptPressure(h), null, '回合 5 拦')
  turnEnd(h, 5)
  await preStep(h, 6)
  assert.equal(await attemptPressure(h), null, '回合 6 拦')
  turnEnd(h, 6)
  await preStep(h, 7)
  assert.equal(await attemptPressure(h), null, '回合 7 拦')
  turnEnd(h, 7)
  await preStep(h, 8)
  assert.equal(await attemptPressure(h), null, '回合 8 过期 → 切回手动拒绝，本回合首次询问')
  const expired = traceEvents(h.traceStart).find(e => e.ev === 'tier-expired')
  assert.ok(expired, '过期有 trace')
  assert.equal(expired.turn, 8)
  assert.equal(expired.to, 'manual')
  const reAsk = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked' && e.turn === 8)
  assert.equal(reAsk.length, 1)
  assert.equal(reAsk[0].why, 'manual-ask', '过期后按 manual 语义询问')
  // 会话覆盖已是 manual：全局 tier 仍是 temporary，但不再重复武装临时窗
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'tier-armed').length, 1, '不重复武装')
  await callRoute(h, '/refuse-compaction/allow', { method: 'POST', query: `sessionId=${h.sid}` })
  h.engine.result = { shadowedSeqs: [3] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [3] }, 'manual 语义下 allowOnce 放行')
})

test('临时档 90% 切档：占用率 ≥0.9 → manual 语义接管（询问/放行/重问）', async () => {
  const h = mockHarness({ tier: 'temporary', tokens: 92000, contextWindow: 100000 })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null, '0.92 ≥ 0.9 → 切 manual 后按 manual 首问拦截')
  const switched = traceEvents(h.traceStart).find(e => e.ev === 'tier-switch')
  assert.ok(switched, 'tier-switch trace')
  assert.equal(switched.from, 'temporary')
  assert.equal(switched.to, 'manual')
  assert.equal(switched.occupancy, 0.92)
  assert.equal(await attemptPressure(h), null, '同回合重试静默拦')
  // 本回合放行
  await callRoute(h, '/refuse-compaction/allow', { method: 'POST', query: `sessionId=${h.sid}` })
  h.engine.result = { shadowedSeqs: [1] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [1] }, 'allowOnce 放行')
  turnEnd(h, 1)
  await preStep(h, 2)
  assert.equal(await attemptPressure(h), null, '下一回合重新询问')
})

test('临时档 89% 不切档：保持临时档语义（拦但无询问）', async () => {
  const h = mockHarness({ tier: 'temporary', tokens: 89000, contextWindow: 100000 })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null)
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'tier-switch').length, 0)
  const blocked = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].why, 'temporary')
  assert.equal(blocked[0].expiresAtTurn, 3)
})

/* -------------------------------------------------------------------------- */
/* 4. 手动档：block-first 询问 / 同回合拒绝记忆 / 回合切换重问                     */
/* -------------------------------------------------------------------------- */

test('手动档：首次拦+亮条，同回合重试静默拦，allowOnce 放行，回合切换重问', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000, contextWindow: 100000 })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null, '首次：拦截')
  const blocked = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].why, 'manual-ask')
  assert.equal(blocked[0].occupancy, 0.9)
  // 提示条事件（phase=ask）
  const state1 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(state1.json.phase, 'ask')
  assert.equal(state1.json.tier, 'manual')
  assert.equal(state1.json.event.why, 'manual-ask')
  assert.equal(state1.json.occupancy, 0.9)
  // 同回合重试：静默拦（不重复亮条，不触发原始方法）
  assert.equal(await attemptPressure(h), null)
  assert.equal(await attemptSwitch(h), null, '模型切换直调同样被拦')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked').length, 3, '重试仍有 trace（manual-repeat）')
  const state2 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(state2.json.event.why, 'manual-ask', '提示条事件不重复刷新')
  // 本回合放行
  const allow = await callRoute(h, '/refuse-compaction/allow', { method: 'POST', query: `sessionId=${h.sid}` })
  assert.equal(allow.json.ok, true)
  assert.equal(allow.json.turn, 1)
  h.engine.result = { shadowedSeqs: [4] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [4] }, 'allowOnce 放行')
  // 回合切换：allowOnce/refusedTurn 失效 → 重新询问
  turnEnd(h, 1)
  await preStep(h, 2)
  assert.equal(await attemptPressure(h), null, '回合 2 重新询问')
  const reAsk = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked' && e.turn === 2)
  assert.equal(reAsk.length, 1)
  assert.equal(reAsk[0].why, 'manual-ask')
})

/* -------------------------------------------------------------------------- */
/* 5. 全局改档 = 清全部会话覆盖                                                  */
/* -------------------------------------------------------------------------- */

test('全局改档：会话覆盖清除，按新全局档决策（global-tier-change trace）', async () => {
  const h = mockHarness({ tier: 'temporary', tokens: 85000 })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null, 'temporary 生效（0.85 在压缩点上、90% 切档下）')
  // 用户改档（volatile 单元格现读）
  h.config.tier = cell('off')
  h.engine.result = { shadowedSeqs: [2] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [2] }, '改档后放行')
  const changed = traceEvents(h.traceStart).filter(e => e.ev === 'global-tier-change')
  assert.equal(changed.length, 1)
  assert.deepEqual(changed[0], { ...changed[0], from: 'temporary', to: 'off' })
})

/* -------------------------------------------------------------------------- */
/* 6. 联动（exa-distill 桥）                                                    */
/* -------------------------------------------------------------------------- */

test('联动：hold+pending 拦压力压缩；flush 后放行；溢出永不拦', async () => {
  const h = mockHarness({ tier: 'off', tokens: 60000, contextWindow: 100000 })
  globalThis[BRIDGE] = {
    holdCompactionEnabled: () => true,
    hasPending: () => true,
  }
  try {
    assert.equal(await attemptPressure(h), null, '有 pending → 拦')
    const linkBlock = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked' && e.why === 'link-hold')
    assert.equal(linkBlock.length, 1)
    // flush：hasPending 变 false → 同配置放行
    globalThis[BRIDGE].hasPending = () => false
    h.engine.result = { shadowedSeqs: [8] }
    assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [8] }, 'flush 后放行')
    // 溢出永不拦（联动仅 'pressure'）
    assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [8] })
  } finally {
    delete globalThis[BRIDGE]
  }
})

test('联动安全阀：占用率 ≥95% 放行（link-release）+ 档位状态机继续', async () => {
  const h = mockHarness({ tier: 'forbid', tokens: 96000, contextWindow: 100000 })
  globalThis[BRIDGE] = {
    holdCompactionEnabled: () => true,
    hasPending: () => true,
  }
  try {
    assert.equal(await attemptPressure(h), null, '安全阀放行落入 forbid 档 → 仍拦')
    const released = traceEvents(h.traceStart).filter(e => e.ev === 'link-release')
    assert.equal(released.length, 1)
    assert.equal(released[0].occupancy, 0.96)
    // 放行 + off 档 → 真正执行压缩。注意：off 档放行路径会经两层包装各决策一次
    // （compactIfNeeded 放行 → 原方法内部 this.compactPressure 再过包装，计划书
    // §1 已核实的幂等双过），因此 link-release trace 每次尝试可能两条——只断言发生。
    const h2 = mockHarness({ tier: 'off', tokens: 96000, contextWindow: 100000, engine: makeEngine({ result: { shadowedSeqs: [6] } }) })
    globalThis[BRIDGE] = { holdCompactionEnabled: () => true, hasPending: () => true }
    try {
      assert.deepEqual(await attemptPressure(h2), { shadowedSeqs: [6] }, '安全阀放行 + off → 压缩执行')
      assert.ok(traceEvents(h2.traceStart).some(e => e.ev === 'link-release' && e.sessionId === h2.sid), 'link-release trace')
    } finally {
      delete globalThis[BRIDGE]
    }
  } finally {
    delete globalThis[BRIDGE]
  }
})

test('联动缺失/未启用：桥不存在或 holdCompaction=false → 完全不联动', async () => {
  const h = mockHarness({ tier: 'off', engine: makeEngine({ result: { shadowedSeqs: [1] } }) })
  // 桥不存在
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [1] })
  // 桥存在但 holdCompaction=false（exa-distill 复选框未开）
  globalThis[BRIDGE] = { holdCompactionEnabled: () => false, hasPending: () => true }
  try {
    assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [1] })
  } finally {
    delete globalThis[BRIDGE]
  }
  // 桥抛错（旧版损坏）→ 视作不联动
  globalThis[BRIDGE] = { holdCompactionEnabled: () => { throw new Error('stale bridge') }, hasPending: () => true }
  try {
    assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [1] })
  } finally {
    delete globalThis[BRIDGE]
  }
})

test('联动：占用率未知（resolveModelInfo 失败）→ 安全阀无法判定，仍拦', async () => {
  const h = mockHarness({ tier: 'off', tokens: 60000 })
  h.ctx.llm.resolveModelInfo = async () => ({ context: {} }) // 无 contextWindow
  globalThis[BRIDGE] = { holdCompactionEnabled: () => true, hasPending: () => true }
  try {
    assert.equal(await attemptPressure(h), null)
    assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'link-release').length, 0)
  } finally {
    delete globalThis[BRIDGE]
  }
})

/* -------------------------------------------------------------------------- */
/* 7. 异常注入（D3）                                                            */
/* -------------------------------------------------------------------------- */

test('decide 异常 → 放行（session.id 访问抛错；tier 单元格抛错被 readValue 吞掉走默认档）', async () => {
  const h = mockHarness({ engine: makeEngine({ result: { shadowedSeqs: [1] } }) })
  // readValue 对单元格 get() 抛错自吞（返回 undefined → 默认 off），不构成 decide 异常——
  // 真正能触发 D3 的注入点：会话 id 访问器抛错（decide 顶部 sid = String(session.id)）
  Object.defineProperty(h.session, 'id', { get() { throw new Error('session exploded') } })
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [1] }, 'D3：异常放行')
  const err = traceEvents(h.traceStart).find(e => e.ev === 'decide-error')
  assert.ok(err, 'decide-error trace')
  assert.equal(err.fallback, 'allow')
  // overflow 与模型切换路径同样放行
  assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [1] })
  assert.deepEqual(await attemptSwitch(h), { shadowedSeqs: [1] })
})

test('原始方法抛错 → 原样透传（不吞）', async () => {
  const h = mockHarness({ engine: makeEngine({ failIfNeeded: true }) })
  await assert.rejects(attemptPressure(h), /boom from original/)
  await assert.rejects(attemptOverflow(h), /boom from original/)
})

test('tokenMeter 缺席 → 占用率未知 → 空探查放行（v0.2.11 压力门；不崩、不切档）', async () => {
  const h = mockHarness({ tier: 'temporary', engine: makeEngine({ result: { shadowedSeqs: [6] } }) })
  delete h.ctx.tokenMeter
  await preStep(h, 1)
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [6] }, '占用未知 → 放行（引擎自身也会 no-op）')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'tier-switch').length, 0, '占用率未知不切档')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked').length, 0, '不记拦截')
})

/* -------------------------------------------------------------------------- */
/* 8. compact-now 路由                                                          */
/* -------------------------------------------------------------------------- */

test('compact-now：空闲 → ok + 本回合 allowOnce；忙 → busy 标记', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000 })
  await preStep(h, 1)
  await preStep(h, 1) // noteAgent 已记录 agent
  assert.equal(await attemptPressure(h), null) // 先拦一次（manual-ask）
  const busy = await callRoute(h, '/refuse-compaction/compact-now', {
    method: 'POST',
    query: `sessionId=${h.sid}`,
  })
  assert.equal(busy.json.ok, true)
  assert.deepEqual(busy.json.shadowed, 2)
  assert.equal(h.engine.nowCalls.length, 1, '手动 compactNow 到达引擎（结构性放行的实证）')
  h.engine.result = { shadowedSeqs: [3] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [3] }, '手动压缩成功后本回合放行')
  // 忙：compactNow 抛 busy
  const h2 = mockHarness({ tier: 'manual', tokens: 90000, engine: makeEngine({ failNow: Object.assign(new Error('manual compaction requires an idle agent with no waking queued work'), { kind: 'busy' }) }) })
  preStep(h2, 1)
  preStep(h2, 1)
  const busy2 = await callRoute(h2, '/refuse-compaction/compact-now', { method: 'POST', query: `sessionId=${h2.sid}` })
  assert.equal(busy2.json.ok, false)
  assert.equal(busy2.json.busy, true)
  // v0.2.7 忙碌回落：批准不静默丢弃——写"批准到下一回合"，queued 事件回原条
  assert.equal(busy2.json.queued, true, '手动档忙碌 → 批准下一检查点')
  const qstate = await callRoute(h2, '/refuse-compaction/state.json', { query: `sessionId=${h2.sid}&turn=1` })
  assert.equal(qstate.json.phase, 'queued', 'queued 事件落在原询问条回合')
  assert.equal(qstate.json.event.kind, 'queued')
  h2.engine.result = { shadowedSeqs: [7] }
  assert.deepEqual(await attemptPressure(h2), { shadowedSeqs: [7] }, '批准后本回合（当前回合）尝试放行')
  turnEnd(h2, 1)
  preStep(h2, 2)
  assert.deepEqual(await attemptPressure(h2), { shadowedSeqs: [7] }, '下一回合也放行（批准到第 2 回合）')
  turnEnd(h2, 2)
  preStep(h2, 3)
  assert.equal(await attemptPressure(h2), null, '批准窗口外恢复询问')
})

test('compact-now：非忙失败同样回落批准；非手动档（forbid）不回落', async () => {
  // 非忙失败（如摘要模型报错）：手动档回落批准
  const h = mockHarness({ tier: 'manual', tokens: 90000, engine: makeEngine({ failNow: new Error('summarizer exploded') }) })
  await preStep(h, 1)
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null, '先拦一次（manual-ask）')
  const failed = await callRoute(h, '/refuse-compaction/compact-now', { method: 'POST', query: `sessionId=${h.sid}` })
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.busy, false)
  assert.equal(failed.json.queued, true, '失败回落 → 批准下一检查点')
  h.engine.result = { shadowedSeqs: [9] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [9] }, '批准后放行（引擎自身路径重试）')
  // forbid 覆盖：busy 不回落（forbid 分支不查 allowOnceTurn，落了也不生效）
  const h2 = mockHarness({ tier: 'manual', tokens: 90000, engine: makeEngine({ failNow: Object.assign(new Error('idle required'), { kind: 'busy' }) }) })
  preStep(h2, 1)
  preStep(h2, 1)
  await callRoute(h2, '/refuse-compaction/quiet', { method: 'POST', query: `sessionId=${h2.sid}&mode=forbid` })
  const busy2 = await callRoute(h2, '/refuse-compaction/compact-now', { method: 'POST', query: `sessionId=${h2.sid}` })
  assert.equal(busy2.json.busy, true)
  assert.equal(busy2.json.queued, false, 'forbid 档不批准（allowOnceTurn 无处生效）')
  assert.equal(await attemptPressure(h2), null, 'forbid 档继续拦')
})

test('拦截计数：manual-repeat 递增，新回合归 1，state.json 按 refusedTurn 匹配供给', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000, contextWindow: 100000 })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null, '首次 ask（计 1）')
  const s1 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s1.json.repeatCount, 1)
  await attemptPressure(h)
  await attemptSwitch(h)
  const s2 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s2.json.repeatCount, 3, '两次静默重试 → 计 3')
  assert.equal(s2.json.event.why, 'manual-ask', '事件本身不刷新')
  const sOld = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=9` })
  assert.equal(sOld.json.repeatCount, null, '回合不匹配不供给（老条不串数）')
  turnEnd(h, 1)
  await preStep(h, 2)
  assert.equal(await attemptPressure(h), null, '回合 2 重新询问')
  const s3 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=2` })
  assert.equal(s3.json.repeatCount, 1, '新回合归 1')
  const sBack = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(sBack.json.repeatCount, null, '老回合条不再显示计数')
})

test('state.json：未知会话 → none；GET 不改变状态（peek 语义）', async () => {
  const h = mockHarness({ tier: 'temporary' })
  const none = await callRoute(h, '/refuse-compaction/state.json', { query: 'sessionId=unknown&turn=1' })
  assert.equal(none.json.phase, 'none')
  assert.equal(none.json.tier, 'temporary')
  // GET 前后状态不变：临时窗不因轮询提前武装/消费
  await preStep(h, 1)
  const s1 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s1.json.tier, 'temporary')
  assert.equal(s1.json.currentTurn, 1)
  assert.equal(s1.json.promptBar, true)
  const s2 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s2.json.tier, 'temporary', 'GET 幂等')
  turnEnd(h, 1)
  await preStep(h, 2)
  const s3 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=2` })
  assert.equal(s3.json.tier, 'temporary')
  turnEnd(h, 2)
  await preStep(h, 3)
  await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=3` })
  turnEnd(h, 3)
  await preStep(h, 4)
  const s4 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=4` })
  assert.equal(s4.json.tier, 'manual', '过期后报告已切回手动拒绝')
})

test('state.json：promptBar=false 上报（客户端据此不渲染提示条）', async () => {
  const h = mockHarness({ tier: 'manual', promptBar: false })
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s.json.promptBar, false)
})

/* -------------------------------------------------------------------------- */
/* F1 压力快照 / F2 compaction-policy 桥                                        */
/* -------------------------------------------------------------------------- */

test('state.json v2：现算压力快照（占用/token/窗口/压缩点/生效比例）', async () => {
  const h = mockHarness({ tier: 'off', tokens: 162000, contextWindow: 262144 })
  await preStep(h, 1) // noteAgent 记录 session（快照数据源）
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s.json.occupancyTokens, 162000)
  assert.equal(s.json.contextWindow, 262144)
  assert.equal(s.json.compactionPoint, Math.floor(262144 * 0.8), '桥缺席 → 内置默认 0.8')
  assert.equal(s.json.effectiveRatio, Math.floor(262144 * 0.8) / 262144)
  assert.equal(s.json.occupancy, 162000 / 262144)
})

test('F2 直读 loader 行：compaction-policy 活配置修正压缩点（用户机 0.75/0 形态）', async () => {
  const h = mockHarness({ tier: 'off', tokens: 162000, contextWindow: 262144, policyRow: { enabled: true, triggerRatio: 0.75, headroomTokens: 0 } })
  await preStep(h, 1)
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  // floor(min(0.75×262144, 262144−0−0)) = 196608
  assert.equal(s.json.compactionPoint, 196608, '按策略行修正压缩点')
  assert.equal(s.json.effectiveRatio, 196608 / 262144)
  // 字段缺省 → 归一化默认（headroomTokens 缺省 24576，字面 0 合法）
  const h2 = mockHarness({ tier: 'off', tokens: 0, contextWindow: 262144, policyRow: { enabled: true } })
  preStep(h2, 1)
  const s2 = await callRoute(h2, '/refuse-compaction/state.json', { query: `sessionId=${h2.sid}&turn=1` })
  assert.equal(s2.json.compactionPoint, Math.floor(Math.min(262144 * 0.8, 262144 - 24576)), '未设字段用 compaction-policy 缺省')
})

test('F2 直读 v0.2.8：entries() 递归（组内子行）+ fiber 活配置优先于行原始值', async () => {
  const W = 262144
  // 行嵌在组内子树：loader.entries() 官方递归遍历能找到（平铺 store 扫描漏掉的真实形态）
  const nested = { options: { id: 'compaction-policy', name: 'dsh-compaction-policy', config: { enabled: true, triggerRatio: 0.3, headroomTokens: 0 } } }
  const h = mockHarness({ tier: 'off', tokens: 39322, contextWindow: W })
  h.ctx.loader = {
    store: {},
    entries: function * () { yield nested },
  }
  await preStep(h, 1)
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s.json.compactionPoint, Math.floor(W * 0.3), 'entries() 递归找到组内行（0.3 生效）')

  // 运行 fiber 的活配置优先：设置页提交写进 fiber，行原始值是组装层快照
  const entryWithFiber = {
    options: { id: 'compaction-policy', name: 'dsh-compaction-policy', config: { enabled: true, triggerRatio: 0.75, headroomTokens: 0 } },
    fiber: { config: { enabled: true, triggerRatio: 0.4, headroomTokens: 0 } },
  }
  const h2 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W })
  h2.ctx.loader = { store: { row1: entryWithFiber }, entries: function * () { yield entryWithFiber } }
  preStep(h2, 1)
  const s2 = await callRoute(h2, '/refuse-compaction/state.json', { query: `sessionId=${h2.sid}&turn=1` })
  assert.equal(s2.json.compactionPoint, Math.floor(W * 0.4), 'fiber.config 优先（设置提交后的活值）')

  // effectiveConfig 的 volatile cell 优先于两者（插件真实使用的活引用）
  const entryWithCells = {
    options: { id: 'compaction-policy', name: 'dsh-compaction-policy', config: { enabled: true, triggerRatio: 0.75, headroomTokens: 0 } },
    fiber: {
      config: { enabled: true, triggerRatio: 0.4, headroomTokens: 0 },
      effectiveConfig: { enabled: { get: () => true }, triggerRatio: { get: () => 0.5 }, headroomTokens: { get: () => 0 } },
    },
  }
  const h3 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W })
  h3.ctx.loader = { store: { row1: entryWithCells }, entries: function * () { yield entryWithCells } }
  preStep(h3, 1)
  const s3 = await callRoute(h3, '/refuse-compaction/state.json', { query: `sessionId=${h3.sid}&turn=1` })
  assert.equal(s3.json.compactionPoint, Math.floor(W * 0.5), 'effectiveConfig cell 现读（最活一层）')

  // 平铺 store（无 entries() 的旧形态）仍工作
  const h4 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: { enabled: true, triggerRatio: 0.3, headroomTokens: 0 } })
  preStep(h4, 1)
  const s4 = await callRoute(h4, '/refuse-compaction/state.json', { query: `sessionId=${h4.sid}&turn=1` })
  assert.equal(s4.json.compactionPoint, Math.floor(W * 0.3), '平铺扫描回退路径不回归')

  // policy-scan 诊断事件：挂载时扫描一次（行缺失时 matched=null 也可见）
  const scan = traceEvents(h4.traceStart).find(e => e.ev === 'policy-scan' && e.when === 'mount')
  assert.ok(scan, 'mount 时有 policy-scan 追踪')
  assert.equal(scan.entryCount, 1)
  assert.ok(scan.names.includes('dsh-compaction-policy'))
})

test('F2 回退：未装/禁用/路由不命中/预算非正 → 内置默认 0.8×window', async () => {
  const W = 262144
  const fallback = Math.floor(W * 0.8)
  // 未装（无 loader）
  const h1 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W })
  preStep(h1, 1)
  assert.equal((await callRoute(h1, '/refuse-compaction/state.json', { query: `sessionId=${h1.sid}&turn=1` })).json.compactionPoint, fallback)
  // loader 存在但无该行
  const h2 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: undefined })
  h2.ctx.loader = { store: { other: { options: { id: 'x', name: 'dsh-other', config: {} } } } }
  preStep(h2, 1)
  assert.equal((await callRoute(h2, '/refuse-compaction/state.json', { query: `sessionId=${h2.sid}&turn=1` })).json.compactionPoint, fallback)
  // 禁用
  const h3 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: { enabled: false, triggerRatio: 0.75, headroomTokens: 0 } })
  preStep(h3, 1)
  assert.equal((await callRoute(h3, '/refuse-compaction/state.json', { query: `sessionId=${h3.sid}&turn=1` })).json.compactionPoint, fallback)
  // 路由不命中
  const h4 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: { enabled: true, routes: 'other-provider', triggerRatio: 0.75, headroomTokens: 0 } })
  preStep(h4, 1)
  assert.equal((await callRoute(h4, '/refuse-compaction/state.json', { query: `sessionId=${h4.sid}&turn=1` })).json.compactionPoint, fallback)
  // routes 清空（'' = 哪儿都不干预）→ 回退
  const h5 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: { enabled: true, routes: '', triggerRatio: 0.75, headroomTokens: 0 } })
  preStep(h5, 1)
  assert.equal((await callRoute(h5, '/refuse-compaction/state.json', { query: `sessionId=${h5.sid}&turn=1` })).json.compactionPoint, fallback)
  // 预算非正（headroom 吃满窗口）→ 回退
  const h6 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: { enabled: true, triggerRatio: 0.75, headroomTokens: W } })
  preStep(h6, 1)
  assert.equal((await callRoute(h6, '/refuse-compaction/state.json', { query: `sessionId=${h6.sid}&turn=1` })).json.compactionPoint, fallback)
  // headroom 字面 0 合法（预算 = W − 0 − 0）
  const h7 = mockHarness({ tier: 'off', tokens: 0, contextWindow: W, policyRow: { enabled: true, triggerRatio: 0.75, headroomTokens: 0 } })
  preStep(h7, 1)
  assert.equal((await callRoute(h7, '/refuse-compaction/state.json', { query: `sessionId=${h7.sid}&turn=1` })).json.compactionPoint, Math.floor(W * 0.75))
})

test('F1 数据链：decide 路径占用率与 state.json 快照同源（pressureSnapshot）', async () => {
  // tokens 92000/100000 = 0.92 ≥ 0.9 → temporary 切 manual（decide 用同一快照口径）
  const h = mockHarness({ tier: 'temporary', tokens: 92000, contextWindow: 100000 })
  await preStep(h, 1)
  assert.equal(await attemptPressure(h), null)
  const switched = traceEvents(h.traceStart).find(e => e.ev === 'tier-switch')
  assert.equal(switched.occupancy, 0.92)
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s.json.occupancy, 0.92, 'state.json 与 decide 同口径')
  assert.equal(s.json.compactionPoint, 80000)
})

/* -------------------------------------------------------------------------- */
/* 提示条按钮路由：refuse / quiet（会话级静默）                                   */
/* -------------------------------------------------------------------------- */

test('quiet temporary：本回合起拦 3 回合（事件带还剩N回合），到期切回 manual 询问', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 85000, contextWindow: 100000 })
  await preStep(h, 4)
  assert.equal(await attemptPressure(h), null, 'manual 首次询问拦截')
  const quiet = await callRoute(h, '/refuse-compaction/quiet', { method: 'POST', query: `sessionId=${h.sid}&mode=temporary` })
  assert.equal(quiet.json.ok, true)
  assert.equal(quiet.json.mode, 'temporary')
  assert.equal(quiet.json.expiresAtTurn, 6, '回合 4 起 3 回合：4/5/6')
  // 本回合后续尝试：临时档静默拦（不再询问）
  assert.equal(await attemptPressure(h), null)
  const blocked = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked' && e.why === 'temporary')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].expiresAtTurn, 6)
  turnEnd(h, 4)
  await preStep(h, 5)
  assert.equal(await attemptPressure(h), null, '回合 5 继续拦')
  turnEnd(h, 5)
  await preStep(h, 6)
  assert.equal(await attemptPressure(h), null, '回合 6 继续拦（还剩1回合）')
  turnEnd(h, 6)
  await preStep(h, 7)
  assert.equal(await attemptPressure(h), null, '回合 7 过期 → manual 重新询问')
  const expired = traceEvents(h.traceStart).find(e => e.ev === 'tier-expired')
  assert.equal(expired.to, 'manual')
  const reAsk = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked' && e.turn === 7)
  assert.equal(reAsk[0].why, 'manual-ask')
})

test('quiet temporary（中断回合）：以询问条回合为锚武装，跳过死回合（还剩3/2/1 不跳档）', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 85000, contextWindow: 100000 })
  // 回合 5 被中断：pre-step 走了（currentTurn=5），turn-stopping 不走
  // （dsh-agent-loop 中止路径设 turnEnds={kind:'aborted'} 后 rethrow）
  await preStep(h, 5)
  assert.equal(await attemptPressure(h), null, '中断前的 manual 询问拦截')
  // 在死回合 5 的条上点"三回合内不再询问"（客户端带上条目回合 5）
  const quiet = await callRoute(h, '/refuse-compaction/quiet', { method: 'POST', query: `sessionId=${h.sid}&mode=temporary&turn=5` })
  assert.equal(quiet.json.expiresAtTurn, 8, 'base = max(currentTurn=5, 条回合5+1=6) = 6 → 覆盖 6/7/8')
  assert.equal(quiet.json.turn, 5, '事件仍落在点击的条上（currentTurn 未推进）')
  // 回合 6/7/8 全拦（三回合语义兑现），回合 9 过期 → manual 重新询问
  await preStep(h, 6)
  assert.equal(await attemptPressure(h), null, '回合 6 拦')
  turnEnd(h, 6)
  await preStep(h, 7)
  assert.equal(await attemptPressure(h), null, '回合 7 拦')
  turnEnd(h, 7)
  await preStep(h, 8)
  assert.equal(await attemptPressure(h), null, '回合 8 拦')
  turnEnd(h, 8)
  await preStep(h, 9)
  assert.equal(await attemptPressure(h), null, '回合 9 过期 → manual 重新询问')
  const expired = traceEvents(h.traceStart).find(e => e.ev === 'tier-expired')
  assert.equal(expired.to, 'manual')
})

test('quiet forbid：本会话驳回全部自动压缩（含溢出），全局改档解除', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000 })
  await preStep(h, 2)
  const quiet = await callRoute(h, '/refuse-compaction/quiet', { method: 'POST', query: `sessionId=${h.sid}&mode=forbid` })
  assert.equal(quiet.json.ok, true)
  assert.equal(quiet.json.mode, 'forbid')
  assert.equal(await attemptPressure(h), null, '压力拦')
  assert.equal(await attemptSwitch(h), null, '模型切换拦')
  assert.equal(await attemptOverflow(h), null, '溢出也拦（forbid 语义）')
  // 全局改档 → 清全部会话覆盖 → 解除
  h.config.tier = cell('off')
  h.engine.result = { shadowedSeqs: [9] }
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [9] }, '改档清覆盖后放行')
})

test('clear-override：清会话覆盖（仪表快切配套），清后按全局档重新决策', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000 })
  await preStep(h, 2)
  await callRoute(h, '/refuse-compaction/quiet', { method: 'POST', query: `sessionId=${h.sid}&mode=forbid` })
  assert.equal(await attemptPressure(h), null, '覆盖生效中照拦')
  const cleared = await callRoute(h, '/refuse-compaction/clear-override', { method: 'POST', query: `sessionId=${h.sid}` })
  assert.equal(cleared.json.ok, true)
  assert.equal(cleared.json.cleared, true, '确有覆盖被清')
  const traceClear = traceEvents(h.traceStart).find(e => e.ev === 'override-clear')
  assert.ok(traceClear, 'override-clear trace')
  // 清覆盖后按全局档（manual）重新决策：refusedTurn 一并清了 → 本回合重新询问
  assert.equal(await attemptPressure(h), null, '全局 manual → 重新询问拦截')
  const reAsk = traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked' && e.why === 'manual-ask')
  assert.ok(reAsk.length >= 1, '清覆盖后回到 manual 询问语义')
  // 无覆盖时再清：幂等，cleared=false
  const again = await callRoute(h, '/refuse-compaction/clear-override', { method: 'POST', query: `sessionId=${h.sid}` })
  assert.equal(again.json.ok, true)
  assert.equal(again.json.cleared, false)
})

test('refuse：提示条翻"已拒绝"灰态，回合内后续静默拦，下一回合重新询问', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000 })
  await preStep(h, 3)
  assert.equal(await attemptPressure(h), null, '首次询问拦截')
  const refused = await callRoute(h, '/refuse-compaction/refuse', { method: 'POST', query: `sessionId=${h.sid}` })
  assert.equal(refused.json.ok, true)
  const state = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=3` })
  assert.equal(state.json.phase, 'refused', '提示条翻灰态')
  assert.equal(state.json.event.kind, 'refused')
  // 回合内后续：静默拦（manual-repeat，不刷事件）
  assert.equal(await attemptPressure(h), null)
  const state2 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=3` })
  assert.equal(state2.json.phase, 'refused', '拒绝态保持')
  turnEnd(h, 3)
  await preStep(h, 4)
  assert.equal(await attemptPressure(h), null, '下一回合重新询问')
})

/* -------------------------------------------------------------------------- */
/* 9. 路由准入（v0.2.12）：本机网页不能改写档位                                  */
/* -------------------------------------------------------------------------- */

test('准入：宿主栅栏放行 → 路由照常执行', async () => {
  const h = mockHarness({ tier: 'off', fence: { requestRejection: () => undefined } })
  const state = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(state.code, 200)
  assert.equal(state.json.phase, 'none')
})

test('准入：宿主栅栏回 403 → 拒绝且 handler 不执行', async () => {
  const h = mockHarness({ tier: 'off', fence: { requestRejection: () => 403 } })
  const refused = await callRoute(h, '/refuse-compaction/allow', { method: 'POST', query: `sessionId=${h.sid}` })
  assert.equal(refused.code, 403)
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.error, 'forbidden')
  const events = traceEvents(h.traceStart)
  assert.ok(events.some(e => e.ev === 'route-rejected' && e.status === 403), '拒绝必须留痕')
})

test('准入：宿主栅栏回 401 → 区分未认证', async () => {
  const h = mockHarness({ tier: 'off', fence: { requestRejection: () => 401 } })
  const refused = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(refused.code, 401)
  assert.equal(refused.json.error, 'unauthorized')
})

test('准入：栅栏自身抛异常 → 403（fail-closed，绝不静默放行）', async () => {
  const h = mockHarness({
    tier: 'off',
    fence: { requestRejection: () => { throw new Error('boom') } },
  })
  const res = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(res.code, 403)
  assert.ok(traceEvents(h.traceStart).some(e => e.ev === 'route-fence-error'))
})

test('准入：无栅栏时跨站 Origin 被拒；DNS 重绑定的同源相等也不行', async () => {
  const h = mockHarness({ tier: 'off' })
  const cross = await callRoute(h, '/refuse-compaction/allow', {
    method: 'POST',
    query: `sessionId=${h.sid}`,
    headers: { host: '127.0.0.1:5173', origin: 'http://evil.example' },
  })
  assert.equal(cross.code, 403, '跨站 Origin 必须拒')
  // 重绑定：Origin 与 Host 相同，但 Host 不是回环权威 —— 这一层是 Origin 相等拦不住的
  const rebound = await callRoute(h, '/refuse-compaction/allow', {
    method: 'POST',
    query: `sessionId=${h.sid}`,
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  })
  assert.equal(rebound.code, 403, '非回环 Host 必须拒')
  const sandboxed = await callRoute(h, '/refuse-compaction/allow', {
    method: 'POST',
    query: `sessionId=${h.sid}`,
    headers: { host: '127.0.0.1:5173', origin: 'null' },
  })
  assert.equal(sandboxed.code, 403, 'Origin: null（沙箱 iframe / data: 文档）必须拒')
})

test('准入：无栅栏时同源回环放行；Host 缺失也放行（桌面代理会剥掉头再签 cookie）', async () => {
  const h = mockHarness({ tier: 'off' })
  const sameOrigin = await callRoute(h, '/refuse-compaction/state.json', {
    query: `sessionId=${h.sid}`,
    headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
  })
  assert.equal(sameOrigin.code, 200, '同源回环是仪表自己的调用')
  const localhost = await callRoute(h, '/refuse-compaction/state.json', {
    query: `sessionId=${h.sid}`,
    headers: { host: 'localhost:5173' },
  })
  assert.equal(localhost.code, 200)
  const stripped = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(stripped.code, 200, '无 Host（被代理剥离）不得误伤')
})

test('准入：回环逐段校验，127.0.0.1.evil.example 不算回环', async () => {
  const h = mockHarness({ tier: 'off' })
  const res = await callRoute(h, '/refuse-compaction/state.json', {
    query: `sessionId=${h.sid}`,
    headers: { host: '127.0.0.1.evil.example' },
  })
  assert.equal(res.code, 403)
})

/* -------------------------------------------------------------------------- */
/* 10. 截断自动恢复（auto-resume）                                              */
/* -------------------------------------------------------------------------- */

/** turn/end 事件：session/event 监听器的输入。 */
function turnEndEvent(turn, kind = 'max-tokens') {
  return { type: 'turn/end', seq: 9000 + turn, data: { turn, reason: { kind } } }
}

/** 走真实入口：ctx.on('session/event') 的监听器。 */
async function fireTurnEnd(h, turn, kind = 'max-tokens') {
  const listener = h.listeners['session/event']
  assert.ok(listener, 'apply 未注册 session/event')
  const returned = await listener(h.session, turnEndEvent(turn, kind))
  // 真实的 agent 会把 followup 消息取走开新一轮；mock 里手动消费，模拟该时序。
  h.agent.inbox.nextTurn.length = 0
  return returned
}

/** 一段最小可信表面：system + turn1 + turn2（turn2 是被截断的那一轮）。 */
function twoTurnSurface() {
  return [
    { seq: 1, type: 'system/message', data: {} },
    { seq: 2, type: 'user/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'old request' }] } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'old answer' }] } } },
    { seq: 4, type: 'user/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'latest request' }] } } },
    { seq: 5, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'truncated answer' }] } } },
  ]
}

test('自动恢复：max-tokens 结束 → 自动排队一条「继续」（插件自有 source）', async () => {
  const h = mockHarness({ tier: 'off', autoResume: 'continue' })
  await fireTurnEnd(h, 1)
  assert.equal(h.agent.followups.length, 1, '必须自动继续一次')
  const message = h.agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'refuse-compaction:auto-resume')
  assert.match(message.content[0].text, /继续/)
  const fired = traceEvents(h.traceStart).find(e => e.ev === 'resume-fire')
  assert.equal(fired?.mode, 'continue')
  assert.equal(fired?.attempt, 1)
})

test('自动恢复：aborted / error / completed 一律不触发', async () => {
  const h = mockHarness({ tier: 'off', autoResume: 'continue' })
  await fireTurnEnd(h, 1, 'aborted')
  await fireTurnEnd(h, 2, 'error')
  await fireTurnEnd(h, 3, 'completed')
  assert.equal(h.agent.followups.length, 0)
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'resume-fire').length, 0)
})

test('自动恢复：off 档完全不动作（默认关闭）', async () => {
  const h = mockHarness({ tier: 'manual' })
  await fireTurnEnd(h, 1)
  assert.equal(h.agent.followups.length, 0)
})

test('自动恢复：用户已排队输入 → 不抢话（resume-skip user-pending）', async () => {
  const h = mockHarness({ tier: 'off', autoResume: 'continue' })
  h.agent.inbox.nextTurn.push({ id: 'user-typed', source: { kind: 'user' } })
  await fireTurnEnd(h, 1)
  assert.equal(h.agent.followups.length, 0, '用户先说话')
  const skip = traceEvents(h.traceStart).find(e => e.ev === 'resume-skip')
  assert.equal(skip?.reason, 'user-pending')
})

test('自动恢复：连续上限 2 次后停手；用户新消息重置计数', async () => {
  const h = mockHarness({ tier: 'off', autoResume: 'continue', autoResumeMax: 2 })
  await fireTurnEnd(h, 1)
  await fireTurnEnd(h, 2)
  await fireTurnEnd(h, 3)
  assert.equal(h.agent.followups.length, 2, '第三次必须停手')
  const exhausted = traceEvents(h.traceStart).find(e => e.ev === 'resume-exhausted')
  assert.equal(exhausted?.attempts, 2)
  // 用户真的插话 → 计数归零，可再次恢复
  await preStep(h, 4, [{ source: { kind: 'user' }, content: [{ type: 'text', text: '我自己来' }] }])
  await fireTurnEnd(h, 4)
  assert.equal(h.agent.followups.length, 3)
})

test('自动恢复 continue 档：低占用时绝不压缩（不调 compactRegion）', async () => {
  const h = mockHarness({
    tier: 'off',
    autoResume: 'recover',
    contextWindow: 100000,
    tokens: 5000,
    maxTokens: 32768,
    surfaceEvents: twoTurnSurface(),
  })
  await fireTurnEnd(h, 2)
  await preStep(h, 3, [h.agent.followups[0]])
  assert.equal(h.engine.regionCalls.length, 0, '剩余输出空间充足 → 只继续')
  const fired = traceEvents(h.traceStart).find(e => e.ev === 'resume-fire')
  assert.equal(fired?.compress, false)
  assert.equal(fired?.remaining, 100000 - 5000 - 32768)
})

test('自动恢复 recover 档：剩余空间不足 → 只压「被截断轮之前」，该轮原样保留', async () => {
  const h = mockHarness({
    tier: 'off',
    autoResume: 'recover',
    contextWindow: 61440,
    tokens: 50000,
    maxTokens: 32768,
    maxTokens: 32768,
    surfaceEvents: twoTurnSurface(),
  })
  await fireTurnEnd(h, 2)
  assert.equal(h.agent.followups.length, 1)
  await preStep(h, 3, [h.agent.followups[0]])
  assert.deepEqual(h.engine.regionCalls, [{ start: 2, end: 3 }], 'start 跳过 system 头，end 停在被截断轮之前')
  const compacted = traceEvents(h.traceStart).find(e => e.ev === 'resume-compact')
  assert.equal(compacted?.brokenTurn, 2)
  assert.equal(compacted?.shadowed, 2)
})

test('自动恢复：无可压范围（只有被截断的一轮）→ 跳过压缩但仍继续', async () => {
  const h = mockHarness({
    tier: 'off',
    autoResume: 'recover',
    contextWindow: 61440,
    tokens: 50000,
    maxTokens: 32768,
    surfaceEvents: [
      { seq: 1, type: 'system/message', data: {} },
      { seq: 2, type: 'user/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'only turn' }] } } },
      { seq: 3, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'cut' }] } } },
    ],
  })
  await fireTurnEnd(h, 2)
  await preStep(h, 3, [h.agent.followups[0]])
  assert.equal(h.engine.regionCalls.length, 0)
  const skip = traceEvents(h.traceStart).find(e => e.ev === 'resume-compact-skip')
  assert.equal(skip?.reason, 'no-range')
})

test('自动恢复：压缩失败只降级为「继续」，不抛不给引擎补二次压缩', async () => {
  const engine = makeEngine({ failRegion: new Error('summary blew up') })
  const h = mockHarness({
    tier: 'off',
    autoResume: 'recover',
    engine,
    contextWindow: 61440,
    tokens: 50000,
    maxTokens: 32768,
    surfaceEvents: twoTurnSurface(),
  })
  await fireTurnEnd(h, 2)
  await preStep(h, 3, [h.agent.followups[0]])
  const failure = traceEvents(h.traceStart).find(e => e.ev === 'resume-compact-fail')
  assert.match(failure?.err ?? '', /summary blew up/)
  // 失败不得设置 resume-hold：引擎本回合仍可自行压缩
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'resume-hold').length, 0)
})

test('自动恢复：压缩成功 → 本回合引擎不再二次压缩（resume-hold）', async () => {
  const h = mockHarness({
    tier: 'off',
    autoResume: 'recover',
    contextWindow: 61440,
    tokens: 50000,
    maxTokens: 32768,
    surfaceEvents: twoTurnSurface(),
  })
  await fireTurnEnd(h, 2)
  await preStep(h, 3, [h.agent.followups[0]])
  assert.deepEqual(await attemptPressure(h), null, '恢复压缩刚落地 → 压力路径直接 no-op')
  assert.equal(h.engine.pressureCalls.length, 0)
  assert.ok(traceEvents(h.traceStart).some(e => e.ev === 'resume-hold'))
})

test('自动恢复摘要：包装 summarize 时带上只读尾部 + 独立输出上限', async () => {
  const captured = []
  async function* fakeStream(options) {
    captured.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '## Next Step\n- keep going' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    yield { type: 'finish', reason: { kind: 'completed' } }
  }
  const h = mockHarness({
    tier: 'off',
    autoResume: 'recover',
    contextWindow: 61440,
    tokens: 50000,
    maxTokens: 32768,
    surfaceEvents: twoTurnSurface(),
    llmStream: fakeStream,
  })
  await fireTurnEnd(h, 2)
  await preStep(h, 3, [h.agent.followups[0]])
  assert.equal(captured.length, 1, '一次旁路摘要请求')
  const options = captured[0]
  assert.equal(options.purpose, 'compaction')
  assert.equal(options.maxTokens, 4096, '摘要请求绝不能沿用会话 32k 的输出预留')
  const last = options.messages[options.messages.length - 2]
  const tailText = JSON.stringify(last)
  assert.match(tailText, /MOST RECENT TURN/, '指令前必须带只读尾部前言')
  assert.match(tailText, /truncated answer/, '尾部必须含被截断轮的可见内容')
  assert.doesNotMatch(tailText, /reasoning/, '绝不把 reasoning 塞进摘要请求')
})

/* -------------------------------------------------------------------------- */
/* 11. 输出预算守门（output guard / A）                                         */
/* -------------------------------------------------------------------------- */

/** 走真实入口：ctx.on('agent/request') 的 waterfall 监听器。 */
async function fireRequest(h, proposed = { provider: 'test-provider', model: 'test-model', maxTokens: 32768 }) {
  const listener = h.listeners['agent/request']
  assert.ok(listener, 'apply 未注册 agent/request')
  return listener({ agent: h.agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => proposed)
}

/** 压缩点压到 20,000（triggerRatio 0.2）：便于在 100k 窗口里造出「越过压缩点」。 */
const GUARD_POLICY = { enabled: true, triggerRatio: 0.2, headroomTokens: 0 }

test('输出守门：未越过压缩点 → 原样返回（正常回合绝不碰 maxTokens）', async () => {
  const h = mockHarness({
    tier: 'manual',
    contextWindow: 100000,
    tokens: 5000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 32768)
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'output-guard').length, 0)
})

test('输出守门：越过压缩点且预算不足 → 压到「窗口 − 已用 − 4096」', async () => {
  const h = mockHarness({
    tier: 'forbid',
    contextWindow: 100000,
    tokens: 70000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 100000 - 70000 - 4096)
  const guard = traceEvents(h.traceStart).find(e => e.ev === 'output-guard')
  assert.equal(guard?.configured, 32768)
  assert.equal(guard?.clamped, 25904)
  assert.equal(guard?.compactionPoint, 20000)
  // 其余字段原样保留（provider/model 不得改动）
  assert.equal(out.provider, 'test-provider')
  assert.equal(out.model, 'test-model')
})

test('输出守门：预算已够（剩余空间大于配置上限）→ 不压', async () => {
  const h = mockHarness({
    tier: 'manual',
    contextWindow: 100000,
    tokens: 25000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 32768, '25,000 已过压缩点，但 100k−25k−4096 > 32768')
})

test('输出守门：压到 1024 以下就没有意义 → 跳过，交给溢出恢复', async () => {
  const h = mockHarness({
    tier: 'forbid',
    contextWindow: 100000,
    tokens: 99000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 32768, '不压，保持原值')
  const skip = traceEvents(h.traceStart).find(e => e.ev === 'output-guard-skip')
  assert.equal(skip?.budget, -3096)
})

test('输出守门：off 档完全不动作', async () => {
  const h = mockHarness({
    tier: 'forbid',
    contextWindow: 100000,
    tokens: 70000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
    outputGuard: 'off',
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 32768)
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'output-guard').length, 0)
})

test('输出守门：maxTokens 缺失 → 不动（不凭空造一个上限）', async () => {
  const h = mockHarness({
    tier: 'forbid',
    contextWindow: 100000,
    tokens: 70000,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h, { provider: 'test-provider', model: 'test-model' })
  assert.equal(out.maxTokens, undefined)
})

test('输出守门：state.json 现算 armed / effective（仪表提醒的数据源）', async () => {
  const h = mockHarness({
    tier: 'forbid',
    contextWindow: 100000,
    tokens: 70000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const res = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(res.code, 200)
  const guard = res.json.outputGuard
  assert.equal(guard.enabled, true)
  assert.equal(guard.armed, true)
  assert.equal(guard.configured, 32768)
  assert.equal(guard.effective, 25904)
  assert.equal(guard.remaining, 30000)
  assert.equal(guard.safety, 4096)
})

test('输出守门：未越线时 state.json 的 armed=false（仪表不提醒）', async () => {
  const h = mockHarness({
    tier: 'manual',
    contextWindow: 100000,
    tokens: 5000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const res = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(res.json.outputGuard.armed, false)
  assert.equal(res.json.outputGuard.effective, 32768)
})

test('输出守门：档位「关闭」时整条停用（即使开关打开、已越线）', async () => {
  const h = mockHarness({
    tier: 'off',
    contextWindow: 100000,
    tokens: 70000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 32768, '关闭档 = 完全放手，不碰输出预算')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'output-guard').length, 0)
  const res = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(res.json.outputGuard.enabled, true, '开关本身是开的')
  assert.equal(res.json.outputGuard.armed, false, '但档位关闭 → 不生效')
  assert.equal(res.json.outputGuard.tier, 'off')
})

test('输出守门：临时档同样生效（不是只有禁止档）', async () => {
  const h = mockHarness({
    tier: 'temporary',
    contextWindow: 100000,
    tokens: 70000,
    maxTokens: 32768,
    policyRow: GUARD_POLICY,
  })
  const out = await fireRequest(h)
  assert.equal(out.maxTokens, 25904)
  const res = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}` })
  assert.equal(res.json.outputGuard.armed, true)
  assert.equal(res.json.outputGuard.tier, 'temporary')
})
