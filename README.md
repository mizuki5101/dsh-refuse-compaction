# dsh-refuse-compaction

**拒绝压缩**：拦截 dsh **自动**触发的上下文压缩，手动 `/compact` 结构性不受影响。
四个档位 + 与 dsh-exa-distill（同一作者的另一个 dsh 插件：检索结果的精简落盘；
未安装时联动静默不生效，两插件各自完整可用）的"精简结果替换前不压缩"联动。

![占用仪表](screenshots/gauge.png)

```
dsh 自动压缩的三个触发点（0.2.2-rc.3 dsh-compaction-basic 源码逐行核实）
  ① agent/pre-step     → compactIfNeeded(agent, 'pressure')
  ② agent/request 模型切换 → compactPressure(agent, header, signal, true) 直调
  ③ agent/request-error 溢出恢复 → compactIfNeeded(agent, 'context-overflow')
                    │
                    ▼
活引擎解析：桌面组合没有全局 ctx.compaction（DSH 0.2 把压缩后端挂在每个
agent preset 内部，宿主面 compaction-basic 行被禁用）——本插件经
agentPresets.serviceFor(agent, 'compaction') 按需取 preset 作用域引擎，
每个实例以实例属性赋值影子包装 compactIfNeeded + compactPressure（WeakSet
去重，pre-step prepend 抢在引擎自己的监听器前安装）；手动 compactNow 不碰
→ 手动 /compact 结构性免疫
                    │
                    ▼
decide()（绝不抛错，异常一律放行）：
  溢出特判（D2）→ 联动分支（仅 pressure）→ 压力门（占用未知/低于压缩点放行）→ 档位状态机
                    │
              拦截 = 返回 null
  调用方视作"无需压缩"正常继续，零状态残留；追踪文件 + 提示条留痕
```

## 设计动机

这个插件为**本地小窗口模型**而生：dsh 的自动压缩总是挑最坏的时机到来。本地模型
上下文短，复杂任务里大量工具结果灌进来，几个回合就顶到压缩阈值；自动压缩不问
场合——任务跑到一半，中段的关键细节（文件内容、检索结果、中间结论）被摘要一刀
切掉，后续步骤拿着残缺的上下文继续，轻则答非所问，重则整个任务报废。压缩本身
没做错什么，错的是**时机不由你定**。

本插件做的就是把压缩的主动权拿回来：自动压缩发生前先拦下——每轮先问（手动档）、
推迟几个回合（临时档）、或全部驳回只留手动 /compact（禁止档），让你在任务自己
选的段落间隙压缩，而不是让引擎在工具结果刚落地时动手。

与 [dsh-compaction-policy](https://github.com/zyd232/dsh-compaction-policy) 的
动机同源（都不满足引擎默认的压缩时机），但做法更激进：它通过调整阈值/预算**挪动
压缩点的位置**，让压缩晚一点发生；本插件直接把"要不要压缩"变成显式决策——压缩
点位置交给它管，时机交给你管，两者叠用正合适。

拦下压缩不能把事情做死，所以安全闸一个不少：溢出恢复（provider 已确认真实超限）
除"禁止"档外全部放行；联动保持期间占用 ≥95% 触发安全阀放行；临时档占用 ≥90%
自动切手动；插件内部任何异常一律放行（D3），拦截 = 返回 null 零状态残留、不写
会话日志——压缩是最后的安全阀，本插件绝不成为新的故障点。

对官方模型（1M 上下文）意义不大：窗口足以完成绝大多数长任务，压缩点遥远，人为
选择压缩时机的余裕本来就大——这是给本地小窗口模型准备的工具。

## 档位

| 档位 | 语义 |
| --- | --- |
| **关闭**（默认） | 无任何效果 |
| **临时拒绝** | 拦接下来 **3 个回合**内自动触发的压缩；上下文占用率 **≥90%** 时该会话自动切为手动拒绝。窗口按会话武装（首个 pre-step 或首次决策时起算，含当回合）；**过期后该会话自动切回"手动拒绝"**（会话级覆盖；设置页档位值不变——v0.2.5 起语义）。会话级临时窗每个会话只消费一次 |
| **手动拒绝** | 每回合首次自动压缩尝试 → 拦截 + 对话流提示条询问（四键）：**[立即压缩]**（调公开手动 API `compactNow`；忙碌/失败回落"批准下一检查点"，见下方批准语义）/**[拒绝压缩]**（本回合不放行，翻灰态）/**[三回合内不再询问]**（写会话级临时窗）/**[不再询问]**（写会话级禁止）。同回合重试静默拦并计数（条上显示"本回合已拦 N 次"），回合切换自动重新询问 |
| **禁止** | 驳回所有自动压缩（含溢出恢复），只放行手动压缩——后果是当轮可能报"上下文超限"错误、需手动 /compact，这是该档的诚实语义。`spareOverflow` 开启后放行溢出恢复兜底 |

![手动档询问条](screenshots/ask-bar.png)

- 改档（设置页）= 写全局默认 + **清除全部会话级运行时覆盖**（90% 自动切档、临时窗等）。
- 会话级覆盖优先于全局档位；当前只有 90% 切档会产生会话覆盖。
- 占用率 = `tokenMeter.measure(session[, header]).totalTokens / contextWindow`
  （contextWindow 经 `llm.resolveModelInfo` 解析，与官方压缩引擎同款；算不出 → 视为未知，
  不触发 90% 切档）。
- **批准语义（v0.2.7）**：`allowOnceTurn` 是"批准到第 X 回合"（`<=`）。compact-now
  成功写当前回合；**忙碌/失败回落写下一回合**（同时覆盖正在跑的回合的剩余尝试）——
  你点「立即压缩」的批准不会静默丢弃：下一次压缩尝试在引擎自己的 step 边界放行执行
  （先硬剪再摘要的官方路径），压缩完毕才继续那个 step 的模型调用；若届时压力已回落
  （如精简落盘缩了上下文、不再触发尝试），批准自然过期不消费。仅手动档回落——
  禁止/临时分支不查批准（落了也不生效）。

## 截断自动恢复（v0.2.14，与四档解耦）

回合以 `turn/end.reason = 'max-tokens'`（模型输出撞到请求的 `maxTokens`）结束时，
不再等你手动发「继续」：

1. `turn/end` 事件里判定（用户已排队输入 / 已取消 / 达上限 → 不动作）；
2. `agent.followup()` 排一条 `继续。`，source 是本插件自己的 kind
   （`refuse-compaction:auto-resume`，会话校验只要求 kind 非空）；
3. `recover` 档且**剩余输出空间不足**时，在下一轮 `pre-step` 里调引擎公开的
   `compactRegion`：范围 = 第一个非 system 节点 → **被截断回合之前**的最后一个节点，
   边界按 tool-call/result 配对平衡回退；被截断这一轮原样留在 surface 上，
   "摘要 + 最新一轮"的拼接就是 surface 顺序本身；
4. 摘要走包装后的 `engine.summarize`：会话自己的 system/tools/消息前缀照旧（KV 缓存
   仍命中），末尾追加一段**只读**的「被截断轮可见内容」（text + 工具名，**不含
   reasoning**），并要求摘要的 `Current Work` / `Next Step` 据此判断；摘要请求单独设
   `maxTokens = 4096`，绝不复用会话那 32k/256k 的输出预留；
5. 压缩成功后本回合引擎不再二次压缩（`resume-hold`），避免把刚保留的那一轮也压掉；
6. 任一步失败 → 降级为「只继续」，绝不卡死会话。

**做不到的一条**：那句「已达到输出 token 上限」是 `turn/end` 的持久记录
（客户端 `TurnMaxTokensItem` 注释原文 *persistent, turn-positioned*），插件撤回不了；
本插件只在提示条上加一条「已自动恢复 N/M」的状态。

## 输出预算守门（v0.2.16）

压缩点是「窗口 − 单次输出上限」和「窗口 × 触发比例」里**更小**的那个：后台的
`dsh-compaction-policy` 用 `min(W×triggerRatio, W−O−headroom)` 计算，`O` 就是模型页
那个 `maxTokens`。本地小窗口模型上 `W−O` 通常更小，所以压缩点落在 46% 附近而不是
75% —— 这是把输出空间提前留出来了，不是配置错误。

也因此，只要压缩正常工作，prompt 永远到不了溢出边界；**只有压缩被拦住或失败时**，
它才会越过去，接着那次请求就会被服务端直接拒绝。守门只在那一刻接管：

```
outputGuard === 'auto'                // 独立开关（默认开）
生效档位 !== 'off'                     // 关闭档 = 完全放手，连输出预算也不干预
measured >= compactionPoint           // 该压没压，才动手
budget = W − measured − 4096          // 4096 留给本轮还没进 surface 的消息
if budget < configured → maxTokens = budget
if budget < 1024      → 放弃（写不出东西），交给溢出恢复
```

**任何非「关闭」档都会生效**（temporary / manual / forbid），不只是禁止档 ——
只是禁止档最容易复现「越线却没被压」这个前提。

**为什么门要开在压缩点之后**：`agent/request` 改 `maxTokens` 会被写进
`request/header`（`headerEquals` 用 `callConfigEquals` 比较它），而
dsh-compaction-policy 的压缩点按最新 header 的 `O` 计价。若在压缩点之前就压预算，
压缩点会跟着后移，形成「越压越不压」的正反馈。限定在越线之后，正常回合完全不碰；
压缩一旦成功，header 回到配置值，压缩点自行复原。代价是越线后压缩点最多被推后
一次 `4096`，之后按 4k 一阶跟随。

仪表会提前告知：「上下文余量已贴近输出上限，将自动压低允许的上限值 · 32,768 → 26,336」。
仪表的出现阈值（`compactionPoint × (1 − revealAhead)`）早于守门触发点，所以这句提醒
不会晚于仪表出现。

## 与 dsh-exa-distill 联动（"精简结果替换前不压缩"）

两个插件都在时，exa-distill（≥0.2.7）设置里出现"**精简结果替换前不压缩**"复选框。
开启后：exa-distill 回合末精简完成、摘要还在**待落盘队列**里时，本插件拦住 dsh 的
自动压力压缩（含模型切换压力）；下一个回合 `agent/pre-step` 把摘要落盘（拿到精简后的
上下文）后自然放行——如果精简后依然超限，再申请压缩就不会拦。

- 桥：`globalThis[Symbol.for('dsh.exa-distill.bridge')]` =
  `{ hasPending(session), holdCompactionEnabled(session) }`，进程内、feature-detect、
  每次调用现读，任一侧缺失/旧版 → 联动静默不生效，各自独立功能不受影响。
- **永不拦溢出恢复**（provider 已确认真实超限时，摘要必然已拿过机会）；溢出恢复
  按 D2 只被"禁止"档拦截。
- **95% 安全阀**：联动保持期间占用率 ≥95% → 放行并 trace `link-release`
  （防 flush 连续失败骑到溢出）。

## 设计红线

- **拦截 = 返回 null**：三个调用点对 null 都是"无需压缩、正常继续"，零状态残留。
- **只内存、不写会话**：运行时状态全部 Map 内存 + `agent/pre-step`/`agent/turn-stopping`
  回合追踪，重启即还原；提示条/状态走宿主 webServer 路由（`/refuse-compaction/*`），
  不写任何会话日志事件（unknown 非 ignorable 事件会被恢复校验器拒绝）。
- **D3 异常一律放行**：decide/包装内任何异常按 allow 处理 + trace——压缩是安全阀，
  本插件绝不能成为新的故障点。
- **D1 block-first 询问**：手动拒绝不用 userQuestions 服务（回答会被 steer 成 user
  message 写入对话、工具形状耦合），改用"拦截 + 提示条按钮"。
- 引擎方法缺失（dsh 更新改名）→ feature-detect 自禁用 + `mount-fail` trace，不抛。

## 安装（手动 / 离线，dsh 桌面 profile）

dsh 桌面 profile 的插件加载是"**三件套 + bundle patch**"，缺一不可：
`node_modules` 包内容、profile `package.json` 的依赖行、`dsh.profile.bundles` 数组。

以 0.2.10 为例（Release 页可下载 `dsh-refuse-compaction-0.2.10.tgz`，或自行 `pnpm pack`）：

```bash
# ① 包内容解压到 profile 的 node_modules
mkdir -p ~/.dsh/profiles/desktop/node_modules/dsh-refuse-compaction
tar -xzf dsh-refuse-compaction-0.2.10.tgz \
  -C ~/.dsh/profiles/desktop/node_modules/dsh-refuse-compaction --strip-components=1
```

② 编辑 `~/.dsh/profiles/desktop/package.json`，`dependencies` 加一行
（tgz 放在 profile 目录旁，或改成实际路径）：

```json
"dependencies": {
  "dsh-refuse-compaction": "file:dsh-refuse-compaction-0.2.10.tgz"
}
```

③ 同文件的 `dsh.profile.bundles` 数组加包名（已装其他插件的话追加即可）：

```json
"dsh": {
  "profile": {
    "bundles": [
      "dsh-refuse-compaction"
    ]
  }
}
```

④ `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加（包内自带的
`cordis.patch.yml` 走 bundle patch 机制，profile 层这行由安装器并入；手动安装需手补）：

```yaml
- id: refuse-compaction
  name: dsh-refuse-compaction
```

然后**重启 dsh**。设置侧边栏 →「**拒绝压缩**」区块。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tier` | `off` | 档位：`off` / `temporary` / `manual` / `forbid`（volatile，改档即生效并清会话覆盖） |
| `spareOverflow` | `false` | true =「禁止」档也放行溢出恢复（provider 已确认超限时的兜底压缩） |
| `promptBar` | `true` | 对话内提示条：拦截发生时在该回合尾部显示档位/原因/占用率；manual 档带四键询问条（立即压缩/拒绝压缩/三回合内不再询问/不再询问） |
| `revealAhead` | `0.2` | F1 占用仪表提前量：距压缩点不足这个比例时在对话流尾部亮出环形仪表 + 四档快切；未达阈值不展示 |
| `autoResume` | `off` | 截断自动恢复：回合以「输出 token 上限」结束时自动代发「继续」。`off` / `continue`（只继续）/ `recover`（先压缩被截断轮之前的历史再继续）。**与四档解耦** |
| `autoResumeMax` | `2` | 连续自动恢复上限；用户自己发消息即重置计数 |
| `autoResumeMinTail` | `8192` | `recover` 档的压缩门槛：剩余输出空间不足时先压缩，否则只继续 |
| `outputGuard` | `auto` | 输出预算守门：历史越过压缩点却没被压（被拒/失败）时，把本次请求的 `maxTokens` 压到「窗口 − 已用 − 4096」，避免 provider 直接报超限；**仅在档位非「关闭」时生效**；`off` 关闭 |

**F1 占用仪表**：上下文距压缩点不足 `revealAhead` 时，对话流最后回合尾部出现仪表条
——环形进度（复用 ContextMeter 视觉语言）+ 主文本 `X%（已用 / 压缩点）`（X% =
已用/压缩点，越过钳 100%；总窗口占比看 dsh 自带的上下文仪表，这里不重复强调）+
第二行 `距压缩点 N tokens`（越过压缩点后钳 0）+ 档位快切。快切高亮 = **会话生效档**
（quiet 写的会话覆盖即时反映；覆盖生效时生效档按钮虚线边框 + 悬停说明，点击任意
档位 = 写全局档并清本会话覆盖）。压缩点按 **F2 联动**自动读取 **dsh-compaction-policy
的活配置**（见下方致谢节）：从 loader 入口树递归找到该插件行，取值优先
`fiber.effectiveConfig` → `fiber.config` → `entry.options.config`，归一化
（与其 normalizePolicy/缺省对齐）后按同款公式
`floor(min(W×triggerRatio, W−O−headroomTokens))` 算生效压缩点，路由不命中/禁用/
未装 → 回退内置 0.8。**对 dsh-compaction-policy 零改动、零桥**。仪表只在
"活尾回合"展示并轮询，老回合尾巴静默。

## 与 dsh-compaction-policy 的关系（致谢）

- 仪表的压缩点计算**直读** [zyd232/dsh-compaction-policy](https://github.com/zyd232/dsh-compaction-policy)
  的活配置（loader 入口树递归查找，归一化对齐其 normalizePolicy，公式同款），
  对它零改动、零桥；未安装/禁用/路由不命中 → 回退内置 0.8。
- 两者定位互补：compaction-policy 管"压缩在何时发生"（阈值/预算），
  本插件管"自动压缩要不要先问过我"。
- 感谢 zyd232 的实现与 dsh（DeepSeek Harness）的插件接缝设计。

## 兼容性

- `dsh.verifiedWith: 0.2.3-alpha.2`——在该版本上开发并真机验证（0.2.13 起更新；
  此前声明为 0.2.2-rc.3，中间版本的接缝未变，故未做代码改动）。
- dsh 升级后若内部接缝变化（引擎方法改名等），插件 feature-detect **自禁用**
  （不抛错、不影响 dsh 运行），追踪文件出现 `mount-fail` 事件说明原因。
- 排查入口：`~/.dsh/refuse-compaction-trace.ndjson`（`mounted` / `mount-fail` /
  `policy-scan` 事件）。

## 追踪与验证

追踪文件：`~/.dsh/refuse-compaction-trace.ndjson`（>1MB 轮转；测试用
`DSH_REFUSE_COMPACTION_TRACE` 隔离）。关键事件：

| 事件 | 含义 |
| --- | --- |
| `mounted` / `mount-fail` | 挂载成功（含模型切换接缝是否存在）/ 自禁用原因 |
| `policy-scan` | F2 自诊断：入口树行名列表 + 命中行配置形状（mount 一次 + 轮询 30s 节流） |
| `tier-armed` / `tier-expired` | 临时窗武装（回合区间）/ 过期自动切回"手动拒绝" |
| `tier-switch` | 临时档 ≥90% 自动切手动（含占用率） |
| `global-tier-change` | 设置页改档（from → to，伴随清全部会话覆盖） |
| `compaction-blocked` | 一次拦截（trigger/via/why/occupancy/expiresAtTurn） |
| `link-block` / `link-release` | 联动保持 / 95% 安全阀放行 |
| `allow-once` / `compact-now` / `compact-queued` | 提示条按钮动作（compact-now 带 ok/busy；compact-queued = 忙碌批准回落，带 throughTurn） |
| `quiet` / `refused` / `override-clear` | 询问条按钮动作 / 清会话覆盖（仪表档位快切配套） |
| `decide-error` | 决策异常（fallback= allow，D3） |
| `resume-fire` / `resume-skip` / `resume-exhausted` | 自动恢复已排队（含 compress / remaining）/ 跳过原因 / 达上限 |
| `resume-compact` / `resume-compact-skip` / `resume-compact-fail` | 恢复压缩落地（brokenTurn / 范围 / shadowed）/ 跳过 / 失败降级 |
| `resume-hold` / `resume-summary-fallback` | 恢复压缩后本回合不再二次压缩 / 无旁路通道时退回引擎自带摘要 |
| `output-guard` / `output-guard-skip` / `output-guard-error` | 输出预算被压（configured → clamped）/ 压到 1024 以下放弃 / 守门异常 |

真机验证路径：设置里切"手动拒绝" → 聊到压缩阈值附近 → 看到提示条 →
点[立即压缩]（忙碌时自动转"已批准：下一个压缩检查点"）或[三回合内不再询问] →
trace 与对话流状态一致。

## 版本

- **0.2.17**：设置页八条描述全部改写——去掉公式和内部变量名，统一为「上下文窗口 /
  单次输出上限 / 压缩点 / 剩余输出空间」四个词，每条只讲「什么时候生效、会发生什么」。
- **0.2.16**：输出预算守门（`outputGuard`，独立开关）。历史越过压缩点却没被压时，把本次
  请求的 `maxTokens` 压到「窗口 − 已用 − 4096」，避免 provider 直接报超限；仅在档位非
  「关闭」时生效；门开在压缩点之后，避免 header 变小反过来推后压缩点。仪表增加
  「上下文余量已贴近输出上限」提醒。
- **0.2.14**：截断自动恢复（`autoResume` / `autoResumeMax` / `autoResumeMinTail`）。
  `turn/end(max-tokens)` → 自动 `followup("继续")`；`recover` 档在剩余输出空间不足时
  先压缩「被截断轮之前」的历史（`compactRegion` + 平衡回退），被截断轮原样保留；
  摘要包装 `engine.summarize` 追加只读尾部（不含 reasoning）并独立设 4096 输出上限；
  压缩后本回合 `resume-hold` 防二次压缩；失败一律降级为只继续。
  **pre-step 监听器改为 async**（压缩必须在 turn 内执行）。截断提示本身无法撤回。
- **0.2.13**：仅更新兼容性声明（`dsh.verifiedWith` → `0.2.3-alpha.2`），无功能变更。
  在 0.2.3-alpha.2 上复核：`agentPresets.serviceFor(agent,'compaction')`、
  `compactIfNeeded` / `compactPressure(agent,header,signal,requireBelowThreshold)` 签名、
  `agent/pre-step`、`agent/turn-stopping`、`tokenMeter.measure().totalTokens`、
  `llm.resolveModelInfo` 均未变；65 项测试全绿，启动 trace `mounted` + `policy-scan` 正常
  （读到 compaction-policy 活配置 `enabled=true / triggerRatio=0.75 / headroomTokens=0`）。
- **0.2.12**：六条路由加入口准入（`connection.requestRejection` + 回环兜底）。
- **0.2.11**：修**新对话第一轮弹假询问条**（真机 trace 实锤：每个新对话第一轮
  `compaction-blocked {why:manual-ask, occupancy:null}`——占用远未达阈值、仪表不亮，
  之后轮次正常）。根因：新会话首个 pre-step 时 `requestHeader()` 还没建立（meter
  无投影基线）→ 占用率未知（null），旧逻辑把引擎的这次**空探查**当成"压缩尝试"
  拦下——拦截档在占用率未知时一律拦截，且手动档在占用已知但**低于压缩点**时也拦
  （档位分支没有任何占用率门）。修复：压力路径加**统一门**——占用率未知或
  `totalTokens < compactionPoint` → 放行。安全性：引擎自身对这两种情况都 no-op
  （`compactIfNeeded` 无 header/无路由目标直接返回 null；`compactPressure` 内
  `measurement < thresholdTokens` 短路），放行 = 与无插件时行为完全一致。附带收益：
  未装 dsh-compaction-policy 的环境（独立安装本插件的用户）里引擎每步都会调到包装，
  此门同时避免低压力回合被反复询问。溢出恢复（D2）不看占用率，禁止档照拦；
  联动分支的空探查同样静默放行不记事件。58 测试全绿（39 host + 19 client；
  新增压力门两形态回归，旧"任何调用即尝试"语义的用例全部改为真实阈值穿越形态，
  并补放行可区分断言）。
- **0.2.10**：修**中断回合后临时窗倒数跳档**（用户实测：中断模型 → 手动询问 → 点
  "三回合内不再询问" → 3/1/1，"还剩2"被跳过；无中断时 3/2/1 正常）。根因：
  `agent/turn-stopping` 只在回合正常收尾时分发（dsh-agent-loop 中止路径设
  `turnEnds={kind:'aborted'}` 后直接 rethrow），中断后 currentTurn 停在死回合上，
  quiet 按"当前回合算第一回合"武装，死回合吃掉一个名额。修复：① quiet 武装以
  **点击的询问条所在回合**为锚——客户端 POST 带 `turn`（条目回合号），宿主
  `base = max(currentTurn, 条回合+1)`，"三回合"永远覆盖接下来的三个完整回合
  （正常完成/迟到点击行为不变，仅中断场景变化）；② **"还剩N回合"改为按事件自身
  回合冻结计算**（expiresAtTurn − event.turn，旧条不随轮询漂移；事件缺 turn 的
  旧宿主数据退化为不带倒数）。56 测试全绿（37 host + 19 client）。
- **0.2.9**：仪表两处口径/语义修正（用户实测反馈）。① **主文本改压缩点口径**：
  原"35%（45k / 131k 上下文）"误导（总窗口占比 dsh 自带 ContextMeter 已有）→
  "**100%（45k / 39k 压缩点）**"——X% = 已用/压缩点（越过钳 100%），括号同口径，
  与环形进度一致；纯函数 `gaugeText` 导出直测；**"距压缩点 N tokens"第二行保留
  原样**（越过压缩点后钳 0）。② **仪表档位高亮改会话生效档**
  （payload.tier = peekTier）：quiet 写的会话覆盖（临时/禁止）即时反映在快切上
  （原高亮读全局档，覆盖期间显示不实）；覆盖生效时生效档按钮虚线边框 + 悬停说明，
  点击任意档位 = 写全局档 + **清本会话覆盖**（新路由
  `POST /refuse-compaction/clear-override`，同时清 refusedTurn/allowOnceTurn/
  repeatCount——改档后旧批准/拒绝记忆作废，回到新档位的干净语义），乐观更新
  生效档与全局档一起翻、2.5s 保护窗双字段守护。55 测试全绿（36 host + 19 client）。
- **0.2.8**：修 **F2 直读在真机上从未命中**（静默回退掩盖，阈值降到 0.3 才暴露）。
  真机实证：dsh 重启后（组装层已是 0.3）仪表仍走内置 0.8 回退
  （`compactionPoint = floor(W×0.8)` 实测）——旧版平铺扫 `Object.values(loader.store)`
  + 只读 `entry.options.config` 的组合没命中真机的行。读取路径重写：
  ① 用 loader 官方递归遍历 `entries()`（行嵌在组内子树也能找到；缺席时回退平铺扫描，
  旧 mock 兼容）；② 取值优先 `entry.fiber.effectiveConfig`（插件真实使用的活配置，
  volatile 提交保留 cell 引用）→ `fiber.config`（设置页提交整体替换的原始值）→
  `entry.options.config`（组装层原始值，fiber 未挂载时兜底）。新增 `policy-scan`
  追踪事件（mount 一次 + state.json 轮询 30s 节流）：行是否存在、配置形状、
  readValue 解包结果全落 trace——这类静默回退不再无声。53 测试全绿（35 host +
  18 client）。
- **0.2.7**：**忙碌批准回落 + 拦截计数**。手动档"立即压缩"的一个死胡同修复：回合中
  （或点了旧回合的条）时点击会撞 `runMaintenance` busy，批准被静默丢弃。现在忙碌/
  失败时手动档回落"**批准下一检查点**"——`allowOnceTurn` 从"本回合"升级为"批准到
  第 X 回合"（`<=`），busy/失败写 `当前回合+1`，下一次压缩尝试（最迟下一回合首个
  pre-step）在引擎自己的 step 边界自动执行，批准必然物化成一次真压缩；条翻
  「已批准：下一个压缩检查点自动执行压缩」（queued 形态，calm 灰态无按钮；事件回写
  到原询问条所在回合）。非手动档（forbid/temporary）busy 维持原 busy 提示——其分支
  不查批准，落了也不生效。另：manual-repeat 静默拦截计数，条上显示"本回合已拦 N 次"
  （≥2 才显示；新回合归 1；state.json 按 refusedTurn 匹配供给，老条不串数）。
  52 测试全绿（34 host + 18 client）。
- **0.2.6**：修**档位快切卡手**——0.2.4 的乐观高亮被自己触发的立即重轮询打回：
  写入链（form→loader→volatile，几百 ms）落地前轮询带回旧 globalTier，高亮翻回去
  要等下一次轮询。改为点击后不立即重轮询 + 轮询侧 2.5s 乐观保护窗（窗内旧档位不
  覆盖点击值；确认或超时解除）。
- **0.2.5**：**询问条按钮组重构**——原「本回合放行/立即压缩」实际效果收敛（回合中
  agent 忙，立即压缩十有八九 busy），改为四键：**立即压缩**（手动 API，忙则提示）、
  **拒绝压缩**（本回合不放行，翻"已拒绝"灰态，下一回合再次询问）、**三回合内不再
  询问**（本回合不放行 + 会话级临时窗 3 回合）、**不再询问**（本回合不放行 + 会话级
  禁止）。新增 `POST /refuse-compaction/refuse` 与 `POST /refuse-compaction/quiet`
  （quiet 写**会话级覆盖**，不动全局档——全局改档仍走设置页）。临时档提示条文案带
  剩余回合数（"临时拒绝（还剩N回合）"，N = expiresAtTurn − 当前回合 + 1）；**临时窗
  过期自动切回手动拒绝**（原为回落 off）。按钮点击乐观更新。48 测试全绿（31 host +
  17 client）。
- **0.2.4**：仪表档位快切**乐观更新**（配置写入有 form→loader→volatile 提交链，
  点击即时翻按钮高亮，轮询确认真实值）+ 仪表轮询 5s → 3s。新增
  `scripts/render-demo.mjs`：把 lib/client.js 真实组件渲染成 `demo.html` 静态
  演示页（同构 DOM + 同一份动画 CSS，双击可看全部状态与真实动画）。
- **0.2.3**：修复**占用仪表从不显示**——"活尾回合"判定错位一回合：turnTail 在
  回合结束后才渲染，此刻宿主 currentTurn 已推进到 turn+1，原判定
  `currentTurn === turn` 永不成立。改为 `currentTurn === turn + 1`，且旧尾巴在
  更新回合完成后自动停轮询并隐藏（仪表随最新回合尾"移动"）。
- **0.2.2**：`revealAhead` 上限 0.5 → **0.95**（0.95 ≈ 占用 5% 即亮出仪表，方便
  不构造长上下文就能看特效/调样式）。
- **0.2.1**：两处修正。(1) **revealAhead 输入框不可编辑**——Field 的受控 input
  没接 onChange（等于只读），补草稿态 + onBlur 校验提交（越界/非法回滚显示，
  `normalizeNumberInput` 纯函数）。(2) **F2 重构：直读 loader 入口树**——不再依赖
  对 dsh-compaction-policy 的任何改动（0.2.0 曾短暂要求其发布桥），改为
  `ctx.loader.store` 按行名 `dsh-compaction-policy` 直读该行的活配置（设置页改动
  经 internal/commit 写回 entry.options.config，实时可见），归一化 + 同款公式算
  压缩点；未装/禁用/路由不命中/预算非正 → 回退内置 0.8。inject 增加 `loader`。
- **0.2.0**：**F1 占用仪表 + F2 策略修正 + F3 动画**。新对话内 `turnTail` 仪表条
  （`refuse-compaction-gauge`）：距压缩点不足 `revealAhead`（新配置，默认 0.2）时
  显示环形进度 + 占用信息 + 四档快切（写全局设置档）；
  `state.json` v2 现算压力快照（occupancyTokens/contextWindow/compactionPoint/
  effectiveRatio）。F3：提示条/仪表入场动画、ask 相位与临压缩脉冲、环形进度过渡。
  压缩点口径说明：90% 切档与 95% 联动安全阀仍按窗口占用率（不随策略修正）。
- **0.1.0**：首个可用版本（四档拦截 + exa-distill 联动 + 提示条）。

## 本地开发

```bash
npm install --no-save @deepseek-ai/schemastery@^3.18.2   # optional peer；lib 顶层 import 了它，测试挂载路径需要能解析（CI 同款）
npm test                                                 # 87 条：65 host + 22 client
node scripts/render-demo.mjs                             # 生成 demo.html——双击可看全部 UI 状态与真实动画
```

测试只依赖 Node 内置模块（`node --test`），无需安装 react / dsh-client-ui-settings
（client 侧测试在 vm 沙箱里用 React 替身驱动真实组件）。

## 边界与说明

- 临时档窗按**会话**计：全局选"临时拒绝"后，每个在对话的会话各武装自己的 3 回合窗
  （一次性语义；**过期自动切回"手动拒绝"**——该会话此后每轮首次压缩尝试都会重新
  询问，全局档位值不变、也不重复武装新窗）。想要"完全不问"的长期档请用"禁止"，
  想要"每轮都问"请用"手动拒绝"（设置页全局档）。
- `compact-now` 需要 Agent 空闲（官方 `runMaintenance` 语义）；回合进行中点击会得到
  busy → 手动档转"已批准：下一个压缩检查点"（见批准语义）。
- 模型切换被拦（禁止/手动/临时窗内）= 切换照常进行但不压缩；若新窗口装不下，请求会
  以 CONTEXT_WINDOW_EXCEEDED 失败并进入溢出恢复（除"禁止"外都不拦溢出）。
- 拦截面只含 `compactIfNeeded` + `compactPressure` 两个方法；放行路径会经两层包装各
  决策一次（幂等，trace 可能双条 link-release，无副作用）。
- 子代理会话同样经过决策（同一引擎实例）；如需豁免可后续加开关（未做）。

## 维护状态

个人工具，**事件驱动、尽力而为**地维护：Issue 是最快的反馈渠道（不承诺响应
时限），PR 欢迎。dsh 大版本更新后若内部接缝变化，插件会 feature-detect 自禁用
（见[兼容性](#兼容性)）——最坏情况是本插件功能失效，不影响宿主稳定性；接缝
断裂只会在真机以 `mount-fail` trace 呈现（`npm test` 测不到接缝变化）。已知的
语义回归（如 0.2.11 的假询问条）优先处理。

## License

[MIT](LICENSE)
