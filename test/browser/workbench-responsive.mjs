#!/usr/bin/env node
/**
 * DevBot v0.5 响应式工作台 + DSH 风格时间线的真实浏览器回归器。
 *
 * 在无头 Chromium 里加载真实 client.js 的 DevbotWorkbench 组件 + 复刻 DSH
 * Session Controller 语义的 fake sessions，按 PRD §13 的验收点做几何与交互断言：
 *   - AC-01 375/390/430 scrollWidth <= clientWidth（page / root / chat）
 *   - AC-02 群聊 clientWidth >= 280 且 clientHeight >= 300
 *   - AC-03 底部状态条单行、不竖排
 *   - AC-05 三断点：1280/1024/900 三栏、899/768/600 两栏、559/430/375 单栏 + 四段 tab
 *   - AC-06 <900 热区 >= 40x40
 *   - AC-07 项目切换：390 底部抽屉、768 顶栏浮层；点遮罩不切换
 *   - AC-08 切 tab 保 scrollTop（±2px），切回仍在原位置
 *   - AC-09 上滑加载更早：触发一次、loading 文案、到最早不再触发
 *   - AC-12/13/14 markdown / 用户胶囊 / 成员头合并 / 流式 / 日分隔
 *   - AC-15 XSS 不执行
 *   - AC-16 深/浅色 token 可读（正文色 != 背景色）
 *   - AC-17 桌面 1280/1440 三栏回归
 *
 * 用法（需要本机 DSH checkout 的 node_modules 与 Playwright 浏览器）：
 *   node test/browser/workbench-responsive.mjs
 *   DSH_CHECKOUT=/path/to/deepseek-harness node test/browser/workbench-responsive.mjs
 *   node test/browser/workbench-responsive.mjs --json     # 只输出 JSON
 *
 * 截图与报告写入 test/browser/out/。退出码：0 = 全绿；1 = 有断言失败。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

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
const CLIENT_PATH = fileURLToPath(new URL('../../client.js', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url))
mkdirSync(OUT_DIR, { recursive: true })
const jsonOnly = process.argv.includes('--json')

const DARK_TOKENS = `
  color-scheme: dark;
  --dsw-alias-label-primary: #F9FAFB;
  --dsw-alias-label-secondary: #CFD3D6;
  --dsw-alias-label-tertiary: #ADB2B8;
  --dsw-alias-label-caption: #81858C;
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2C2C2E;
  --dsw-alias-bg-overlay: #61666B;
  --dsw-alias-border-l1: rgba(255, 255, 255, .06);
  --dsw-alias-border-l2: rgba(255, 255, 255, .12);
  --dsw-alias-border-l3: rgba(255, 255, 255, .16);
  --dsw-alias-border-l4: rgba(255, 255, 255, .20);
  --dsw-alias-link: #7AAAFF;
  --dsw-alias-state-success-primary: #22C55E;
  --dsw-alias-state-warn-primary: #F59E0B;
  --dsw-alias-state-error-primary: #F25A5A;
  --dsw-alias-markdown-code-block: #1B1B1C;
  --dsw-alias-markdown-code-block-banner: #2C2C2E;
  --dsw-alias-markdown-inline-code: #292929;
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, .08);
  --dsw-specific-bubble: #2C2C2E;
  --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px;
  --dsw-radius-lg: 16px; --dsw-radius-xl: 20px; --dsw-radius-panel: 28px;
`
const LIGHT_TOKENS = `
  color-scheme: light;
  --dsw-alias-label-primary: #0F1115;
  --dsw-alias-label-secondary: #61666B;
  --dsw-alias-label-tertiary: #81858C;
  --dsw-alias-label-caption: #ADB2B8;
  --dsw-alias-bg-base: #FFFFFF;
  --dsw-alias-bg-layer-1: #FFFFFF;
  --dsw-alias-bg-layer-2: #FFFFFF;
  --dsw-alias-bg-overlay: #E9ECF2;
  --dsw-alias-border-l1: rgba(0, 0, 0, .04);
  --dsw-alias-border-l2: rgba(0, 0, 0, .10);
  --dsw-alias-border-l3: rgba(0, 0, 0, .12);
  --dsw-alias-border-l4: rgba(0, 0, 0, .16);
  --dsw-alias-link: #4176E6;
  --dsw-alias-state-success-primary: #22C55E;
  --dsw-alias-state-warn-primary: #F59E0B;
  --dsw-alias-state-error-primary: #EC1313;
  --dsw-alias-markdown-code-block: #F9FAFB;
  --dsw-alias-markdown-code-block-banner: #F9FAFB;
  --dsw-alias-markdown-inline-code: #FAFAFA;
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, .06);
  --dsw-specific-bubble: #EDF3FE;
`

const HTML = `<!doctype html>
<html data-theme="dark"><head><meta charset="utf-8"><title>devbot responsive</title>
<style>
:root{${DARK_TOKENS}}
html[data-theme="light"]{${LIGHT_TOKENS}}
html,body{margin:0;padding:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif}
#root{display:flex;flex-direction:column;height:100vh;width:100%;max-width:100%;min-height:0}
</style></head><body>
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
  const BT = String.fromCharCode(96);
  const makeStore = (init) => internals.createStore(init);

  const leadId = 'S-lead';
  const lead2Id = 'S-lead2';
  const pmId = 'S-pm';
  const designerId = 'S-designer';
  const fullstackId = 'S-fullstack';
  const testerId = 'S-tester';
  const pm2Id = 'S-pm2';
  const base = Date.now() - 6 * 3600 * 1000;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const longUrl = 'https://example.com/' + 'segment-'.repeat(24) + 'end';
  const md = [
    '# 实现进度',
    '',
    '已完成 **响应式三断点** 与 ' + BT + '容器查询' + BT + '，PRD 见 [链接](https://example.com/prd)。',
    '',
    '- 三栏 ≥900',
    '- 两栏 560–899',
    '- 单栏 <560',
    '',
    '1. 先布局',
    '2. 再时间线',
    '',
    '> 约束：不动 controller 的 retain/release。',
    '',
    '~~~css',
    '.devbot-root{container-type:inline-size}',
    '~~~',
    '',
    '---',
    '',
    '超长链接：' + longUrl,
    '',
    '| # | 名称 | 用途 | 结果 |',
    '|---|:---:|---:|---|',
    '| 7 | Recon | 摸 CSS/token/字号/间距 | 读到了，cwd 不对 |',
    '| 8 | Draft | 代写需求文档 | **失败** |',
    '| 11 | Probe | 确认能不能写 | ' + BT + 'DENIED' + BT + ' |',
    '',
    '任务列表：',
    '',
    '- [x] PRD 定稿',
    '- [ ] 设计评审',
    '',
    '~~作废的方案~~ 与 __下划线粗体__；裸链接 https://example.com/bare-link。 完成。',
    '',
    '脚本注入：<script>alert("xss")</script> 与 <img src=x onerror=alert(1)>'
  ].join('\n').replace(/~~~/g, String.fromCharCode(96).repeat(3));

  function ev(event) { return { type: 'event', event: Object.assign({ surfaceOp: 'append' }, event) }; }

  const entriesBySession = {
    [leadId]: [
      ev({ type: 'assistant/message', seq: 1, time: base + 1 * MIN, data: { message: { content: [{ type: 'text', text: md }] } } }),
      ev({ type: 'user/message', seq: 2, time: base + 2 * MIN, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把顶栏改成四段 tab，底部保留加载状态条。' }] } }),
      ev({ type: 'team/member', seq: 3, time: base + 3 * MIN, data: { member: { id: pmId, name: 'pm', phase: 'active' } } }),
      ev({ type: 'team/task', seq: 4, time: base + 4 * MIN, data: { task: { id: 'task-3', subject: '[设计] 移动端工作台', status: 'completed', ownerId: designerId } } }),
      ev({ type: 'assistant/message', seq: 5, time: base + 5 * MIN, data: { message: { content: [{ type: 'text', text: '下一步实现 client.js 渲染层。' }] } } }),
      // Team 投递副本：落在 Lead 会话里的消息，收件人 = @lead。
      ev({ type: 'user/message', seq: 6, time: base + 7 * MIN, data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: pmId }, content: [{ type: 'text', text: 'Team message from pm:\nPRD v0.2 已落盘，请 review。' }] } }),
      { type: 'transient', event: { type: 'assistant/live', time: base + 6 * MIN, data: { attemptId: 'attempt-1', chunk: { type: 'text-delta', text: '正在输出：底部状态条与安全区叠加…' } } } },
    ],
    [pmId]: [
      ev({ type: 'user/message', seq: 1, time: base + 1 * MIN, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '→ fullstack2 · 按设计稿实现 client.js v0.5 响应式布局与时间线渲染' }] } }),
      ev({ type: 'assistant/message', seq: 2, time: base + 2 * MIN, data: { message: { content: [{ type: 'text', text: '- [x] PRD 定稿\n- [ ] 设计评审' }] } } }),
      // Team 投递副本：落在 pm 会话里的消息，收件人 = @pm。
      ev({ type: 'user/message', seq: 3, time: base + 2.5 * MIN, data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: leadId }, content: [{ type: 'text', text: 'Team message from lead:\n请先出 PRD v0.2（含范围与非目标）。' }] } }),
    ],
    [designerId]: [
      ev({ type: 'assistant/message', seq: 1, time: base + 2 * MIN, data: { message: { content: [{ type: 'text', text: '## 设计稿\n\n交付两份 HTML，含 **390×844** 与 375/430 检查。' }] } } }),
      ev({ type: 'assistant/message', seq: 2, time: base + 3 * MIN, data: { message: { content: [{ type: 'text', text: '连续发送第二条：不重复头像与名字。' }] } } }),
      ev({ type: 'assistant/message', seq: 3, time: base + 9 * MIN, data: { message: { content: [{ type: 'text', text: '间隔超过 5 分钟，应重新显示成员头。' }] } } }),
      ev({ type: 'assistant/message', seq: 4, time: base + 10 * MIN, data: { message: { content: [{ type: 'text', text: '连续发送第四条：同一发送者 5 分钟内不重复头。' }] } } }),
    ],
    [fullstackId]: [
      ev({ type: 'assistant/message', seq: 1, time: base + 4 * MIN, data: { message: { content: [{ type: 'text', text: '容器查询按 .devbot-root 的 inline-size 重排。' }] } } }),
    ],
    [testerId]: [
      ev({ type: 'assistant/message', seq: 1, time: base + 5 * MIN, data: { message: { content: [{ type: 'text', text: '按 AC-01~23 逐条跑。' }] } } }),
    ],
    ['S-late']: [
      ev({ type: 'assistant/message', seq: 1, time: base - 2 * HOUR, data: { message: { content: [{ type: 'text', text: '晚到成员会话的旧消息 A（应插入时间线上方）' }] } } }),
      ev({ type: 'assistant/message', seq: 2, time: base - 2 * HOUR + 1 * MIN, data: { message: { content: [{ type: 'text', text: '晚到成员会话的旧消息 B' }] } } }),
    ],
    [lead2Id]: [
      ev({ type: 'assistant/message', seq: 1, time: base + 2 * MIN, data: { message: { content: [{ type: 'text', text: '二号项目的独立时间线内容。' }] } } }),
    ],
    [pm2Id]: [
      ev({ type: 'assistant/message', seq: 1, time: base + 3 * MIN, data: { message: { content: [{ type: 'text', text: '二号项目 PM 已就绪。' }] } } }),
    ],
  };

  // 更早的历史页（loadOlder 用）：时间更早、带「更早消息」标记。
  const olderBySession = {};
  for (const sid of [leadId, pmId, designerId, fullstackId, testerId]) {
    olderBySession[sid] = [
      ev({ type: 'assistant/message', seq: -2, time: base - 30 * HOUR, data: { message: { content: [{ type: 'text', text: '更早消息 ' + sid + ' · 昨天' }] } } }),
      ev({ type: 'assistant/message', seq: -1, time: base - 29 * HOUR, data: { message: { content: [{ type: 'text', text: '更早消息 ' + sid + ' · 第二条' }] } } }),
    ];
  }

  const OPEN_MS = 20;
  const recs = new Map();
  const calls = { retain: 0, release: 0, open: 0, loadOlder: 0 };
  window.__calls = calls;
  window.__actions = { loadOlder: 0 };

  function makeGeneration(sid) {
    const rec = {
      id: sid, refs: 0, dropped: false, opened: false, hasMore: true,
      listeners: new Set(), esListeners: new Set(),
      esSnapshot: { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } },
    };
    const notify = () => { for (const cb of Array.from(rec.esListeners)) cb(); };
    rec.eventSource = {
      getSnapshot: () => rec.esSnapshot,
      subscribe: (cb) => { rec.esListeners.add(cb); return () => rec.esListeners.delete(cb); },
      replace: (entries, hasMore) => {
        rec.hasMore = hasMore;
        rec.esSnapshot = { entries, hasMore, revision: rec.esSnapshot.revision + 1, change: { kind: 'replace', entries } };
        notify();
      },
      prepend: (entries, hasMore) => {
        rec.hasMore = hasMore;
        rec.esSnapshot = { entries: entries.concat(rec.esSnapshot.entries), hasMore,
          revision: rec.esSnapshot.revision + 1, change: { kind: 'prepend', entries } };
        notify();
      },
      append: (entry) => {
        rec.esSnapshot = { entries: rec.esSnapshot.entries.concat([entry]), hasMore: rec.esSnapshot.hasMore,
          revision: rec.esSnapshot.revision + 1, change: { kind: 'append', entries: [entry] } };
        notify();
      },
    };
    rec.session = {
      getSnapshot: () => ({ sessionId: sid, openState: rec.opened ? 'open' : 'idle', openError: null,
        running: false, hasMore: rec.esSnapshot.hasMore }),
      subscribe: (cb) => { rec.listeners.add(cb); return () => rec.listeners.delete(cb); },
      loadOlder: () => {
        calls.loadOlder += 1;
        if (!rec.opened || !rec.esSnapshot.hasMore) return Promise.resolve();
        rec.eventSource.prepend(olderBySession[sid] || [], false);
        return Promise.resolve();
      },
    };
    rec.binding = { sessionId: sid, session: rec.session, eventSource: rec.eventSource };
    rec.openTimer = setTimeout(() => {
      if (rec.dropped) return;
      rec.opened = true;
      calls.open += 1;
      rec.eventSource.replace(entriesBySession[sid] || [], (olderBySession[sid] || []).length > 0);
    }, OPEN_MS);
    return rec;
  }

  function dropGeneration(rec) {
    if (rec.dropped) return;
    rec.dropped = true;
    clearTimeout(rec.openTimer);
    if (recs.get(rec.id) === rec) recs.delete(rec.id);
  }

  const sessions = {
    list: makeStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    subagentAddress: (id) => ({ parentSessionId: id === pm2Id ? lead2Id : leadId, childSessionId: id, mode: 'subagent' }),
    retain(target) {
      const sid = typeof target === 'string' ? target : target.childSessionId;
      calls.retain += 1;
      let rec = recs.get(sid);
      if (!rec || rec.dropped) { rec = makeGeneration(sid); recs.set(sid, rec); }
      rec.refs += 1;
      const ready = rec.opened ? Promise.resolve(rec.binding) : new Promise((resolve) => {
        const timer = setInterval(() => {
          if (rec.opened) { clearInterval(timer); resolve(rec.binding); }
        }, 5);
      });
      let released = false;
      return {
        ready,
        release() {
          if (released) return;
          released = true;
          calls.release += 1;
          rec.refs -= 1;
          if (rec.refs <= 0) dropGeneration(rec);
        },
      };
    },
    refresh: () => Promise.resolve(),
  };

  const disposers = [];
  const captured = {};
  const slots = {
    inject(name, cb) { const d = typeof cb === 'function' ? cb() : undefined; if (typeof d === 'function') disposers.push(d); return d; },
    register(config, Component) { captured[config.name + (config.key ? ':' + config.key : '')] = { config, Component }; return () => {}; },
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

  const tasks = [
    { id: 'task-1', subject: '[需求] 需求分析', status: 'completed', ownerId: pmId, ownerName: 'pm' },
    { id: 'task-2', subject: '[规划] v0.5 PRD', status: 'completed', ownerId: pmId, ownerName: 'pm' },
    { id: 'task-3', subject: '[设计] 移动端工作台高保真', status: 'completed', ownerId: designerId, ownerName: 'designer2' },
    { id: 'task-4', subject: '[实现] client.js v0.5 响应式工作台 + DSH 风格时间线渲染层改造', status: 'in_progress', ownerId: fullstackId, ownerName: 'fullstack2' },
    { id: 'task-5', subject: '[测试] v0.5 响应式与时间线验收', status: 'pending', ownerId: testerId, ready: false },
  ];
  function teamFor(lead, members, teamTasks) {
    return {
      members: [{ id: lead, name: 'lead', role: 'lead', phase: 'active' }]
        .concat(members.map((m) => ({ id: m.id, name: m.name, role: 'member', phase: m.phase || 'active' }))),
      tasks: teamTasks || tasks,
    };
  }
  const team1 = teamFor(leadId, [
    { id: pmId, name: 'pm' }, { id: designerId, name: 'designer2' },
    { id: fullstackId, name: 'fullstack2' }, { id: testerId, name: 'tester2', phase: 'provisioning' },
  ]);
  const team2 = teamFor(lead2Id, [{ id: pm2Id, name: 'pm2' }], [
    { id: 'task-9', subject: '[规划] 二号项目 PRD', status: 'completed', ownerId: pm2Id },
  ]);

  sessions.list.set({
    ids: [leadId, lead2Id],
    byId: {
      [leadId]: { id: leadId, displayTitle: '移动端 UI 重设计', running: true, updatedAt: 1000, projectionValues: {} },
      [lead2Id]: { id: lead2Id, displayTitle: '二号项目', running: false, updatedAt: 500, projectionValues: {} },
    },
    phase: 'ready',
    projectionsBySession: {
      [leadId]: { values: { agentTeam: team1 } },
      [lead2Id]: { values: { agentTeam: team2 } },
    },
  });

  const face = typeof main.config.inject === 'function' ? main.config.inject() : (main.config.inject || {});
  const rawLoadOlder = face.loadOlder;
  face.loadOlder = function () {
    window.__actions.loadOlder += 1;
    return typeof rawLoadOlder === 'function' ? rawLoadOlder.apply(null, arguments) : undefined;
  };
  const useTeamTeams = (selector) => React.useSyncExternalStore(face.hooks.teams.subscribe, () => selector(face.hooks.teams.getSnapshot()));
  const useTeamDetail = (selector) => React.useSyncExternalStore(face.hooks.detail.subscribe, () => selector(face.hooks.detail.getSnapshot()));
  function Root() {
    return h(main.Component, Object.assign({}, face, { useTeams: useTeamTeams, useDetail: useTeamDetail }));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(Root));

  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
  };
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  window.__metrics = function metrics() {
    const root = q('[data-testid="devbot-root"]');
    const chat = q('[data-testid="chat-scroll"]');
    const status = q('[data-testid="status-bar"]');
    const statusText = status ? status.querySelector('.devbot-status-text') : null;
    const st = statusText ? getComputedStyle(statusText) : null;
    const teams = q('.devbot-teams');
    const side = q('.devbot-side');
    const tabs = q('[data-testid="tabs"]');
    const drawer = q('[data-testid="project-drawer"]');
    const activePanel = q('.devbot-panel[data-active="true"]');
    const kinds = qa('[data-kind]').map((n) => n.getAttribute('data-kind'));
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      theme: document.documentElement.getAttribute('data-theme'),
      page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      root: root ? {
        rect: rect(root), scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
        scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
        color: getComputedStyle(root).color, bg: getComputedStyle(root).backgroundColor,
        projects: root.getAttribute('data-projects'), view: root.getAttribute('data-view'),
      } : null,
      chat: chat ? {
        rect: rect(chat), scrollWidth: chat.scrollWidth, clientWidth: chat.clientWidth,
        clientHeight: chat.clientHeight, scrollHeight: chat.scrollHeight,
        scrollTop: Math.round(chat.scrollTop), visible: visible(chat),
      } : null,
      statusBar: status ? { visible: visible(status), rect: rect(status) } : null,
      status: statusText ? {
        text: statusText.textContent, rect: rect(statusText),
        lineHeight: st.lineHeight, whiteSpace: st.whiteSpace,
        scrollWidth: statusText.scrollWidth, clientWidth: statusText.clientWidth,
      } : null,
      teams: teams ? { visible: visible(teams), rect: rect(teams) } : null,
      side: side ? { visible: visible(side), rect: rect(side) } : null,
      tabs: tabs ? { visible: visible(tabs), rect: rect(tabs) } : null,
      drawer: drawer ? { visible: visible(drawer) } : null,
      projectItems: qa('[data-testid^="team-item"]').filter(visible).length,
      reconnect: document.body.textContent.includes('正在重新连接…'),
      activePanel: activePanel ? activePanel.getAttribute('aria-label') : null,
      heads: qa('.devbot-member-head').length,
      bubbles: qa('.devbot-bubble').length,
      userBubbles: qa('[data-kind="user"] .devbot-bubble').length,
      assistantBubbles: qa('[data-kind="assistant"] .devbot-bubble').length,
      headings: qa('.devbot-md h1, .devbot-md h2, .devbot-md h3').length,
      codeblocks: qa('.devbot-codeblock pre').length,
      links: qa('.devbot-md a').map((a) => a.getAttribute('href')),
      // v0.5.4 GFM 扩展
      tables: qa('.devbot-md .devbot-table table').length,
      tableRows: qa('.devbot-md .devbot-table tbody tr').length,
      checkboxes: qa('.devbot-md input[type=checkbox]').length,
      checkedBoxes: qa('.devbot-md input[type=checkbox]:checked').length,
      dels: qa('.devbot-md del').length,
      typing: qa('.devbot-typing').length,
      days: qa('.devbot-day').map((d) => d.textContent),
      kinds,
      // AC-24：@收件人 chip（代码按会话归属生成，不靠提示词）
      mentions: qa('.devbot-at').map((node) => {
        const owner = node.closest('[data-kind]');
        return {
          name: node.getAttribute('data-mention'),
          text: String(node.textContent || ''),
          kind: owner ? owner.getAttribute('data-kind') : null,
          row: owner ? String(owner.textContent || '').slice(0, 80) : '',
        };
      }),
      text: document.body.textContent,
      buttons: qa('[data-testid="devbot-root"] button').filter(visible).map((b) => ({
        id: b.getAttribute('data-testid') || (b.className || '').split(' ')[0] || String(b.textContent || '').trim().slice(0, 8),
        w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height),
      })),
    };
  };

  window.__scrollChat = function (fraction) {
    const el = q('[data-testid="chat-scroll"]');
    if (!el) return null;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.max(0, Math.round(max * fraction));
    return { top: el.scrollTop, max };
  };
  window.__scrollChatTop = function () {
    const el = q('[data-testid="chat-scroll"]');
    if (!el) return null;
    el.scrollTop = 0;
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  };
  window.__click = function (selector) {
    const el = q(selector);
    if (!el) return false;
    el.click();
    return true;
  };
  window.__stagger = function () {
    const snap = sessions.list.getSnapshot();
    const team = snap.projectionsBySession[leadId].values.agentTeam;
    if (team.members.some((m) => m.id === 'S-late')) return false;
    const members = team.members.concat([{ id: 'S-late', name: 'late', role: 'member', phase: 'active' }]);
    sessions.list.set(Object.assign({}, snap, {
      projectionsBySession: Object.assign({}, snap.projectionsBySession, {
        [leadId]: { values: Object.assign({}, snap.projectionsBySession[leadId].values, { agentTeam: Object.assign({}, team, { members }) }) },
      }),
    }));
    return true;
  };
  window.__appendNew = function () {
    const rec = recs.get(leadId);
    if (!rec || !rec.opened) return false;
    rec.eventSource.append(ev({
      type: 'assistant/message', seq: 9001, time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '上滑之后到达的新消息' }] } },
    }));
    return true;
  };
  window.__breakList = function () {
    sessions.list.set({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} });
    return true;
  };
  window.__switchTeam = function (teamId) {
    const el = q('[data-testid="team-item"][data-team-id="' + teamId + '"]');
    if (!el) return false;
    el.click();
    return true;
  };
  window.__ready = true;
  console.log('[responsive] harness ready');
})();
`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
  if (url.pathname === '/') return send('text/html; charset=utf-8', HTML)
  if (url.pathname === '/react.js') return send('text/javascript', readFileSync(REACT))
  if (url.pathname === '/react-dom.js') return send('text/javascript', readFileSync(REACT_DOM))
  if (url.pathname === '/client.js') return send('text/javascript', readFileSync(CLIENT_PATH))
  if (url.pathname === '/harness.js') return send('text/javascript', HARNESS)
  res.writeHead(404); res.end('nope')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const { chromium } = await import(PW)
const browser = await chromium.launch({ headless: true })

const report = {
  generatedAt: new Date().toISOString(), client: CLIENT_PATH, playwright: PW,
  screens: {}, checks: [], shots: [], failures: [], ok: false,
}
const failures = []
function check(name, condition, detail) {
  report.checks.push({ name, pass: !!condition, detail: condition ? undefined : detail })
  if (!condition) failures.push({ name, detail })
}

const screenshot = async (page, name) => {
  const path = `${OUT_DIR}${name}.png`
  await page.screenshot({ path })
  report.shots.push(path)
  return path
}

async function newPage(width, height, theme) {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  const dialogs = []
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('[console] ' + msg.text()) })
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}) })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  if (theme === 'light') await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light') })
  await page.waitForFunction('window.__ready === true && document.querySelector("[data-testid=message-list]") !== null', null, { timeout: 9000 })
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]')
    return el && el.scrollHeight > el.clientHeight
  }, null, { timeout: 9000 })
  await page.waitForTimeout(250)
  return { page, errors, dialogs }
}

const metrics = (page) => page.evaluate(() => window.__metrics())

try {
  // ---------------------------------------------------------------- 各宽度几何
  const configs = [
    [375, 844], [390, 844], [430, 844], [600, 900], [768, 900], [899, 900],
    [900, 900], [1024, 900], [1280, 900], [1440, 900],
  ]
  for (const [width, height] of configs) {
    const theme = (width === 375 || width === 1280) ? 'light' : 'dark'
    const { page, errors, dialogs } = await newPage(width, height, theme)
    const m = await metrics(page)
    report.screens[`workbench-${width}-${theme}`] = m

    check(`AC-01 ${width}: 页面无横向溢出`, m.page.scrollWidth <= m.page.clientWidth, { scrollWidth: m.page.scrollWidth, clientWidth: m.page.clientWidth })
    check(`AC-01 ${width}: 工作台根无横向溢出`, m.root.scrollWidth <= m.root.clientWidth + 1, { scrollWidth: m.root.scrollWidth, clientWidth: m.root.clientWidth })
    check(`AC-01 ${width}: 群聊列无横向溢出`, m.chat.scrollWidth <= m.chat.clientWidth + 1, { scrollWidth: m.chat.scrollWidth, clientWidth: m.chat.clientWidth })
    check(`AC-02 ${width}: 群聊宽高 > 0（>=280x300）`, m.chat.visible && m.chat.clientWidth >= 280 && m.chat.clientHeight >= 300, { w: m.chat.clientWidth, h: m.chat.clientHeight, visible: m.chat.visible })
    check(`AC-03 ${width}: 状态条单行且不竖排`, m.statusBar.visible && m.statusBar.rect.w >= 200 && m.status.whiteSpace === 'nowrap' && m.status.rect.h <= 20 && m.status.scrollWidth <= m.status.clientWidth + 1, { bar: m.statusBar, text: m.status })
    check(`AC-03 ${width}: 状态条文案为三态之一`, /正在加载更早消息…|上滑加载更早消息|已到当前会话窗口最早处/.test(m.status.text), m.status.text)

    const bp = width >= 900 ? 'three' : width >= 560 ? 'two' : 'one'
    if (bp === 'three') {
      check(`AC-05 ${width}: 三栏（项目列表 196）`, m.teams.visible && Math.abs(m.teams.rect.w - 196) <= 1, m.teams)
      check(`AC-05 ${width}: 三栏（信息区 252）`, m.side.visible && Math.abs(m.side.rect.w - 252) <= 1, m.side)
      check(`AC-05 ${width}: 移动 tab 隐藏`, m.tabs.visible === false, m.tabs)
    } else if (bp === 'two') {
      check(`AC-05 ${width}: 两栏（项目列表收起）`, m.teams.visible === false, m.teams)
      check(`AC-05 ${width}: 两栏（信息区 252）`, m.side.visible && Math.abs(m.side.rect.w - 252) <= 1, m.side)
      check(`AC-05 ${width}: 移动 tab 隐藏`, m.tabs.visible === false, m.tabs)
      check(`AC-05 ${width}: 顶栏项目切换可见`, (await page.$('[data-testid="project-switcher"]')) !== null)
    } else {
      check(`AC-05 ${width}: 单栏（项目列表/信息区收进 tab）`, m.teams.visible === false && m.side.visible === false, { teams: m.teams, side: m.side })
      check(`AC-05 ${width}: 四段 tab 可见 44 高`, m.tabs.visible && m.tabs.rect.h >= 40 && (await page.$$('[data-testid^="tab-"]')).length === 4, m.tabs)
      check(`AC-06 ${width}: 顶栏按钮 40x40`, (await page.evaluate(() => ['back-btn-mobile', 'refresh-btn-mobile', 'project-switcher'].map((id) => {
        const el = document.querySelector('[data-testid="' + id + '"]')
        if (!el) return { id, ok: false }
        const r = el.getBoundingClientRect()
        return { id, w: Math.round(r.width), h: Math.round(r.height), ok: r.width >= 40 && r.height >= 40 }
      }))).every((b) => b.ok), await page.evaluate(() => ['back-btn-mobile', 'refresh-btn-mobile', 'project-switcher'].map((id) => {
        const el = document.querySelector('[data-testid="' + id + '"]')
        if (!el) return { id, ok: false }
        const r = el.getBoundingClientRect()
        return { id, w: Math.round(r.width), h: Math.round(r.height) }
      })))
    }

    if (width < 900) {
      const small = m.buttons.filter((b) => b.w < 40 || b.h < 40)
      check(`AC-06 ${width}: 所有可见按钮热区 >= 40x40`, small.length === 0, small)
    }

    check(`AC-16 ${width}/${theme}: 正文色与背景色不同（token 生效）`, m.root.color !== m.root.bg, { color: m.root.color, bg: m.root.bg })
    check(`AC-12 ${width}: markdown 标题/代码块/链接渲染`, m.headings >= 1 && m.codeblocks >= 1 && m.links.includes('https://example.com/prd'), { headings: m.headings, codeblocks: m.codeblocks, links: m.links })
    check(`AC-12 ${width}: GFM 表格渲染（无原始管道文本，3 表体行）`,
      m.tables === 1 && m.tableRows === 3 && !m.text.includes('|---|') && !m.text.includes('| 7 |'),
      { tables: m.tables, tableRows: m.tableRows })
    check(`AC-12 ${width}: 任务列表复选框（[x] 勾选；Lead+pm 两条消息共 4 个）`, m.checkboxes === 4 && m.checkedBoxes === 2, { checkboxes: m.checkboxes, checkedBoxes: m.checkedBoxes })
    check(`AC-12 ${width}: 删除线/下划线粗体/裸链接自动链接`,
      m.dels >= 1 && m.links.includes('https://example.com/bare-link') && m.text.includes('下划线粗体'),
      { dels: m.dels, bare: m.links.includes('https://example.com/bare-link') })
    check(`AC-13 ${width}: 用户胶囊存在且 assistant 无气泡`, m.userBubbles >= 1 && m.assistantBubbles === 0, { userBubbles: m.userBubbles, assistantBubbles: m.assistantBubbles })
    const memberRows = m.kinds.filter((k) => k === 'assistant' || k === 'member' || k === 'stream').length
    check(`AC-13 ${width}: 连续发送者合并成员头`, m.heads > 0 && m.heads < memberRows, { heads: m.heads, memberRows })
    // AC-24：@收件人由代码按「消息落在哪个会话」生成，不靠 persona/提示词让成员手写 @。
    const relayToPm = m.mentions.find((x) => x.name === 'pm' && x.kind === 'member')
    const relayToLead = m.mentions.find((x) => x.name === 'lead' && x.kind === 'member')
    const dispatchToPm = m.mentions.find((x) => x.name === 'pm' && x.kind === 'dispatch')
    const userToLead = m.mentions.find((x) => x.name === 'lead' && x.kind === 'user')
    check(`AC-24 ${width}: 投递副本显示 @收件人（lead→@pm / pm→@lead）`,
      !!relayToPm && !!relayToLead && relayToPm.text === '@pm' && relayToLead.text === '@lead'
        && m.text.includes('请先出 PRD v0.2') && m.text.includes('PRD v0.2 已落盘'),
      { relayToPm, relayToLead })
    check(`AC-24 ${width}: 派单/用户消息也显示 @收件人`, !!dispatchToPm && !!userToLead, { dispatchToPm, userToLead })
    check(`AC-24 ${width}: 成员 assistant 旁白不伪造 @`, m.mentions.every((x) => x.kind !== 'assistant'),
      m.mentions.filter((x) => x.kind === 'assistant'))
    check(`AC-14 ${width}: 流式行 + 输入中指示`, m.kinds.includes('stream') && m.typing >= 1, { kinds: m.kinds, typing: m.typing })
    check(`AC-14 ${width}: 日分隔存在（跨天）`, m.days.length >= 1, m.days)
    check(`AC-15 ${width}: XSS 未执行（无 dialog）`, dialogs.length === 0, dialogs)
    check(`AC-15 ${width}: 注入文本仅作纯文本`, m.text.includes('<script>alert("xss")</script>') && m.text.includes('<img src=x onerror=alert(1)>'), { hasScriptText: m.text.includes('<script>alert("xss")</script>') })
    const hard = errors.filter((t) => !/style property during rerender|Warning:/.test(t))
    check(`AC-18 ${width}: 首屏打开即贴底`, m.chat.scrollTop >= (m.chat.scrollHeight - m.chat.clientHeight) - 2, { top: m.chat.scrollTop, max: m.chat.scrollHeight - m.chat.clientHeight })
    check(`AC-17 ${width}: 运行期无未捕获错误`, hard.length === 0, hard)

    await screenshot(page, `workbench-${width}-${theme}`)
    if (width === 1280 && theme === 'light') {
      // v0.5.4：滚到时间线顶部，留一张 GFM 表格/任务列表的视觉回归截图
      await page.evaluate(() => { const el = document.querySelector('[data-testid="chat-scroll"]'); if (el) el.scrollTop = 520 })
      await page.waitForTimeout(150)
      await screenshot(page, 'workbench-1280-md-top')
    }
    await page.close()
  }

  // ---------------------------------------------------------------- 交互：390 单栏
  {
    const { page, dialogs } = await newPage(390, 844, 'dark')
    // AC-07 抽屉
    await page.click('[data-testid="project-switcher"]')
    await page.waitForTimeout(250)
    let m = await metrics(page)
    check('AC-07 390: 点项目名打开底部抽屉', m.drawer.visible && m.root.projects === 'open', m.drawer)
    await screenshot(page, 'workbench-390-drawer')
    await page.click('[data-testid="project-mask"]')
    await page.waitForTimeout(250)
    m = await metrics(page)
    check('AC-07 390: 点遮罩关闭且不切换团队', m.root.projects === 'closed' && m.text.includes('移动端 UI 重设计'), { projects: m.root.projects })
    await page.click('[data-testid="project-switcher"]')
    await page.waitForTimeout(250)
    await page.click('[data-testid="team-item-drawer"][data-team-id="S-lead2"]')
    await page.waitForTimeout(700)
    m = await metrics(page)
    check('AC-07 390: 抽屉内切换团队成功', m.text.includes('二号项目的独立时间线内容'), { text: m.text.slice(0, 80) })
    check('AC-07 390: 切换后无旧团队消息残留', !m.text.includes('实现进度'), { hasOld: m.text.includes('实现进度') })
    await page.click('[data-testid="project-switcher"]')
    await page.waitForTimeout(200)
    await page.click('[data-testid="team-item-drawer"][data-team-id="S-lead"]')
    await page.waitForTimeout(700)
    m = await metrics(page)

    // AC-08 切 tab 保 scrollTop
    await page.evaluate(() => window.__scrollChat(0.35))
    await page.waitForTimeout(200)
    const before = await metrics(page)
    await page.click('[data-testid="tab-gates"]')
    await page.waitForTimeout(300)
    m = await metrics(page)
    check('AC-08 390: 切到阶段门后 chat 隐藏、阶段门显示 5 行', m.chat.visible === false && m.activePanel === '阶段门' && (await page.$$('.devbot-gate')).length === 5, { chat: m.chat.visible, activePanel: m.activePanel })
    await screenshot(page, 'workbench-390-tab-gates')
    await page.click('[data-testid="tab-tasks"]')
    await page.waitForTimeout(250)
    m = await metrics(page)
    check('AC-08 390: 任务 tab 显示任务板', m.activePanel === '任务' && (await page.$$('.devbot-task')).length === 5, { activePanel: m.activePanel })
    await screenshot(page, 'workbench-390-tab-tasks')
    await page.click('[data-testid="tab-members"]')
    await page.waitForTimeout(250)
    m = await metrics(page)
    check('AC-08 390: 成员 tab 显示 5 名成员', m.activePanel === '成员' && (await page.$$('.devbot-member-row')).length === 5, { activePanel: m.activePanel })
    await screenshot(page, 'workbench-390-tab-members')
    await page.click('[data-testid="tab-chat"]')
    await page.waitForTimeout(350)
    const after = await metrics(page)
    check('AC-08 390: 切回群聊 scrollTop 保持 ±2px', Math.abs(after.chat.scrollTop - before.chat.scrollTop) <= 2, { before: before.chat.scrollTop, after: after.chat.scrollTop })

    // AC-09 上滑加载更早：只触发一次、到最早不再触发
    const callsBefore = await page.evaluate(() => window.__actions.loadOlder)
    await page.evaluate(() => window.__scrollChatTop())
    await page.waitForTimeout(700)
    const callsAfter = await page.evaluate(() => window.__actions.loadOlder)
    m = await metrics(page)
    check('AC-09 390: 上滑到顶触发一次 loadOlder', callsAfter === callsBefore + 1, { before: callsBefore, after: callsAfter })
    check('AC-09 390: 加载后状态条为「已到最早」', m.status.text === '已到当前会话窗口最早处', m.status.text)
    check('AC-09 390: 更早消息已出现', m.text.includes('更早消息'), { hasOlder: m.text.includes('更早消息') })
    await page.evaluate(() => window.__scrollChatTop())
    await page.waitForTimeout(500)
    const callsAgain = await page.evaluate(() => window.__actions.loadOlder)
    check('AC-09 390: 到最早后不再触发加载', callsAgain === callsAfter, { callsAgain })
    check('AC-15 390: 交互后仍无 XSS dialog', dialogs.length === 0, dialogs)

    // AC-11 会话列表暂时不可读：保留现有列表 + 正在重新连接…
    await page.evaluate(() => window.__breakList())
    await page.waitForTimeout(400)
    await page.click('[data-testid="project-switcher"]')
    await page.waitForTimeout(300)
    m = await metrics(page)
    check('AC-11 390: 列表不可读时保留现有项目', m.projectItems >= 2, { projectItems: m.projectItems })
    check('AC-11 390: 显示「正在重新连接…」', m.reconnect === true, { reconnect: m.reconnect })
    check('AC-11 390: 不误判为空列表', !m.text.includes('还没有带 Team 的会话'), { text: m.text.slice(0, 120) })
    await screenshot(page, 'workbench-390-reconnect')
    await page.close()
  }

  // ---------------------------------------------------------------- 交互：390 首屏贴底 + 晚到会话 prepend（AC-18）
  {
    const { page } = await newPage(390, 844, 'dark')
    let m = await metrics(page)
    const max0 = m.chat.scrollHeight - m.chat.clientHeight
    check('AC-18 390: 首次打开即贴底', max0 > 0 && m.chat.scrollTop >= max0 - 2, { top: m.chat.scrollTop, max: max0 })
    const rowsBefore = m.kinds.length
    const staggerOk = await page.evaluate(() => window.__stagger())
    await page.waitForTimeout(900)
    m = await metrics(page)
    const max1 = m.chat.scrollHeight - m.chat.clientHeight
    check('AC-18 390: 晚到成员会话异步 open 后仍贴底', staggerOk === true && m.kinds.length > rowsBefore && m.chat.scrollTop >= max1 - 2, { rowsBefore, rowsAfter: m.kinds.length, top: m.chat.scrollTop, max: max1 })
    check('AC-18 390: 晚到会话旧消息已插入', m.text.includes('晚到成员会话的旧消息'), { hasLate: m.text.includes('晚到成员会话的旧消息') })
    await screenshot(page, 'workbench-390-stagger')

    // 上滑离开底部后，新消息不得拉回
    await page.evaluate(() => window.__scrollChat(0.3))
    await page.waitForTimeout(250)
    const mid = await metrics(page)
    const appended = await page.evaluate(() => window.__appendNew())
    await page.waitForTimeout(600)
    const after = await metrics(page)
    check('AC-18 390: 上滑后新消息不拉回', appended === true && Math.abs(after.chat.scrollTop - mid.chat.scrollTop) <= 2, { before: mid.chat.scrollTop, after: after.chat.scrollTop })
    await page.close()
  }

  // ---------------------------------------------------------------- 交互：768 两栏浮层
  {
    const { page } = await newPage(768, 900, 'dark')
    await page.click('[data-testid="project-switcher"]')
    await page.waitForTimeout(250)
    const m = await metrics(page)
    check('AC-07 768: 顶栏项目名打开浮层', m.drawer.visible && m.root.projects === 'open', m.drawer)
    await screenshot(page, 'workbench-768-drawer')
    await page.click('[data-testid="project-mask"]')
    await page.waitForTimeout(200)
    const m2 = await metrics(page)
    check('AC-07 768: 点遮罩关闭', m2.root.projects === 'closed', m2.root.projects)
    await page.close()
  }

  // ---------------------------------------------------------------- 交互：1280 三栏
  {
    const { page } = await newPage(1280, 900, 'light')
    const m = await metrics(page)
    check('AC-17 1280: 三栏宽度 196 / 252', Math.abs(m.teams.rect.w - 196) <= 1 && Math.abs(m.side.rect.w - 252) <= 1, { teams: m.teams.rect, side: m.side.rect })
    check('AC-17 1280: 群聊在中间且 > 300 宽', m.chat.visible && m.chat.clientWidth > 300, { w: m.chat.clientWidth })
    await page.click('[data-testid="side-tab-tasks"]')
    await page.waitForTimeout(250)
    const m2 = await metrics(page)
    check('AC-17 1280: 桌面信息区切任务，群聊不消失', m2.activePanel === '任务' && m2.chat.visible, { activePanel: m2.activePanel, chat: m2.chat.visible })
    await screenshot(page, 'workbench-1280-light')
    await page.close()
  }

  // ---------------------------------------------------------------- 桌面 1440 三栏
  {
    const { page } = await newPage(1440, 900, 'dark')
    const m = await metrics(page)
    check('AC-05 1440: 三栏', m.teams.visible && m.side.visible && m.chat.visible, { teams: m.teams.visible, side: m.side.visible })
    check('AC-12 1440: 桌面正文列 <= 760', await page.evaluate(() => {
      const inner = document.querySelector('.devbot-stream-inner')
      return inner ? inner.getBoundingClientRect().width <= 761 : false
    }), await page.evaluate(() => {
      const inner = document.querySelector('.devbot-stream-inner')
      return inner ? Math.round(inner.getBoundingClientRect().width) : null
    }))
    await page.close()
  }
} catch (error) {
  report.failure = String(error && error.stack ? error.stack : error)
} finally {
  await browser.close()
  server.close()
}

report.failures = failures
report.ok = failures.length === 0 && !report.failure
writeFileSync(`${OUT_DIR}report-responsive.json`, JSON.stringify(report, null, 2))

if (jsonOnly) {
  console.log(JSON.stringify({ ok: report.ok, failures, shots: report.shots, failure: report.failure }))
} else {
  console.log(`[responsive] 检查 ${report.checks.length} 项，失败 ${failures.length} 项`)
  for (const f of failures) console.log('  ✖', f.name, JSON.stringify(f.detail))
  console.log('截图：', report.shots.length, '张 →', OUT_DIR)
  if (report.failure) console.log('failure:', report.failure)
  console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL')
}
process.exit(report.ok ? 0 : 1)
