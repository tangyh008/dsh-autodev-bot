/**
 * 回归测试：DevBot 工作台的会话 attach 语义。
 *
 * 背景 bug：页面滑动时偶尔「闪一下，然后自动滚到底部」。
 * 根因之一：controller.attach() 每次都先 detach() 再重新 retain 全部成员会话；
 * release 到 0 会让 Session Controller drop 掉 Session，重新 retain 必须重新 open，
 * open 完成前 eventSource 是空窗口——时间线先渲染成空态（闪一下），滚动位置被浏览器
 * 夹到 0，随后内容恢复时被当成「用户回到底部」而自动滚到底。
 * 另外 scheduleRetry() 在 bindings 尚未 settle 时（必然如此）也总被排上，于是每 2s
 * 重挂一次，形成扫射式闪烁。
 *
 * 这里用 fake sessions 复刻 DSH 的 retain/release/drop 语义，锁住修复后的行为：
 *  - 首次 attach 后不再无谓重试；
 *  - 成员 phase 变化不重挂会话；
 *  - 成员增删只 retain/release 变化的那一个；
 *  - open 失败的重试也只补失败成员；
 *  - 换团队才整体释放旧团队。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTestController, listSnapshot, loadClient, teamFor, tick } from './helpers.mjs'

const { internals } = loadClient()

function teamOf(members) {
  return teamFor('S-lead', members)
}

function mountTeam(members) {
  const { controller, fake } = createTestController(internals)
  fake.list.set(listSnapshot([{ leadId: 'S-lead', team: teamOf(members) }]))
  controller.startWatching()
  controller.actions.setActive(true)
  fake.settleAll()
  return { controller, fake }
}

test('首次 attach 之后不再自我重试重挂（旧实现每 2s 闪一次）', async () => {
  const { controller, fake } = mountTeam([{ id: 'S-pm', name: 'pm' }])
  await tick()

  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm'], '首次 attach 只 retain lead + 成员各一次')
  assert.deepEqual(fake.calls.release, [], '首次 attach 不应释放任何引用')
  assert.equal(controller._state.retryTimer, null, 'bindings 会在 settle 回调里就绪，不需要 scheduleRetry')

  // 多等一会：旧实现这里会在 2s 后再次 attach 并把所有会话 drop 重开。
  await tick(80)
  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm'])
  assert.deepEqual(fake.calls.release, [])
  assert.equal(controller._state.handles.length, 2)

  controller.dispose()
  assert.deepEqual(fake.calls.release, ['S-lead', 'S-pm'], 'dispose 时整体释放')
})

test('成员 phase 变化不重新挂载会话（只是展示信息）', async () => {
  const { controller, fake } = mountTeam([{ id: 'S-pm', name: 'pm' }])
  await tick()

  fake.list.set(listSnapshot([{ leadId: 'S-lead', team: teamOf([{ id: 'S-pm', name: 'pm', phase: 'failed' }]) }]))
  await tick()

  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm'], 'phase 变化不应产生新的 retain')
  assert.deepEqual(fake.calls.release, [], 'phase 变化不应释放会话')
  controller.dispose()
})

test('新成员加入只 retain 新成员，已有会话不断开', async () => {
  const { controller, fake } = mountTeam([{ id: 'S-pm', name: 'pm' }])
  await tick()

  fake.list.set(listSnapshot([{
    leadId: 'S-lead',
    team: teamOf([{ id: 'S-pm', name: 'pm' }, { id: 'S-designer', name: 'designer' }]),
  }]))
  fake.settleAll()
  await tick()

  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm', 'S-designer'], '只在末尾补 retain 新成员')
  assert.deepEqual(fake.calls.release, [], '已有 lead/pm 会话必须保持')
  assert.equal(controller._state.handles.length, 3)

  // 再等一拍，确认没有把老成员重挂一遍（旧实现 retain 会变成 5 次）
  await tick(60)
  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm', 'S-designer'])
  controller.dispose()
})

test('成员移除只释放该成员', async () => {
  const { controller, fake } = mountTeam([{ id: 'S-pm', name: 'pm' }, { id: 'S-designer', name: 'designer' }])
  await tick()

  fake.list.set(listSnapshot([{ leadId: 'S-lead', team: teamOf([{ id: 'S-pm', name: 'pm' }]) }]))
  await tick()

  assert.deepEqual(fake.calls.release, ['S-designer'], '只释放离开团队的成员')
  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm', 'S-designer'], '不应重新 retain 留下的成员')
  assert.equal(controller._state.handles.length, 2)
  controller.dispose()
})

test('换团队才整体释放旧团队并挂新团队', async () => {
  const { controller, fake } = mountTeam([{ id: 'S-pm', name: 'pm' }])
  await tick()

  fake.list.set(listSnapshot([
    { leadId: 'S-lead', team: teamOf([{ id: 'S-pm', name: 'pm' }]) },
    { leadId: 'S-lead2', team: teamFor('S-lead2', [{ id: 'S-pm2', name: 'pm2' }]), updatedAt: 900 },
  ]))
  await tick()
  controller.actions.selectTeam('S-lead2')
  fake.settleAll()
  await tick()

  assert.deepEqual(fake.calls.release, ['S-lead', 'S-pm'], '换团队释放旧团队全部引用')
  assert.deepEqual(fake.calls.retain, ['S-lead', 'S-pm', 'S-lead2', 'S-pm2'], '新团队重新 retain')
  controller.dispose()
})

test('open 失败只补失败成员，不重挂其它正常会话', async () => {
  const { controller, fake } = createTestController(internals)
  fake.list.set(listSnapshot([{ leadId: 'S-lead', team: teamOf([{ id: 'S-pm', name: 'pm' }]) }]))
  controller.startWatching()
  controller.actions.setActive(true)
  fake.settle('S-lead') // lead 正常打开
  fake.reject('S-pm') // pm 打开失败
  await tick()

  assert.equal(fake.calls.retain.length, 2)
  assert.equal(controller._state.retryTimer !== null, true, '失败成员应安排一次补拉')

  // 等一次重试（scheduleRetry 固定 2s）
  await tick(2200)

  assert.equal(fake.calls.retain.filter((sid) => sid === 'S-pm').length, 2, 'pm 被重试一次')
  assert.equal(fake.calls.retain.filter((sid) => sid === 'S-lead').length, 1, 'lead 不应被重新 retain')
  assert.deepEqual(fake.calls.release, ['S-pm'], '只释放失败成员的引用，lead 不动')
  controller.dispose()
})
