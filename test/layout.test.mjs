/**
 * v0.5 布局/时间线纯函数单测：断点判定、成员头合并、状态条文案、首行摘要。
 * 这些函数只依赖行数据，不读 DOM（PRD §10/§11、AC-03/AC-08/AC-09/AC-13）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers.mjs'

const { internals } = loadClient()
const { breakpointOf, shouldShowMemberHead, statusTextOf, firstLine } = internals

const MIN = 60 * 1000
const base = new Date(2026, 9, 30, 10, 0, 0).getTime()

function msg(senderId, time, extra) {
  return Object.assign({ kind: 'msg', senderId, sessionId: senderId, time }, extra || {})
}

test('breakpointOf：≥900 three / 560–899 two / <560 one', () => {
  assert.equal(breakpointOf(1440), 'three')
  assert.equal(breakpointOf(1280), 'three')
  assert.equal(breakpointOf(900), 'three')
  assert.equal(breakpointOf(899), 'two')
  assert.equal(breakpointOf(768), 'two')
  assert.equal(breakpointOf(560), 'two')
  assert.equal(breakpointOf(559), 'one')
  assert.equal(breakpointOf(430), 'one')
  assert.equal(breakpointOf(375), 'one')
  assert.equal(breakpointOf(Number.NaN), 'one', '非法宽度按最保守的单栏')
})

test('shouldShowMemberHead：首位成员消息显示头', () => {
  assert.equal(shouldShowMemberHead(null, msg('pm', base)), true)
})

test('shouldShowMemberHead：同发送者 5 分钟内不重复头', () => {
  assert.equal(shouldShowMemberHead(msg('pm', base), msg('pm', base + 1 * MIN)), false)
  assert.equal(shouldShowMemberHead(msg('pm', base), msg('pm', base + 5 * MIN)), false)
})

test('shouldShowMemberHead：同发送者间隔 >5 分钟重新显示头', () => {
  assert.equal(shouldShowMemberHead(msg('pm', base), msg('pm', base + 6 * MIN)), true)
})

test('shouldShowMemberHead：换发送者必显示头', () => {
  assert.equal(shouldShowMemberHead(msg('pm', base), msg('designer', base + MIN)), true)
})

test('shouldShowMemberHead：跨日必显示头', () => {
  const nextDay = new Date(2026, 9, 31, 9, 0, 0).getTime()
  assert.equal(shouldShowMemberHead(msg('pm', base), msg('pm', nextDay)), true)
})

test('shouldShowMemberHead：上一条是系统行/用户消息时重新显示头', () => {
  assert.equal(shouldShowMemberHead({ kind: 'sys', time: base }, msg('pm', base + MIN)), true)
  assert.equal(shouldShowMemberHead({ kind: 'msg', human: true, time: base }, msg('pm', base + MIN)), true)
})

test('shouldShowMemberHead：人类消息/系统行自身不显示成员头', () => {
  assert.equal(shouldShowMemberHead(null, { kind: 'msg', human: true, time: base }), false)
  assert.equal(shouldShowMemberHead(null, { kind: 'sys', time: base }), false)
})

test('shouldShowMemberHead：流式行按成员正文参与合并', () => {
  assert.equal(shouldShowMemberHead(msg('pm', base), { kind: 'stream', senderId: 'pm', sessionId: 'pm', time: base + MIN }), false)
  assert.equal(shouldShowMemberHead(msg('pm', base), { kind: 'stream', senderId: 'pm', sessionId: 'pm', time: base + 9 * MIN }), true)
})

test('shouldShowMemberHead：没有 senderId 时回退到 sessionId 区分', () => {
  assert.equal(shouldShowMemberHead(msg(undefined, base, { sessionId: 'S-pm' }), { kind: 'msg', sessionId: 'S-designer', time: base + MIN }), true)
  assert.equal(shouldShowMemberHead(msg(undefined, base, { sessionId: 'S-pm' }), { kind: 'msg', sessionId: 'S-pm', time: base + MIN }), false)
})

test('statusTextOf：三态文案（加载中 / 可上滑 / 已到最早）', () => {
  assert.equal(statusTextOf({ loadingOlder: true, hasMore: true }), '正在加载更早消息…')
  assert.equal(statusTextOf({ loadingOlder: false, hasMore: true }), '上滑加载更早消息')
  assert.equal(statusTextOf({ loadingOlder: false, hasMore: false }), '已到当前会话窗口最早处')
  assert.equal(statusTextOf(null), '')
})

test('firstLine：派单行取首行摘要', () => {
  assert.equal(firstLine('第一行\n第二行'), '第一行')
  assert.equal(firstLine('  单行  '), '单行')
  assert.equal(firstLine(''), '')
  assert.equal(firstLine(null), '')
})
