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

function makeConfig({ tier = 'off', spareOverflow = false, promptBar = true, tierThrows = false } = {}) {
  return {
    tier: tierThrows ? { get() { throw new Error('cell exploded') } } : cell(tier),
    spareOverflow: cell(spareOverflow),
    promptBar: cell(promptBar),
  }
}

/**
 * mock CompactionEngine：记录三方法调用；compactIfNeeded('pressure') 内部
 * this.compactPressure（与 basic 引擎同款内部形态，检验包装幂等）。
 */
function makeEngine({ result = null, failIfNeeded = false, failNow } = {}) {
  const engine = {
    ifNeededCalls: [],
    pressureCalls: [],
    nowCalls: [],
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
  }
  return engine
}

let sessionCounter = 0

/** 组装 mock harness 并挂载插件。每条测试用唯一 sid，避免模块级状态串扰。 */
function mockHarness({ contextWindow = 100000, tokens = 0, tier = 'off', spareOverflow = false, promptBar = true, engine = makeEngine(), compactionMissing = false, tierThrows = false, policyRow } = {}) {
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
    },
    logger: {
      info() {},
      warn() {},
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
  const session = {
    id: sid,
    header: { id: sid },
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
  }
  const agent = { session }
  const config = makeConfig({ tier, spareOverflow, promptBar, tierThrows })
  apply(ctx, config)
  // 自动探针：触发一次包装安装（turn=0 → 不记回合、不武装临时窗），
  // 模拟真实时序里 pre-step 先于首次压缩尝试。显式 preStep 调用保持幂等。
  listeners['agent/pre-step']({ agent, messages: [], turn: 0, step: 0, signal: new AbortController().signal, modelSelection: { provider: 'test-provider', model: 'test-model' } }, () => 'next')
  return { ctx, engine, listeners, routes, session, agent, config, traceStart, sid }
}

/* --- 事件驱动辅助（对齐真实触发点：pre-step / turn-stopping / 三调用点） --- */

function preStep(h, turn) {
  assert.ok(h.listeners['agent/pre-step'], 'apply 未注册 agent/pre-step')
  const decision = { kind: 'enter' }
  const returned = h.listeners['agent/pre-step']({ agent: h.agent, messages: [], turn, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'test-provider', model: 'test-model' } }, () => decision)
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

async function callRoute(h, routePath, { method = 'GET', query = '' } = {}) {
  const handler = h.routes.get(routePath)
  assert.ok(handler, `route ${routePath} not registered`)
  const req = { method, url: query === '' ? routePath : `${routePath}?${query}` }
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

test('自禁用：agentPresets 服务缺席 → mount-fail，apply 不抛，监听器照常', () => {
  const h = mockHarness({ compactionMissing: true })
  const events = traceEvents(h.traceStart)
  assert.equal(events[0].ev, 'mount-fail')
  assert.equal(events[0].why, 'agentPresets service missing')
  // 回合追踪/路由等其余功能不受影响；探针/显式 preStep 静默（无引擎可包装）
  assert.ok(h.listeners['agent/pre-step'])
  preStep(h, 1)
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
  preStep(h, 1) // 武装临时窗 [1,3]
  assert.equal(await attemptPressure(h), null, '拦 = null（放行会返回 result）')
  assert.equal(await attemptSwitch(h), null)
  const overflowEngine = makeEngine({ result: { shadowedSeqs: [7] } })
  h.engine.result = { shadowedSeqs: [7] }
  assert.deepEqual(await attemptOverflow(h), { shadowedSeqs: [7] }, '溢出放行')
})

test('manual 档：压力拦+问、模型切换拦、溢出放行', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000, engine: makeEngine({ result: { shadowedSeqs: [2] } }) })
  preStep(h, 1)
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
  preStep(h, 1)
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
  preStep(h, 1)
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
  preStep(h, 5) // 武装：expiresAtTurn = 7
  const armed = traceEvents(h.traceStart).find(e => e.ev === 'tier-armed')
  assert.equal(armed.turn, 5)
  assert.equal(armed.expiresAtTurn, 7)
  assert.equal(await attemptPressure(h), null, '回合 5 拦')
  turnEnd(h, 5)
  preStep(h, 6)
  assert.equal(await attemptPressure(h), null, '回合 6 拦')
  turnEnd(h, 6)
  preStep(h, 7)
  assert.equal(await attemptPressure(h), null, '回合 7 拦')
  turnEnd(h, 7)
  preStep(h, 8)
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
  preStep(h, 1)
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
  preStep(h, 2)
  assert.equal(await attemptPressure(h), null, '下一回合重新询问')
})

test('临时档 89% 不切档：保持临时档语义（拦但无询问）', async () => {
  const h = mockHarness({ tier: 'temporary', tokens: 89000, contextWindow: 100000 })
  preStep(h, 1)
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
  preStep(h, 1)
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
  preStep(h, 2)
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
  preStep(h, 1)
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
  preStep(h, 1)
  assert.deepEqual(await attemptPressure(h), { shadowedSeqs: [6] }, '占用未知 → 放行（引擎自身也会 no-op）')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'tier-switch').length, 0, '占用率未知不切档')
  assert.equal(traceEvents(h.traceStart).filter(e => e.ev === 'compaction-blocked').length, 0, '不记拦截')
})

/* -------------------------------------------------------------------------- */
/* 8. compact-now 路由                                                          */
/* -------------------------------------------------------------------------- */

test('compact-now：空闲 → ok + 本回合 allowOnce；忙 → busy 标记', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000 })
  preStep(h, 1)
  preStep(h, 1) // noteAgent 已记录 agent
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
  preStep(h, 1)
  preStep(h, 1)
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
  preStep(h, 1)
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
  preStep(h, 2)
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
  preStep(h, 1)
  const s1 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s1.json.tier, 'temporary')
  assert.equal(s1.json.currentTurn, 1)
  assert.equal(s1.json.promptBar, true)
  const s2 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s2.json.tier, 'temporary', 'GET 幂等')
  turnEnd(h, 1)
  preStep(h, 2)
  const s3 = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=2` })
  assert.equal(s3.json.tier, 'temporary')
  turnEnd(h, 2)
  preStep(h, 3)
  await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=3` })
  turnEnd(h, 3)
  preStep(h, 4)
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
  preStep(h, 1) // noteAgent 记录 session（快照数据源）
  const s = await callRoute(h, '/refuse-compaction/state.json', { query: `sessionId=${h.sid}&turn=1` })
  assert.equal(s.json.occupancyTokens, 162000)
  assert.equal(s.json.contextWindow, 262144)
  assert.equal(s.json.compactionPoint, Math.floor(262144 * 0.8), '桥缺席 → 内置默认 0.8')
  assert.equal(s.json.effectiveRatio, Math.floor(262144 * 0.8) / 262144)
  assert.equal(s.json.occupancy, 162000 / 262144)
})

test('F2 直读 loader 行：compaction-policy 活配置修正压缩点（triggerRatio 0.75/0 形态）', async () => {
  const h = mockHarness({ tier: 'off', tokens: 162000, contextWindow: 262144, policyRow: { enabled: true, triggerRatio: 0.75, headroomTokens: 0 } })
  preStep(h, 1)
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
  preStep(h, 1)
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
  preStep(h, 1)
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
  preStep(h, 4)
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
  preStep(h, 5)
  assert.equal(await attemptPressure(h), null, '回合 5 继续拦')
  turnEnd(h, 5)
  preStep(h, 6)
  assert.equal(await attemptPressure(h), null, '回合 6 继续拦（还剩1回合）')
  turnEnd(h, 6)
  preStep(h, 7)
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
  preStep(h, 5)
  assert.equal(await attemptPressure(h), null, '中断前的 manual 询问拦截')
  // 在死回合 5 的条上点"三回合内不再询问"（客户端带上条目回合 5）
  const quiet = await callRoute(h, '/refuse-compaction/quiet', { method: 'POST', query: `sessionId=${h.sid}&mode=temporary&turn=5` })
  assert.equal(quiet.json.expiresAtTurn, 8, 'base = max(currentTurn=5, 条回合5+1=6) = 6 → 覆盖 6/7/8')
  assert.equal(quiet.json.turn, 5, '事件仍落在点击的条上（currentTurn 未推进）')
  // 回合 6/7/8 全拦（三回合语义兑现），回合 9 过期 → manual 重新询问
  preStep(h, 6)
  assert.equal(await attemptPressure(h), null, '回合 6 拦')
  turnEnd(h, 6)
  preStep(h, 7)
  assert.equal(await attemptPressure(h), null, '回合 7 拦')
  turnEnd(h, 7)
  preStep(h, 8)
  assert.equal(await attemptPressure(h), null, '回合 8 拦')
  turnEnd(h, 8)
  preStep(h, 9)
  assert.equal(await attemptPressure(h), null, '回合 9 过期 → manual 重新询问')
  const expired = traceEvents(h.traceStart).find(e => e.ev === 'tier-expired')
  assert.equal(expired.to, 'manual')
})

test('quiet forbid：本会话驳回全部自动压缩（含溢出），全局改档解除', async () => {
  const h = mockHarness({ tier: 'manual', tokens: 90000 })
  preStep(h, 2)
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
  preStep(h, 2)
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
  preStep(h, 3)
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
  preStep(h, 4)
  assert.equal(await attemptPressure(h), null, '下一回合重新询问')
})
