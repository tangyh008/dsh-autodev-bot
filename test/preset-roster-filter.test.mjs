/**
 * 模式选择器过滤单测（v0.5.3）。
 *
 * 背景：用户只把任务直接派给 Lead，不需要在模式选择器里看到 pm/designer/
 * fullstack/tester 四个队友角色。但四个 preset 必须继续注册在 Host：
 *   - Lead 的 spawn 桥按 devbot_role= 用 id 挂载它们；
 *   - 已存在的队友会话 resume 时按 id 重新组合。
 * 所以只过滤浏览器端 `remote.agentPresets.list` 的 roster 应答：
 * Host 定义 / resolve / spawn 桥 / 旧会话一概不动。
 *
 * 这里用最小 fake ctx 复刻生成式 Remote 客户端的形态：namespace service 的
 * 每个方法都是「自有访问器，读取时返回一个绑定调用方 ctx 的函数」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers.mjs'

const internals = loadClient().internals
const { HIDDEN_ROLE_PRESETS, withoutHiddenRolePresets, installPresetRosterFilter } = internals

/** 一行 roster（只做过滤测试，字段少到够用）。 */
function row(id, name) {
  return { id, name, isDefault: id === 'standard' }
}

const ROSTER = [
  row('standard', '标准模式'),
  row('ptc', 'PTC 模式'),
  row('minimal', '极简模式'),
  row('cordis', '创造模式'),
  row('devbot-lead', 'DevBot Lead'),
  row('devbot-pm', 'DevBot PM'),
  row('devbot-designer', 'DevBot Designer'),
  row('devbot-fullstack', 'DevBot Fullstack'),
  row('devbot-tester', 'DevBot Tester'),
]

/**
 * 复刻 gateway 客户端 namespace service 的方法形态：configurable 自有访问器。
 * @param {() => any} answer - 每次调用返回的 RemoteResult。
 */
function makeNamespaceService(answer) {
  const state = { reads: 0 }
  const service = {}
  Object.defineProperty(service, 'list', {
    configurable: true,
    enumerable: true,
    get() {
      state.reads += 1;
      return async () => answer();
    },
  })
  return { service, state }
}

/**
 * 最小 cordis 上下文：inject 立即用满足依赖的 child 调 callback，effect 立即建 disposer。
 * @param {object} service - fake remote.agentPresets service。
 */
function makeCtx(service) {
  const cleanups = []
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['remote.agentPresets'])
      const child = {
        get: () => service,
        effect(factory) {
          const dispose = factory()
          if (typeof dispose === 'function') cleanups.push(dispose)
          return dispose
        },
      }
      callback(child)
    },
  }
  return { ctx, cleanups }
}

test('只剩 Lead：4 个队友角色从 roster 消失，其它 preset 原序保留', async () => {
  const { service } = makeNamespaceService(() => ({ ok: true, value: { presets: ROSTER } }))
  const { ctx } = makeCtx(service)
  installPresetRosterFilter(ctx)

  const answer = await service.list()
  assert.equal(answer.ok, true)
  assert.deepEqual(
    answer.value.presets.map((entry) => entry.id),
    ['standard', 'ptc', 'minimal', 'cordis', 'devbot-lead'],
  )
  // 未隐藏行的对象身份/字段不变
  assert.deepEqual(answer.value.presets[4], ROSTER[4])
})

test('过滤是幂等的：没有队友角色的 roster 原样返回（同一对象）', async () => {
  const visible = ROSTER.filter((entry) => !HIDDEN_ROLE_PRESETS.includes(entry.id))
  const raw = { ok: true, value: { presets: visible } }
  const { service } = makeNamespaceService(() => raw)
  const { ctx } = makeCtx(service)
  installPresetRosterFilter(ctx)

  assert.equal(await service.list(), raw)
})

test('失败应答与畸形应答原样透传，不被过滤逻辑吞掉', async () => {
  const failures = [
    { ok: false, error: { code: 'gateway/invocation-unavailable', message: 'nope' } },
    { ok: true, value: { presets: [] } },
    { ok: true, value: null },
    { ok: true },
    null,
    undefined,
  ]
  for (const failure of failures) {
    const { service } = makeNamespaceService(() => failure)
    const { ctx } = makeCtx(service)
    installPresetRosterFilter(ctx)
    assert.equal(await service.list(), failure)
  }
})

test('插件卸载/热重载后恢复 Host 原始应答（不把过滤泄漏给下一个模块世代）', async () => {
  const raw = { ok: true, value: { presets: ROSTER } }
  const { service } = makeNamespaceService(() => raw)
  const { ctx, cleanups } = makeCtx(service)
  installPresetRosterFilter(ctx)

  const filtered = await service.list()
  assert.ok(filtered.value.presets.length < ROSTER.length)
  assert.equal(cleanups.length, 1)

  cleanups[0]()
  assert.equal(await service.list(), raw)
})

test('防御式：DSH 若把方法装成普通函数（无自有访问器），放弃过滤且不抛错', () => {
  const original = async () => ({ ok: true, value: { presets: ROSTER } })
  const service = { list: original }
  const { ctx } = makeCtx(service)
  assert.doesNotThrow(() => installPresetRosterFilter(ctx))
  assert.equal(service.list, original)
})

test('防御式：ctx 没有 inject（老宿主/极简测试桩）时静默跳过，不刷错误', () => {
  const originalError = console.error
  const logged = []
  console.error = (...args) => logged.push(args)
  try {
    assert.doesNotThrow(() => installPresetRosterFilter({ get: () => undefined }))
    assert.doesNotThrow(() => installPresetRosterFilter(undefined))
    assert.deepEqual(logged, [])
  } finally {
    console.error = originalError
  }
})

test('防御式：没有 agentPresets namespace 的部署不拖垮插件（inject 抛错也被吞掉）', () => {
  const ctx = {
    inject() { throw new Error('service unavailable') },
  }
  // 该分支会 console.error（插件环境问题值得留痕），测试里静音以免刷屏。
  const originalError = console.error
  console.error = () => {}
  try {
    assert.doesNotThrow(() => installPresetRosterFilter(ctx))
  } finally {
    console.error = originalError
  }
})

test('HIDDEN_ROLE_PRESETS 固定为 4 个队友角色，Lead 不在其中', () => {
  assert.deepEqual(
    [...HIDDEN_ROLE_PRESETS].sort(),
    ['devbot-designer', 'devbot-fullstack', 'devbot-pm', 'devbot-tester'],
  )
  assert.equal(HIDDEN_ROLE_PRESETS.includes('devbot-lead'), false)
})

test('withoutHiddenRolePresets 不修改入参（Host 应答对象保持只读语义）', () => {
  const raw = { ok: true, value: { presets: ROSTER } }
  const filtered = withoutHiddenRolePresets(raw)
  assert.equal(raw.value.presets.length, ROSTER.length)
  assert.notEqual(filtered, raw)
  assert.notEqual(filtered.value, raw.value)
})
