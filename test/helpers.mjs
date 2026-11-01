/**
 * 在 Node 里加载浏览器 half 的 client.js，并造一个假的 sessions 服务。
 *
 * client.js 是纯 loader 文件（顶层只有 window.__ModuleLoader__.load），factory
 * 顶部只取 React 的 createElement/useState/useEffect/useRef；createController 与
 * 滚动判定都是纯逻辑，因此不需要 DOM/React 运行时就能测。
 *
 * fake sessions 复刻 DSH Session Controller 的关键语义：
 *  - retain() 返回一个待 resolve 的引用（open 完成前 eventSource 是空窗口）；
 *  - release() 到 0 → drop 掉这代 Session，再 retain 必须重新 open（换新 generation）。
 * 这正是「重挂会话 → 空一帧 → 闪一下」的温床，测试据此断言插件不再无谓重挂。
 */
import { readFileSync } from 'node:fs'

// 默认测仓库里的 client.js；DEVBOT_CLIENT 可指向任意副本（用于红/绿对照）。
const CLIENT_PATH = process.env.DEVBOT_CLIENT || new URL('../client.js', import.meta.url)

/** @returns {{ plugin: any, internals: any, moduleId: string }} */
export function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let recorded
  const fakeWindow = { __ModuleLoader__: { load: (mod) => { recorded = mod } } }
  // client.js 顶层只依赖 window.__ModuleLoader__；factory 里才取 React。
  new Function('window', source)(fakeWindow)
  if (!recorded || typeof recorded.factory !== 'function') {
    throw new Error('client.js 没有通过 __ModuleLoader__.load 注册模块')
  }
  const reactStub = { createElement() { return {} }, useState() {}, useEffect() {}, useRef() {} }
  const plugin = recorded.factory(() => reactStub)
  return { plugin, internals: plugin._internals, moduleId: recorded.id }
}

/**
 * @param {any} internals - loadClient().internals（需要 createStore）
 */
export function createFakeSessions(internals) {
  const list = internals.createStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  const calls = { retain: [], release: [], address: [] }
  const generations = new Map()
  const pending = []

  function makeGeneration(sid) {
    const rec = { sid, refs: 0, dropped: false }
    rec.binding = {
      sessionId: sid,
      session: {
        getSnapshot: () => ({
          sessionId: sid, openState: 'open', openError: null, running: false, hasMore: false,
        }),
        subscribe: () => () => {},
        loadOlder: () => Promise.resolve(),
      },
      eventSource: {
        getSnapshot: () => ({ entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }),
        subscribe: () => () => {},
      },
    }
    return rec
  }

  const sessions = {
    list,
    subagentAddress(id) {
      calls.address.push(id)
      return { parentSessionId: 'S-lead', childSessionId: id, mode: 'subagent' }
    },
    retain(target) {
      const sid = typeof target === 'string' ? target : target.childSessionId
      calls.retain.push(sid)
      let rec = generations.get(sid)
      if (!rec || rec.dropped) {
        rec = makeGeneration(sid)
        generations.set(sid, rec)
      }
      rec.refs += 1
      let resolveReady
      let rejectReady
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      ready.catch(() => {}) // 插件可能先 detach 再处理；别让 Node 报 unhandled rejection
      pending.push({ sid, binding: rec.binding, resolve: resolveReady, reject: rejectReady })
      let released = false
      return {
        ready,
        release() {
          if (released) return
          released = true
          calls.release.push(sid)
          rec.refs -= 1
          if (rec.refs <= 0) {
            rec.dropped = true
            generations.delete(sid)
          }
        },
      }
    },
    refresh: () => Promise.resolve(),
  }

  return {
    sessions,
    list,
    calls,
    generations,
    /** resolve 所有等待中的 retain ready（模拟 open 完成）。 */
    settleAll() {
      const waiting = pending.splice(0)
      for (const item of waiting) item.resolve(item.binding)
    },
    /** resolve 某个 session 的 retain ready。 */
    settle(sid) {
      const index = pending.findIndex((item) => item.sid === sid)
      if (index < 0) return
      const [item] = pending.splice(index, 1)
      item.resolve(item.binding)
    },
    /** reject 某个 session 的 retain ready（模拟 open 失败）。 */
    reject(sid, reason = new Error('open failed')) {
      const index = pending.findIndex((item) => item.sid === sid)
      if (index < 0) return
      const [item] = pending.splice(index, 1)
      item.reject(reason)
    },
  }
}

/**
 * 一个带 lead + members 的团队投影（readTeams 的判据：members>1 或 tasks 非空）。
 * @param {string} leadId
 * @param {Array<{id: string, name?: string, phase?: string}>} members
 */
export function teamFor(leadId, members) {
  return {
    members: [{ id: leadId, name: 'lead', role: 'lead', phase: 'active' }].concat(
      members.map((m) => ({ id: m.id, name: m.name || m.id, role: 'member', phase: m.phase || 'active' })),
    ),
    tasks: [],
  }
}

/**
 * 构造 sessions.list 快照，仅包含给定团队。
 * @param {Array<{leadId: string, title?: string, team: any, updatedAt?: number}>} teams
 */
export function listSnapshot(teams) {
  const byId = {}
  const projectionsBySession = {}
  teams.forEach((team, index) => {
    const id = team.leadId
    byId[id] = {
      id,
      displayTitle: team.title || id,
      running: false,
      updatedAt: team.updatedAt || 1000 - index,
      projectionValues: {},
    }
    projectionsBySession[id] = { values: { agentTeam: team.team } }
  })
  return { ids: teams.map((team) => team.leadId), byId, phase: 'ready', projectionsBySession }
}

/** 创建 controller 并接到假 sessions 上。 */
export function createTestController(internals) {
  const fake = createFakeSessions(internals)
  const ctx = {
    effect(fn) { return fn() },
    slots: { inject() {}, register() {} },
    layout: { selectPanel() {} },
    sessions: fake.sessions,
  }
  const controller = internals.createController(ctx)
  return { controller, fake }
}

/** 下一轮 macrotask（等 schedulePublish 的 setTimeout / promise settle 跑完）。 */
export const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
