/**
 * 回归测试：DevBot 工作台时间线的「贴底 / 跟随到底部」判定。
 *
 * 背景 bug：页面滑动时偶尔「闪一下，然后自动滚到底部」。
 * 根因之二：onScroll 无条件用 `scrollHeight - scrollTop - clientHeight < 64` 更新贴底
 * 意图。内容因重载/暂时为空而塌缩时，浏览器会把 scrollTop 夹到 0 并触发 scroll 事件，
 * 此时差值 ≈ 0 → 贴底被误打开；内容恢复后 useEffect 就把 scrollTop 写到底部。
 *
 * 修复后由 nextStick / shouldFollowBottom 两个纯函数判定：
 *  - 内容不可滚动（max <= 0）时保持原来的贴底意图；
 *  - 只有用户本来就贴底且内容可滚动时才跟随到底部。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers.mjs'

const { internals } = loadClient()
const { nextStick, shouldFollowBottom } = internals

test('nextStick：用户上滑后保持不贴底', () => {
  // 6403 = 内容可滚动范围，2241 = 用户滑到的位置
  assert.equal(nextStick(false, 2241, 7130, 727), false)
  assert.equal(nextStick(true, 2241, 7130, 727), false)
})

test('nextStick：滚到底部才贴底', () => {
  assert.equal(nextStick(false, 6403, 7130, 727), true)
  assert.equal(nextStick(true, 6400, 7130, 727), true)
})

test('nextStick：内容塌缩（max<=0）不改变贴底意图 —— 这就是闪一下后滚到底的入口', () => {
  // 时间线从 6000+px 塌成空态卡片（scrollHeight == clientHeight），浏览器把
  // scrollTop 夹到 0 并派发 scroll；旧逻辑在这里返回 true，内容恢复后滚到底。
  assert.equal(nextStick(false, 0, 727, 727), false, '用户上滑时塌缩不能打开贴底')
  assert.equal(nextStick(true, 0, 727, 727), true, '本来贴底的用户塌缩后仍应贴底')
  assert.equal(nextStick(false, 0, 0, 0), false)
})

test('shouldFollowBottom：上滑中内容恢复不应跳到底部', () => {
  assert.equal(shouldFollowBottom(false, 2241, 7130, 727), false)
})

test('shouldFollowBottom：贴底且内容可滚动才跟随', () => {
  assert.equal(shouldFollowBottom(true, 5000, 7130, 727), true)
  assert.equal(shouldFollowBottom(true, 6403, 7130, 727), false, '已在底部无需再写')
})

test('shouldFollowBottom：内容不可滚动时不写 scrollTop', () => {
  assert.equal(shouldFollowBottom(true, 0, 727, 727), false, '空态/短内容不触发滚动写入')
})
