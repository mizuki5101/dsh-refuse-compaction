/**
 * dsh-refuse-compaction — 拒绝压缩。
 *
 * 拦截 dsh **自动**触发的上下文压缩，不拦截手动 /compact。接缝（0.2.2-rc.3
 * 源码逐行核实 + dsh-compaction-policy 实证，见 PLAN-v0.1.md §1）：
 *
 * - **桌面组合里没有全局 `ctx.compaction` 服务**：DSH 0.2 把 compaction 后端
 *   挂在**每个 agent preset 内部**（`dsh-web-app/presets/*.patch.yml`），宿主面
 *   的 compaction-basic 行被禁用。活的引擎用
 *   `agentPresets.serviceFor(agent, 'compaction')` 按需解析（每个 preset 一份，
 *   WeakSet 去重后包装一次）——直接 `inject: ['compaction']` 会等一个永不出现
 *   的服务，fiber 永远 INACTIVE、插件静默不挂载（0.1.0 真机踩坑）。
 * - 自动/手动 API 层天然分离：`compactIfNeeded`（自动：pre-step 压力 / 溢出恢复）
 *   与 `compactNow`（手动 /compact，runMaintenance 空闲事务）互不经过；
 *   模型切换走 `compactPressure(..., true)` 直调（绕过 compactIfNeeded）——
 *   所以拦截面 = 包装 compactIfNeeded + compactPressure 两个方法；
 * - 拦截 = 返回 null：调用方视作"无需压缩"正常继续，零状态残留；
 * - 包装是实例属性赋值（影子原型方法），`this.compactIfNeeded/compactPressure`
 *   的内部调用同样命中；只内存、不写会话，重启即还原；
 * - 手动 compactNow 结构性不碰——手动 /compact 永远放行。
 *
 * 四档（全局默认 tier，会话级运行时覆盖优先）：
 *   off        无任何效果（默认）
 *   temporary  拦接下来 3 个回合内的自动压缩；占用率 ≥90% 自动切 manual
 *   manual     每回合首次自动压缩尝试 → 拦截 + 对话流提示条（block-first 询问）；
 *              用户点「本回合放行」后本回合放行，回合切换自动重新询问
 *   forbid     驳回所有自动压缩（含溢出恢复，spareOverflow 可放行溢出兜底）
 *
 * 联动（dsh-exa-distill v0.2.7+，globalThis Symbol 桥 feature-detect）：
 *   exa-distill 有待落盘摘要时拦住 'pressure' 触发（含模型切换压力），拿到精简
 *   上下文后自然放行；占用率 ≥95% 安全阀放行；永不拦溢出。
 *
 * 拦截器异常一律放行（D3）——压缩是安全阀，本插件绝不能成为新的故障点。
 *
 * @module dsh-refuse-compaction
 */
import Schema from '@deepseek-ai/schemastery'
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 轻量文件追踪：宿主日志不落盘，用它定位拦截链路（>1MB 轮转一次）。测试用 DSH_REFUSE_COMPACTION_TRACE 指到临时文件。 */
const TRACE_FILE = process.env.DSH_REFUSE_COMPACTION_TRACE ?? join(homedir(), '.dsh', 'refuse-compaction-trace.ndjson')

function trace(event) {
  try {
    try {
      if (statSync(TRACE_FILE).size > 1_000_000) renameSync(TRACE_FILE, `${TRACE_FILE}.old`)
    } catch {
      // 首次写入前文件不存在，正常
    }
    appendFileSync(TRACE_FILE, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`)
  } catch {
    // 追踪绝不能破坏插件本身
  }
}

/** Settings namespace == bundle row id，设置 UI 以此 join。 */
export const name = 'refuse-compaction'

/**
 * 需要解析的服务：`agentPresets` 按需解析 preset 作用域的压缩引擎
 * （serviceFor(agent, 'compaction')，与 dsh-compaction-policy 同款——桌面组合
 * 没有全局 ctx.compaction，inject 'compaction' 会让 fiber 永远 INACTIVE）；
 * `tokenMeter` 算占用率；`llm` 的 resolveModelInfo 拿 contextWindow；
 * `loader` 读 dsh-compaction-policy 行的活配置（入口树 entry.options.config，
 * 设置页改动经 internal/commit 写回，零对方改动）。
 */
export const inject = ['agentPresets', 'tokenMeter', 'llm', 'loader']

export const Config = Schema.object({
  tier: Schema.string()
    .default('off')
    .description('拒绝压缩档位：off = 无任何效果；temporary = 拦接下来 3 个回合内自动触发的压缩（占用率 ≥90% 自动切为 manual）；manual = 每回合首次自动压缩尝试先拦截并在对话流询问（本回合放行 / 立即压缩），回合切换自动重新询问；forbid = 驳回所有自动压缩，只放行手动压缩。改档即清除全部会话级运行时覆盖。')
    .volatile(),
  spareOverflow: Schema.boolean()
    .default(false)
    .description('溢出恢复兜底策略：provider 已确认上下文超限（CONTEXT_WINDOW_EXCEEDED）时的自动压缩，默认只被「禁止(forbid)」档拦截；开启后「禁止」档也放行它（临时/手动档永不拦溢出）。')
    .volatile(),
  promptBar: Schema.boolean()
    .default(true)
    .description('对话内提示条：拦截发生时在对话流该回合尾部显示拦截信息（档位/原因/占用率）；manual 档带「本回合放行」「立即压缩」按钮，其它档带「立即压缩」。需要客户端伴侣包渲染。')
    .volatile(),
  revealAhead: Schema.number()
    .min(0.02)
    .max(0.95)
    .step(0.01)
    .default(0.2)
    .description('对话内占用仪表的提前量：占用距压缩点不足这个比例时（默认 0.2 = 还剩 20% 就到压缩点；调大可提前亮出，0.95 ≈ 5% 占用即显示），在对话流该回合尾部亮出"百分比（token 数）"仪表与档位切换；未达阈值不展示。压缩点按 dsh-compaction-policy 的生效策略修正（未装回退内置 0.8）。')
    .volatile(),
})

/* -------------------------------------------------------------------------- */
/* 常量与配置读取                                                              */
/* -------------------------------------------------------------------------- */

const TIERS = ['off', 'temporary', 'manual', 'forbid']
const TEMP_TURNS = 3            // 临时档拦截的回合数（含武装当回合）
const SWITCH_OCCUPANCY = 0.9    // 临时档占用率阈值：≥90% 自动切 manual
const LINK_RELEASE_OCCUPANCY = 0.95 // 联动安全阀：≥95% 放行（防 flush 连续失败骑到溢出）
const COMPACT_NOW_TIMEOUT_MS = 120000
const DEFAULT_THRESHOLD_RATIO = 0.8 // dsh 内置压缩点比例（compaction-policy 行可修正）
/** dsh-compaction-policy 的策略缺省（与其 normalizePolicy 的 POLICY_DEFAULTS 对齐）。 */
const POLICY_DEFAULTS = { enabled: true, routes: '*', triggerRatio: 0.8, headroomTokens: 24576 }

/** exa-distill v0.2.7+ 发布的联动桥（进程内，feature-detect，双方都是自己的包）。 */
const EXA_BRIDGE = Symbol.for('dsh.exa-distill.bridge')

/**
 * 解包 volatile 字段：`.volatile()` 的配置项以"活单元格"（带 `.get()` 的对象）
 * 到达，不是裸值。每次访问现读，设置改动免重挂即生效（与 exa-distill 同款）。
 */
function readValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

function globalTierOf(config) {
  const raw = readValue(config?.tier)
  return TIERS.includes(raw) ? raw : 'off'
}

/** policy-scan 追踪节流（state.json 轮询 3s 一次，扫描 30s 一次）。 */
let lastPolicyScanAt = 0

/**
 * 诊断：loader 入口树扫描快照（mount 一次 + state.json 轮询节流）。F2 直读
 * 曾在真机静默回退且无从排查——行是否存在、配置形状、readValue 解包结果
 * 全部落 trace，不再无声。
 */
function tracePolicyScan(ctx, when) {
  try {
    let count = 0
    const names = []
    let matched = null
    const dumpRow = (obj) => {
      if (obj === undefined || obj === null || typeof obj !== 'object') return null
      return {
        keys: Object.keys(obj),
        enabled: readValue(obj.enabled),
        routes: readValue(obj.routes),
        triggerRatio: readValue(obj.triggerRatio),
        headroomTokens: readValue(obj.headroomTokens),
      }
    }
    const collect = (entry) => {
      if (count >= 500) return
      count += 1
      const name = entry?.options?.name
      if (name !== undefined && names.length < 40) names.push(String(name))
      if (matched === null && name === 'dsh-compaction-policy') {
        let fiberLive
        try {
          fiberLive = entry.fiber?.effectiveConfig ?? entry.fiber?.config
        } catch {
          fiberLive = undefined
        }
        matched = {
          id: entry?.options?.id ?? null,
          hasFiber: entry?.fiber !== undefined,
          fiberConfig: dumpRow(fiberLive),
          entryConfig: dumpRow(entry?.options?.config),
        }
      }
    }
    if (typeof ctx.loader?.entries === 'function') {
      for (const entry of ctx.loader.entries()) collect(entry)
    } else {
      for (const entry of Object.values(ctx.loader?.store ?? {})) collect(entry)
    }
    trace({ ev: 'policy-scan', when, entryCount: count, names, matched })
  } catch (error) {
    try { trace({ ev: 'policy-scan', when, err: String(error?.message ?? error) }) } catch { /* 忽略 */ }
  }
}

/* -------------------------------------------------------------------------- */
/* 会话运行时状态（全部内存 per-session，重启即还原，零会话日志写入）             */
/* -------------------------------------------------------------------------- */

/** sid → { currentTurn, ov:{tier,expiresAtTurn?}, tempDone, refusedTurn, allowOnceTurn, occ, occAt } */
const sessionStates = new Map()
/** sid → { agent, session, at }：compact-now 按钮按 sessionId 找 Agent。 */
const sessionAgents = new Map()
/** sid → 最近一条拦截/动作事件（提示条与 state.json 的数据源）。 */
const lastEvents = new Map()
/** 全局档变化检测（改档 = 清全部会话覆盖；undefined = 尚未见过）。 */
let lastGlobalTier

function stateOf(sid) {
  let state = sessionStates.get(sid)
  if (state === undefined) {
    state = {}
    sessionStates.set(sid, state)
  }
  return state
}

function currentTurnOf(state) {
  return Number.isFinite(state?.currentTurn) && state.currentTurn > 0 ? state.currentTurn : 1
}

/** 设置页改档（volatile 单元格现读发现变化）= 写全局默认 + 清除全部会话覆盖。 */
function syncGlobalTier(config) {
  const tier = globalTierOf(config)
  if (lastGlobalTier === undefined) {
    lastGlobalTier = tier
    return
  }
  if (tier !== lastGlobalTier) {
    sessionStates.clear()
    trace({ ev: 'global-tier-change', from: lastGlobalTier, to: tier })
    lastGlobalTier = tier
  }
}

/**
 * 临时档武装：本会话尚无运行时覆盖 → 从当前回合起拦 TEMP_TURNS 个回合
 * （武装当回合算第一回合）。在 pre-step 与 decide 双入口调用，正常路径由
 * pre-step 武装（会话在对话就会命中正确的回合），decide 兜底覆盖选择发生在
 * 同一步内 basic 监听器之后的边缘时序。quiet 按钮也走同一形态的会话覆盖。
 */
function ensureTempWindow(state, sid) {
  if (state.ov !== undefined) return
  const turn = currentTurnOf(state)
  state.ov = { tier: 'temporary', expiresAtTurn: turn + TEMP_TURNS - 1 }
  trace({ ev: 'tier-armed', sessionId: sid, turn, expiresAtTurn: state.ov.expiresAtTurn, tempTurns: TEMP_TURNS })
}

/**
 * 会话生效档位（运行时覆盖优先；临时窗过期 → **自动切回手动拒绝**——用户
 * 语义：临时拒绝是"先不问"，到期恢复询问，而不是回落 off。全局 tier 配置
 * 不改动，dropdown 仍显示用户选的值）。
 */
function sessionTier(state, config, sid) {
  if (state.ov !== undefined) {
    if (state.ov.tier === 'temporary' && currentTurnOf(state) > state.ov.expiresAtTurn) {
      state.ov = { tier: 'manual' }
      trace({ ev: 'tier-expired', sessionId: sid, turn: currentTurnOf(state), to: 'manual' })
      return 'manual'
    }
    return state.ov.tier
  }
  const global = globalTierOf(config)
  if (global === 'temporary') {
    ensureTempWindow(state, sid)
    return 'temporary'
  }
  return global
}

/** 只读生效档位（state.json 报告用）：不武装、不写状态——GET 不得改变状态；过期按已回落（manual）报告。 */
function peekTier(state, config) {
  if (state.ov !== undefined) {
    if (state.ov.tier === 'temporary' && currentTurnOf(state) > state.ov.expiresAtTurn) return 'manual'
    return state.ov.tier
  }
  return globalTierOf(config)
}

function recordEvent(sid, event) {
  try {
    lastEvents.set(sid, { ...event, sessionId: sid })
  } catch {
    // 提示条数据源失败不影响拦截本身
  }
}

function noteAgent(agent) {
  try {
    const session = agent?.session
    if (session?.id === undefined) return
    sessionAgents.set(String(session.id), { agent, session, at: Date.now() })
  } catch {
    // compact-now 的 Agent 映射失败只影响按钮
  }
}

/* -------------------------------------------------------------------------- */
/* 占用率（tokenMeter 活表面口径 + llm.resolveModelInfo 的 contextWindow）       */
/* -------------------------------------------------------------------------- */

/**
 * 从 loader 入口树读 dsh-compaction-policy 行的**活配置**，零对方改动、零桥。
 * 行可能嵌在组内子树（bundle insert / 组装分组）→ 用 loader 官方递归遍历
 * entries()（缺席时回退平铺 store 扫描）。取值优先级：
 *   fiber.effectiveConfig（插件真实使用的活配置，volatile 提交保留 cell 引用）
 *   → fiber.config（运行 fiber 原始配置，设置页提交会整体替换）
 *   → entry.options.config（组装层原始值，仅 fiber 未挂载时兜底）。
 * 0.2.1 只读 entry.options.config 的版本在真机上读不到行（仪表静默走 0.8
 * 回退，阈值 0.75→0.8 视觉难辨，降到 0.3 才暴露）——policy-scan 追踪事件
 * 让这类失败可见（0.2.8）。
 * @returns 行配置对象，行不存在/无 loader → undefined。
 */
function readPolicyRow(ctx) {
  try {
    const pickRow = (entry) => {
      if (entry?.options?.name !== 'dsh-compaction-policy') return undefined
      let live
      try {
        live = entry.fiber?.effectiveConfig ?? entry.fiber?.config
      } catch {
        live = undefined
      }
      const config = live !== undefined && live !== null && typeof live === 'object'
        ? live
        : entry.options.config
      return config !== null && typeof config === 'object' ? config : undefined
    }
    if (typeof ctx.loader?.entries === 'function') {
      for (const entry of ctx.loader.entries()) {
        const row = pickRow(entry)
        if (row !== undefined) return row
      }
      return undefined
    }
    const store = ctx.loader?.store
    if (store === undefined || typeof store !== 'object') return undefined
    for (const entry of Object.values(store)) {
      const row = pickRow(entry)
      if (row !== undefined) return row
    }
  } catch {
    // 读不到就按内置默认处理
  }
  return undefined
}

/**
 * 归一化 dsh-compaction-policy 的行配置（与其 normalizePolicy/POLICY_DEFAULTS
 * 对齐）：字段缺省用缺省值；数字字段 '' 视作未设、字面 0 合法（零 headroom）；
 * routes 的 '' 有独立语义（"哪儿都不干预"），不用缺省值。
 */
function normalizePolicyRow(config) {
  const unset = (value) => value === undefined || value === null
  const unsetNumber = (value) => unset(value) || value === ''
  const enabled = readValue(config?.enabled)
  const routes = readValue(config?.routes)
  const triggerRatio = readValue(config?.triggerRatio)
  const headroomTokens = readValue(config?.headroomTokens)
  const ratio = unsetNumber(triggerRatio) ? POLICY_DEFAULTS.triggerRatio : Number(triggerRatio)
  const headroom = unsetNumber(headroomTokens) ? POLICY_DEFAULTS.headroomTokens : Number(headroomTokens)
  return {
    enabled: unset(enabled) ? POLICY_DEFAULTS.enabled : enabled === true,
    routes: unset(routes) ? POLICY_DEFAULTS.routes : String(routes),
    triggerRatio: Number.isFinite(ratio) ? ratio : POLICY_DEFAULTS.triggerRatio,
    headroomTokens: Number.isFinite(headroom) ? headroom : POLICY_DEFAULTS.headroomTokens,
  }
}

/** 解析路由过滤文本（与 compaction-policy 的 parseRouteList 同款语义）。 */
function parseRouteEntries(text) {
  return String(text ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const slash = entry.indexOf('/')
      if (slash < 0) return { provider: entry, model: undefined }
      return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) || undefined }
    })
}

/** 路由是否被过滤覆盖（与 compaction-policy 的 routeMatches 同款语义）。 */
function routeCovered(entries, target) {
  if (target === undefined || target.provider === undefined) return false
  return entries.some((entry) => {
    if (entry.provider === '*') return true
    if (entry.provider !== target.provider) return false
    return entry.model === undefined || entry.model === '*' || entry.model === target.model
  })
}

/**
 * 压缩点（F2）：按 dsh-compaction-policy 行的活配置算该路由的生效压力阈值
 * （与其 computeTriggerTokens 同款公式 floor(min(W×ratio, W−O−headroom))）；
 * 策略禁用/路由不命中/预算非正 → null → 调用方回退内置默认 window × 0.8。
 */
function policyCompactionPoint(ctx, target, window, reservedCompletionTokens) {
  const row = readPolicyRow(ctx)
  if (row === undefined) return null // 未装 compaction-policy → 内置默认口径
  const policy = normalizePolicyRow(row)
  if (policy.enabled !== true) return null
  const entries = parseRouteEntries(policy.routes)
  if (entries.length === 0) return null
  if (!routeCovered(entries, target)) return null
  const budget = window - reservedCompletionTokens - policy.headroomTokens
  if (budget <= 0) return null
  return Math.floor(Math.min(window * policy.triggerRatio, budget))
}

/**
 * 压力快照：measure(session[, header]).totalTokens + contextWindow + 压缩点。
 * header 传入（compactPressure 的模型切换路径）按拟议 header 计价，与 basic
 * 引擎同款。算不出（无路由/无窗口/meter 缺席）→ null。
 */
async function pressureSnapshot(ctx, session, header) {
  try {
    const cfg = header?.config ?? session?.requestHeader?.()?.config
    if (cfg === undefined || typeof cfg.provider !== 'string' || cfg.provider === ''
      || typeof cfg.model !== 'string' || cfg.model === '') return null
    const meter = ctx.tokenMeter
    if (meter === undefined || typeof meter.measure !== 'function') return null
    if (typeof ctx.llm?.resolveModelInfo !== 'function') return null
    const info = await ctx.llm.resolveModelInfo(cfg.provider, cfg.model, undefined)
    const window = info?.context?.contextWindow
    if (!Number.isFinite(window) || window <= 0) return null
    const measure = header === undefined ? meter.measure(session) : meter.measure(session, header)
    const total = measure?.totalTokens
    if (!Number.isFinite(total)) return null
    const reserved = cfg.maxTokens ?? info?.defaultMaxTokens ?? 0
    const viaPolicy = policyCompactionPoint(ctx, { provider: cfg.provider, model: cfg.model }, window, reserved)
    const compactionPoint = viaPolicy !== null ? viaPolicy : Math.floor(window * DEFAULT_THRESHOLD_RATIO)
    return {
      totalTokens: total,
      contextWindow: window,
      compactionPoint,
      occupancy: total / window,
      toCompaction: compactionPoint / window,
    }
  } catch {
    return null
  }
}

/**
 * 占用率 = measure(session[, header]).totalTokens / contextWindow。
 * 调用方视作"占用率未知"（null）时不触发 90% 切档与 95% 安全阀。
 */
async function occupancyOf(ctx, session, header) {
  const snapshot = await pressureSnapshot(ctx, session, header)
  return snapshot === null ? null : snapshot.occupancy
}

/* -------------------------------------------------------------------------- */
/* 决策（纯函数读运行时状态；绝不抛错——D3 异常一律放行）                          */
/* -------------------------------------------------------------------------- */

function decideManual(state, currentTurn, occupancy) {
  // allowOnceTurn 是"批准到第 X 回合"（<=，v0.2.7）：compact-now 成功写当前
  // 回合；忙碌/失败回落写下一回合（同时覆盖正在跑的回合的剩余尝试）。
  if (Number.isFinite(state.allowOnceTurn) && currentTurn <= state.allowOnceTurn) {
    return { action: 'allow', why: 'allow-once' }
  }
  const asked = state.refusedTurn === currentTurn
  if (!asked) state.refusedTurn = currentTurn
  // 拦截计数（提示条"本回合已拦 N 次"）：ask 计 1，manual-repeat 递增；
  // 回合锚点就是 refusedTurn，state.json 按其匹配供给，新回合自动归 1。
  if (asked) state.repeatCount = (Number.isFinite(state.repeatCount) ? state.repeatCount : 1) + 1
  else state.repeatCount = 1
  return { action: 'block', why: asked ? 'manual-repeat' : 'manual-ask', turn: currentTurn, occupancy }
}

/**
 * 一次自动压缩尝试的决策。返回 { action:'allow'|'block', why?, ... }，绝不抛错。
 * 顺序：溢出特判（D2）→ 联动分支（仅 pressure）→ 档位状态机。
 */
async function decide(ctx, config, agent, trigger, header) {
  let sid = ''
  try {
    const session = agent?.session
    sid = String(session?.id ?? '')
    syncGlobalTier(config)
    const state = stateOf(sid)
    const currentTurn = currentTurnOf(state)

    // 溢出恢复（provider 已确认真实超限）：只被「禁止」档拦截（spareOverflow 可
    // 放行兜底）；联动分支无论何档都不拦溢出（D2）。
    if (trigger === 'context-overflow') {
      const eff = sessionTier(state, config, sid)
      if (eff === 'forbid' && readValue(config?.spareOverflow) !== true) {
        return { action: 'block', why: 'forbid-overflow', tier: eff }
      }
      return { action: 'allow' }
    }

    // 联动分支（仅 'pressure'，含模型切换压力）：exa-distill 有待落盘摘要 →
    // 拦住压力压缩，等精简落盘（hasPending 变 false 后同一步的下次检查自然放行）。
    // 占用未知（新会话空探查）→ 引擎自己也会 no-op，静默放行不记事件（v0.2.11）。
    if (trigger === 'pressure') {
      const bridge = globalThis[EXA_BRIDGE]
      let hold = false
      let pending = false
      try {
        hold = bridge?.holdCompactionEnabled?.(session) === true
        pending = bridge?.hasPending?.(session) === true
      } catch {
        hold = false
      }
      if (hold && pending) {
        const linkOcc = await occupancyOf(ctx, session, header)
        if (linkOcc !== null && Number.isFinite(linkOcc)) {
          state.occ = linkOcc
          state.occAt = Date.now()
        }
        if (linkOcc === null) {
          // 空探查不是压缩尝试（引擎无 header/无测量时必然 no-op）——静默放行
        } else if (linkOcc >= LINK_RELEASE_OCCUPANCY) {
          trace({ ev: 'link-release', sessionId: sid || null, turn: currentTurn, occupancy: linkOcc })
          recordEvent(sid, { kind: 'link-release', phase: 'released', turn: currentTurn, occupancy: linkOcc, ts: Date.now() })
          // 安全阀放行：落入下方档位状态机继续决策
        } else {
          return { action: 'block', why: 'link-hold', occupancy: linkOcc }
        }
      }
    }

    const eff = sessionTier(state, config, sid)
    if (eff === 'off') return { action: 'allow' }

    // 压力路径统一门（v0.2.11）：占用率未知或低于压缩点 → 不是"压缩尝试"，
    // 放行让引擎自己决定（compactIfNeeded 无 header 直接返回 null；
    // compactPressure 内 measurement < threshold 短路——都与无插件时行为一致）。
    // 真机实锤（0.2.10 trace ×3）：新会话首个 pre-step 时 requestHeader() 还没
    // 建立 → snapshot null，旧逻辑把空探查当尝试拦下，手动档在每个新对话第一轮
    // 弹假询问条。未装 dsh-compaction-policy 的环境里引擎每步都会调到包装，
    // 此门同时避免低压力回合被反复询问。
    const snap = await pressureSnapshot(ctx, session, header)
    if (snap === null) return { action: 'allow', why: 'occupancy-unknown' }
    const occ = snap.occupancy
    state.occ = occ
    state.occAt = Date.now()
    if (snap.totalTokens < snap.compactionPoint) {
      return { action: 'allow', why: 'below-compaction-point' }
    }

    switch (eff) {
      case 'forbid':
        return { action: 'block', why: 'forbid', tier: eff }
      case 'temporary': {
        if (occ >= SWITCH_OCCUPANCY) {
          state.ov = { tier: 'manual' }
          trace({ ev: 'tier-switch', sessionId: sid || null, from: 'temporary', to: 'manual', turn: currentTurn, occupancy: occ })
          recordEvent(sid, { kind: 'tier-switch', phase: 'blocked', to: 'manual', turn: currentTurn, occupancy: occ, ts: Date.now() })
          return decideManual(state, currentTurn, occ)
        }
        return { action: 'block', why: 'temporary', occupancy: occ, expiresAtTurn: state.ov?.expiresAtTurn, tier: eff }
      }
      case 'manual':
        return decideManual(state, currentTurn, occ)
      default:
        return { action: 'allow' }
    }
  } catch (error) {
    // D3：拦截器异常一律放行 + 追踪——压缩是最后的安全阀
    try {
      trace({ ev: 'decide-error', sessionId: sid || null, trigger, err: error?.message ?? String(error), fallback: 'allow' })
    } catch {
      // 追踪失败也放行
    }
    return { action: 'allow' }
  }
}

/* -------------------------------------------------------------------------- */
/* 引擎包装（唯一且最小的接缝动作）                                              */
/* -------------------------------------------------------------------------- */

/** 记录一次拦截：trace + 提示条事件（manual-repeat 静默，不重复亮条）。 */
function noteBlock(agent, decision, via) {
  const sid = String(agent?.session?.id ?? '')
  const state = stateOf(sid)
  const turn = currentTurnOf(state)
  trace({
    ev: 'compaction-blocked',
    sessionId: sid || null,
    turn,
    trigger: via === 'compactPressure' ? 'pressure(model-switch)' : decision.trigger,
    via,
    why: decision.why ?? null,
    occupancy: decision.occupancy ?? null,
    expiresAtTurn: decision.expiresAtTurn ?? null,
  })
  if (decision.why !== 'manual-repeat') {
    recordEvent(sid, {
      kind: 'blocked',
      phase: decision.why === 'manual-ask' ? 'ask' : 'blocked',
      turn,
      why: decision.why,
      occupancy: decision.occupancy,
      expiresAtTurn: decision.expiresAtTurn,
      ts: Date.now(),
    })
  }
}

/**
 * 实例属性赋值影子原型方法：`this.compactIfNeeded(...)` 与
 * `engine.compactIfNeeded(...)` 均命中包装。手动 compactNow 结构性不碰。
 * 每个 preset 作用域的引擎实例只包装一次（WeakSet 去重）。
 */
function patchEngine(ctx, config, engine) {
  const originalIfNeeded = engine.compactIfNeeded
  if (typeof originalIfNeeded !== 'function') return false
  engine.compactIfNeeded = async function (agent, trigger, signal) {
    noteAgent(agent)
    const decision = await decide(ctx, config, agent, trigger, undefined)
    if (decision.action === 'block') {
      noteBlock(agent, { ...decision, trigger }, 'compactIfNeeded')
      return null // 拦截 = null，调用方视作"无需压缩"，零状态残留
    }
    return originalIfNeeded.call(this, agent, trigger, signal)
  }
  // 模型切换直调 compactPressure（basic 实现私有方法，feature-detect）。
  // compactIfNeeded('pressure') 内部也走这里 → 决策幂等，无副作用。
  if (typeof engine.compactPressure === 'function') {
    const originalPressure = engine.compactPressure
    engine.compactPressure = async function (agent, header, signal, requireBelowThreshold) {
      noteAgent(agent)
      const decision = await decide(ctx, config, agent, 'pressure', header)
      if (decision.action === 'block') {
        noteBlock(agent, { ...decision, trigger: 'pressure' }, 'compactPressure')
        return null
      }
      return originalPressure.call(this, agent, header, signal, requireBelowThreshold)
    }
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* 插件                                                                        */
/* -------------------------------------------------------------------------- */

/** apply() 的配置引用（volatile 单元格，listener 内现读）。 */
let configRef
/** 已包装的引擎实例（每个 preset 作用域一份，WeakSet 去重）。 */
const instrumentedEngines = new WeakSet()

export function apply(ctx, config) {
  configRef = config
  lastGlobalTier = undefined // 重新挂载视为首次见档

  const serviceFor = (agent) => {
    try {
      return ctx.agentPresets?.serviceFor?.(agent, 'compaction')
    } catch {
      return undefined
    }
  }

  if (ctx.agentPresets === undefined || typeof ctx.agentPresets?.serviceFor !== 'function') {
    // 优雅降级：解析不了活引擎就没有拦截面，其余功能（回合追踪/路由）照常
    trace({ ev: 'mount-fail', why: 'agentPresets service missing' })
    ctx.logger?.warn?.('refuse-compaction: agentPresets 服务不可用，拦截功能自禁用')
  } else {
    trace({
      ev: 'mounted',
      tier: globalTierOf(config),
      spareOverflow: readValue(config?.spareOverflow) === true,
      promptBar: readValue(config?.promptBar) !== false,
    })
  }
  tracePolicyScan(ctx, 'mount')

  /**
   * 包装该 agent 的 preset 作用域引擎（每实例一次）。pre-step prepend 保证在
   * 引擎自己的 pre-step 监听器之前装好包装——同一步内的首次压缩尝试即被拦截面覆盖。
   */
  function instrument(agent) {
    const engine = serviceFor(agent)
    if (engine === undefined || engine === null || instrumentedEngines.has(engine)) return
    if (!patchEngine(ctx, config, engine)) {
      trace({ ev: 'mount-fail', why: 'compactIfNeeded missing on preset engine' })
      ctx.logger?.warn?.('refuse-compaction: preset 压缩引擎缺少 compactIfNeeded，拦截功能对该引擎自禁用')
      instrumentedEngines.add(engine) // 防止重复报错刷屏
      return
    }
    instrumentedEngines.add(engine)
    trace({ ev: 'engine-instrumented', sessionId: String(agent?.session?.id ?? '') || null })
  }

  /**
   * 回合追踪 + 临时档武装 + 引擎包装：pre-step（prepend，先于引擎自己的
   * pre-step 监听器运行——同一步内的压缩决策就能命中包装）。turn-stopping
   * 推进到下一回合号，跨回合边界两处一致。
   */
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload?.agent
      const session = agent?.session
      if (session?.id !== undefined) {
        noteAgent(agent)
        instrument(agent)
        const sid = String(session.id)
        const state = stateOf(sid)
        if (typeof payload.turn === 'number' && payload.turn > 0) state.currentTurn = payload.turn
        syncGlobalTier(config)
        // turn>0 才武装：包装安装探针（turn=0 的最小 payload）不得启动临时窗
        if (typeof payload.turn === 'number' && payload.turn > 0 && globalTierOf(config) === 'temporary') {
          ensureTempWindow(state, sid)
        }
      }
    } catch (error) {
      try { trace({ ev: 'listener-error', where: 'pre-step', err: error?.message ?? String(error) }) } catch { /* 忽略 */ }
    }
    return next?.()
  }, { prepend: true })

  // serial 分发：返回非 undefined 会 bail 中断后续监听器——显式返回 undefined。
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent
      const session = agent?.session
      if (session?.id !== undefined) {
        noteAgent(agent)
        const state = stateOf(String(session.id))
        if (typeof payload.turn === 'number' && payload.turn > 0) state.currentTurn = payload.turn + 1
      }
    } catch (error) {
      try { trace({ ev: 'listener-error', where: 'turn-stopping', err: error?.message ?? String(error) }) } catch { /* 忽略 */ }
    }
    return undefined
  })

  // 提示条数据通道 + 按钮动作路由（与 exa-distill 状态行同款：内存 + HTTP，
  // 不写任何会话日志事件——unknown 非 ignorable 事件会被恢复校验器拒绝）。
  try {
    ctx.inject(['webServer'], (serviceCtx) => {
      const webServer = serviceCtx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return
      serviceCtx.effect(() => {
        webServer.register({ kind: 'exact', path: '/refuse-compaction/state.json', handler: stateHandler(config) })
        webServer.register({ kind: 'exact', path: '/refuse-compaction/allow', handler: allowHandler })
        webServer.register({ kind: 'exact', path: '/refuse-compaction/compact-now', handler: compactNowHandler })
        webServer.register({ kind: 'exact', path: '/refuse-compaction/refuse', handler: refuseHandler })
        webServer.register({ kind: 'exact', path: '/refuse-compaction/quiet', handler: quietHandler })
        webServer.register({ kind: 'exact', path: '/refuse-compaction/clear-override', handler: clearOverrideHandler })
      }, 'refuse-compaction: routes')
    })
  } catch (error) {
    trace({ ev: 'route-fail', err: error?.message ?? String(error) })
  }

  /** GET state.json?sessionId=&turn=：最近拦截事件 + 生效档位 + 现算压力快照。 */
  function stateHandler(configAtMount) {
    return async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sid = url.searchParams.get('sessionId') ?? ''
        const turnParam = url.searchParams.get('turn')
        const turn = turnParam === null || turnParam === '' ? undefined : Number(turnParam)
        const state = sid !== '' ? stateOf(sid) : {}
        const currentTurn = currentTurnOf(state)
        const effectiveTier = peekTier(state, configRef ?? configAtMount)
        const event = sid !== '' ? lastEvents.get(sid) : undefined
        // F2 仪表的自诊断：30s 节流，行配置读不到时可见（不再静默回退 0.8）
        if (sid !== '' && Date.now() - lastPolicyScanAt > 30000) {
          lastPolicyScanAt = Date.now()
          tracePolicyScan(ctx, 'state')
        }
        // 压力快照现算（F1 仪表的数据源）：无拦截事件时仪表也要有数——
        // 用回合追踪记下的 session 现场measure + compaction-policy 桥修正压缩点
        const entry = sessionAgents.get(sid)
        const snapshot = entry?.session !== undefined && sid !== ''
          ? await pressureSnapshot(ctx, entry.session)
          : null
        const payload = {
          phase: event === undefined ? 'none' : (event.phase ?? 'blocked'),
          event: event ?? null,
          eventTurn: event?.turn,
          tier: effectiveTier,
          globalTier: globalTierOf(configRef ?? configAtMount),
          occupancy: snapshot !== null ? snapshot.occupancy : (Number.isFinite(state.occ) ? state.occ : null),
          occupancyTokens: snapshot?.totalTokens ?? null,
          contextWindow: snapshot?.contextWindow ?? null,
          compactionPoint: snapshot?.compactionPoint ?? null,
          effectiveRatio: snapshot !== null ? snapshot.compactionPoint / snapshot.contextWindow : null,
          occupancyAt: snapshot !== null ? Date.now() : state.occAt,
          currentTurn,
          allowOnce: Number.isFinite(state.allowOnceTurn) && currentTurn <= state.allowOnceTurn,
          repeatCount: state.refusedTurn === turn && Number.isFinite(state.repeatCount) ? state.repeatCount : null,
          promptBar: readValue(configRef?.promptBar) !== false,
          ts: Date.now(),
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ phase: 'none', error: String(error?.message ?? error) }))
      }
    }
  }

  /** POST allow?sessionId=：本回合放行（写 allowOnceTurn，回合切换自动清除）。 */
  async function allowHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sid = url.searchParams.get('sessionId') ?? ''
      if (sid === '') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'sessionId required' }))
        return
      }
      const state = stateOf(sid)
      const turn = currentTurnOf(state)
      state.allowOnceTurn = turn
      trace({ ev: 'allow-once', sessionId: sid, turn })
      recordEvent(sid, { kind: 'allow-once', phase: 'allowed', turn, ts: Date.now() })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, turn }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }

  /**
   * POST refuse?sessionId=：本回合拒绝（提示条翻"已拒绝"灰态；回合内后续尝试
   * 本就静默拦，下一回合 manual 档再次询问）。不写 allowOnce——拒绝就是不放行。
   */
  async function refuseHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sid = url.searchParams.get('sessionId') ?? ''
      if (sid === '') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'sessionId required' }))
        return
      }
      const state = stateOf(sid)
      const turn = currentTurnOf(state)
      trace({ ev: 'refused', sessionId: sid, turn })
      recordEvent(sid, { kind: 'refused', phase: 'refused', turn, ts: Date.now() })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, turn }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }

  /**
   * POST quiet?sessionId=&mode=temporary|forbid：提示条按钮发起的**会话级**
   * 档位覆盖（本回合不放行 + 静默后续自动压缩）。
   *   temporary → 从当前回合起拦 TEMP_TURNS 个回合，到期自动切回 manual；
   *   forbid    → 本会话驳回全部自动压缩（无到期；全局改档会在 syncGlobalTier
   *               清覆盖时解除）。
   * 覆盖写进会话运行时状态（不动全局配置）——当前会话立即生效。
   */
  async function quietHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sid = url.searchParams.get('sessionId') ?? ''
      if (sid === '') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'sessionId required' }))
        return
      }
      const mode = url.searchParams.get('mode') === 'forbid' ? 'forbid' : 'temporary'
      const state = stateOf(sid)
      const turn = currentTurnOf(state)
      // 武装基准以**点击的询问条所在回合**为准（v0.2.10）：中断回合不走
      // turn-stopping（dsh-agent-loop agent.ts 中止路径直接 rethrow），currentTurn
      // 停在死回合上——按 currentTurn+2 武装会让死回合吃掉一个名额，"三回合"
      // 只拦 2 个、条上倒数从 3 跳 1。base = max(currentTurn, 条回合+1)：
      //   正常完成点击（currentTurn=条回合+1）→ base=条回合+1，行为不变；
      //   中断回合点击（currentTurn=条回合）→ base=条回合+1，跳过死回合；
      //   迟到点击（新回合已在跑，currentTurn>条回合+1）→ base=currentTurn，不变。
      const barTurn = Number(url.searchParams.get('turn'))
      const base = Number.isFinite(barTurn) && barTurn > 0 ? Math.max(turn, barTurn + 1) : turn
      if (mode === 'temporary') {
        state.ov = { tier: 'temporary', expiresAtTurn: base + TEMP_TURNS - 1 }
      } else {
        state.ov = { tier: 'forbid' }
      }
      trace({ ev: 'quiet', sessionId: sid, mode, turn, base, expiresAtTurn: state.ov.expiresAtTurn ?? null })
      recordEvent(sid, {
        kind: 'blocked',
        phase: 'blocked',
        why: mode === 'forbid' ? 'forbid' : 'temporary',
        turn,
        occupancy: Number.isFinite(state.occ) ? state.occ : null,
        expiresAtTurn: state.ov.expiresAtTurn,
        ts: Date.now(),
      })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, mode, turn, expiresAtTurn: state.ov.expiresAtTurn ?? null }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }

  /**
   * POST clear-override?sessionId=：清除本会话的运行时档位覆盖（v0.2.9，仪表
   * 档位快切配套——覆盖生效中点击任意档位 = 写全局档 + 清覆盖，否则覆盖继续
   * 压着生效档，全局档没变时 syncGlobalTier 不清，点击"看不出效果"）。
   */
  async function clearOverrideHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sid = url.searchParams.get('sessionId') ?? ''
      if (sid === '') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'sessionId required' }))
        return
      }
      const state = stateOf(sid)
      const had = state.ov !== undefined
      if (had) {
        state.ov = undefined
        state.refusedTurn = undefined
        state.allowOnceTurn = undefined
        state.repeatCount = undefined
        trace({ ev: 'override-clear', sessionId: sid, turn: currentTurnOf(state) })
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, cleared: had }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }

  /**
   * POST compact-now?sessionId=：立即手动压缩（公开手动 API compactNow，
   * 不经过本插件拦截面）。agent 忙（runMaintenance throws）或压缩失败时，
   * 手动档回落"批准下一检查点"（queued: true，allowOnceTurn = 当前回合+1），
   * 下一次自动尝试在引擎自己的 step 边界执行——批准不静默丢弃；非手动档
   * 维持 busy 标记。成功后本回合放行后续自动尝试（allowOnce）。
   */
  async function compactNowHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'POST only' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sid = url.searchParams.get('sessionId') ?? ''
      if (sid === '') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'sessionId required' }))
        return
      }
      const entry = sessionAgents.get(sid)
      const target = entry?.agent
      const engine = serviceFor(target)
      if (target === undefined || engine === undefined || typeof engine.compactNow !== 'function') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'agent or engine unavailable' }))
        return
      }
      const state = stateOf(sid)
      const turn = currentTurnOf(state)
      try {
        const result = await engine.compactNow(target, AbortSignal.timeout(COMPACT_NOW_TIMEOUT_MS))
        state.allowOnceTurn = turn
        trace({ ev: 'compact-now', sessionId: sid, turn, ok: true, shadowed: result?.shadowedSeqs?.length ?? null })
        recordEvent(sid, { kind: 'compacted', phase: 'compacted', turn, ts: Date.now() })
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, turn, shadowed: result?.shadowedSeqs?.length ?? null }))
      } catch (error) {
        const message = String(error?.message ?? error)
        const busy = error?.kind === 'busy' || message.includes('busy')
        // 忙碌/失败回落（v0.2.7）：手动档下不把批准静默丢弃——写"批准到下一
        // 回合"（allowOnceTurn 的 <= 语义），下一次压缩尝试在引擎自己的 step
        // 边界自动执行，批准必然物化成一次真压缩。仅手动档回落：forbid/
        // temporary 分支不查 allowOnceTurn，落了也不生效。queued 事件回写到
        // 原询问条所在的回合（lastEvent.turn），点的那条条原地翻"已批准"。
        let queued = false
        if (peekTier(state, configRef) === 'manual') {
          state.allowOnceTurn = turn + 1
          queued = true
          const lastEvent = lastEvents.get(sid)
          recordEvent(sid, {
            kind: 'queued',
            phase: 'queued',
            turn: Number.isFinite(lastEvent?.turn) ? lastEvent.turn : turn,
            ts: Date.now(),
          })
          trace({ ev: 'compact-queued', sessionId: sid, turn, throughTurn: state.allowOnceTurn, busy })
        }
        trace({ ev: 'compact-now', sessionId: sid, turn, ok: false, busy, queued, err: message })
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, busy, queued, error: message }))
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }
}
