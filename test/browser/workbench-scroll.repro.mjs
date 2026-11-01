#!/usr/bin/env node
/**
 * DevBot 工作台「闪一下 + 自动滚到底」的真实浏览器回归器。
 *
 * 这不是单元测试（`npm test` 之外的独立诊断/回归脚本）：无头 Chromium 里加载
 * 真实 client.js 的 DevbotWorkbench 组件 + 复刻 DSH Session Controller 语义的
 * fake sessions，断言「上滑后内容重挂/追加不会把滚动位置弹到底部」。
 *
 * 用 fake ctx.sessions 复刻 DSH Session Controller 的真实语义：
 *  - retain() 打开一个 Session（异步 open，open 完成前 eventSource 是空窗口）；
 *  - release() 到 0 → manager.drop 删掉 Session，下次 retain 必须重新 open
 *    （dsh packages/api/session-controller/src/client/sessions/service.ts:retireScope
 *     → manager.ts:drop）；
 *  - sessions.list 快照变化会触发 controller.syncTeams。
 *
 * 断言用户症状：上滑后内容「闪一下（塌缩成空态）」并「自动滚到底部」。
 *
 * 用法（需要本机有 DSH checkout 的 node_modules 与 Playwright 浏览器）：
 *   node test/browser/workbench-scroll.repro.mjs                 # 测仓库当前 client.js
 *   node test/browser/workbench-scroll.repro.mjs --client <path> # 测指定 client.js（红/绿对照）
 *   node test/browser/workbench-scroll.repro.mjs --json          # 只输出 JSON
 *   DSH_CHECKOUT=/path/to/deepseek-harness node ...              # 非默认 checkout 位置
 *
 * 退出码：0 = 全绿；1 = 复现了 bug。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

// 依赖来自本机 DSH checkout（React 18 UMD + Playwright）。用 DSH_CHECKOUT 覆盖：
//   DSH_CHECKOUT=/path/to/deepseek-harness node test/browser/workbench-scroll.repro.mjs
const DSH = process.env.DSH_CHECKOUT
if (!DSH) {
  console.error('需要 DSH_CHECKOUT 环境变量指向 deepseek-harness checkout（浏览器回归依赖其 node_modules/Playwright）')
  process.exit(1)
}
const PNPM_DIR = `${DSH}/node_modules/.pnpm`

/** 在 DSH checkout 的 pnpm store 里找包目录（优先最新稳定版，避开 alpha/beta/rc）。 */
function pnpmPackage(packageName) {
  if (!existsSync(PNPM_DIR)) throw new Error(`找不到 ${PNPM_DIR}；请先在本机 DSH checkout 执行 pnpm install`)
  const names = readdirSync(PNPM_DIR).filter((name) => name.startsWith(packageName + '@'))
  const stable = names.filter((name) => !/(alpha|beta|rc)/i.test(name))
  const pool = (stable.length > 0 ? stable : names).slice().sort((a, b) => {
    const va = /@(\d+)\.(\d+)\.(\d+)/.exec(a)
    const vb = /@(\d+)\.(\d+)\.(\d+)/.exec(b)
    if (!va || !vb) return a < b ? 1 : -1
    return (Number(vb[1]) - Number(va[1])) || (Number(vb[2]) - Number(va[2])) || (Number(vb[3]) - Number(va[3]))
  })
  if (pool.length === 0) throw new Error(`找不到 ${packageName} 于 ${PNPM_DIR}`)
  return `${PNPM_DIR}/${pool[0]}/node_modules/${packageName}`
}

const REACT = `${pnpmPackage('react')}/umd/react.development.js`
const REACT_DOM = `${pnpmPackage('react-dom')}/umd/react-dom.development.js`
const PW = `${pnpmPackage('playwright')}/index.mjs`

const args = process.argv.slice(2)
const clientPath = args.includes('--client')
  ? args[args.indexOf('--client') + 1]
  : fileURLToPath(new URL('../../client.js', import.meta.url))
const jsonOnly = args.includes('--json')

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>devbot scroll repro</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#111;}
  #root{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;}
</style>
</head><body>
<div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>window.__ModuleLoader__={load(m){window.__pluginModule=m}};</script>
<script src="/client.js"></script>
<script src="/harness.js"></script>
</body></html>`

const HARNESS = String.raw`
(async function () {
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const h = React.createElement;
  const mod = window.__pluginModule;
  if (!mod || typeof mod.factory !== 'function') { window.__fatal = 'client.js did not register module'; return; }
  const plugin = mod.factory(function require(id) {
    if (id === 'react') return window.React;
    throw new Error('unknown require: ' + id);
  });
  const internals = plugin._internals;
  const makeStore = (init) => internals.createStore(init);

  const leadId = 'S-lead';
  const pmId = 'S-pm';
  const designerId = 'S-designer';
  const lead2Id = 'S-lead2';
  const pm2Id = 'S-pm2';
  const baseTime = Date.now() - 6 * 3600 * 1000;

  // ---------- entries ----------
  function mkEntries(label, count, startTime, offset) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const seq = (offset || 0) + i + 1;
      const time = startTime + i * 45000;
      const body = label + ' 第 ' + i + ' 条回复：' + '内容'.repeat(14);
      if (i % 6 === 3) {
        out.push({ type: 'event', event: { type: 'user/message', seq, time, surfaceOp: 'append',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: label + ' 的人类消息 ' + i }] } } });
      } else {
        out.push({ type: 'event', event: { type: 'assistant/message', seq, time,
          data: { message: { content: [{ type: 'text', text: body }] } } } });
      }
    }
    return out;
  }
  const entriesBySession = {
    [leadId]: mkEntries('Lead', 60, baseTime),
    [pmId]: mkEntries('pm', 60, baseTime + 5000),
    [designerId]: mkEntries('designer', 40, baseTime + 9000),
    [lead2Id]: mkEntries('Lead2', 20, baseTime + 7000),
    [pm2Id]: mkEntries('pm2', 20, baseTime + 12000),
  };
  // 更早的历史页（loadOlder 用）：时间更早、seq 更小，文本带「更早消息」标记。
  const olderBySession = {
    [leadId]: mkEntries('更早消息 Lead', 25, baseTime - 4 * 3600 * 1000, -1000),
    [pmId]: mkEntries('更早消息 pm', 25, baseTime - 4 * 3600 * 1000 + 5000, -1000),
    [designerId]: mkEntries('更早消息 designer', 15, baseTime - 4 * 3600 * 1000 + 9000, -1000),
  };

  // ---------- fake sessions service ----------
  const OPEN_MS = 45;
  const recs = new Map();
  const activity = { retain: 0, release: 0, open: 0, drop: 0 };

  function makeGeneration(sid) {
    const rec = {
      id: sid, refs: 0, dropped: false, opened: false, hasMore: true,
      listeners: new Set(), esListeners: new Set(),
      esSnapshot: { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } },
    };
    const notifyEs = () => { for (const cb of Array.from(rec.esListeners)) cb(); };
    rec.eventSource = {
      getSnapshot: () => rec.esSnapshot,
      subscribe: (cb) => { rec.esListeners.add(cb); return () => rec.esListeners.delete(cb); },
      replace: (entries, hasMore) => {
        rec.hasMore = hasMore;
        rec.esSnapshot = { entries, hasMore, revision: rec.esSnapshot.revision + 1, change: { kind: 'replace', entries } };
        notifyEs();
      },
      prepend: (entries, hasMore) => {
        rec.hasMore = hasMore;
        rec.esSnapshot = { entries: entries.concat(rec.esSnapshot.entries), hasMore,
          revision: rec.esSnapshot.revision + 1, change: { kind: 'prepend', entries } };
        notifyEs();
      },
      append: (entry) => {
        rec.esSnapshot = { entries: rec.esSnapshot.entries.concat([entry]), hasMore: rec.esSnapshot.hasMore,
          revision: rec.esSnapshot.revision + 1, change: { kind: 'append', entries: [entry] } };
        notifyEs();
      },
      settleAssistant: (attemptId, entry) => {
        const entries = rec.esSnapshot.entries.filter((e) => e.type !== 'transient' || e.event.data.attemptId !== attemptId);
        if (entry !== undefined) entries.push(entry);
        rec.esSnapshot = { entries, hasMore: rec.esSnapshot.hasMore,
          revision: rec.esSnapshot.revision + 1, change: { kind: 'settle-assistant', attemptId, entry } };
        notifyEs();
      },
    };
    rec.session = {
      getSnapshot: () => ({ sessionId: sid, openState: rec.opened ? 'open' : 'idle', openError: null,
        running: false, hasMore: rec.esSnapshot.hasMore }),
      subscribe: (cb) => { rec.listeners.add(cb); return () => rec.listeners.delete(cb); },
      loadOlder: () => {
        if (!rec.opened || !rec.esSnapshot.hasMore) return Promise.resolve();
        rec.eventSource.prepend(olderBySession[sid] || [], false);
        return Promise.resolve();
      },
    };
    rec.binding = { sessionId: sid, session: rec.session, eventSource: rec.eventSource };
    rec.openPromise = new Promise((resolve, reject) => {
      rec.openTimer = setTimeout(() => {
        if (rec.dropped) { reject(new Error('released')); return; }
        rec.opened = true;
        activity.open += 1;
        rec.eventSource.replace(entriesBySession[sid] || [], (olderBySession[sid] || []).length > 0);
        resolve();
      }, OPEN_MS);
    });
    rec.openPromise.catch(() => {});
    return rec;
  }

  function dropGeneration(rec) {
    if (rec.dropped) return;
    rec.dropped = true;
    clearTimeout(rec.openTimer);
    if (recs.get(rec.id) === rec) recs.delete(rec.id);
    activity.drop += 1;
  }

  const sessions = {
    list: makeStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    subagentAddress: (id) => {
      if (id === pmId || id === designerId) return { parentSessionId: leadId, childSessionId: id, mode: 'subagent' };
      return { parentSessionId: lead2Id, childSessionId: id, mode: 'subagent' };
    },
    retain(target) {
      const sid = typeof target === 'string' ? target : target.childSessionId;
      let rec = recs.get(sid);
      if (!rec || rec.dropped) { rec = makeGeneration(sid); recs.set(sid, rec); }
      rec.refs += 1;
      activity.retain += 1;
      const ready = rec.opened ? Promise.resolve(rec.binding) : rec.openPromise.then(() => rec.binding);
      let released = false;
      return {
        ready,
        release() {
          if (released) return;
          released = true;
          rec.refs -= 1;
          activity.release += 1;
          if (rec.refs <= 0) dropGeneration(rec);
        },
      };
    },
    refresh: () => Promise.resolve(),
  };

  // ---------- ctx ----------
  const disposers = [];
  const captured = {};
  const slots = {
    inject(name, cb) { const d = typeof cb === 'function' ? cb() : undefined; if (typeof d === 'function') disposers.push(d); return d; },
    register(config, Component) {
      captured[config.name + (config.key ? ':' + config.key : '')] = { config, Component };
      return () => {};
    },
  };
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    slots,
    layout: { selectPanel() {} },
    sessions,
  };
  plugin.apply(ctx);
  const main = captured['main:devbot'];
  if (!main) { window.__fatal = 'main:devbot component was not registered'; return; }

  // ---------- teams ----------
  function teamFor(lead, members, tasks) {
    return {
      members: [{ id: lead, name: 'lead', role: 'lead', phase: 'active' }]
        .concat(members.map((m) => ({ id: m.id, name: m.name, role: 'member', phase: m.phase || 'active' }))),
      tasks: tasks || [{ id: 't1', subject: '[实现] 实现登录页', status: 'in_progress', ownerId: pmId }],
    };
  }
  const team1 = teamFor(leadId, [{ id: pmId, name: 'pm' }]);
  const team2 = teamFor(lead2Id, [{ id: pm2Id, name: 'pm2' }], [{ id: 't9', subject: '[规划] 二号项目 PRD', status: 'completed' }]);

  function listSnapshot() {
    return {
      ids: [leadId, lead2Id],
      byId: {
        [leadId]: { id: leadId, displayTitle: '一号项目', running: true, updatedAt: 1000, projectionValues: {} },
        [lead2Id]: { id: lead2Id, displayTitle: '二号项目', running: false, updatedAt: 500, projectionValues: {} },
      },
      phase: 'ready',
      projectionsBySession: {
        [leadId]: { values: { agentTeam: team1 } },
        [lead2Id]: { values: { agentTeam: team2 } },
      },
    };
  }
  sessions.list.set(listSnapshot());

  // ---------- mount ----------
  const face = typeof main.config.inject === 'function' ? main.config.inject() : (main.config.inject || {});
  const useTeamTeams = (selector) => React.useSyncExternalStore(
    face.hooks.teams.subscribe, () => selector(face.hooks.teams.getSnapshot()));
  const useTeamDetail = (selector) => React.useSyncExternalStore(
    face.hooks.detail.subscribe, () => selector(face.hooks.detail.getSnapshot()));
  function Root() {
    return h(main.Component, Object.assign({}, face, { useTeams: useTeamTeams, useDetail: useTeamDetail }));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(Root));

  // ---------- probes ----------
  const probe = {
    ready: false, el: null, emptyFrames: 0, minScrollHeight: Infinity,
    machineSets: [], scrollEvents: [], collapses: [], prevMax: 0,
  };
  window.__probe = probe;

  function findScrollEl() {
    let best = null;
    for (const el of Array.from(document.querySelectorAll('div'))) {
      const cs = getComputedStyle(el);
      if (cs.overflowY !== 'auto' && cs.overflow !== 'auto') continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    return best;
  }
  function patchSetter(el) {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const protoGet = desc.get;
    const protoSet = desc.set;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return protoGet.call(el); },
      set(v) {
        probe.machineSets.push({ before: protoGet.call(el), to: v, max: el.scrollHeight - el.clientHeight,
          t: Math.round(performance.now()) });
        protoSet.call(el, v);
      },
    });
    el.addEventListener('scroll', () => {
      probe.scrollEvents.push({ top: Math.round(protoGet.call(el)),
        max: el.scrollHeight - el.clientHeight, t: Math.round(performance.now()) });
    }, { passive: true });
  }
  function frame() {
    const el = probe.el;
    if (el) {
      const hh = el.scrollHeight;
      const max = hh - el.clientHeight;
      if (hh < probe.minScrollHeight) probe.minScrollHeight = hh;
      if (max <= 0) probe.emptyFrames += 1;
      if (probe.prevMax > 100 && max <= 0 && probe.ready) {
        probe.collapses.push({ t: Math.round(performance.now()), prevMax: probe.prevMax, scrollHeight: hh });
      }
      probe.prevMax = max;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  const started = performance.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const el = findScrollEl();
      if (el && el.scrollHeight > 600 && document.body.textContent.includes('第 1 条回复')) {
        clearInterval(timer);
        probe.el = el;
        patchSetter(el);
        resolve();
      }
      if (performance.now() - started > 6000) { clearInterval(timer); resolve(); }
    }, 25);
  });
  if (!probe.el) { window.__fatal = 'scroll container never appeared'; return; }
  probe.ready = true;

  // ---------- helpers ----------
  window.__metrics = function metrics() {
    const el = probe.el;
    const max = el.scrollHeight - el.clientHeight;
    return {
      scrollTop: Math.round(el.scrollTop), max: Math.round(max),
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      atBottom: max > 0 ? (max - el.scrollTop) < 8 : true,
      emptyFrames: probe.emptyFrames, minScrollHeight: probe.minScrollHeight,
      collapses: probe.collapses.slice(-8), collapseCount: probe.collapses.length,
      machineSets: probe.machineSets.slice(-10),
      activity: JSON.parse(JSON.stringify(activity)),
      seen: {
        older: el.textContent.includes('更早消息'),
        streamed: el.textContent.includes('流式片段'),
        lead2: el.textContent.includes('Lead2 第'),
      },
    };
  };
  window.__scrollToMiddle = function () {
    const el = probe.el;
    el.scrollTop = Math.max(100, Math.round((el.scrollHeight - el.clientHeight) * 0.35));
    return window.__metrics();
  };
  window.__scrollToTop = function () {
    probe.el.scrollTop = 0;
    return window.__metrics();
  };
  window.__triggerPhaseChange = function () {
    const snap = sessions.list.getSnapshot();
    const team = teamFor(leadId, [{ id: pmId, name: 'pm', phase: 'failed' }]);
    sessions.list.set({ ...snap, byId: { ...snap.byId },
      projectionsBySession: { ...snap.projectionsBySession, [leadId]: { values: { agentTeam: team } } } });
  };
  window.__addMember = function () {
    const snap = sessions.list.getSnapshot();
    const team = teamFor(leadId, [{ id: pmId, name: 'pm' }, { id: designerId, name: 'designer' }]);
    sessions.list.set({ ...snap, byId: { ...snap.byId },
      projectionsBySession: { ...snap.projectionsBySession, [leadId]: { values: { agentTeam: team } } } });
  };
  window.__streamInto = function (sid) {
    const rec = recs.get(sid);
    if (!rec || !rec.opened) return false;
    const attemptId = 'attempt-1';
    rec.eventSource.append({ type: 'transient', event: { type: 'assistant/live', time: Date.now(),
      data: { attemptId, chunk: { type: 'text-delta', text: '流式片段' } } } });
    setTimeout(() => {
      rec.eventSource.settleAssistant(attemptId, { type: 'event', event: {
        type: 'assistant/message', seq: 99999, time: Date.now(),
        data: { message: { content: [{ type: 'text', text: '流式片段 已结算' }] } } } });
    }, 120);
    return true;
  };
  window.__switchTeam2 = function () {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.includes('二号项目'));
    if (!btn) return false;
    btn.click();
    return true;
  };
  window.__resetCounters = function () {
    probe.machineSets.length = 0;
    probe.emptyFrames = 0;
    probe.scrollEvents.length = 0;
    probe.collapses.length = 0;
    probe.prevMax = 0;
  };
  console.log('[repro] harness ready');
})();
`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
  if (url.pathname === '/') return send('text/html; charset=utf-8', HTML)
  if (url.pathname === '/react.js') return send('text/javascript', readFileSync(REACT))
  if (url.pathname === '/react-dom.js') return send('text/javascript', readFileSync(REACT_DOM))
  if (url.pathname === '/client.js') return send('text/javascript', readFileSync(clientPath))
  if (url.pathname === '/harness.js') return send('text/javascript', HARNESS)
  res.writeHead(404); res.end('nope')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const { chromium } = await import(PW)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)))
page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push('[console] ' + msg.text()) })

const out = { client: clientPath, ok: false, fatal: null, failure: null, verdict: {}, pageErrors }
const metrics = () => page.evaluate(() => window.__metrics())
const reset = () => page.evaluate(() => window.__resetCounters())
const scrollMiddle = () => page.evaluate(() => window.__scrollToMiddle())
async function waitStable(minMax) {
  await page.waitForFunction((h) => window.__metrics().max > h, minMax, { timeout: 6000 })
  await page.waitForTimeout(200)
}
function snap(before, after, extra) {
  return Object.assign({
    userScrollTop: before.scrollTop,
    finalScrollTop: after.scrollTop,
    max: after.max,
    atBottomBefore: before.atBottom,
    atBottomAfter: after.atBottom,
    snappedToBottom: before.atBottom === false && after.atBottom === true,
    collapses: after.collapseCount,
    dropDelta: after.activity.drop - before.activity.drop,
    openDelta: after.activity.open - before.activity.open,
    machineSetToBottom: after.machineSets.some((s) => s.max > 100 && s.to >= s.max - 2 && s.before < s.max - 100),
  }, extra || {})
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForFunction('window.__probe && window.__probe.ready === true', null, { timeout: 9000 })
  await waitStable(500)
  out.verdict.mount = await metrics()

  // ---- A：初始 attach 后的 2s retry（bug 主要触发点）----
  await reset(); await scrollMiddle(); await page.waitForTimeout(250)
  const retryBefore = await metrics()
  let retryCollapseObserved = false
  try {
    await page.waitForFunction(() => window.__metrics().collapseCount >= 1, null, { timeout: 3500 })
    retryCollapseObserved = true
  } catch { retryCollapseObserved = false }
  await waitStable(500)
  const retryAfter = await metrics()
  out.verdict.retry = snap(retryBefore, retryAfter, { observedCollapse: retryCollapseObserved })

  // ---- B：成员 phase 变化（不应重新挂载会话）----
  await reset(); await scrollMiddle(); await page.waitForTimeout(250)
  const phaseBefore = await metrics()
  await page.evaluate(() => window.__triggerPhaseChange())
  await page.waitForTimeout(900)
  out.verdict.phaseChange = snap(phaseBefore, await metrics())

  // ---- C：新成员加入（增量 attach，只 retain 新成员）----
  await reset(); await scrollMiddle(); await page.waitForTimeout(250)
  const memberBefore = await metrics()
  await page.evaluate(() => window.__addMember())
  await page.waitForTimeout(1300)
  out.verdict.addMember = snap(memberBefore, await metrics())

  // ---- D：上滑时流式消息追加/结算，不应跳到底部 ----
  await reset(); await scrollMiddle(); await page.waitForTimeout(250)
  const streamBefore = await metrics()
  await page.evaluate((sid) => window.__streamInto(sid), 'S-pm')
  await page.waitForTimeout(700)
  const streamAfter = await metrics()
  out.verdict.streaming = snap(streamBefore, streamAfter, { streamedVisible: streamAfter.seen.streamed })

  // ---- E：上滑到顶加载更早消息，不应塌缩、不应跳到底部 ----
  await reset(); await scrollMiddle(); await page.waitForTimeout(200)
  const olderBefore = await metrics()
  await page.evaluate(() => window.__scrollToTop())
  await page.waitForTimeout(1200)
  const olderAfter = await metrics()
  out.verdict.loadOlder = snap(olderBefore, olderAfter, { olderVisible: olderAfter.seen.older })

  // ---- F：切换团队（换会话应回到最新一条）----
  await reset()
  const switched = await page.evaluate(() => window.__switchTeam2())
  await page.waitForTimeout(1500)
  const switchAfter = await metrics()
  out.verdict.teamSwitch = {
    switched,
    lead2Visible: switchAfter.seen.lead2,
    atBottom: switchAfter.atBottom,
    rowsText: switchAfter.seen,
  }

  out.ok = true
} catch (error) {
  out.failure = String(error && error.stack ? error.stack : error)
} finally {
  await browser.close()
  server.close()
}

const benign = (text) => /style property during rerender|Warning:/.test(text)
const hardErrors = pageErrors.filter((text) => !benign(text))

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push({ check: name, detail })
}
const mount = out.verdict.mount || {}
const retry = out.verdict.retry || {}
const phaseChange = out.verdict.phaseChange || {}
const addMember = out.verdict.addMember || {}
const streaming = out.verdict.streaming || {}
const loadOlder = out.verdict.loadOlder || {}
const teamSwitch = out.verdict.teamSwitch || {}

check('初始打开应直接贴底（新会话从最新一条看起）', mount.atBottom === true, mount)
check('retry：不应再出现内容塌缩（闪一下）', retry.collapses === 0, retry)
check('retry：上滑位置不应被弹到底部', retry.snappedToBottom === false, retry)
check('retry：不应重挂会话（无 drop/open）', retry.dropDelta === 0 && retry.openDelta === 0, retry)
check('phase 变化：不应重挂会话', phaseChange.collapses === 0 && phaseChange.dropDelta === 0, phaseChange)
check('phase 变化：滚动位置不变', phaseChange.snappedToBottom === false, phaseChange)
check('新成员：只 retain 新成员、不断开旧会话',
  addMember.openDelta === 1 && addMember.dropDelta === 0 && addMember.collapses === 0, addMember)
check('流式消息：上滑时不应跳到底部', streaming.snappedToBottom === false && streaming.collapses === 0, streaming)
check('流式消息：结算后内容应出现', streaming.streamedVisible === true, streaming)
check('加载更早：不应塌缩/跳底', loadOlder.collapses === 0 && loadOlder.snappedToBottom === false, loadOlder)
check('加载更早：历史内容应出现', loadOlder.olderVisible === true, loadOlder)
check('换团队：新团队内容出现并贴底', teamSwitch.switched === true && teamSwitch.lead2Visible === true && teamSwitch.atBottom === true, teamSwitch)
check('运行期不应有未捕获错误', hardErrors.length === 0, hardErrors)

out.ok = out.ok && failures.length === 0
const report = { ok: out.ok, fatal: out.fatal, failure: out.failure, failures, verdict: out.verdict, errors: hardErrors }
if (jsonOnly) {
  console.log(JSON.stringify(report))
} else {
  for (const name of ['retry', 'phaseChange', 'addMember', 'streaming', 'loadOlder', 'teamSwitch']) {
    const v = out.verdict[name] || {}
    console.log(`[${name}]`, JSON.stringify({
      scrollTop: v.finalScrollTop, max: v.max, snappedToBottom: v.snappedToBottom,
      collapses: v.collapses, dropDelta: v.dropDelta, openDelta: v.openDelta,
      olderVisible: v.olderVisible, streamedVisible: v.streamedVisible,
      lead2Visible: v.lead2Visible, atBottom: v.atBottom,
    }))
  }
  console.log('errors:', JSON.stringify(report.errors))
  if (failures.length === 0) console.log('RESULT: PASS — 不再「闪一下并自动滚到底」')
  else {
    console.log('RESULT: FAIL')
    for (const f of failures) console.log('  ✖', f.check, JSON.stringify(f.detail))
  }
  if (out.fatal) console.log('fatal:', out.fatal)
  if (out.failure) console.log('failure:', out.failure)
}
process.exit(out.ok ? 0 : 1)
