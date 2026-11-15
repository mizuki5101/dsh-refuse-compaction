/**
 * dsh-refuse-compaction — browser half.
 *
 * Hand-written client bundle in the loader's lazy-CJS factory format
 * (`window.__ModuleLoader__.load({ id: <package name>, factory })`) — same
 * recipe as dsh-exa-distill's client half. No build step: the artifact IS this
 * file.
 *
 * Contributes:
 * - one Settings left-sidebar section (`settings.section`, order 57): tier
 *   select (off/temporary/manual/forbid) + spareOverflow + promptBar;
 * - one in-conversation prompt bar (`conversation.chat.turnTail` slot): polls
 *   the host route /refuse-compaction/state.json per (sessionId, turn) and
 *   renders interception info with 「本回合放行」/「立即压缩」 buttons — the
 *   block-first "ask" channel (D1), no userQuestions transcript pollution.
 *
 * State lives in host memory; nothing is written to the session log (unknown
 * non-ignorable events are rejected by the restore validator).
 */
window.__ModuleLoader__.load({
  id: 'dsh-refuse-compaction',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    /** Must equal the bundle row id and the host settings namespace. */
    var NS = 'refuse-compaction'
    var inject = ['slots', 'configForms', 'locale']

    /**
     * Message catalogue. English is the terminal fallback in DSH's lookup chain,
     * so it has to be complete; every other locale may omit keys and inherit.
     */
    var MESSAGES = {
      en: {
        sectionLabel: 'Refuse compaction',
        intro1:
          'Intercepts DSH\'s AUTO-triggered context compaction while manual /compact stays untouched. Tiers: temporary blocks the next 3 turns (auto-switches to manual at >=90% occupancy); manual asks you via an in-conversation bar on each turn\'s first attempt; forbid rejects all auto compaction; off does nothing. Changing the tier clears all per-session overrides.',
        intro2:
          'Overflow recovery (the provider already confirmed the context window is exceeded) is only blocked by forbid by default; temporary/manual never block it. When dsh-exa-distill is installed and its "hold compaction before digests land" option is on, pressure compaction is held while distilled digests are pending (a 95% occupancy safety valve releases it).',
        tierLabel: 'Tier',
        tierDesc: 'off = no effect; temporary = block the next 3 turns; manual = ask before each turn\'s first auto attempt; forbid = reject all auto compaction (manual /compact always allowed).',
        tierOff: 'Off (no effect)',
        tierTemporary: 'Temporary refuse (next 3 turns)',
        tierManual: 'Manual refuse (ask each turn)',
        tierForbid: 'Forbid (reject all auto)',
        spareOverflowLabel: 'Forbid also releases overflow recovery',
        spareOverflowDesc: 'When the provider already reported CONTEXT_WINDOW_EXCEEDED, allow the automatic recovery compaction even under the forbid tier (temporary/manual never block it). Off by default: forbid means everything.',
        promptBarLabel: 'In-conversation prompt bar',
        promptBarDesc: 'When an interception happens, show a bar at that turn\'s tail with the tier, reason and occupancy; the manual tier asks with four buttons (compact now / refuse / quiet for 3 turns / stop asking). A busy "compact now" click is not dropped: it approves the next compaction checkpoint, which then runs at the engine\'s own step boundary. Rendered by the client companion package; nothing is written to the session log.',
        revealAheadLabel: 'Gauge reveal ahead',
        revealAheadDesc: 'Show the in-conversation occupancy gauge ("percent (tokens)" + tier quick-switch) once the context is within this fraction of the compaction point (default 0.2 = 20% left). Hidden below the threshold. The compaction point follows the dsh-compaction-policy effective strategy when installed (fallback: built-in 0.8).',
        gaugePoint: 'compaction point',
        gaugeToCompaction: 'to compaction point',
        gaugeSessionOverride: 'Session override active — click any tier to set the global tier and clear this session override',
        gaugeTierPrompt: 'Tier',
        tierShortOff: 'Off',
        tierShortTemporary: 'Temp',
        tierShortManual: 'Manual',
        tierShortForbid: 'Forbid',
        reset: 'Restore default',
        resetTitle: 'Clear your override and fall back to the composition default',
        loading: 'Reading host settings…',
        noService: 'The settings service is unavailable (the refuse-compaction namespace is not mounted).',
        unavailable: 'The host does not expose the refuse-compaction namespace, so there is nothing to edit.',
        readOnly: 'This connection is read-only, so changes are not written to the host.',
        barAsk: 'Auto compaction intercepted — allow it for this turn?',
        barBlocked: 'Auto compaction intercepted',
        barAllowed: 'Allowed for this turn (asks again next turn)',
        barRefused: 'Refused for this turn (will ask again next turn)',
        barCompacted: 'Manual compaction done',
        barQueued: 'Approved — the next compaction checkpoint will compact automatically',
        barRepeat: '{n} auto attempts blocked this turn',
        barReleased: 'Released by the distill linkage (occupancy too high)',
        barOccupancy: 'occupancy',
        barOccupancyUnknown: 'occupancy unknown',
        barBusy: 'Agent is busy — try again after the turn ends',
        barCompactBtn: 'Compact now',
        barRefuseBtn: 'Refuse',
        barQuiet3Btn: 'Quiet for 3 turns',
        barQuietForeverBtn: 'Stop asking',
        whyTemporary: 'temporary refuse',
        whyTemporaryLeft: 'temporary refuse ({n} turns left)',
        whyForbid: 'forbid',
        whyForbidOverflow: 'forbid (overflow included)',
        whyLinkHold: 'holding for distill digests',
        whyManual: 'manual refuse',
        whyTierSwitch: 'occupancy >=90%, switched to manual',
      },
      zh: {
        sectionLabel: '拒绝压缩',
        intro1:
          '拦截 dsh 自动触发的上下文压缩，手动 /compact 不受影响。档位：临时拒绝 = 拦接下来 3 个回合（占用率 ≥90% 自动切为手动拒绝）；手动拒绝 = 每回合首次自动压缩尝试先拦截并在对话流询问；禁止 = 驳回所有自动压缩；关闭 = 无任何效果。改档会清除全部会话级运行时覆盖。',
        intro2:
          '溢出恢复（provider 已确认上下文超限）默认只被「禁止」档拦截，临时/手动档永不拦。装了 dsh-exa-distill 且开启「精简结果替换前不压缩」时，有待落盘摘要会拦住压力压缩，精简落盘后自然放行（占用率 ≥95% 安全阀放行）。',
        tierLabel: '档位',
        tierDesc: '关闭 = 无任何效果；临时拒绝 = 拦接下来 3 个回合；手动拒绝 = 每回合首次尝试先询问；禁止 = 驳回所有自动压缩（手动压缩永远放行）。',
        tierOff: '关闭（无任何效果）',
        tierTemporary: '临时拒绝（接下来 3 个回合）',
        tierManual: '手动拒绝（每回合询问）',
        tierForbid: '禁止（驳回全部自动压缩）',
        spareOverflowLabel: '禁止档也放行溢出恢复',
        spareOverflowDesc: 'provider 已报上下文超限（CONTEXT_WINDOW_EXCEEDED）时的自动恢复压缩，开启后「禁止」档也放行（临时/手动档永不拦）。默认关：禁止就是全拦。',
        promptBarLabel: '对话内提示条',
        promptBarDesc: '拦截发生时在该回合尾部显示档位、原因与占用率；手动档询问条带四键（立即压缩 / 拒绝压缩 / 三回合内不再询问 / 不再询问）。忙碌时点「立即压缩」不会静默丢弃：自动批准下一个压缩检查点，在引擎自己的 step 边界执行。由客户端伴侣包渲染，不写任何会话日志。',
        revealAheadLabel: '仪表提前量',
        revealAheadDesc: '上下文距压缩点不足这个比例时（默认 0.2 = 还剩 20%），在对话流该回合尾部亮出"百分比（token 数）"占用仪表与档位快切；未达阈值不展示。压缩点按 dsh-compaction-policy 的生效策略修正（未装回退内置 0.8）。',
        gaugePoint: '压缩点',
        gaugeToCompaction: '距压缩点',
        gaugeSessionOverride: '会话覆盖生效中——点击任意档位 = 写全局档并清除本会话覆盖',
        gaugeTierPrompt: '档位',
        tierShortOff: '关闭',
        tierShortTemporary: '临时',
        tierShortManual: '手动',
        tierShortForbid: '禁止',
        reset: '恢复默认',
        resetTitle: '清除该字段的用户覆盖，回到组装层默认值',
        loading: '正在读取宿主配置…',
        noService: '设置服务不可用（refuse-compaction 命名空间未挂载）。',
        unavailable: '宿主未提供 refuse-compaction 命名空间，这里没有可编辑的内容。',
        readOnly: '当前连接只读，改动不会写入宿主。',
        barAsk: '已拦截自动压缩——要放行本回合的自动压缩吗？',
        barBlocked: '已拦截自动压缩',
        barAllowed: '本回合已放行（下一回合恢复拦截）',
        barRefused: '已拒绝本回合自动压缩（下一回合再次询问）',
        barCompacted: '已手动压缩上下文',
        barQueued: '已批准：下一个压缩检查点自动执行压缩',
        barRepeat: '本回合已拦 {n} 次自动压缩',
        barReleased: '精简联动放行（占用率过高，不再保持）',
        barOccupancy: '占用',
        barOccupancyUnknown: '占用率未知',
        barBusy: '会话忙碌——回合结束后可再试',
        barCompactBtn: '立即压缩',
        barRefuseBtn: '拒绝压缩',
        barQuiet3Btn: '三回合内不再询问',
        barQuietForeverBtn: '不再询问',
        whyTemporary: '临时拒绝',
        whyTemporaryLeft: '临时拒绝（还剩{n}回合）',
        whyForbid: '禁止',
        whyForbidOverflow: '禁止（含溢出兜底）',
        whyLinkHold: '等待精简结果落盘（联动保持）',
        whyManual: '手动拒绝',
        whyTierSwitch: '占用率 ≥90%，已切为手动拒绝',
      },
    }

    var rowStyle = { display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 0' }
    var labelStyle = { fontSize: '13px', fontWeight: 600 }
    var hintStyle = { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 }
    var inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      fontSize: '13px',
      borderRadius: '6px',
      border: '1px solid rgba(128,128,128,0.35)',
      background: 'transparent',
      color: 'inherit',
    }

    var h = React.createElement

    /** 数字输入提交（纯函数，测试直用）：解析并校验范围；非法/越界 → undefined（调用方回滚显示）。 */
    function normalizeNumberInput(raw, min, max) {
      var parsed = Number(String(raw ?? '').trim())
      if (!Number.isFinite(parsed)) return undefined
      var low = Number.isFinite(min) ? min : -Infinity
      var high = Number.isFinite(max) ? max : Infinity
      if (parsed < low || parsed > high) return undefined
      return parsed
    }

    /** One labelled field with a reset-to-default action. */
    function Field(props) {
      // 受控输入要有草稿态：onChange 更新草稿、onBlur 校验提交（越界/非法回滚显示）
      var draft = React.useState(String(props.value ?? ''))
      var text = draft[0]
      var setText = draft[1]
      React.useEffect(function () {
        setText(String(props.value ?? ''))
      }, [props.value])
      var control
      if (props.type === 'switch') {
        control = h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': props.value === true,
            'aria-label': props.label,
            disabled: props.disabled === true,
            onClick: function () {
              props.onCommit(props.value !== true)
            },
            style: Object.assign({}, inputStyle, {
              width: 'auto',
              minWidth: '72px',
              cursor: 'pointer',
              fontWeight: 600,
            }),
          },
          props.value === true ? props.onLabel : props.offLabel,
        )
      } else if (props.type === 'select') {
        control = h(
          'select',
          {
            value: String(props.value ?? ''),
            disabled: props.disabled,
            'aria-label': props.label,
            style: inputStyle,
            onChange: function (event) {
              props.onCommit(event.currentTarget.value)
            },
          },
          (props.options ?? []).map(function (opt) {
            return h('option', { value: opt.value }, opt.label)
          }),
        )
      } else {
        control = h('input', {
          type: props.type === 'number' ? 'number' : 'text',
          step: props.type === 'number' ? (props.step ?? 'any') : undefined,
          min: props.type === 'number' ? props.min : undefined,
          max: props.type === 'number' ? props.max : undefined,
          value: text,
          disabled: props.disabled,
          'aria-label': props.label,
          style: inputStyle,
          onChange: function (event) {
            setText(event.currentTarget.value)
          },
          onBlur: function () {
            if (props.type === 'number') {
              var next = normalizeNumberInput(text, props.min, props.max)
              if (next === undefined) {
                setText(String(props.value ?? ''))
                return
              }
              props.onCommit(next)
              return
            }
            props.onCommit(text)
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter') event.currentTarget.blur()
          },
        })
      }
      return h(
        'div',
        { style: rowStyle },
        h('div', { style: labelStyle }, props.label),
        props.description ? h('div', { style: hintStyle }, props.description) : null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          control,
          h(
            'button',
            {
              type: 'button',
              disabled: props.disabled || props.overridden !== true,
              title: props.resetTitle,
              onClick: function () {
                props.onReset()
              },
              style: Object.assign({}, inputStyle, {
                width: 'auto',
                cursor: props.overridden === true ? 'pointer' : 'default',
                opacity: props.overridden === true ? 1 : 0.45,
              }),
            },
            props.resetLabel,
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 对话内提示条：turnTail 扩展条 + 宿主 HTTP 状态查询 + 按钮动作          */
    /* （不写会话日志：unknown 非 ignorable 事件会被恢复校验器拒绝）           */
    /* ------------------------------------------------------------------ */

    var barBaseStyle = {
      margin: '2px 0',
      padding: '8px 12px',
      fontSize: '12px',
      lineHeight: 1.6,
      borderRadius: '6px',
      border: '1px solid rgba(255,140,90,0.45)',
      borderLeft: '3px solid rgba(255,140,90,0.75)',
      background: 'rgba(255,140,90,0.07)',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }
    var btnRowStyle = { display: 'flex', gap: '8px', flexWrap: 'wrap' }
    var btnStyle = {
      padding: '3px 12px',
      fontSize: '12px',
      cursor: 'pointer',
      borderRadius: '6px',
      border: '1px solid rgba(128,128,128,0.4)',
      background: 'transparent',
      color: 'inherit',
    }

    /**
     * 拦截原因 → 本地化标签（纯函数，测试直用）。temporary 带"还剩N回合"：
     * N = expiresAtTurn − currentTurn + 1（含当前回合）。
     */
    function whyLabel(why, t, remaining) {
      if (why === 'temporary') {
        return Number.isFinite(remaining)
          ? String(t('whyTemporaryLeft')).replace('{n}', String(remaining))
          : t('whyTemporary')
      }
      if (why === 'forbid') return t('whyForbid')
      if (why === 'forbid-overflow') return t('whyForbidOverflow')
      if (why === 'link-hold') return t('whyLinkHold')
      if (why === 'manual-ask' || why === 'manual-repeat') return t('whyManual')
      if (why === 'tier-switch') return t('whyTierSwitch')
      return ''
    }

    /**
     * 临时拒绝剩余回合数（纯函数，测试直用）：以**事件自身回合**为基准冻结计算
     * （0.2.10）——中断回合不走 turn-stopping、currentTurn 停在死回合上，活口径
     * 会把"还剩2"跳成"还剩1"；事件口径 = 该回合当时的真实剩余（旧条不随轮询漂移）。
     */
    function temporaryRemaining(state) {
      var ev = state && state.event ? state.event : {}
      if (ev.why !== 'temporary') return undefined
      if (!Number.isFinite(ev.expiresAtTurn) || !Number.isFinite(ev.turn)) return undefined
      return Math.max(1, ev.expiresAtTurn - ev.turn)
    }

    /** 状态记录 → 提示条主文本（纯函数，测试直用）。 */
    function barText(state, t) {
      var ev = state && state.event ? state.event : {}
      var phase = state && state.phase ? state.phase : 'blocked'
      var head
      if (phase === 'ask') head = t('barAsk')
      else if (phase === 'allowed') head = t('barAllowed')
      else if (phase === 'refused') head = t('barRefused')
      else if (phase === 'compacted') head = t('barCompacted')
      else if (phase === 'queued') head = t('barQueued')
      else if (phase === 'released') head = t('barReleased')
      else head = t('barBlocked')
      var parts = [head]
      var why = whyLabel(ev.why, t, temporaryRemaining(state))
      if (why !== '') parts.push(why)
      var occ = typeof ev.occupancy === 'number'
        ? ev.occupancy
        : (state && typeof state.occupancy === 'number' ? state.occupancy : undefined)
      parts.push(occ === undefined || occ === null
        ? t('barOccupancyUnknown')
        : t('barOccupancy') + ' ' + Math.round(occ * 100) + '%')
      return parts.join(' · ')
    }

    /**
     * turnTail 提示条组件：props = owner {turn} + 注入 {sessionId} + locale t。
     * 按 (sessionId, turn) 轮询宿主状态查询（3s 间隔）；该回合有拦截事件才渲染。
     * ask 形态带四键（立即压缩/拒绝压缩/三回合内不再询问/不再询问）；blocked
     * 形态带「立即压缩」；忙碌/失败回落 → queued 形态（已批准下一检查点，无按钮）。
     */
    function RefusePromptBar(props) {
      var t = props && typeof props.t === 'function' ? props.t : function (key) { return key }
      var sessionId = props && props.sessionId
      var turnLocation = props && props.turn
      var turn = turnLocation && typeof turnLocation.turn === 'number' ? turnLocation.turn : undefined
      var stateRef = React.useState(undefined)
      var state = stateRef[0]
      var setState = stateRef[1]
      var noteRef = React.useState('')
      var note = noteRef[0]
      var setNote = noteRef[1]
      var pollRef = React.useRef(null)
      React.useEffect(function () {
        if (sessionId === undefined || turn === undefined) return undefined
        var disposed = false
        var timer = undefined
        var poll = function () {
          try {
            var url = '/refuse-compaction/state.json?sessionId=' + encodeURIComponent(String(sessionId)) + '&turn=' + encodeURIComponent(String(turn))
            fetch(url)
              .then(function (res) { return res.ok ? res.json() : null })
              .then(function (data) {
                if (disposed) return
                if (!data || typeof data !== 'object' || data.promptBar === false) {
                  setState(function (current) { return current === undefined ? current : undefined })
                  return
                }
                if (!data.event || data.eventTurn !== turn) {
                  setState(function (current) { return current === undefined ? current : undefined })
                  return
                }
                setState(data)
                if (timer === undefined) timer = setInterval(poll, 3000)
              })
              .catch(function () {
                // 网络失败：保持现状，下个定时器再试
              })
          } catch (error) {
            // 装饰性功能，失败静默
          }
        }
        pollRef.current = poll
        poll()
        return function () {
          disposed = true
          pollRef.current = null
          if (timer !== undefined) clearInterval(timer)
        }
      }, [sessionId, turn])
      if (state === undefined || !state.event || state.eventTurn !== turn || state.promptBar === false) return null
      var act = function (path, extra, optimistic) {
        try {
          fetch('/refuse-compaction/' + path + '?sessionId=' + encodeURIComponent(String(sessionId)) + (extra ? '&' + extra : ''), { method: 'POST' })
            .then(function (res) { return res.ok ? res.json() : null })
            .then(function (data) {
              if (!data) return
              // 忙碌回落（v0.2.7）：queued = 批准已落到下一检查点，不再提示 busy；
              // 非手动档（批准无处落地）维持 barBusy 提示。
              if (path === 'compact-now' && data.busy === true && data.queued !== true) setNote(t('barBusy'))
              else setNote('')
              // 乐观更新：POST 链路有延迟，立即翻到预期形态，轮询确认真实值
              if (typeof optimistic === 'function') {
                setState(function (current) { return current ? optimistic(current, data) : current })
              }
              if (typeof pollRef.current === 'function') pollRef.current()
            })
            .catch(function () {
              // 装饰性功能，失败静默
            })
        } catch (error) {
          // 装饰性功能，失败静默
        }
      }
      var canAllow = state.phase === 'ask'
      var canCompact = state.phase === 'ask' || state.phase === 'blocked' || state.phase === 'released'
      var children = [h('div', { key: 'text' }, barText(state, t))]
      // 拦截计数（v0.2.7）：manual-repeat 静默拦截的可见化——ask 计 1，
      // ≥2 才显示（单独的 1 就是这条询问本身，不必复述）。
      if (typeof state.repeatCount === 'number' && state.repeatCount >= 2) {
        children.push(h('div', { key: 'repeat', style: hintStyle }, String(t('barRepeat')).replace('{n}', String(state.repeatCount))))
      }
      if (canAllow || canCompact) {
        var buttons = []
        if (canCompact) {
          buttons.push(h('button', {
            key: 'compact',
            type: 'button',
            style: btnStyle,
            onClick: function () {
              act('compact-now', undefined, function (current, data) {
                if (data && data.ok === true) return Object.assign({}, current, { phase: 'compacted' })
                // 忙碌/失败回落：批准已落到下一检查点（手动档）
                if (data && data.queued === true) return Object.assign({}, current, { phase: 'queued' })
                return current
              })
            },
          }, t('barCompactBtn')))
        }
        if (canAllow) {
          buttons.push(h('button', {
            key: 'refuse',
            type: 'button',
            style: btnStyle,
            onClick: function () {
              act('refuse', undefined, function (current) {
                return Object.assign({}, current, { phase: 'refused' })
              })
            },
          }, t('barRefuseBtn')))
          buttons.push(h('button', {
            key: 'quiet3',
            type: 'button',
            style: btnStyle,
            onClick: function () {
              act('quiet', 'mode=temporary&turn=' + encodeURIComponent(String(turn)), function (current, data) {
                return Object.assign({}, current, {
                  phase: 'blocked',
                  event: Object.assign({}, current.event ?? {}, { why: 'temporary', expiresAtTurn: data ? data.expiresAtTurn : undefined }),
                })
              })
            },
          }, t('barQuiet3Btn')))
          buttons.push(h('button', {
            key: 'quiet-forever',
            type: 'button',
            style: btnStyle,
            onClick: function () {
              act('quiet', 'mode=forbid', function (current) {
                return Object.assign({}, current, {
                  phase: 'blocked',
                  event: Object.assign({}, current.event ?? {}, { why: 'forbid' }),
                })
              })
            },
          }, t('barQuietForeverBtn')))
        }
        children.push(h('div', { key: 'btns', style: btnRowStyle }, buttons))
      }
      if (note !== '') children.push(h('div', { key: 'note', style: hintStyle }, note))
      var calm = state.phase === 'allowed' || state.phase === 'refused' || state.phase === 'compacted' || state.phase === 'queued' || state.phase === 'released'
      var style = calm
        ? Object.assign({}, barBaseStyle, {
          border: '1px solid rgba(128,128,128,0.3)',
          borderLeft: '3px solid rgba(128,128,128,0.4)',
          background: 'rgba(128,128,128,0.06)',
        })
        : barBaseStyle
      return h('div', {
        className: 'refuse-compaction-prompt-bar' + (state.phase === 'ask' ? ' ask' : ''),
        style: style,
      }, children)
    }

    /* ------------------------------------------------------------------ */
    /* F1 占用仪表 + F3 动画：距压缩点不足 revealAhead 时亮出的 turnTail 条    */
    /* ------------------------------------------------------------------ */

    var gaugeBaseStyle = {
      margin: '2px 0',
      padding: '6px 12px',
      fontSize: '12px',
      lineHeight: 1.6,
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '10px',
      borderRadius: '6px',
      border: '1px solid rgba(110,150,235,0.4)',
      background: 'rgba(110,150,235,0.07)',
    }
    var tierBtnStyle = {
      padding: '2px 10px',
      fontSize: '12px',
      cursor: 'pointer',
      borderRadius: '999px',
      border: '1px solid rgba(128,128,128,0.4)',
      background: 'transparent',
      color: 'inherit',
      fontWeight: 600,
    }
    var RING_RADIUS = 11
    var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

    /** token 数缩写（纯函数，测试直用）：1234 → 1.2k，262144 → 262k。 */
    function formatTokens(n) {
      if (!Number.isFinite(n)) return '—'
      if (n < 1000) return String(Math.round(n))
      return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k'
    }

    /** 仪表可见性（纯函数，测试直用）：占用距压缩点不足 revealAhead → true。 */
    function gaugeVisible(data, revealAhead) {
      if (!data || typeof data !== 'object') return false
      var occ = data.occupancy
      var eff = data.effectiveRatio
      var tokens = data.occupancyTokens
      var point = data.compactionPoint
      if (typeof occ !== 'number' || !Number.isFinite(occ)) return false
      if (typeof eff !== 'number' || !Number.isFinite(eff) || eff <= 0) return false
      if (typeof tokens !== 'number' || typeof point !== 'number' || point <= 0) return false
      var ahead = Number.isFinite(revealAhead) ? Math.min(Math.max(revealAhead, 0), 1) : 0.2
      return occ >= eff * (1 - ahead)
    }

    /**
     * 仪表主文本（纯函数，测试直用）：X% = 当前上下文 / 压缩点（越过钳 100%），
     * 括号内同口径"已用 / 压缩点"——与环形进度一致。总窗口占比交给 dsh 自带的
     * ContextMeter，不重复强调（0.2.9：原"已用 / 窗口"口径误导，压缩点由本插件
     * 按 compaction-policy 生效策略现算）。
     */
    function gaugeText(data, t) {
      var used = data && typeof data.occupancyTokens === 'number' && Number.isFinite(data.occupancyTokens)
        ? data.occupancyTokens : 0
      var point = data && typeof data.compactionPoint === 'number' && Number.isFinite(data.compactionPoint) && data.compactionPoint > 0
        ? data.compactionPoint : 0
      var pct = point > 0 ? Math.min(100, Math.round((used / point) * 100)) : 0
      return pct + '%（' + formatTokens(used) + ' / ' + formatTokens(point) + ' ' + t('gaugePoint') + '）'
    }

    /** F3 动画样式（页面侧一次性注入；测试环境无 document 时跳过）。 */
    function ensureGaugeStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('refuse-compaction-style')) return
      var style = document.createElement('style')
      style.id = 'refuse-compaction-style'
      style.textContent = ''
        + '.refuse-compaction-prompt-bar, .refuse-compaction-gauge { animation: refuseBarIn 0.3s ease-out; }'
        + '@keyframes refuseBarIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }'
        + '.refuse-compaction-prompt-bar.ask { animation: refuseBarIn 0.3s ease-out, refuseAskPulse 1.8s ease-in-out 0.3s infinite; }'
        + '@keyframes refuseAskPulse {'
        + '  0%, 100% { border-color: rgba(255,140,90,0.45); box-shadow: none; }'
        + '  50% { border-color: rgba(255,140,90,0.95); box-shadow: 0 0 0 3px rgba(255,140,90,0.14); }'
        + '}'
        + '.refuse-compaction-gauge circle.fg { transition: stroke-dashoffset 0.6s ease, stroke 0.6s ease; }'
        + '.refuse-compaction-gauge.near { animation: refuseBarIn 0.3s ease-out, refuseNearPulse 1.8s ease-in-out 0.3s infinite; }'
        + '@keyframes refuseNearPulse {'
        + '  0%, 100% { border-color: rgba(110,150,235,0.4); box-shadow: none; }'
        + '  50% { border-color: rgba(255,150,80,0.9); box-shadow: 0 0 0 3px rgba(255,150,80,0.13); }'
        + '}'
        + '.refuse-compaction-gauge button { transition: background 0.25s ease, color 0.25s ease, border-color 0.25s ease; }'
      document.head.appendChild(style)
    }

    /**
     * F1 占用仪表：按 (sessionId, turn) 轮询宿主压力快照；只在"活尾回合"
     * （data.currentTurn === turn）持续轮询与展示，老回合尾巴单次探查后静默。
     * 距压缩点不足 revealAhead（设置项，默认 0.2）才渲染：环形进度（F3 过渡）
     * + "百分比（token 数）+ 距压缩点" + 四档快切（写设置表单，全局档生效）。
     */
    function RefuseGauge(props) {
      var t = props && typeof props.t === 'function' ? props.t : function (key) { return key }
      var sessionId = props && props.sessionId
      var form = props && props.form
      var turnLocation = props && props.turn
      var turn = turnLocation && typeof turnLocation.turn === 'number' ? turnLocation.turn : undefined
      var stateRef = React.useState(undefined)
      var state = stateRef[0]
      var setState = stateRef[1]
      var pollRef = React.useRef(null)
      /** 档位乐观更新的保护窗：{ value, at }——写入链落地前轮询带回的旧档位不覆盖高亮。 */
      var pendingTierRef = React.useRef(null)
      React.useEffect(function () {
        if (sessionId === undefined || turn === undefined) return undefined
        var disposed = false
        var timer
        var poll = function () {
          try {
            var url = '/refuse-compaction/state.json?sessionId=' + encodeURIComponent(String(sessionId)) + '&turn=' + encodeURIComponent(String(turn))
            fetch(url)
              .then(function (res) { return res.ok ? res.json() : null })
              .then(function (data) {
                if (disposed || !data || typeof data !== 'object') return
                // turnTail 在回合结束后才渲染，此刻宿主 currentTurn 已推进到
                // turn+1（turn-stopping 写 turn+1）——"活尾回合" = 本条目回合号
                // 恰是最近完成的回合。失配 = 老尾巴：停轮询并隐藏（仪表随最新
                // 回合尾"移动"）。
                if (data.currentTurn !== turn + 1) {
                  if (timer !== undefined) {
                    clearInterval(timer)
                    timer = undefined
                  }
                  setState(function (current) { return current === undefined ? current : undefined })
                  return
                }
                // 乐观保护窗：点击档位后 2.5s 内，轮询若带回旧档位（写入链
                // form→loader→volatile 与 clear-override 尚未落地）以点击值为准
                // （生效档 tier 与全局档 globalTier 一起保护）；确认或超时即解除。
                var pending = pendingTierRef.current
                if (pending !== null) {
                  if (data.tier === pending.value && data.globalTier === pending.value) pendingTierRef.current = null
                  else if (Date.now() - pending.at > 2500) pendingTierRef.current = null
                  else data = Object.assign({}, data, { tier: pending.value, globalTier: pending.value })
                }
                setState(data)
                if (timer === undefined) timer = setInterval(poll, 3000)
              })
              .catch(function () {
                // 装饰性功能，失败静默
              })
          } catch (error) {
            // 装饰性功能，失败静默
          }
        }
        pollRef.current = poll
        poll()
        return function () {
          disposed = true
          pollRef.current = null
          if (timer !== undefined) clearInterval(timer)
        }
      }, [sessionId, turn])
      if (state === undefined) return null
      var snap = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
      var snapValue = snap && typeof snap.value === 'object' && snap.value !== undefined ? snap.value : {}
      var revealAhead = Number(snapValue.revealAhead)
      if (!gaugeVisible(state, revealAhead)) return null
      var progress = Math.min(Math.max(state.occupancyTokens / state.compactionPoint, 0), 1)
      var near = progress >= 0.85
      // 距压缩点（用户要求保留原样，直观）：越过压缩点后钳 0
      var remaining = Math.max(0, state.compactionPoint - state.occupancyTokens)
      var writable = snap && snap.writable === true
      // 高亮**会话生效档**（payload.tier = peekTier）：quiet 按钮写的会话覆盖
      // （临时/禁止）立即反映在仪表上，与询问条口径一致；覆盖生效时按钮加虚线
      // 边框 + 悬停说明，点击任意档位 = 写全局档 + 清覆盖。
      var activeTier = String(state.tier ?? state.globalTier ?? 'off')
      var overridden = state.tier !== undefined && state.globalTier !== undefined && state.tier !== state.globalTier
      var tiers = [
        { value: 'off', label: t('tierShortOff') },
        { value: 'temporary', label: t('tierShortTemporary') },
        { value: 'manual', label: t('tierShortManual') },
        { value: 'forbid', label: t('tierShortForbid') },
      ]
      var ringChildren = [
        h('circle', { key: 'bg', cx: 14, cy: 14, r: RING_RADIUS, fill: 'none', stroke: 'rgba(128,128,128,0.25)', strokeWidth: 3 }),
        h('circle', {
          key: 'fg',
          className: 'fg',
          cx: 14,
          cy: 14,
          r: RING_RADIUS,
          fill: 'none',
          stroke: near ? 'rgba(255,150,80,0.9)' : 'rgba(110,150,235,0.9)',
          strokeWidth: 3,
          strokeLinecap: 'round',
          strokeDasharray: RING_CIRCUMFERENCE,
          strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress),
          transform: 'rotate(-90 14 14)',
        }),
      ]
      var children = [
        h('svg', {
          key: 'ring',
          width: 28,
          height: 28,
          viewBox: '0 0 28 28',
          'aria-hidden': 'true',
          style: { flexShrink: 0 },
        }, ringChildren),
        h('div', {
          key: 'text',
          style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
        }, [
          h('div', { key: 'main' }, gaugeText(state, t)),
          h('div', { key: 'sub', style: { opacity: 0.7 } }, t('gaugeToCompaction') + ' ' + formatTokens(remaining) + ' tokens'),
        ]),
        h('div', {
          key: 'tiers',
          style: { display: 'flex', gap: '6px', alignItems: 'center', marginLeft: 'auto' },
        }, [h('span', { key: 'label', style: { opacity: 0.7 } }, t('gaugeTierPrompt'))].concat(tiers.map(function (tier) {
          var active = tier.value === activeTier
          return h('button', {
            key: tier.value,
            type: 'button',
            disabled: writable !== true,
            title: active && overridden ? t('gaugeSessionOverride') : undefined,
            style: Object.assign({}, tierBtnStyle, active ? {
              background: 'rgba(110,150,235,0.22)',
              borderColor: 'rgba(110,150,235,0.65)',
            } : {}, active && overridden ? { borderStyle: 'dashed' } : {}),
            onClick: function () {
              try {
                if (writable && tier.value !== activeTier && form && typeof form.set === 'function') {
                  void form.set('tier', tier.value)
                  // 会话覆盖生效中：点击档位还要清掉本会话覆盖，否则覆盖继续压着
                  // 生效档，点击"看不出效果"（全局档没变时 syncGlobalTier 不清覆盖）
                  if (overridden) {
                    void fetch('/refuse-compaction/clear-override?sessionId=' + encodeURIComponent(String(sessionId)), { method: 'POST' }).catch(function () {})
                  }
                  // 乐观更新 + 保护窗：立即翻按钮高亮（生效档与全局档一起翻）；
                  // 不要立即重轮询——写入链落地前轮询带回的旧档位会把高亮打回去
                  //（0.2.4 卡手根因）
                  pendingTierRef.current = { value: tier.value, at: Date.now() }
                  setState(function (current) {
                    return current ? Object.assign({}, current, { tier: tier.value, globalTier: tier.value }) : current
                  })
                }
              } catch (error) {
                // 装饰性功能，失败静默
              }
            },
          }, tier.label)
        }))),
      ]
      return h('div', {
        className: 'refuse-compaction-gauge' + (near ? ' near' : ''),
        style: gaugeBaseStyle,
      }, children)
    }

    function Section(props) {
      var form = props && props.form
      var t = props && props.t ? props.t : function (key) { return key }

      // Re-render when the language changes; registration bumps the locale
      // revision and `t` reads the active locale at call time.
      var localeFace = props && props.localeFace
      var bump = React.useState(0)
      var setBump = bump[1]
      React.useEffect(
        function () {
          if (!localeFace || typeof localeFace.subscribe !== 'function') return undefined
          return localeFace.subscribe(function () {
            setBump(function (n) { return n + 1 })
          })
        },
        [localeFace],
      )

      var state = React.useState(function () {
        return form ? form.getSnapshot() : undefined
      })
      var snapshot = state[0]
      var setSnapshot = state[1]
      React.useEffect(
        function () {
          if (!form) return undefined
          setSnapshot(form.getSnapshot())
          return form.subscribe(function () {
            setSnapshot(form.getSnapshot())
          })
        },
        [form],
      )

      if (!form || !snapshot) return h('div', { style: hintStyle }, t('noService'))
      if (snapshot.status === 'loading') return h('div', { style: hintStyle }, t('loading'))
      if (snapshot.status === 'unavailable' || snapshot.value === undefined) {
        return h('div', { style: hintStyle }, t('unavailable'))
      }

      var value = snapshot.value
      var user = snapshot.user && typeof snapshot.user === 'object' ? snapshot.user : {}
      var writable = snapshot.writable === true
      var overridden = function (fieldId) {
        return Object.prototype.hasOwnProperty.call(user, fieldId)
      }
      var field = function (id, extra) {
        return Object.assign(
          {
            resetLabel: t('reset'),
            resetTitle: t('resetTitle'),
            disabled: !writable,
            overridden: overridden(id),
            onCommit: function (next) {
              if (!writable) return
              void form.set(id, next)
            },
            onReset: function () {
              if (!writable) return
              void form.unset(id)
            },
          },
          extra,
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: hintStyle }, t('intro1'), h('br'), h('br'), t('intro2')),
        h(Field, field('tier', {
          label: t('tierLabel'),
          description: t('tierDesc'),
          type: 'select',
          value: value.tier ?? 'off',
          options: [
            { value: 'off', label: t('tierOff') },
            { value: 'temporary', label: t('tierTemporary') },
            { value: 'manual', label: t('tierManual') },
            { value: 'forbid', label: t('tierForbid') },
          ],
        })),
        h(Field, field('spareOverflow', {
          label: t('spareOverflowLabel'),
          description: t('spareOverflowDesc'),
          type: 'switch',
          onLabel: t('tierForbid'),
          offLabel: t('tierOff'),
          value: value.spareOverflow === true,
        })),
        h(Field, field('promptBar', {
          label: t('promptBarLabel'),
          description: t('promptBarDesc'),
          type: 'switch',
          onLabel: t('whyManual'),
          offLabel: t('tierOff'),
          value: value.promptBar !== false,
        })),
        h(Field, field('revealAhead', {
          label: t('revealAheadLabel'),
          description: t('revealAheadDesc'),
          type: 'number',
          step: 0.01,
          min: 0.02,
          max: 0.95,
          value: value.revealAhead,
        })),
        writable ? null : h('div', { style: hintStyle }, t('readOnly')),
      )
    }

    function apply(ctx) {
      var locale = ctx.locale
      var t = locale && typeof locale.bind === 'function' ? locale.bind(NS) : function (key) { return key }

      // F1 仪表需要设置表单（revealAhead 读取 + 档位快切写入）；宿主未挂载时
      // 表单快照 status=unavailable，仪表自然不渲染。提前捕获供槽位闭包使用。
      var gaugeForm = null
      try {
        if (ctx.configForms && typeof ctx.configForms.get === 'function') gaugeForm = ctx.configForms.get(NS)
      } catch (error) {
        gaugeForm = null
      }

      // 对话内提示条 + F1 占用仪表：向 conversation.chat.turnTail 列表槽注册两条
      // 扩展项（每条 entry 收到 owner {turn, seq, openFile} + session 作用域注入
      // 的 sessionId）。按 (sessionId, turn) 轮询宿主状态查询，无内容返回 null。
      try {
        ensureGaugeStyle()
        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'refuse-compaction-prompt',
            locale: NS,
            inject: function (sessionId) { return { sessionId: sessionId } },
          }, RefusePromptBar)
        })
        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'refuse-compaction-gauge',
            locale: NS,
            inject: function (sessionId) { return { sessionId: sessionId, form: gaugeForm } },
          }, RefuseGauge)
        })
      } catch (error) {
        // 装饰性功能，失败静默
      }

      // Register one locale at a time: the multi-locale form requires every
      // built-in locale to be present, while the single-locale form is the
      // documented path for namespaces outside DSH's merged table. A locale the
      // runtime does not know is skipped rather than fatal — English still shows.
      if (locale && typeof locale.register === 'function') {
        ctx.effect(
          function () {
            var disposers = []
            for (var id of ['en', 'zh']) {
              try {
                disposers.push(locale.register(NS, id, MESSAGES[id]))
              } catch (error) {
                // keep the remaining locales; the fallback chain covers the gap
              }
            }
            return function () {
              for (var dispose of disposers) {
                try {
                  dispose()
                } catch (error) {
                  // disposers are idempotent; ignore
                }
              }
            }
          },
          'refuse-compaction: dictionaries',
        )
      }

      var forms = ctx.configForms
      if (!forms || typeof forms.get !== 'function') return
      var form = forms.get(NS)
      var register = function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: NS,
              order: 57,
              label: function () {
                return t('sectionLabel')
              },
              locale: NS,
              inject: function () {
                return { form: form, t: t, localeFace: locale }
              },
            },
            Section,
          )
        })
      }
      if (typeof forms.whileServed !== 'function') {
        ctx.effect(register, 'refuse-compaction: settings section')
        return
      }
      ctx.effect(
        function () {
          return forms.whileServed([NS], register)
        },
        'refuse-compaction: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.MESSAGES = MESSAGES
    exports.barText = barText
    exports.whyLabel = whyLabel
    exports.gaugeVisible = gaugeVisible
    exports.gaugeText = gaugeText
    exports.formatTokens = formatTokens
    exports.normalizeNumberInput = normalizeNumberInput
    exports.RefusePromptBar = RefusePromptBar
    exports.RefuseGauge = RefuseGauge
    return module.exports
  },
})
