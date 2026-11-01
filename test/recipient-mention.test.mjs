/**
 * 群聊时间线 @收件人 单测。
 *
 * 背景：用户要求「每条消息开头能看到 @目标成员」，但不能靠 persona/提示词让成员
 * 自己写 @。实现改为在渲染层按**消息落在哪个会话**推导收件人（Team 投递、派单、
 * 人类消息都写进收件人自己的会话），因此：
 *  - 投递副本 / 派单 / 用户消息 → target = 会话主人；
 *  - 成员自己的 assistant 旁白没有投递目标 → 不伪造 @；
 *  - 旧会话日志同样能回放出来（不依赖新消息里带标记）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** 用记录型 React stub 加载 client.js，便于断言渲染树。 */
function loadInternals() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let recorded
  const fakeWindow = { __ModuleLoader__: { load: (mod) => { recorded = mod } } }
  new Function('window', source)(fakeWindow)
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState() {},
    useEffect() {},
    useRef() {},
  }
  return recorded.factory(() => react)._internals
}

const internals = loadInternals()
const { mentionOf, buildRow, renderMarkdown, mentionChip } = internals

const LEAD = { id: 'lead-session', name: 'lead', role: 'lead', phase: 'active' }
const PM = { id: 'pm-session', name: 'pm', role: 'member', phase: 'active' }
const TESTER = { id: 'tester-session', name: 'tester2', role: 'member', phase: 'active' }
const memberById = new Map([[LEAD.id, LEAD], [PM.id, PM], [TESTER.id, TESTER]])

const base = new Date(2026, 9, 31, 10, 0, 0).getTime()

function userMessage(sessionId, member, source, text) {
  return {
    type: 'event',
    event: {
      type: 'user/message', time: base, seq: 1,
      data: { source, content: [{ type: 'text', text }] },
    },
  }
}

function assistantMessage(sessionId, text) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message', time: base, seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    },
  }
}

function rowOf(entry, member) {
  return buildRow(entry, {
    sessionId: member.id, member, memberById,
  })
}

test('mentionOf：Lead 用 target 名 lead，成员用 spawn name', () => {
  assert.deepEqual(mentionOf(LEAD), { id: 'lead-session', name: 'lead', role: 'lead' })
  assert.deepEqual(mentionOf(TESTER), { id: 'tester-session', name: 'tester2', role: 'tester' })
  assert.equal(mentionOf(undefined), undefined)
})

test('用户消息：收件人 = 消息所在会话的主人', () => {
  const toLead = rowOf(userMessage(LEAD.id, LEAD, { kind: 'user', rpcId: 'r1' }, '开始吧'), LEAD)
  assert.equal(toLead.human, true)
  assert.equal(toLead.target.name, 'lead')

  const toPm = rowOf(userMessage(PM.id, PM, { kind: 'user', rpcId: 'r2' }, '单独问你'), PM)
  assert.equal(toPm.human, true)
  assert.equal(toPm.target.name, 'pm')
})

test('派单（无 rpcId 的 user/message）：收件人 = 目标成员', () => {
  const dispatch = rowOf(userMessage(PM.id, PM, { kind: 'user' }, '负责 PRD'), PM)
  assert.equal(dispatch.kind, 'task')
  assert.equal(dispatch.name, '派单')
  assert.equal(dispatch.target.name, 'pm')
})

test('Team 投递：收件人 = 收件会话主人，发送者仍按 senderSessionId 解析', () => {
  const toPm = rowOf(userMessage(PM.id, PM, {
    kind: 'agent-message', form: 'relay', senderSessionId: LEAD.id,
  }, 'Team message from lead:\n请出一版 PRD'), PM)
  assert.equal(toPm.msgSource, 'agent-message')
  assert.equal(toPm.name, 'Lead')
  assert.equal(toPm.target.name, 'pm')

  const toLead = rowOf(userMessage(LEAD.id, LEAD, {
    kind: 'agent-message', form: 'relay', senderSessionId: PM.id,
  }, 'Team message from pm:\nPRD 已落盘'), LEAD)
  assert.equal(toLead.name, 'pm')
  assert.equal(toLead.target.name, 'lead')
})

test('成员 assistant 旁白没有投递目标：不伪造 @', () => {
  const assistant = rowOf(assistantMessage(PM.id, '正在写 PRD…'), PM)
  assert.equal(assistant.msgSource, 'assistant')
  assert.equal(assistant.target, undefined)
  assert.equal(mentionChip(assistant.target), null)
})

test('renderMarkdown：@收件人放在第一段开头', () => {
  const chip = mentionChip({ name: 'pm', role: 'pm' })
  const blocks = renderMarkdown('请出一版 PRD\n\n- 需求\n- 排期', chip)
  assert.equal(blocks.length, 2)
  const first = blocks[0]
  assert.equal(first.type, 'p')
  assert.equal(first.children[0], chip)
  assert.equal(chip.props['data-mention'], 'pm')
  assert.match(chip.props.className, /devbot-role-pm/)
})

test('renderMarkdown：首块是标题/代码块时也能看到 @收件人', () => {
  const chip = mentionChip({ name: 'tester2', role: 'tester' })
  const heading = renderMarkdown('## 验收报告\n内容', chip)
  assert.equal(heading[0].type, 'h2')
  assert.equal(heading[0].children[0], chip)

  const code = renderMarkdown('```js\nrun()\n```', mentionChip({ name: 'pm', role: 'pm' }))
  assert.equal(code[0].props.className, 'devbot-at-row')
  assert.equal(code[0].children[0].props['data-mention'], 'pm')
  assert.equal(code[1].props.className, 'devbot-codeblock')
})

test('renderMarkdown：无收件人时不插入任何 chip', () => {
  const blocks = renderMarkdown('普通正文')
  assert.equal(blocks.length, 1)
  const children = blocks[0].children.flat(2).filter((node) => node !== null && node !== undefined)
  assert.deepEqual(children, ['普通正文'])
  assert.equal(children.some((node) => node !== null && typeof node === 'object' && node.props
    && String(node.props.className || '').indexOf('devbot-at') >= 0), false)
})
