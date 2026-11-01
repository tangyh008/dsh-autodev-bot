#!/usr/bin/env node
/**
 * DevBot v0.5 真实渲染验收器（Playwright，test-only，不改产品代码）。
 *
 * 目标：在无头 Chromium 里加载**真实 client.js** + 真实 React，用 fake sessions
 * 复刻 DSH Session Controller 语义（异步 open / retain-release / loadOlder /
 * 流式 settle），逐条覆盖 docs/prd-ui-v0.5.md §13 的 AC-01 ~ AC-23。
 *
 * 设计原则（为适配未知的 v0.5 DOM）：
 *  - 语义优先：按可见文案（群聊/阶段门/任务/成员/刷新/回到会话/状态条文案）
 *    与几何（栏位宽度、滚动容器、热区）定位；`data-testid` 是加分项而非硬依赖。
 *  - 断言分三层：① Node/静态检查（diff 范围、依赖、硬编码、XSS 静态）；② 真实
 *    DOM/几何/交互（断点、溢出、滚动、tab、抽屉、热区）；③ 控制器 store 语义
 *    （选中团队、行数、hasMore/loadingOlder），避免只看截图。
 *  - 证据入库：截图写 test/browser/out/v0.5/，报告写同目录 report.json；每条
 *    check 带 detail（实测数值），FAIL 可直接抄进 docs/test-report-ui-v0.5.md。
 *
 * 用法：
 *   node test/browser/workbench-visual.mjs                 # 全量
 *   node test/browser/workbench-visual.mjs --json          # 只输出 JSON 摘要
 *   node test/browser/workbench-visual.mjs --ac AC-01,AC-02
 *   node test/browser/workbench-visual.mjs --client <path> # 红/绿对照
 *   node --test test/*.test.mjs                            # AC-20（runner 也会跑）
 * 环境：
 *   DSH_CHECKOUT=/path/to/deepseek-harness   # 提供 React UMD + Playwright
 *   DEVBOT_BASELINE_DIR=/path/to/baseline    # AC-23 基线（task-4 开工前快照）
 *
 * 基线约定：AC-23 的 diff 以「task-4 开工前」为基线，而不是 git HEAD（仓库在
 * task-4 之前已有未提交的 v0.5.1 preset 桥改动）。基线目录需含：
 *   package.json.baseline, client.js.baseline, test.baseline/, git-status.baseline,
 *   baseline-before-task4.txt（含 tracked file sha256）。
 * 缺基线时 runner 会 FAIL AC-23 并给出生成命令，不会静默放行。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH = process.env.DSH_CHECKOUT
if (!DSH) {
  console.error('需要 DSH_CHECKOUT 环境变量指向 deepseek-harness checkout（浏览器回归依赖其 node_modules/Playwright）')
  process.exit(1)
}
const PNPM_DIR = `${DSH}/node_modules/.pnpm`
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const OUT = join(ROOT, 'test', 'browser', 'out', 'v0.5')
const BASELINE = process.env.DEVBOT_BASELINE_DIR || '/tmp/devbot-tester2'

const argv = process.argv.slice(2)
const jsonOnly = argv.includes('--json')
const smokeOnly = argv.includes('--smoke')
const clientPath = argv.includes('--client') ? argv[argv.indexOf('--client') + 1] : join(ROOT, 'client.js')
const acFilter = argv.includes('--ac') ? new Set(argv[argv.indexOf('--ac') + 1].split(',').map((s) => s.trim())) : null

/** 在 DSH checkout 的 pnpm store 里找包目录（优先稳定版）。 */
function pnpmPackage(packageName) {
  if (!existsSync(PNPM_DIR)) throw new Error(`找不到 ${PNPM_DIR}；请先在 DSH checkout 执行 pnpm install`)
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
const { chromium } = await import(PW)

mkdirSync(OUT, { recursive: true })

/* ------------------------------------------------------------------ *
 * 0. 主题 token（来自 docs/dsh-ui-style-spec.md §9；只用于测试宿主，
 *    产品代码必须自己引用 --dsw-alias-*，不得依赖本文件）
 * ------------------------------------------------------------------ */
const TOKENS = {
  dark: {
    '--dsw-alias-label-primary': '#F9FAFB',
    '--dsw-alias-label-secondary': '#CFD3D6',
    '--dsw-alias-label-tertiary': '#ADB2B8',
    '--dsw-alias-label-caption': '#81858C',
    '--dsw-alias-bg-base': '#151517',
    '--dsw-alias-bg-layer-1': '#232324',
    '--dsw-alias-bg-layer-2': '#2C2C2E',
    '--dsw-alias-bg-overlay': '#61666B',
    '--dsw-alias-border-l1': 'rgba(255,255,255,.06)',
    '--dsw-alias-border-l2': 'rgba(255,255,255,.12)',
    '--dsw-alias-border-l3': 'rgba(255,255,255,.16)',
    '--dsw-alias-border-l4': 'rgba(255,255,255,.20)',
    '--dsw-alias-link': '#7AAAFF',
    '--dsw-alias-state-success-primary': '#22C55E',
    '--dsw-alias-state-warn-primary': '#F59E0B',
    '--dsw-alias-state-error-primary': '#F25A5A',
    '--dsw-alias-markdown-code-block': '#1B1B1C',
    '--dsw-alias-markdown-code-block-banner': '#2C2C2E',
    '--dsw-alias-markdown-inline-code': '#292929',
    '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.08)',
    '--dsw-specific-bubble': '#2C2C2E',
    '--dsw-radius-xs': '4px',
    '--dsw-radius-sm': '8px',
    '--dsw-radius-md': '12px',
    '--dsw-radius-lg': '16px',
    '--dsw-radius-xl': '20px',
    '--dsw-radius-panel': '28px',
  },
  light: {
    '--dsw-alias-label-primary': '#0F1115',
    '--dsw-alias-label-secondary': '#61666B',
    '--dsw-alias-label-tertiary': '#81858C',
    '--dsw-alias-label-caption': '#ADB2B8',
    '--dsw-alias-bg-base': '#FFFFFF',
    '--dsw-alias-bg-layer-1': '#FFFFFF',
    '--dsw-alias-bg-layer-2': '#FFFFFF',
    '--dsw-alias-bg-overlay': '#E9ECF2',
    '--dsw-alias-border-l1': 'rgba(0,0,0,.04)',
    '--dsw-alias-border-l2': 'rgba(0,0,0,.10)',
    '--dsw-alias-border-l3': 'rgba(0,0,0,.12)',
    '--dsw-alias-border-l4': 'rgba(0,0,0,.16)',
    '--dsw-alias-link': '#4176E6',
    '--dsw-alias-state-success-primary': '#22C55E',
    '--dsw-alias-state-warn-primary': '#F59E0B',
    '--dsw-alias-state-error-primary': '#EC1313',
    '--dsw-alias-markdown-code-block': '#F9FAFB',
    '--dsw-alias-markdown-code-block-banner': '#F9FAFB',
    '--dsw-alias-markdown-inline-code': '#FAFAFA',
    '--dsw-alias-interactive-bg-hover': 'rgba(38,49,72,.06)',
    '--dsw-specific-bubble': '#EDF3FE',
    '--dsw-radius-xs': '4px',
    '--dsw-radius-sm': '8px',
    '--dsw-radius-md': '12px',
    '--dsw-radius-lg': '16px',
    '--dsw-radius-xl': '20px',
    '--dsw-radius-panel': '28px',
  },
}

const tokenCss = (selector, tokens) => selector + '{' + Object.entries(tokens)
  .map(([key, value]) => `${key}:${value};`).join('') + '}'

const BASE_CSS = `
html,body{margin:0;padding:0;height:100%;}
body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
#root{height:100%;min-height:0;display:flex;flex-direction:column;}
*{box-sizing:border-box;}
:root{--dsh-frame-top-clearance:0px;color-scheme:dark;}
[data-theme="light"]{color-scheme:light;}
${tokenCss(':root', TOKENS.dark)}
${tokenCss('[data-theme="light"]', TOKENS.light)}
`

const HTML = `<!doctype html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>devbot v0.5 acceptance harness</title>
<style>${BASE_CSS}</style></head>
<body><div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>window.__ModuleLoader__={load(m){window.__pluginModule=m}};</script>
<script src="/client.js"></script>
<script src="/harness.js"></script>
</body></html>`

/* ------------------------------------------------------------------ *
 * 1. 浏览器 harness：fake sessions + 真实 client.js 组件
 * ------------------------------------------------------------------ */
const HARNESS = String.raw`
(async function () {
  'use strict';
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  var h = React.createElement;
  var mod = window.__pluginModule;
  var errors = [];
  window.addEventListener('error', function (e) { errors.push('error: ' + (e.message || e)); });
  window.addEventListener('unhandledrejection', function (e) { errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)); });
  if (!mod || typeof mod.factory !== 'function') { window.__fatal = 'client.js did not register module'; return; }
  var plugin = mod.factory(function require(id) {
    if (id === 'react') return window.React;
    throw new Error('unknown require: ' + id);
  });
  var internals = plugin._internals || {};
  var makeStore = internals.createStore;
  if (typeof makeStore !== 'function') { window.__fatal = 'client.js has no _internals.createStore'; return; }

  var NOW = Date.now();
  var DAY = 86400000;
  var query = new URLSearchParams(location.search);
  var scenario = query.get('scenario') || 'default';

  var leadId = 'S-lead';
  var pmId = 'S-pm';
  var designerId = 'S-designer';
  var fullstackId = 'S-fullstack';
  var testerId = 'S-tester';
  var lead2Id = 'S-lead2';
  var pm2Id = 'S-pm2';
  var failSids = new Set();
  if (scenario === 'memberFail') failSids.add(testerId);

  var counters = { retain: 0, release: 0, open: 0, drop: 0, loadOlder: 0, loadOlderBySid: {}, refresh: 0, back: 0 };
  var recs = new Map();
  var loadOlderFail = false;
  var listUnreadable = false;
  var refreshResolve = null;
  var backCalls = [];
  var probe = null;

  /* ---------- 事件构造 ---------- */
  function event(type, seq, time, data, surfaceOp) {
    return { type: 'event', event: { type: type, seq: seq, time: time, surfaceOp: surfaceOp || 'append', data: data || {} } };
  }
  function userMsg(text, seq, time, source, extra) {
    return event('user/message', seq, time, {
      source: Object.assign({ kind: 'user' }, source || {}),
      content: [{ type: 'text', text: text }],
    });
  }
  function assistantMsg(text, seq, time) {
    return event('assistant/message', seq, time, { message: { content: [{ type: 'text', text: text }] } });
  }
  function memberEvent(name, phase, seq, time, error) {
    return event('team/member', seq, time, { member: { id: name + '-id', name: name, phase: phase, error: error } });
  }
  function taskEvent(id, subject, status, seq, time) {
    return event('team/task', seq, time, { task: { id: id, subject: subject, status: status, ownerId: 'S-pm' } });
  }
  function transient(attemptId, text, time) {
    return { type: 'transient', event: { type: 'assistant/live', time: time || Date.now(), data: { attemptId: attemptId, chunk: { type: 'text-delta', text: text } } } };
  }

  /* ---------- 每个会话的持久日志 ---------- */
  var FENCE = String.fromCharCode(96, 96, 96);
  var entriesBySession = {};
  var olderBySession = {};
  var hasMoreBySession = {};

  // Lead：人类/系统/派单/助手 markdown/XSS/日分隔/跨会话去重源
  entriesBySession[leadId] = [
    userMsg('[[human]] 这是人类在群里发的一条消息，请按阶段门推进。', 1, NOW - 4 * DAY),
    assistantMsg('[[day3]] 三天前的回复，用于验证日分隔（M月D日）。', 2, NOW - 4 * DAY + 60000),
    assistantMsg('[[assistant-lead]] 收到，先对齐方向：这一段是 Lead 会话里的 assistant 正文。', 3, NOW - 3 * DAY),
    memberEvent('pm', 'active', 4, NOW - 3 * DAY + 60000),
    taskEvent('task-1', '[[sys-task]] 需求分析', 'completed', 5, NOW - 3 * DAY + 120000),
    assistantMsg('[[md-simple]] 标题示例段落，**粗体** 与 *斜体* 与行内代码都在这一段里。', 6, NOW - 3 * DAY + 180000),
    event('user/message', 8, NOW - 2 * DAY + 60000, {
      source: { kind: 'agent-message', senderSessionId: pmId, senderName: 'pm' },
      content: [{ type: 'text', text: 'Team message from pm:\n[[relay-msg]] 这是 pm 经 Lead 会话投递的群消息。' }],
    }),
    assistantMsg('[[day2]] 昨天的回复，用于验证日分隔（昨天）。', 9, NOW - DAY - 3600000),
    assistantMsg('[[dedupe2]] 甲（与 pm 会话里的乙不同，不能被去重吞掉）。', 8.5, NOW - DAY - 3500000),
    event('user/message', 10, NOW - DAY - 3000000, {
      source: { kind: 'agent-message', senderSessionId: pmId, senderName: 'pm' },
      content: [{ type: 'text', text: 'Team message from pm:\n[[dedupe]] 同一条消息：只在目标会话保留一份（去重标记）。' }],
    }),
    assistantMsg('[[day1]] 今天的回复，用于验证日分隔（今天）。', 11, NOW - 7200000),
    assistantMsg('[[xss-script]] 原样文本：<script>window.__xss_script=1</script> 不应执行。', 12, NOW - 7000000),
    assistantMsg('[[xss-img]] 原样文本：<img src=x onerror="window.__xss_img=1"> 不应注入 DOM。', 13, NOW - 6900000),
    assistantMsg('[[longurl]] https://example.com/a/very/long/path/that/should/not/overflow/the/page/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 14, NOW - 6800000),
  ];

  // PM：连续发送者合并、>5min 重新显示头、派单行、markdown 全子集、流式。
  // 头合并块锚定在「同一天且晚于其它会话」的时间槽，避免跨午夜导致 AC-13 抖动。
  var blockDay = new Date(NOW);
  var startOfDay = new Date(NOW);
  startOfDay.setHours(0, 0, 0, 0);
  var blockBase = Math.max(startOfDay.getTime() + 60000, NOW - 600000);
  if (new Date(blockBase).getHours() === 23) {
    blockDay.setHours(20, 0, 0, 0);
    blockBase = blockDay.getTime();
  }
  entriesBySession[pmId] = [
    assistantMsg('[[pm-old]] 昨天的一条成员消息，用于跨日头。', 1, blockBase - DAY - 7200000),
    assistantMsg('[[pm-head-1]] 连续发送 #1：三个连续消息只应显示一个成员头。', 2, blockBase),
    assistantMsg('[[pm-head-2]] 连续发送 #2：正文应左对齐同一 x。', 3, blockBase + 60000),
    assistantMsg('[[pm-head-3]] 连续发送 #3：组内行距收紧。', 4, blockBase + 120000),
    userMsg('[[dispatch]] 派单给 designer：请产出移动端工作台高保真。', 5, blockBase - 600000, { kind: 'user' }),
    assistantMsg('[[md-simple]] 标题示例段落，**粗体** 与 *斜体* 与行内代码都在这一段里。', 6, blockBase + 180000),
    assistantMsg('# 一级标题 [[md]]\n\n## 二级标题\n\n### 三级标题\n\n段落 **粗** *斜体* 与行内码混排。\n\n- 无序一\n- 无序二\n\n1. 有序一\n2. 有序二\n\n> 引用一行\n\n' + FENCE + 'js\nconst a = 1 < 2;\n' + FENCE + '\n\n[安全链接](https://example.com/docs)\n\n[坏链接](javascript:window.__xss_link=1)\n\n---', 7, blockBase + 240000),
    assistantMsg('[[assistant]] 成员 assistant 正文：无气泡、无头像框。', 8, blockBase + 300000),
    assistantMsg('[[dedupe]] 同一条消息：只在目标会话保留一份（去重标记）。', 9, blockBase + 360000),
    assistantMsg('[[dedupe2]] 乙（与 Lead 会话里的甲不同，不能被去重吞掉）。', 10, blockBase + 420000),
    assistantMsg('[[codeblock]] 长代码块开始\n' + FENCE + '\n' + 'x'.repeat(220) + '\n' + FENCE + '\n结束标记 [[codeblock-end]]', 11, blockBase + 480000),
    assistantMsg('[[pm-head-4]] 间隔超过 5 分钟的第四条，应重新显示成员头。', 12, blockBase + 1440000),
    assistantMsg('[[pm-last]] 最新一条 pm 消息，用于贴底跟随与上滑回弹。', 13, blockBase + 1500000),
  ];

  // Designer：markdown 列表/引用/链接/hr/代码块 + 多日
  entriesBySession[designerId] = [
    assistantMsg('[[designer-old]] 前天的设计说明，用于日分隔。', 1, NOW - 2 * DAY - 3600000),
    assistantMsg('[[designer]] 设计稿已产出：design/mobile-workbench.html 与 design/conversation-style.html。', 2, NOW - 2 * DAY - 3500000),
    assistantMsg('[[designer-md]] 对照结论：\n\n- 三断点\n- 四段 tab\n- 用户右侧胶囊\n\n> 差异清单不超过 5 条。', 3, NOW - 2 * DAY - 3400000),
    assistantMsg('[[designer-last]] 今天补充：浅色角色色已加边框。', 4, NOW - 5000000),
  ];

  // Fullstack：实现进度
  entriesBySession[fullstackId] = [
    assistantMsg('[[fullstack]] 实现中：容器查询 + 时间线渲染层，不改 controller。', 1, NOW - 3600000),
    assistantMsg('[[fullstack-last]] 自测：npm test 全绿，Playwright 六档截图入库。', 2, NOW - 3500000),
  ];

  // Tester：成员历史（可配置打开失败）
  entriesBySession[testerId] = [
    assistantMsg('[[tester]] 验收准备：先跑 Node 单测，再跑真实渲染。', 1, NOW - 3400000),
  ];

  // Team 2：项目切换后只应看到这些
  entriesBySession[lead2Id] = [
    assistantMsg('[[teamb]] 二号项目：切换后只应看到本条消息。', 1, NOW - 3000),
  ];
  entriesBySession[pm2Id] = [
    assistantMsg('[[teamb2]] 二号项目 pm2 消息。', 1, NOW - 2500),
  ];

  // 更早窗口（loadOlder）：时间更早，带唯一标记
  function olderEntries(label) {
    var out = [];
    for (var i = 0; i < 18; i += 1) {
      out.push(assistantMsg('[[older-' + label + '-' + i + ']] ' + label + ' 更早消息 ' + i, 1000 + i, NOW - 10 * DAY + i * 60000));
    }
    return out;
  }
  olderBySession[leadId] = olderEntries('lead');
  olderBySession[pmId] = olderEntries('pm');
  olderBySession[designerId] = olderEntries('designer');
  olderBySession[fullstackId] = olderEntries('fullstack');
  hasMoreBySession[leadId] = true;
  hasMoreBySession[pmId] = true;
  hasMoreBySession[designerId] = true;
  hasMoreBySession[fullstackId] = true;

  var ALL_MARKERS = [
    '[[human]]', '[[assistant]]', '[[assistant-lead]]', '[[md]]', '[[md-simple]]', '[[dedupe]]', '[[relay-msg]]', '[[day1]]', '[[day2]]', '[[day3]]',
    '[[xss-script]]', '[[xss-img]]', '[[longurl]]', '[[pm-head-1]]', '[[pm-head-2]]', '[[pm-head-3]]',
    '[[pm-head-4]]', '[[dispatch]]', '[[dedupe2]]', '[[codeblock]]', '[[designer]]', '[[fullstack]]',
    '[[tester]]', '[[teamb]]', '[[teamb2]]', '[[pm-old]]', '[[designer-old]]', '[[designer-last]]',
    '[[pm-last]]', '[[fullstack-last]]', '[[older-lead-0]]', '[[older-pm-0]]',
  ];

  /* ---------- fake Session Controller ---------- */
  function makeGeneration(sid) {
    var rec = {
      id: sid, refs: 0, dropped: false, opened: false,
      entries: scenario === 'emptyChat' ? [] : (entriesBySession[sid] || []).slice(),
      hasMore: scenario === 'emptyChat' ? false : !!hasMoreBySession[sid],
      listeners: new Set(), esListeners: new Set(),
      esSnapshot: { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } },
    };
    function notifyEs() { Array.from(rec.esListeners).forEach(function (cb) { try { cb(); } catch (e) {} }); }
    function publish(kind, payload) {
      rec.esSnapshot = Object.assign({ revision: rec.esSnapshot.revision + 1, change: payload }, {
        entries: rec.entries.slice(), hasMore: rec.hasMore,
      });
      notifyEs();
    }
    rec.eventSource = {
      getSnapshot: function () { return rec.esSnapshot; },
      subscribe: function (cb) { rec.esListeners.add(cb); return function () { rec.esListeners.delete(cb); }; },
      replace: function (entries, hasMore) {
        rec.entries = (entries || []).slice();
        rec.hasMore = hasMore === undefined ? rec.hasMore : !!hasMore;
        publish('replace', { kind: 'replace', entries: rec.entries });
      },
      prepend: function (entries, hasMore) {
        rec.entries = (entries || []).concat(rec.entries);
        rec.hasMore = hasMore === undefined ? rec.hasMore : !!hasMore;
        publish('prepend', { kind: 'prepend', entries: entries || [] });
      },
      append: function (entry) {
        rec.entries = rec.entries.concat([entry]);
        publish('append', { kind: 'append', entries: [entry] });
      },
      settleAssistant: function (attemptId, entry) {
        rec.entries = rec.entries.filter(function (e) {
          return e.type !== 'transient' || e.event.data.attemptId !== attemptId;
        });
        if (entry !== undefined) rec.entries = rec.entries.concat([entry]);
        publish('settle-assistant', { kind: 'settle-assistant', attemptId: attemptId, entry: entry });
      },
    };
    rec.session = {
      getSnapshot: function () {
        return { sessionId: sid, openState: rec.opened ? 'open' : 'idle', openError: null,
          running: false, hasMore: rec.hasMore };
      },
      subscribe: function (cb) { rec.listeners.add(cb); return function () { rec.listeners.delete(cb); }; },
      loadOlder: function () {
        counters.loadOlder += 1;
        counters.loadOlderBySid[sid] = (counters.loadOlderBySid[sid] || 0) + 1;
        if (loadOlderFail) return Promise.reject(new Error('loadOlder failed (test)'));
        if (!rec.opened || !rec.hasMore) return Promise.resolve();
        return new Promise(function (resolve) {
          setTimeout(function () {
            var older = olderBySession[sid] || [];
            rec.hasMore = false;
            hasMoreBySession[sid] = false;
            rec.eventSource.prepend(older, false);
            Array.from(rec.listeners).forEach(function (cb) { try { cb(); } catch (e) {} });
            resolve();
          }, 120);
        });
      },
    };
    rec.binding = { sessionId: sid, session: rec.session, eventSource: rec.eventSource };
    var staggerDelay = scenario === 'stagger'
      ? ({ 'S-pm': 30, 'S-tester': 150, 'S-designer': 300, 'S-fullstack': 500, 'S-lead': 800 }[sid] || 400)
      : 35;
    rec.openPromise = new Promise(function (resolve, reject) {
      rec.openTimer = setTimeout(function () {
        if (rec.dropped) { reject(new Error('released')); return; }
        rec.opened = true;
        counters.open += 1;
        rec.eventSource.replace(rec.entries, rec.hasMore);
        Array.from(rec.listeners).forEach(function (cb) { try { cb(); } catch (e) {} });
        resolve(rec.binding);
      }, staggerDelay);
    });
    rec.openPromise.catch(function () {});
    return rec;
  }

  function dropGeneration(rec) {
    if (rec.dropped) return;
    rec.dropped = true;
    clearTimeout(rec.openTimer);
    if (recs.get(rec.id) === rec) recs.delete(rec.id);
    counters.drop += 1;
  }

  function teamTasks() {
    var list = [
      { id: 'task-1', subject: '[需求] 需求分析', status: 'completed', ownerId: pmId, ownerName: 'pm', ready: true },
      { id: 'task-2', subject: '[规划] 产品规划 PRD', status: 'completed', ownerId: pmId, ownerName: 'pm', ready: true },
      { id: 'task-3', subject: '[设计] 前端设计稿', status: 'completed', ownerId: designerId, ownerName: 'designer', ready: true },
      { id: 'task-4', subject: '[实现] client.js v0.5 响应式 + 时间线', status: 'in_progress', ownerId: fullstackId, ownerName: 'fullstack', ready: true },
      { id: 'task-5', subject: '[[sys-task-2]] [测试] v0.5 验收', status: 'pending', ownerId: testerId, ownerName: 'tester', ready: false },
    ];
    if (scenario === 'longTasks') {
      for (var i = 0; i < 32; i += 1) {
        list.push({ id: 'task-x' + i, subject: '[实现] 长列表任务 ' + i + '（AC-04 滚动到最后）', status: 'pending',
          ownerId: fullstackId, ownerName: 'fullstack', ready: true });
      }
    }
    return list;
  }
  function team1() {
    return {
      members: [
        { id: leadId, name: 'lead', role: 'lead', phase: 'active' },
        { id: pmId, name: 'pm', role: 'member', phase: 'active' },
        { id: designerId, name: 'designer', role: 'member', phase: 'active' },
        { id: fullstackId, name: 'fullstack', role: 'member', phase: 'active' },
        { id: testerId, name: 'tester', role: 'member', phase: scenario === 'memberFail' ? 'failed' : 'active' },
      ],
      tasks: teamTasks(),
    };
  }
  function team2() {
    return {
      members: [
        { id: lead2Id, name: 'lead2', role: 'lead', phase: 'active' },
        { id: pm2Id, name: 'pm2', role: 'member', phase: 'active' },
      ],
      tasks: [{ id: 'task-9', subject: '[规划] 二号项目 PRD', status: 'completed', ownerId: pm2Id, ownerName: 'pm2', ready: true }],
    };
  }
  function listSnapshot() {
    if (scenario === 'pending') return { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} };
    if (scenario === 'emptyList') return { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} };
    var noTeam = scenario === 'noTeam';
    var t1 = noTeam ? { members: [{ id: leadId, name: 'lead', role: 'lead', phase: 'active' }], tasks: [] } : team1();
    var t2 = noTeam ? { members: [{ id: lead2Id, name: 'lead2', role: 'lead', phase: 'active' }], tasks: [] } : team2();
    return {
      ids: [leadId, lead2Id],
      byId: {
        [leadId]: { id: leadId, displayTitle: '移动端 UI 重设计', running: true, updatedAt: 2000, projectionValues: {} },
        [lead2Id]: { id: lead2Id, displayTitle: '支付流程重构', running: false, updatedAt: 1000, projectionValues: {} },
      },
      phase: 'ready',
      projectionsBySession: {
        [leadId]: { values: { agentTeam: t1 } },
        [lead2Id]: { values: { agentTeam: t2 } },
      },
    };
  }

  var listStore = makeStore(listSnapshot());
  var sessions = {
    list: {
      getSnapshot: function () {
        if (listUnreadable) throw new Error('list unreadable (test)');
        return listStore.getSnapshot();
      },
      subscribe: function (cb) { return listStore.subscribe(cb); },
      set: function (next) { listStore.set(next); },
    },
    subagentAddress: function (id) {
      var parent = id === pm2Id ? lead2Id : leadId;
      return { parentSessionId: parent, childSessionId: id, mode: 'subagent' };
    },
    retain: function (target) {
      var sid = typeof target === 'string' ? target : target.childSessionId;
      counters.retain += 1;
      if (failSids.has(sid)) {
        var rejected = Promise.reject(new Error('session/agent-busy (test)'));
        rejected.catch(function () {});
        return { ready: rejected, release: function () { counters.release += 1; } };
      }
      var rec = recs.get(sid);
      if (!rec || rec.dropped) { rec = makeGeneration(sid); recs.set(sid, rec); }
      rec.refs += 1;
      var ready = rec.opened ? Promise.resolve(rec.binding) : rec.openPromise.then(function () { return rec.binding; });
      var released = false;
      return {
        ready: ready,
        release: function () {
          if (released) return;
          released = true;
          counters.release += 1;
          rec.refs -= 1;
          if (rec.refs <= 0) dropGeneration(rec);
        },
      };
    },
    refresh: function () {
      counters.refresh += 1;
      return new Promise(function (resolve) { refreshResolve = resolve; });
    },
  };

  var disposers = [];
  var captured = {};
  var ctx = {
    effect: function (fn) { var d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    slots: {
      inject: function (name, cb) { var d = typeof cb === 'function' ? cb() : undefined; if (typeof d === 'function') disposers.push(d); return d; },
      register: function (config, Component) { captured[config.name + (config.key ? ':' + config.key : '')] = { config: config, Component: Component }; return function () {}; },
    },
    layout: { selectPanel: function (id) { backCalls.push(id); } },
    sessions: sessions,
  };
  plugin.apply(ctx);
  var main = captured['main:devbot'];
  if (!main) { window.__fatal = 'main:devbot component was not registered'; return; }

  var face = typeof main.config.inject === 'function' ? main.config.inject() : (main.config.inject || {});
  var useTeams = function (selector) {
    return React.useSyncExternalStore(face.hooks.teams.subscribe, function () { return selector(face.hooks.teams.getSnapshot()); });
  };
  var useDetail = function (selector) {
    return React.useSyncExternalStore(face.hooks.detail.subscribe, function () { return selector(face.hooks.detail.getSnapshot()); });
  };
  function Root() { return h(main.Component, Object.assign({}, face, { useTeams: useTeams, useDetail: useDetail })); }
  ReactDOM.createRoot(document.getElementById('root')).render(h(Root));

  /* ---------- DOM probes ---------- */
  function rect(el) {
    var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
      top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left) };
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function rootEl() { return document.querySelector('#root > *'); }
  function inRoot(el) { return !!rootEl() && rootEl().contains(el); }
  function textOf(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function alpha(color) {
    var m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return color === 'transparent' ? 0 : 1;
    var parts = m[1].split(',').map(function (s) { return parseFloat(s); });
    return parts.length >= 4 ? parts[3] : 1;
  }
  function chatEl() {
    var el = document.querySelector('[data-testid="chat-scroll"]');
    if (el) return el;
    var root = rootEl();
    if (!root) return null;
    var best = null;
    Array.from(root.querySelectorAll('*')).forEach(function (candidate) {
      var cs = getComputedStyle(candidate);
      if (!/(auto|scroll)/.test(cs.overflowY)) return;
      if (!visible(candidate)) return;
      var r = rect(candidate);
      if (r.h < 120 || r.w < 150) return;
      if (candidate.scrollHeight - candidate.clientHeight < 20) return;
      if (!best || candidate.scrollHeight > best.scrollHeight) best = candidate;
    });
    return best;
  }
  function getScrollEl() {
    var chat = chatEl();
    if (chat && visible(chat)) return chat;
    var root = rootEl();
    if (!root) return null;
    var best = null;
    Array.from(root.querySelectorAll('*')).forEach(function (el) {
      var cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) return;
      if (!visible(el)) return;
      var r = rect(el);
      if (r.h < 80 || r.w < 120) return;
      if (el.scrollHeight - el.clientHeight < 5) return;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    });
    return best;
  }
  function statusLeaf() {
    var bar = document.querySelector('[data-testid="status-bar"]');
    if (bar) {
      var leaves = Array.from(bar.querySelectorAll('*')).filter(function (el) {
        return el.children.length === 0 && (el.textContent || '').trim().length > 0;
      });
      if (leaves.length) {
        leaves.sort(function (a, b) { return (b.textContent || '').length - (a.textContent || '').length; });
        return leaves[0];
      }
      if (visible(bar)) return bar;
    }
    return null;
  }
  function getStatusEl() {
    var leaf = statusLeaf();
    if (leaf && visible(leaf)) return leaf;
    var root = rootEl();
    if (!root) return null;
    var re = /(正在加载更早消息|上滑加载更早消息|已到当前会话窗口最早处|正在重新连接|重新连接)/;
    var best = null;
    Array.from(root.querySelectorAll('*')).forEach(function (el) {
      if (el.children.length > 3) return;
      if (!visible(el)) return;
      var t = textOf(el);
      if (!re.test(t) || t.length > 80) return;
      var r = rect(el);
      if (r.h > 48 || r.w < 80) return;
      if (!best || r.h < rect(best).h || (r.h === rect(best).h && r.y > rect(best).y)) best = el;
    });
    return best;
  }
  function getTabsGroup() {
    var root = rootEl();
    if (!root) return { group: [], all: [] };
    var labels = { '群聊': 1, '阶段门': 1, '任务': 1, '成员': 1 };
    var all = [];
    Array.from(root.querySelectorAll('*')).forEach(function (el) {
      var tag = el.tagName.toLowerCase();
      if (tag !== 'button' && el.getAttribute('role') !== 'tab') return;
      if (!visible(el)) return;
      var t = textOf(el);
      if (!labels[t]) return;
      if (all.some(function (x) { return x.el.contains(el); })) return;
      all.push({ el: el, text: t, rect: rect(el), selected: el.getAttribute('aria-selected') === 'true',
        view: el.getAttribute('data-view') || el.getAttribute('data-testid') || '' });
    });
    var groups = {};
    all.forEach(function (item) {
      var key = Math.round(item.rect.y / 8);
      (groups[key] = groups[key] || []).push(item);
    });
    var best = [];
    Object.keys(groups).forEach(function (key) { if (groups[key].length > best.length) best = groups[key]; });
    return { group: best, all: all };
  }
  function getTeamsColumn() {
    var root = rootEl();
    if (!root) return null;
    var items = Array.from(root.querySelectorAll('[data-testid="team-item"], [data-team-id]')).filter(visible);
    if (items.length >= 2) {
      var parent = items[0].parentElement;
      while (parent && parent !== root) {
        var pr = rect(parent);
        if (pr.w >= 120 && pr.w <= 320 && pr.h >= 120 && parent.querySelectorAll('[data-testid="team-item"], [data-team-id]').length >= 2) return parent;
        parent = parent.parentElement;
      }
    }
    var titles = ['移动端 UI 重设计', '支付流程重构'];
    var best = null;
    Array.from(root.querySelectorAll('*')).forEach(function (el) {
      if (!visible(el)) return;
      var r = rect(el);
      if (r.w < 120 || r.w > 320 || r.h < 150) return;
      var t = textOf(el);
      if (!titles.every(function (title) { return t.indexOf(title) >= 0; })) return;
      var buttons = el.querySelectorAll('button');
      if (buttons.length < 2) return;
      if (!best || rect(el).w < rect(best).w) best = el;
    });
    return best;
  }
  function getSideColumn() {
    var root = rootEl();
    if (!root) return null;
    var need = ['阶段门', '任务', '成员'];
    var best = null;
    Array.from(root.querySelectorAll('*')).forEach(function (el) {
      if (!visible(el)) return;
      var r = rect(el);
      if (r.w < 140 || r.w > 340 || r.h < 180) return;
      var t = textOf(el);
      if (!need.every(function (x) { return t.indexOf(x) >= 0; })) return;
      // 排除 tab 行（高度太小）和整页 root
      if (el === rootEl()) return;
      if (!best || rect(el).w < rect(best).w) best = el;
    });
    return best;
  }
  function getChatColumn(scroll) {
    if (!scroll) return null;
    var cur = scroll;
    while (cur && cur !== document.body) {
      var parent = cur.parentElement;
      if (!parent) break;
      var pr = rect(parent);
      var cr = rect(cur);
      if (pr.w > cr.w + 12) return cur;
      cur = parent;
    }
    return scroll;
  }
  function deepestTextEl(marker, scope) {
    var base = scope || getScrollEl() || rootEl();
    if (!base) return null;
    var hits = Array.from(base.querySelectorAll('*')).filter(function (el) {
      return visible(el) && (el.textContent || '').indexOf(marker) >= 0;
    });
    if (hits.length === 0) return null;
    hits.sort(function (a, b) { return (a.textContent || '').length - (b.textContent || '').length; });
    return hits[0];
  }
  function rowOf(marker) {
    var scroll = getScrollEl();
    var el = deepestTextEl(marker, scroll);
    if (!el) return null;
    var kind = el.closest('[data-kind]');
    if (kind && scroll && scroll.contains(kind) && rect(kind).w >= 150) return kind;
    var cur = el;
    while (cur && cur !== scroll && cur !== document.body) {
      var t = cur.textContent || '';
      var others = ALL_MARKERS.filter(function (m) { return m !== marker && t.indexOf(m) >= 0; });
      var r = rect(cur);
      if (others.length === 0 && r.w >= 200 && r.h >= 12) return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  function styleChain(marker) {
    var scroll = getScrollEl();
    var el = deepestTextEl(marker, scroll);
    if (!el) return { found: false, chain: [] };
    var chain = [];
    var cur = el;
    while (cur) {
      var cs = getComputedStyle(cur);
      chain.push({
        tag: cur.tagName.toLowerCase(), cls: typeof cur.className === 'string' ? cur.className : '',
        rect: rect(cur),
        bg: cs.backgroundColor, color: cs.color, br: parseFloat(cs.borderRadius) || 0,
        borderTopWidth: parseFloat(cs.borderTopWidth) || 0,
        paddingTop: parseFloat(cs.paddingTop) || 0, paddingLeft: parseFloat(cs.paddingLeft) || 0,
        fontSize: parseFloat(cs.fontSize) || 0, lineHeight: parseFloat(cs.lineHeight) || 0,
        display: cs.display, flexDirection: cs.flexDirection, justifyContent: cs.justifyContent,
        alignItems: cs.alignItems, writingMode: cs.writingMode,
      });
      if (cur === scroll) break;
      cur = cur.parentElement;
    }
    return { found: true, text: el.textContent || '', chain: chain };
  }
  function bubbleOf(marker) {
    var info = styleChain(marker);
    for (var i = 0; i < info.chain.length; i += 1) {
      var n = info.chain[i];
      if (alpha(n.bg) > 0.05 && n.br >= 8 && n.paddingTop >= 4 && n.tag !== 'pre' && n.tag !== 'code') return n;
    }
    return null;
  }
  function compositePixels(fg, bg) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      var context = canvas.getContext('2d');
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = bg || '#000';
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = fg;
      context.fillRect(0, 0, 1, 1);
      var data = context.getImageData(0, 0, 1, 1).data;
      return 'rgb(' + data[0] + ', ' + data[1] + ', ' + data[2] + ')';
    } catch (error) { return null; }
  }
  function avatarOfRow(row) {
    if (!row) return null;
    var nodes = Array.from(row.querySelectorAll('*'));
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var r = rect(el);
      if (r.w < 14 || r.w > 32 || Math.abs(r.w - r.h) > 4) continue;
      var cs = getComputedStyle(el);
      if (alpha(cs.backgroundColor) <= 0.1) continue;
      if ((parseFloat(cs.borderRadius) || 0) < Math.min(r.w, r.h) * 0.4) continue;
      return { rect: r, bg: cs.backgroundColor, color: cs.color, fontSize: parseFloat(cs.fontSize) || 0,
        text: textOf(el), border: cs.borderTopWidth + ' ' + cs.borderTopColor };
    }
    return null;
  }
  function countLeafText(name, scope) {
    var base = scope || getScrollEl() || rootEl();
    if (!base) return 0;
    var count = 0;
    Array.from(base.querySelectorAll('*')).forEach(function (el) {
      if (el.children.length > 0) return;
      if (textOf(el) === name) count += 1;
    });
    return count;
  }
  function textCount(marker) {
    var scroll = getScrollEl() || rootEl();
    var text = scroll ? (scroll.textContent || '') : '';
    return text.split(marker).length - 1;
  }
  function interactive() {
    var root = rootEl();
    if (!root) return [];
    var out = [];
    Array.from(root.querySelectorAll('button, [role="tab"], a[href], [role="button"]')).forEach(function (el) {
      if (!visible(el)) return;
      if (el.closest('pre, code')) return; // 代码块里的链接不算导航热区
      out.push({ text: textOf(el).slice(0, 40), rect: rect(el), tag: el.tagName.toLowerCase(),
        aria: el.getAttribute('aria-label') || '', testid: el.getAttribute('data-testid') || '',
        type: el.getAttribute('type') || '', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' });
    });
    return out;
  }
  function drawerInfo() {
    var root = rootEl();
    if (!root) return { open: false };
    var dialog = Array.from(root.querySelectorAll('[data-testid="project-drawer"], [role="dialog"]'))
      .filter(visible)[0] || null;
    if (!dialog) return { open: false };
    var titles = ['移动端 UI 重设计', '支付流程重构'];
    var items = Array.from(dialog.querySelectorAll('button')).filter(function (b) {
      return visible(b) && titles.some(function (t) { return textOf(b).indexOf(t) >= 0; });
    });
    var current = items.filter(function (b) {
      return b.getAttribute('data-current') === 'true' || b.getAttribute('aria-current') === 'true'
        || /\bcurrent\b|\bactive\b|已选/.test(b.className || '');
    });
    return { open: true, rect: rect(dialog), items: items.map(function (b) { return { text: textOf(b).slice(0, 40), rect: rect(b), cls: String(b.className || '') }; }),
      current: current.map(function (b) { return textOf(b).slice(0, 40); }) };
  }
  function projectSwitcher() {
    var root = rootEl();
    if (!root) return null;
    var testid = root.querySelector('[data-testid="project-switcher"]');
    if (testid && visible(testid)) return testid;
    var candidate = Array.from(root.querySelectorAll('button, [role="button"]')).filter(function (el) {
      if (!visible(el)) return false;
      var r = rect(el);
      if (r.y > 140) return false;
      var aria = el.getAttribute('aria-haspopup') || '';
      var t = textOf(el);
      return aria === 'dialog' || aria === 'menu' || /移动端 UI 重设计|支付流程重构|项目/.test(t);
    })[0];
    return candidate || null;
  }
  function selectedTab() {
    var g = getTabsGroup().all.filter(function (x) { return x.selected; });
    return g.length ? g[0].text : null;
  }

  /* ---------- 公开测试 API ---------- */
  var api = {
    ready: false,
    errors: errors,
    markers: ALL_MARKERS,
    state: function () {
      var d = face.hooks.detail.getSnapshot();
      return { leadId: d.leadId, status: d.status, teamsPhase: d.teamsPhase, hasMore: d.hasMore,
        loadingOlder: d.loadingOlder, rowCount: d.rows.length, lastText: d.rows.length ? d.rows[d.rows.length - 1].text : '' };
    },
    counters: function () { return JSON.parse(JSON.stringify(counters)); },
    resetCounters: function () { Object.keys(counters).forEach(function (k) { counters[k] = 0; }); },
    backCalls: function () { return backCalls.slice(); },
    metrics: function () {
      var scroll = getScrollEl();
      var status = getStatusEl();
      var tabs = getTabsGroup();
      var teams = getTeamsColumn();
      var side = getSideColumn();
      var chat = getChatColumn(scroll);
      var pageEl = document.documentElement;
      var statusStyle = status ? getComputedStyle(status) : null;
      var statusLineHeight = statusStyle ? (parseFloat(statusStyle.lineHeight) || parseFloat(statusStyle.fontSize) * 1.6) : 0;
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        page: { scrollWidth: pageEl.scrollWidth, clientWidth: pageEl.clientWidth,
          scrollHeight: pageEl.scrollHeight, clientHeight: pageEl.clientHeight },
        root: rootEl() ? rect(rootEl()) : null,
        scroll: scroll ? Object.assign({}, rect(scroll), { clientWidth: scroll.clientWidth, clientHeight: scroll.clientHeight,
          scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight, scrollTop: Math.round(scroll.scrollTop),
          atBottom: scroll.scrollHeight - scroll.clientHeight <= 0
            || (scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 8 }) : null,
        chat: chat ? rect(chat) : null,
        teams: teams ? rect(teams) : null,
        side: side ? rect(side) : null,
        status: status ? Object.assign({}, rect(status), { text: textOf(status),
          scrollWidth: status.scrollWidth, clientWidth: status.clientWidth,
          lineHeight: Math.round(statusLineHeight),
          singleLine: status.scrollWidth <= status.clientWidth + 1 && rect(status).h <= statusLineHeight * 2 + 2 }) : null,
        tabs: tabs.all.map(function (x) { return { text: x.text, rect: x.rect, selected: x.selected, view: x.view }; }),
        tabGroup: tabs.group.map(function (x) { return { text: x.text, rect: x.rect, selected: x.selected, view: x.view }; }),
        interactive: interactive(),
        drawer: drawerInfo(),
        projectSwitcher: projectSwitcher() ? rect(projectSwitcher()) : null,
        selectedTab: selectedTab(),
        theme: document.documentElement.getAttribute('data-theme'),
        text: (rootEl() ? rootEl().innerText : '').slice(0, 6000),
      };
    },
    styleChain: styleChain,
    bubbleOf: bubbleOf,
    rowOf: function (marker) { var r = rowOf(marker); return r ? rect(r) : null; },
    avatarOf: function (marker) { return avatarOfRow(rowOf(marker)); },
    headCount: function (name) { return countLeafText(name); },
    messageRows: function (kind) {
      var el = chatEl() || getScrollEl() || rootEl();
      if (!el) return [];
      return Array.from(el.querySelectorAll('[data-kind]')).filter(function (row) {
        return !kind || row.getAttribute('data-kind') === kind;
      }).map(function (row) {
        return { kind: row.getAttribute('data-kind'), rect: rect(row), text: textOf(row).slice(0, 120) };
      });
    },
    rowsForMarkers: function (markers) {
      var el = chatEl() || getScrollEl() || rootEl();
      if (!el) return [];
      var rows = Array.from(el.querySelectorAll('[data-kind]'));
      return rows.filter(function (row) {
        return markers.some(function (m) { return (row.textContent || '').indexOf(m) >= 0; });
      });
    },
    headCountForMarkers: function (markers, name) {
      var rows = api.rowsForMarkers(markers);
      if (rows.length === 0) return null;
      var count = 0;
      rows.forEach(function (row) {
        Array.from(row.querySelectorAll('*')).forEach(function (el) {
          if (el.children.length === 0 && textOf(el) === name) count += 1;
        });
      });
      return count;
    },
    avatarCountForMarkers: function (markers) {
      var rows = api.rowsForMarkers(markers);
      if (rows.length === 0) return null;
      var count = 0;
      rows.forEach(function (row) { if (avatarOfRow(row)) count += 1; });
      return count;
    },
    memberAvatars: function () {
      var el = chatEl() || getScrollEl() || rootEl();
      var root = rootEl();
      if (!el || !root) return [];
      var rootBg = getComputedStyle(root).backgroundColor;
      var rows = Array.from(el.querySelectorAll('[data-kind="member"]'));
      return rows.map(function (row) {
        var av = avatarOfRow(row);
        if (!av) return null;
        av.effectiveBg = compositePixels(av.bg, rootBg);
        av.effectiveFg = compositePixels(av.color, av.effectiveBg || rootBg);
        return { text: textOf(row).slice(0, 20), avatar: av };
      }).filter(function (x) { return !!x && !!x.avatar; });
    },
    textCount: textCount,
    find: function (marker) {
      var info = styleChain(marker);
      return info.found ? { found: true, text: info.text.slice(0, 120), chain: info.chain } : { found: false };
    },
    scrollChat: function (ratio) {
      var el = getScrollEl();
      if (!el) return null;
      var max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.round(max * ratio);
      return { scrollTop: Math.round(el.scrollTop), max: Math.round(max) };
    },
    scrollTop: function () { var el = getScrollEl(); if (!el) return null; el.scrollTop = 0; return Math.round(el.scrollTop); },
    scrollBottom: function () { var el = getScrollEl(); if (!el) return null; el.scrollTop = el.scrollHeight; return Math.round(el.scrollTop); },
    chatInfo: function () {
      var el = chatEl() || getScrollEl();
      if (!el) return null;
      var max = el.scrollHeight - el.clientHeight;
      return { scrollTop: Math.round(el.scrollTop), max: Math.round(max), scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        atBottom: max > 0 ? (max - el.scrollTop) < 8 : true };
    },
    clickTab: function (view) {
      var byTestid = document.querySelector('[data-testid="tab-' + view + '"]');
      if (byTestid && visible(byTestid)) { byTestid.click(); return true; }
      var g = getTabsGroup().all;
      var item = g.filter(function (x) { return x.view === view; })[0]
        || g.filter(function (x) { return ({ chat: '群聊', gates: '阶段门', tasks: '任务', members: '成员' })[view] === x.text; })[0];
      if (!item) return false;
      item.el.click();
      return true;
    },
    clickBack: function () {
      var el = Array.from(document.querySelectorAll('[data-testid^="back-btn"], [aria-label*="返回会话"], [aria-label*="回到会话"]'))
        .filter(visible)[0];
      if (!el) return false;
      el.click();
      return true;
    },
    clickButton: function (text) {
      var byTestid = document.querySelector('[data-testid="' + text + '"]');
      if (byTestid && visible(byTestid)) { byTestid.click(); return true; }
      var el = Array.from(rootEl().querySelectorAll('button, [role="button"]')).filter(function (b) {
        if (!visible(b)) return false;
        var aria = b.getAttribute('aria-label') || '';
        return textOf(b).indexOf(text) >= 0 || aria.indexOf(text) >= 0;
      })[0];
      if (!el) return false;
      el.click();
      return true;
    },
    openProjects: function () {
      var btn = projectSwitcher();
      if (!btn) return false;
      btn.click();
      return true;
    },
    clickProject: function (title) {
      var d = drawerInfo();
      if (!d.open) { api.lastProjectClick = { title: title, drawerOpen: false }; return false; }
      var dialog = document.querySelector('[data-testid="project-drawer"]');
      var scope = dialog || rootEl();
      var candidates = Array.from(scope.querySelectorAll('[data-testid="team-item-drawer"], [data-team-id], button')).filter(function (b) {
        return visible(b) && textOf(b).indexOf(title) >= 0;
      });
      var item = candidates[0];
      api.lastProjectClick = { title: title, drawerOpen: true, candidates: candidates.length,
        clicked: item ? textOf(item).slice(0, 60) : null,
        rect: item ? rect(item) : null,
        currentBefore: d.current };
      if (!item) return false;
      item.click();
      return true;
    },
    selectedTitle: function () {
      var d = face.hooks.detail.getSnapshot();
      var teams = face.hooks.teams.getSnapshot();
      var item = teams.items.filter(function (x) { return x.leadId === d.leadId; })[0];
      return item ? item.title : null;
    },
    setTheme: function (theme) { document.documentElement.setAttribute('data-theme', theme); },
    tokens: function () {
      var cs = getComputedStyle(document.documentElement);
      var keys = ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
        '--dsw-alias-bg-base', '--dsw-alias-bg-overlay', '--dsw-specific-bubble', '--dsw-alias-link'];
      var out = {};
      keys.forEach(function (k) { out[k] = cs.getPropertyValue(k).trim(); });
      return out;
    },
    appendMessage: function (sid, text, offsetMs) {
      var rec = recs.get(sid);
      if (!rec || !rec.opened) return false;
      var seq = rec.entries.length + 1000;
      var time = Date.now() + (offsetMs || 0);
      rec.eventSource.append(assistantMsg(text, seq, time));
      return { time: time, marker: text.slice(0, 24) };
    },
    appendUser: function (sid, text, offsetMs) {
      var rec = recs.get(sid);
      if (!rec || !rec.opened) return false;
      var seq = rec.entries.length + 1000;
      rec.eventSource.append(userMsg(text, seq, Date.now() + (offsetMs || 0), { kind: 'user', rpcId: 'rpc-test' }));
      return true;
    },
    stream: function (sid, text, settleText) {
      var rec = recs.get(sid);
      if (!rec || !rec.opened) return false;
      var attemptId = 'attempt-' + Math.random().toString(36).slice(2);
      rec.eventSource.append(transient(attemptId, text, Date.now()));
      setTimeout(function () {
        rec.eventSource.settleAssistant(attemptId, assistantMsg(settleText, rec.entries.length + 2000, Date.now()));
      }, 160);
      return true;
    },
    collapseRestore: function (newText) {
      var opened = Array.from(recs.values()).filter(function (rec) { return rec.opened; });
      if (opened.length === 0) return false;
      var saved = opened.map(function (rec) { return { rec: rec, entries: rec.entries.slice() }; });
      opened.forEach(function (rec) { rec.eventSource.replace([], false); });
      setTimeout(function () {
        saved.forEach(function (item, index) {
          var extra = index === 0 ? [assistantMsg(newText, item.entries.length + 3000, Date.now())] : [];
          item.rec.eventSource.replace(item.entries.concat(extra), false);
        });
      }, 250);
      return true;
    },
    startScrollProbe: function () {
      var el = getScrollEl();
      if (!el) return false;
      var desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      if (!desc || !desc.get || !desc.set) return false;
      probe = { writes: [], events: [] };
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: function () { return desc.get.call(el); },
        set: function (v) {
          probe.writes.push({ before: desc.get.call(el), to: v,
            max: el.scrollHeight - el.clientHeight, t: Math.round(performance.now()) });
          desc.set.call(el, v);
        },
      });
      el.addEventListener('scroll', function () {
        probe.events.push({ top: Math.round(desc.get.call(el)), max: el.scrollHeight - el.clientHeight,
          t: Math.round(performance.now()) });
      }, { passive: true });
      return true;
    },
    probe: function () { return probe ? { writes: probe.writes.slice(-30), events: probe.events.slice(-30) } : null; },
    resetProbe: function () { if (probe) { probe.writes.length = 0; probe.events.length = 0; } },
    switchTeam: function (title) {
      if (!api.openProjects()) return false;
      return api.clickProject(title);
    },
    resolveRefresh: function () { if (refreshResolve) { refreshResolve(); refreshResolve = null; return true; } return false; },
    refreshState: function () { return { counters: counters.refresh, resolvePending: !!refreshResolve }; },
    setLoadOlderFail: function (flag) { loadOlderFail = !!flag; },
    forceHasMore: function () {
      var rec = recs.get(leadId);
      if (!rec) return false;
      rec.hasMore = true;
      rec.eventSource.replace(rec.entries, true);
      return true;
    },
    setScenario: function (name) {
      if (name === 'pending') sessions.list.set({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} });
      else if (name === 'emptyList') sessions.list.set({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} });
      else if (name === 'emptyChat') {
        recs.forEach(function (rec) { rec.entries = []; rec.eventSource.replace([], false); });
      } else if (name === 'unreadable') {
        listUnreadable = true;
        face.refresh();
      } else if (name === 'restoreList') {
        listUnreadable = false;
        face.refresh();
      }
      return true;
    },
  };
  window.__t = api;

  /* ---------- 等首屏 ---------- */
  var started = performance.now();
  await new Promise(function (resolve) {
    var timer = setInterval(function () {
      var root = rootEl();
      var hasMain = !!root;
      var hasText = hasMain && (root.textContent || '').length > 20;
      var hasMarker = hasMain && (root.textContent || '').indexOf('[[md]]') >= 0;
      if (hasMain && (hasText || scenario === 'pending' || scenario === 'emptyList') && (hasMarker || performance.now() - started > 2500)) {
        clearInterval(timer);
        resolve();
      }
      if (performance.now() - started > 9000) { clearInterval(timer); resolve(); }
    }, 40);
  });
  await new Promise(function (r) { setTimeout(r, 500); });
  api.ready = true;
  window.__harnessReady = true;
  console.log('[harness] ready lead=' + (api.state().leadId || 'none') + ' rows=' + api.state().rowCount);
})();
`

/* ------------------------------------------------------------------ *
 * 2. 断言与报告基础设施
 * ------------------------------------------------------------------ */
const checks = []
const screens = []
const shots = []
let fatal = null

const record = (ac, id, ok, detail) => {
  const row = { ac, id, ok: !!ok, detail }
  checks.push(row)
  if (!jsonOnly) console.log(`${ok ? 'PASS' : 'FAIL'}  ${ac} ${id}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
  return row
}
const checkAc = (ac, id, ok, detail) => {
  if (acFilter && !acFilter.has(ac)) return
  record(ac, id, ok, detail)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const toUrl = (path) => 'file://' + path.split('/').map(encodeURIComponent).join('/')
const fmt = (value) => JSON.stringify(value)

/** CSS 颜色解析 + WCAG 对比度（AC-16 用）。 */
function parseCssColor(input) {
  if (!input) return null
  const text = String(input).trim()
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  let match = /^rgba?\(([^)]+)\)$/.exec(text)
  if (match) {
    const parts = match[1].split(',').map((x) => parseFloat(x))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (match) {
    const hex = match[1].length === 3 ? match[1].split('').map((c) => c + c).join('') : match[1]
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 }
  }
  return null
}
function relativeLuminance(color) {
  if (!color) return 0
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}
function contrastRatio(a, b) {
  const ca = parseCssColor(a)
  const cb = parseCssColor(b)
  if (!ca || !cb) return null
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100
}
function blendColor(fg, backdrop) {
  if (!fg || !backdrop) return null
  const a = fg.a === undefined ? 1 : fg.a
  return { r: fg.r * a + backdrop.r * (1 - a), g: fg.g * a + backdrop.g * (1 - a),
    b: fg.b * a + backdrop.b * (1 - a), a: 1 }
}
function colorObjectToRgb(color) {
  if (!color) return null
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`
}
function sameColor(a, b, tolerance = 2) {
  const ca = parseCssColor(a)
  const cb = parseCssColor(b)
  if (!ca || !cb) return false
  return Math.abs(ca.r - cb.r) <= tolerance && Math.abs(ca.g - cb.g) <= tolerance
    && Math.abs(ca.b - cb.b) <= tolerance
}

async function screenshot(page, name) {
  const path = join(OUT, name)
  await page.screenshot({ path })
  shots.push({ name, path })
  screens.push({ name, path })
  return path
}

async function newHarnessPage(browser, { width, height = 900, scenario = 'default', theme = 'dark' }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)))
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push('[console] ' + msg.text()) })
  page.on('dialog', () => pageErrors.push('[dialog] unexpected alert'))
  await page.goto(`http://127.0.0.1:${serverPort}/?scenario=${encodeURIComponent(scenario)}`, { waitUntil: 'load' })
  try {
    await page.waitForFunction('window.__harnessReady === true || !!window.__fatal', null, { timeout: 12000 })
  } catch (error) {
    pageErrors.push('harness not ready: ' + String(error && error.message ? error.message : error))
  }
  const harnessFatal = await page.evaluate(() => window.__fatal || null).catch(() => 'evaluate failed')
  if (harnessFatal) throw new Error('harness fatal: ' + harnessFatal)
  await page.evaluate((t) => window.__t.setTheme(t), theme)
  await sleep(120)
  return { page, pageErrors }
}

async function metricsOf(page) {
  return page.evaluate(() => window.__t.metrics())
}

/** 找到 chat 滚动容器的可见性/尺寸（AC-01/02 用）。 */
function chatOf(m) {
  return m.scroll || null
}

/** 页面 + root 双层横向溢出判定（允许 1px 取整误差）。 */
function noHorizontalOverflow(m) {
  const pageOk = m.page.scrollWidth <= m.page.clientWidth + 1
  const rootOk = !m.root || m.page.scrollWidth <= m.page.clientWidth + 1
  const scrollOk = !m.scroll || m.scroll.scrollWidth <= m.scroll.clientWidth + 1
  return pageOk && rootOk && scrollOk
}

/** 元素是否可滚动并滚到底（AC-04）。 */
async function canScrollToEnd(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('#root *')).filter((el) => {
      const cs = getComputedStyle(el)
      if (!/(auto|scroll)/.test(cs.overflowY)) return false
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      return true
    })
    let best = null
    for (const el of candidates) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el
    }
    if (!best) return { found: false }
    const max = best.scrollHeight - best.clientHeight
    best.scrollTop = max
    const last = best.lastElementChild
    const lastRect = last ? last.getBoundingClientRect() : null
    const box = best.getBoundingClientRect()
    return {
      found: true,
      scrollable: max > 0,
      max: Math.round(max),
      finalTop: Math.round(best.scrollTop),
      lastBottom: lastRect ? Math.round(lastRect.bottom) : null,
      boxBottom: Math.round(box.bottom),
      lastVisible: lastRect ? lastRect.bottom <= box.bottom + 3 : true,
      horizontalOverflow: best.scrollWidth > best.clientWidth + 1,
      clientWidth: best.clientWidth,
    }
  })
}

async function currentTabElements(page) {
  return page.evaluate(() => window.__t.metrics().tabs)
}

/* ------------------------------------------------------------------ *
 * 3. 静态检查（AC-20/22/23）：依赖、diff 范围、硬编码、持久化
 * ------------------------------------------------------------------ */
function readBaseline() {
  const out = {}
  const pkgPath = join(BASELINE, 'package.json.baseline')
  const clientBaseline = join(BASELINE, 'client.js.baseline')
  const statusPath = join(BASELINE, 'git-status.baseline')
  const hashPath = join(BASELINE, 'baseline-before-task4.txt')
  out.available = existsSync(pkgPath) && existsSync(clientBaseline) && existsSync(hashPath)
  out.package = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : null
  out.client = existsSync(clientBaseline) ? readFileSync(clientBaseline, 'utf8') : null
  out.status = existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : null
  out.hashes = {}
  if (existsSync(hashPath)) {
    for (const line of readFileSync(hashPath, 'utf8').split('\n')) {
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
      if (match) out.hashes[match[2]] = match[1]
    }
  }
  return out
}

function packageDiffOnlyVersion(beforeText, afterText) {
  try {
    const a = JSON.parse(beforeText)
    const b = JSON.parse(afterText)
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    const changed = []
    for (const key of keys) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed.push(key)
    }
    return { ok: changed.length === 0 || (changed.length === 1 && changed[0] === 'version'), changed }
  } catch (error) {
    return { ok: false, changed: ['parse-error:' + String(error)] }
  }
}

function scanNewHardcodedColors(beforeSource, afterSource) {
  // 只统计新增行里的显式白底/黑字/纯色字面量；ROLE_COLORS 等基线已存在的不算新增。
  const literal = /(?:background|backgroundColor|color|borderColor)\s*:\s*['"](?:#fff(?:fff)?|#000(?:000)?|white|black|rgb\(255,\s*255,\s*255\)|rgb\(0,\s*0,\s*0\))['"]/g
  const count = (text) => (text.match(literal) || []).length
  const before = count(beforeSource || '')
  const after = count(afterSource || '')
  return { before, after, added: Math.max(0, after - before) }
}

function scanExternal() {
  const files = [join(ROOT, 'client.js'), join(ROOT, 'design', 'mobile-workbench.html'), join(ROOT, 'design', 'conversation-style.html')]
  const hits = []
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/<(?:script|link)[^>]+(?:src|href)=["'](https?:\/\/[^"']+)["']/g)) {
      hits.push({ file: relative(ROOT, file), url: match[1] })
    }
  }
  return hits
}

function changedSinceBaseline(baseline) {
  const rows = []
  const baselineStatus = new Set((baseline.status || '').split('\n').map((line) => line.trim()).filter(Boolean))
  for (const [file, oldHash] of Object.entries(baseline.hashes || {})) {
    const abs = join(ROOT, file)
    if (!existsSync(abs)) { rows.push({ file, kind: 'deleted' }); continue }
    const nowHash = execFileSync('shasum', ['-a', '256', abs], { encoding: 'utf8' }).split(/\s+/)[0]
    if (nowHash !== oldHash) rows.push({ file, kind: 'modified' })
  }
  // 新增文件（baseline 未跟踪）：从 git status 里取 ?? 项 + baseline 目录外的新文件
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    for (const line of status.split('\n')) {
      if (!line.startsWith('?? ')) continue
      if (baselineStatus.has(line.trim())) continue // task-4 开工前就存在
      const file = line.slice(3).trim().replace(/\/$/, '')
      rows.push({ file, kind: 'untracked' })
    }
  } catch (error) {
    rows.push({ file: '.git-status', kind: 'error:' + String(error) })
  }
  return rows
}

function runStaticChecks() {
  const baseline = readBaseline()
  const currentPackage = readFileSync(join(ROOT, 'package.json'), 'utf8')
  const currentClient = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const currentStatus = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })

  // AC-20：npm test + 新增单测
  let npmTest = { ok: false, output: '' }
  try {
    const output = execFileSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    npmTest = { ok: true, output: output.split('\n').slice(-18).join('\n') }
  } catch (error) {
    npmTest = { ok: false, output: String((error.stdout || '') + (error.stderr || '')).slice(-3000) }
  }
  const testFiles = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs'))
  const testText = testFiles.map((f) => readFileSync(join(ROOT, 'test', f), 'utf8')).join('\n')
  const hasMarkdownTest = /markdown|escapeHtml|renderMarkdown|XSS|<script>/i.test(testText)
  const hasBreakpointTest = /breakpoint|断点|layoutForWidth|container|overflow|scrollWidth/i.test(testText)
  const newTestFiles = baseline.hashes
    ? testFiles.filter((f) => !Object.keys(baseline.hashes).some((p) => p === 'test/' + f))
    : []
  checkAc('AC-20', 'npm test 全绿', npmTest.ok, { testFiles, newTestFiles, tail: npmTest.output })
  checkAc('AC-20', '新增 markdown/XSS 单测', hasMarkdownTest, { testFiles })
  checkAc('AC-20', '新增断点/无溢出单测', hasBreakpointTest, { testFiles })

  // AC-22：无外部 CDN / 无新增依赖
  const external = scanExternal()
  const pkgDiff = baseline.package ? packageDiffOnlyVersion(baseline.package, currentPackage) : { ok: false, changed: ['baseline-missing'] }
  checkAc('AC-22', '设计/实现无外部 CDN 资源', external.length === 0, external)
  checkAc('AC-22', 'package.json 相对基线仅 version 变化', pkgDiff.ok, pkgDiff)
  checkAc('AC-22', '未引入 markdown/组件库依赖', !/"(marked|markdown-it|remark|react-markdown|dompurify|sanitize-html)"\s*:/.test(currentPackage), {
    deps: Object.keys(JSON.parse(currentPackage).dependencies || {}),
    devDeps: Object.keys(JSON.parse(currentPackage).devDependencies || {}),
  })
  const conversationHtml = existsSync(join(ROOT, 'design', 'conversation-style.html'))
    ? readFileSync(join(ROOT, 'design', 'conversation-style.html'), 'utf8') : ''
  const diffListMatch = /<ol class="diff-list">([\s\S]*?)<\/ol>/.exec(conversationHtml)
  const diffCount = diffListMatch ? (diffListMatch[1].match(/<li>/g) || []).length : 0
  checkAc('AC-22', '视觉差异清单<=5 条且为 DevBot 特有（设计基线）', diffCount > 0 && diffCount <= 5,
    { diffCount, source: 'design/conversation-style.html #diff-title' })

  // AC-23：diff 范围
  if (!baseline.available) {
    checkAc('AC-23', '基线可用（task-4 开工前快照）', false, {
      hint: '缺少 ' + BASELINE + '；需在 task-4 开工前保存 package.json.baseline/client.js.baseline/test.baseline/git-status.baseline/baseline-before-task4.txt',
    })
  } else {
    const changed = changedSinceBaseline(baseline)
    // task-4 complete 之后 Lead 直接指派的「团队协作节奏」改动，不属于 task-4 UI diff；
    // 归属由 fullstack2/Lead 在群里说明（docs/team-workflow.md 新增 + README/cordis persona 文案）。
    const postTask4LeadFiles = new Set(['README.md', 'cordis.patch.yml', 'docs/team-workflow.md'])
    const allowedPrefixes = ['client.js', 'test/', 'docs/', 'design/']
    const outside = changed.filter((row) => {
      if (postTask4LeadFiles.has(row.file)) return false
      if (row.kind === 'untracked') {
        // 目录级 untracked 行：允许包含 test/docs/design；其余视为新文件
        return !allowedPrefixes.some((prefix) => row.file === prefix.replace(/\/$/, '') || row.file.startsWith(prefix))
      }
      return !allowedPrefixes.some((prefix) => row.file.startsWith(prefix))
    })
    const postTask4 = changed.filter((row) => postTask4LeadFiles.has(row.file))
    const packageChanged = changed.find((row) => row.file === 'package.json')
    checkAc('AC-23', 'diff 仅含 client.js/test/docs/design/package.json(version)', outside.length === 0, {
      changed, outside, postTask4, packageChanged: packageChanged ? 'version-only-checked-above' : 'unchanged',
    })
    const hostFiles = changed.filter((row) => /^(bin\/|index\.js$|cordis\.patch\.yml$)/.test(row.file)
      && !postTask4LeadFiles.has(row.file))
    checkAc('AC-23', '无新增/修改 Host 文件', hostFiles.length === 0, hostFiles)
    const persistence = /(localStorage|sessionStorage|indexedDB|document\.cookie)\s*[.\[]/.test(currentClient)
    checkAc('AC-23', '无第二份群日志/持久化', !persistence, { persistence })
    const clientChanged = changed.some((row) => row.file === 'client.js')
    checkAc('AC-23', 'client.js 在基线后确有改动', clientChanged, {
      clientChanged, baselineBytes: (baseline.client || '').length, currentBytes: currentClient.length,
    })
  }

  // AC-16：新增硬编码白底/黑字（相对基线）
  const literals = scanNewHardcodedColors(baseline.client || '', currentClient)
  checkAc('AC-16', '新增区域无硬编码白底/黑字', literals.added === 0, literals)

  // AC-06：safe-area env() 使用（静态；真机非零 inset 另见报告说明）
  checkAc('AC-06', '顶部/底部使用 safe-area env()',
    /env\(safe-area-inset-top/.test(currentClient) && /env\(safe-area-inset-bottom/.test(currentClient),
    { top: /env\(safe-area-inset-top/.test(currentClient), bottom: /env\(safe-area-inset-bottom/.test(currentClient) })

  // AC-12：未 require markdown 库（静态）
  const mdRequire = /require\(['"](marked|markdown-it|remark|react-markdown|dompurify|sanitize-html)['"]\)/.test(currentClient)
  checkAc('AC-12', '未 require markdown 库', !mdRequire, { mdRequire })
}

/* ------------------------------------------------------------------ *
 * 4. 断点矩阵（AC-01 ~ AC-06、AC-17、AC-21）
 * ------------------------------------------------------------------ */
const MATRIX = [
  { width: 375, height: 844, kind: 'one' },
  { width: 390, height: 844, kind: 'one' },
  { width: 430, height: 844, kind: 'one' },
  { width: 559, height: 900, kind: 'one' },
  { width: 600, height: 900, kind: 'two' },
  { width: 768, height: 900, kind: 'two' },
  { width: 899, height: 900, kind: 'two' },
  { width: 900, height: 900, kind: 'three' },
  { width: 1024, height: 900, kind: 'three' },
  { width: 1280, height: 900, kind: 'three' },
  { width: 1440, height: 900, kind: 'three' },
]
const LIGHT_WIDTHS = new Set([375, 390, 430, 768, 1280, 1440])

function classifyLayout(m) {
  const teams = m.teams
  const side = m.side
  const chat = m.chat
  const tabTexts = m.tabGroup.map((t) => t.text)
  const hasFourTabs = ['群聊', '阶段门', '任务', '成员'].every((t) => tabTexts.includes(t))
  const hasThreeTabs = ['阶段门', '任务', '成员'].every((t) => tabTexts.includes(t)) && tabTexts.length === 3
  const sideBySide = !!(teams && side && chat && teams.x < chat.x && chat.x < side.x
    && Math.abs(teams.y - chat.y) < 80 && Math.abs(side.y - chat.y) < 80)
  const twoCol = !!(side && chat && !teams && Math.abs(side.y - chat.y) < 80 && side.x > chat.x
    && side.w >= 200 && chat.w >= 200)
  const oneCol = !teams && !sideBySide && !twoCol && hasFourTabs
  return { teams: !!teams, side: !!side, chat: !!chat, hasFourTabs, hasThreeTabs, sideBySide, twoCol, oneCol,
    teamsW: teams ? teams.w : null, sideW: side ? side.w : null, chatW: chat ? chat.w : null }
}

async function runMatrix(browser) {
  for (const item of MATRIX) {
    const themes = item.width === 390 || LIGHT_WIDTHS.has(item.width) ? ['dark', 'light'] : ['dark']
    for (const theme of themes) {
      const { page, pageErrors } = await newHarnessPage(browser, {
        width: item.width, height: item.height, theme,
      })
      const m = await metricsOf(page)
      const layout = classifyLayout(m)
      const isMobile = item.width < 560
      await screenshot(page, `workbench-${item.width}-${theme}.png`)

      // AC-01：页面/工作台/滚动容器均无横向溢出（移动端重点，桌面同样检查）
      checkAc('AC-01', `${item.width}-${theme} scrollWidth<=clientWidth`, noHorizontalOverflow(m), {
        page: m.page, root: m.root, scroll: m.scroll ? { clientWidth: m.scroll.clientWidth, scrollWidth: m.scroll.scrollWidth } : null,
      })

      // AC-02：群聊区宽高
      const chat = chatOf(m)
      if (isMobile) {
        checkAc('AC-02', `${item.width}-${theme} 群聊宽>=280 高>=300`,
          !!chat && chat.clientWidth >= 280 && chat.clientHeight >= 300,
          chat ? { clientWidth: chat.clientWidth, clientHeight: chat.clientHeight } : { chat: null })
      }

      // AC-03：正文容器宽≥200 / 状态条单行 / 无 writing-mode 竖排
      if (isMobile) {
        const bodyWidths = await page.evaluate(() => {
          const list = document.querySelector('[data-testid="message-list"]')
            || document.querySelector('[data-testid="chat-scroll"]') || document.querySelector('#root > *')
          const blocks = Array.from(list.querySelectorAll('p, li, blockquote, [data-kind] > div > div'))
          const widths = blocks.filter((el) => {
            const r = el.getBoundingClientRect()
            const text = (el.textContent || '').trim()
            return r.width > 0 && text.length >= 8
          }).map((el) => Math.round(el.getBoundingClientRect().width))
          if (widths.length > 0) return widths
          return Array.from(list.querySelectorAll('[data-kind]')).map((el) => Math.round(el.getBoundingClientRect().width))
        })
        const minBody = bodyWidths.length ? Math.min(...bodyWidths) : 0
        checkAc('AC-03', `${item.width}-${theme} 正文容器宽>=200`, minBody >= 200, { minBody, sample: bodyWidths.slice(0, 8) })
        checkAc('AC-03', `${item.width}-${theme} 状态条单行不竖排`, !!m.status && m.status.singleLine, m.status)
        const vertical = await page.evaluate(() => {
          const root = document.querySelector('#root > *')
          return Array.from(root.querySelectorAll('*')).filter((el) => {
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return /vertical/.test(cs.writingMode) && r.width > 0 && r.height > 0
          }).length
        })
        checkAc('AC-03', `${item.width}-${theme} 无 writing-mode 竖排`, vertical === 0, { vertical })
      }

      // AC-04：三个移动视图滚到最后无裁切（<560 才有整页视图）
      if (isMobile) {
        for (const [view, label] of [['gates', '阶段门'], ['tasks', '任务'], ['members', '成员']]) {
          const clicked = await page.evaluate((v) => window.__t.clickTab(v), view)
          await sleep(180)
          const scrollEnd = await canScrollToEnd(page)
          const viewMetrics = await metricsOf(page)
          checkAc('AC-04', `${item.width}-${theme} ${label}可滚到最后无裁切`,
            clicked && scrollEnd.found && scrollEnd.lastVisible && !scrollEnd.horizontalOverflow,
            { clicked, scrollEnd, status: viewMetrics.status ? viewMetrics.status.text : null })
          await screenshot(page, `workbench-${item.width}-${theme}-tab-${view}.png`)
        }
        await page.evaluate(() => window.__t.clickTab('chat'))
        await sleep(120)
      }

      // AC-05：断点布局
      if (item.kind === 'three') {
        checkAc('AC-05', `${item.width}-${theme} 三栏结构`,
          layout.sideBySide && layout.teams && layout.side && layout.chat,
          { layout, teams: m.teams, chat: m.chat, side: m.side })
      } else if (item.kind === 'two') {
        checkAc('AC-05', `${item.width}-${theme} 两栏且项目列表不常驻`,
          layout.twoCol && !layout.teams, { layout, teams: m.teams, chat: m.chat, side: m.side })
        // 顶栏项目切换入口
        checkAc('AC-07', `${item.width}-${theme} 两栏项目切换入口可见`, !!m.projectSwitcher, m.projectSwitcher)
      } else {
        checkAc('AC-05', `${item.width}-${theme} 单栏+四段 tab`,
          layout.oneCol && layout.hasFourTabs, { layout, tabGroup: m.tabGroup })
      }

      // AC-06：safe-area 注入（Chromium CDP Emulation.setSafeAreaInsetsOverride）
      // 模拟刘海 47px / 手势条 34px，验证顶栏不被遮挡、底栏留白、chat 不被压没。
      if ([375, 390, 430].includes(item.width) && theme === 'dark') {
        try {
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, left: 0, bottom: 34, right: 0 } })
          await sleep(180)
          const safe = await page.evaluate(() => {
            const root = document.querySelector('#root > *')
            const appbar = document.querySelector('.devbot-appbar')
            const status = document.querySelector('[data-testid="status-bar"]')
            const chat = document.querySelector('[data-testid="chat-scroll"]')
            const buttons = Array.from(document.querySelectorAll('[data-testid="back-btn-mobile"], [data-testid="project-switcher"], [data-testid="refresh-btn-mobile"]'))
            const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) } }
            return {
              viewport: { w: innerWidth, h: innerHeight },
              appbar: appbar ? Object.assign(rect(appbar), { paddingTop: parseFloat(getComputedStyle(appbar).paddingTop) || 0 }) : null,
              status: status ? Object.assign(rect(status), { paddingBottom: parseFloat(getComputedStyle(status).paddingBottom) || 0 }) : null,
              chat: chat ? { clientHeight: chat.clientHeight, clientWidth: chat.clientWidth, bottom: Math.round(chat.getBoundingClientRect().bottom) } : null,
              buttons: buttons.map((b) => rect(b)),
              page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
            }
          })
          await screenshot(page, `workbench-${item.width}-safearea.png`)
          const minButtonTop = safe.buttons.length ? Math.min(...safe.buttons.map((b) => b.top)) : 0
          checkAc('AC-06', `${item.width} 注入 safe-area(47/34) 不遮挡`,
            !!safe.appbar && safe.appbar.paddingTop >= 44 && !!safe.status && safe.status.paddingBottom >= 30
            && !!safe.chat && safe.chat.clientHeight >= 300 && minButtonTop >= 44
            && safe.chat.bottom <= safe.status.top + 1
            && safe.page.scrollWidth <= safe.page.clientWidth + 1,
            safe)
        } catch (error) {
          checkAc('AC-06', `${item.width} 注入 safe-area(47/34) 不遮挡`, false, { error: String(error) })
        }
      }

      // AC-06：<900 导航热区 ≥40×40（排除正文链接；system 展开行按实测上报）
      if (item.width < 900) {
        // 正文内联链接属于文本内容而非导航控件（DSH 同款），不计入 40px 热区；
        // 导航/按钮/分段 tab 全部计入。
        const small = m.interactive.filter((x) => x.tag !== 'a' && (x.rect.w < 40 || x.rect.h < 40))
        checkAc('AC-06', `${item.width}-${theme} 导航热区>=40`, small.length === 0, {
          min: m.interactive.reduce((acc, x) => ({ w: Math.min(acc.w, x.rect.w), h: Math.min(acc.h, x.rect.h) }), { w: 999, h: 999 }),
          small,
        })
      }

      // 主题可读性（AC-16 的真实渲染部分）
      if (theme === 'light') {
        const contrast = await page.evaluate(() => {
          const root = document.querySelector('#root > *')
          const bg = getComputedStyle(root).backgroundColor
          const textEls = Array.from(root.querySelectorAll('*')).filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 3)
          const colors = textEls.slice(0, 40).map((el) => getComputedStyle(el).color)
          return { bg, colors, theme: document.documentElement.getAttribute('data-theme') }
        })
        checkAc('AC-16', `${item.width} 浅色主题生效`, contrast.theme === 'light' && contrast.colors.length > 0, contrast)
      }

      // AC-17：桌面三栏与 v0.4 尺寸
      if (item.width === 1280 || item.width === 1440) {
        checkAc('AC-17', `${item.width} 三栏尺寸保持 v0.4`, layout.sideBySide
          && Math.abs((m.teams ? m.teams.w : 0) - 196) <= 2
          && Math.abs((m.side ? m.side.w : 0) - 252) <= 2,
          { teams: m.teams, side: m.side, chat: m.chat, layout })
        for (const [view, label] of [['tasks', '任务'], ['members', '成员']]) {
          const ok = await page.evaluate((v) => window.__t.clickButton(({ tasks: '任务', members: '成员' })[v]), view)
          await sleep(100)
          const after = await metricsOf(page)
          checkAc('AC-17', `${item.width} 信息区 ${label} 可切换`, ok && after.text.includes(label), { ok })
        }
      }

      checkAc('AC-05', `${item.width}-${theme} 页面无脚本错误`, pageErrors.length === 0, pageErrors)
      if (pageErrors.length > 0) record('AC-05', `${item.width}-${theme} pageErrors`, false, pageErrors)
      await page.close()
    }
  }

  // AC-04 长列表：任务面板内容超过视口时必须能滚到最后一项且无裁切。
  {
    const { page } = await newHarnessPage(browser, { width: 375, height: 844, scenario: 'longTasks' })
    await page.evaluate(() => window.__t.clickTab('tasks'))
    await sleep(250)
    const longList = await canScrollToEnd(page)
    const longMetrics = await metricsOf(page)
    await screenshot(page, 'workbench-375-longtasks.png')
    checkAc('AC-04', '375 任务长列表可滚到最后且无裁切',
      longList.found && longList.scrollable && longList.lastVisible && !longList.horizontalOverflow,
      { longList, textTail: longMetrics.text.slice(-220) })
    await page.close()
  }

  // AC-21：六档 + 深/浅色截图入库
  const requiredShots = []
  for (const width of [375, 390, 430, 768, 1280, 1440]) {
    for (const theme of ['dark', 'light']) requiredShots.push(`workbench-${width}-${theme}.png`)
  }
  const missingShots = requiredShots.filter((name) => !existsSync(join(OUT, name)))
  checkAc('AC-21', '375/390/430/768/1280/1440 深/浅色截图入库', missingShots.length === 0,
    { required: requiredShots.length, missingShots, out: relative(ROOT, OUT) })

  // AC-05：跨断点缩放不丢项目/视图（390 单栏 → 768 两栏 → 1280 三栏 → 390）
  const { page, pageErrors } = await newHarnessPage(browser, { width: 390, height: 844 })
  await page.evaluate(() => { window.__t.clickTab('tasks'); window.__t.scrollChat(0.4) })
  await sleep(120)
  const before = await page.evaluate(() => ({ title: window.__t.selectedTitle(), tab: window.__t.metrics().selectedTab }))
  for (const width of [768, 1280, 390]) {
    await page.setViewportSize({ width, height: width < 560 ? 844 : 900 })
    await sleep(250)
    const now = await page.evaluate(() => ({ title: window.__t.selectedTitle(), tab: window.__t.metrics().selectedTab }))
    checkAc('AC-05', `缩放到 ${width} 保留项目/视图`, now.title === before.title && now.tab === before.tab,
      { before, now, width })
  }
  await page.close()
}

/* ------------------------------------------------------------------ *
 * 5. 移动端交互（AC-07 ~ AC-10）
 * ------------------------------------------------------------------ */
async function runInteractions(browser) {
  const { page, pageErrors } = await newHarnessPage(browser, { width: 390, height: 844 })

  // AC-07：项目切换（单栏抽屉）
  const initialTitle = await page.evaluate(() => window.__t.selectedTitle())
  await page.evaluate(() => window.__t.openProjects())
  await sleep(180)
  const drawer = await page.evaluate(() => window.__t.metrics().drawer)
  await screenshot(page, 'workbench-390-drawer.png')
  checkAc('AC-07', '单栏抽屉可打开', drawer.open && drawer.items.length >= 2, drawer)
  // 点遮罩：用坐标点遮罩（抽屉外的左上角）
  await page.mouse.click(5, 5)
  await sleep(180)
  const afterMask = await page.evaluate(() => ({ title: window.__t.selectedTitle(), drawer: window.__t.metrics().drawer.open }))
  checkAc('AC-07', '点遮罩关闭且不切换', afterMask.title === initialTitle && afterMask.drawer === false, afterMask)
  // 切到项目 2（open 与 click 分开：React 状态更新后才能点抽屉项）
  await page.evaluate(() => window.__t.openProjects())
  await sleep(200)
  await page.evaluate(() => window.__t.clickProject('支付流程重构'))
  await sleep(900)
  const switched = await page.evaluate(() => ({
    title: window.__t.selectedTitle(),
    text: window.__t.metrics().text,
    state: window.__t.state(),
  }))
  checkAc('AC-07', '切换后只含新项目消息', switched.title === '支付流程重构'
    && switched.text.includes('[[teamb]]') && !switched.text.includes('[[md]]'), { title: switched.title, state: switched.state })
  await page.evaluate(() => window.__t.openProjects())
  await sleep(180)
  const drawerAfterSwitch = await page.evaluate(() => window.__t.metrics().drawer)
  checkAc('AC-07', '切换后当前项高亮',
    drawerAfterSwitch.open && Array.isArray(drawerAfterSwitch.current)
    && drawerAfterSwitch.current.some((text) => text.includes('支付流程重构')),
    drawerAfterSwitch)
  await page.mouse.click(5, 5)
  await sleep(150)
  // 切回项目 1，便于后续用例
  await page.evaluate(() => window.__t.openProjects())
  await sleep(200)
  await page.evaluate(() => window.__t.clickProject('移动端 UI 重设计'))
  await sleep(900)

  // AC-08：切 tab 保滚动
  await page.evaluate(() => window.__t.scrollChat(0.35))
  await sleep(120)
  const mid = await page.evaluate(() => window.__t.chatInfo())
  await page.evaluate(() => window.__t.startScrollProbe())
  const switchResult = await page.evaluate(async () => {
    const before = window.__t.chatInfo();
    window.__t.clickTab('tasks');
    await new Promise((r) => setTimeout(r, 140));
    window.__t.clickTab('chat');
    await new Promise((r) => setTimeout(r, 160));
    const after = window.__t.chatInfo();
    return { before, after, probe: window.__t.probe() };
  })
  const afterMid = switchResult.after
  const minHeight = switchResult.probe && switchResult.probe.events.length
    ? Math.min(...switchResult.probe.events.map((e) => e.max + 0)) : null
  checkAc('AC-08', '切 tab 回群聊 scrollTop±2px',
    Math.abs((afterMid ? afterMid.scrollTop : -999) - mid.scrollTop) <= 2,
    { mid, after: afterMid })
  const collapses = (switchResult.probe ? switchResult.probe.events : []).filter((e) => e.max <= 0)
  checkAc('AC-08', '切 tab 无塌缩/闪烁', collapses.length === 0, { collapses, events: switchResult.probe ? switchResult.probe.events.slice(0, 6) : null })
  const statusDuringSwitch = await page.evaluate(() => window.__t.metrics().status)
  checkAc('AC-08', '切 tab 无加载中闪烁', !statusDuringSwitch || !/正在加载更早消息/.test(statusDuringSwitch.text), statusDuringSwitch)

  // 贴底切回仍在底部
  await page.evaluate(() => window.__t.scrollBottom())
  await sleep(100)
  await page.evaluate(() => window.__t.clickTab('tasks'))
  await sleep(120)
  await page.evaluate(() => window.__t.clickTab('chat'))
  await sleep(160)
  const bottomAgain = await page.evaluate(() => window.__t.chatInfo())
  checkAc('AC-08', '贴底切回仍在底部', !!bottomAgain && bottomAgain.atBottom, bottomAgain)

  // AC-09：上滑加载（正常）
  const loadBefore = await page.evaluate(() => ({ counters: window.__t.counters(), state: window.__t.state() }))
  const leadLoads = (c) => (c.loadOlderBySid && c.loadOlderBySid['S-lead']) || 0
  await page.evaluate(() => window.__t.scrollTop())
  await sleep(60)
  const loading = await page.evaluate(() => ({ status: window.__t.metrics().status, counters: window.__t.counters(), state: window.__t.state() }))
  await sleep(700)
  const loaded = await page.evaluate(() => ({
    status: window.__t.metrics().status, counters: window.__t.counters(), state: window.__t.state(),
    text: window.__t.metrics().text,
  }))
  checkAc('AC-09', '距顶<48px 触发一次 loadOlder',
    leadLoads(loadBefore.counters) === 0 && leadLoads(loading.counters) === 1,
    { before: loadBefore.counters.loadOlderBySid, during: loading.counters.loadOlderBySid })
  checkAc('AC-09', 'loading 文案出现', !!loading.status && /正在加载更早消息/.test(loading.status.text), loading.status)
  checkAc('AC-09', '到最早显示已到最早且不再触发',
    !!loaded.status && /已到当前会话窗口最早处/.test(loaded.status.text)
    && leadLoads(loaded.counters) === 1 && loaded.text.includes('[[older-pm-0]]'),
    { status: loaded.status, counters: loaded.counters.loadOlderBySid })
  await page.evaluate(() => window.__t.scrollTop())
  await sleep(350)
  const afterEnd = await page.evaluate(() => window.__t.counters())
  checkAc('AC-09', '到最早后不再触发 loadOlder', leadLoads(afterEnd) === 1, afterEnd.loadOlderBySid)

  // AC-09：loadOlder 失败：不弹窗/不清空/不无限重试
  const failBefore = await page.evaluate(() => ({ info: window.__t.chatInfo(), counters: window.__t.counters(), textLen: window.__t.metrics().text.length }))
  await page.evaluate(() => { window.__t.setLoadOlderFail(true); window.__t.forceHasMore(); })
  await sleep(120)
  await page.evaluate(() => window.__t.scrollTop())
  await sleep(900)
  const failAfter = await page.evaluate(() => ({
    info: window.__t.chatInfo(), counters: window.__t.counters(),
    textLen: window.__t.metrics().text.length, status: window.__t.metrics().status, errors: window.__t.errors,
  }))
  checkAc('AC-09', 'loadOlder 失败不弹窗',
    !pageErrors.some((e) => String(e).includes('[dialog]')) && !failAfter.errors.some((e) => String(e).includes('dialog')),
    { pageErrors, harnessErrors: failAfter.errors })
  checkAc('AC-09', 'loadOlder 失败不清空内容',
    failAfter.info && failBefore.info && failAfter.info.scrollHeight >= failBefore.info.scrollHeight - 20
    && failAfter.textLen >= failBefore.textLen - 20, { before: failBefore.info, after: failAfter.info })
  checkAc('AC-09', 'loadOlder 失败不无限重试', leadLoads(failAfter.counters) <= leadLoads(failBefore.counters) + 1,
    { before: failBefore.counters.loadOlderBySid, after: failAfter.counters.loadOlderBySid })

  // AC-10：刷新不清空 + 进行中态；返回回面板
  const refreshBefore = await page.evaluate(() => window.__t.metrics().text)
  await page.evaluate(() => window.__t.clickButton('刷新'))
  await sleep(80)
  const refreshBusy = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('[data-testid^="refresh-btn"]')).filter((b) => b.getBoundingClientRect().width > 0)[0]
      || Array.from(document.querySelectorAll('#root button')).find((b) => (b.textContent || '').includes('刷新'));
    return { found: !!btn, disabled: btn ? !!btn.disabled : null,
      ariaBusy: btn ? btn.getAttribute('aria-busy') : null,
      dataBusy: btn ? btn.getAttribute('data-busy') : null,
      text: btn ? (btn.textContent || '').trim() : null,
      refreshCounters: window.__t.counters().refresh };
  })
  await screenshot(page, 'workbench-390-refresh-busy.png')
  await page.evaluate(() => window.__t.resolveRefresh())
  await sleep(250)
  const refreshAfter = await page.evaluate(() => ({ text: window.__t.metrics().text, counters: window.__t.counters() }))
  checkAc('AC-10', '刷新期间按钮进行中态',
    refreshBusy.found && (refreshBusy.disabled || refreshBusy.ariaBusy === 'true'
      || refreshBusy.dataBusy === 'true' || /刷新中|正在刷新/.test(refreshBusy.text || '')),
    refreshBusy)
  checkAc('AC-10', '刷新不清空内容', refreshAfter.text === refreshBefore && refreshAfter.counters.refresh === 1,
    { sameText: refreshAfter.text === refreshBefore, counters: refreshAfter.counters })
  await page.evaluate(() => window.__t.clickBack())
  await sleep(80)
  const back = await page.evaluate(() => window.__t.backCalls())
  checkAc('AC-10', '返回回到会话面板', back.length > 0 && back[back.length - 1] === null, { back })
  const backBtn = (await metricsOf(page)).interactive.find((x) => /返回会话|回到会话/.test((x.aria || '') + x.text))
  checkAc('AC-10', '刷新/返回热区>=40', !!backBtn && backBtn.rect.w >= 40 && backBtn.rect.h >= 40, backBtn)

  checkAc('AC-07', '交互过程无脚本错误', pageErrors.length === 0, pageErrors)
  await page.close()
}

/* ------------------------------------------------------------------ *
 * 6. 时间线渲染（AC-12 ~ AC-16、AC-19）
 * ------------------------------------------------------------------ */
async function runTimeline(browser) {
  const { page, pageErrors } = await newHarnessPage(browser, { width: 390, height: 844 })

  // AC-12：assistant 无气泡 + markdown 全子集
  const assistant = await page.evaluate(() => {
    const bubble = window.__t.bubbleOf('[[assistant]]')
    const chain = window.__t.find('[[assistant]]')
    return { bubble, chainFound: chain.found, chain: chain.found ? chain.chain.slice(0, 4) : [] }
  })
  checkAc('AC-12', 'assistant 无气泡直排', !assistant.bubble, assistant)

  const md = await page.evaluate(() => {
    const marker = '[[md]]'
    const row = window.__t.rowOf(marker)
    const root = document.querySelector('#root > *')
    // 找到包含该 marker 的消息行：用最深元素向上找到包含 h1 的容器
    const deep = (function () {
      const hits = Array.from(root.querySelectorAll('*')).filter((el) => (el.textContent || '').includes(marker));
      hits.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      return hits[0];
    })();
    let container = deep;
    for (let i = 0; i < 8 && container; i += 1) {
      if (container.querySelector && container.querySelector('h1, h2, h3, pre, ul, ol, blockquote')) break;
      container = container.parentElement;
    }
    if (!container) return { found: false };
    const q = (sel) => Array.from(container.querySelectorAll(sel)).map((el) => ({
      text: (el.textContent || '').slice(0, 80),
      tag: el.tagName.toLowerCase(),
    }));
    const safe = Array.from(container.querySelectorAll('a')).find((a) => (a.textContent || '').includes('安全链接'));
    const bad = Array.from(container.querySelectorAll('a')).find((a) => (a.textContent || '').includes('坏链接'));
    return {
      found: true, row,
      h1: q('h1'), h2: q('h2'), h3: q('h3'), p: q('p'), strong: q('strong'), em: q('em'),
      code: q('code'), pre: q('pre'), ul: q('ul'), ol: q('ol'), blockquote: q('blockquote'), hr: q('hr'),
      safeHref: safe ? safe.getAttribute('href') : null,
      badHref: bad ? bad.getAttribute('href') : null,
      badText: bad ? (bad.textContent || '') : null,
    }
  })
  checkAc('AC-12', 'markdown 标题/段落/粗斜体/行内码/代码块/列表/引用/hr 渲染',
    md.found && md.h1.length && md.h2.length && md.h3.length && md.p.length && md.strong.length
    && md.em.length && md.code.length && md.pre.length && md.ul.length && md.ol.length
    && md.blockquote.length && md.hr.length, md)
  checkAc('AC-12', 'markdown 链接白名单（安全可点/危险不执行）',
    md.found && md.safeHref === 'https://example.com/docs'
    && (!md.badHref || !/^javascript:/i.test(md.badHref)), { safeHref: md.safeHref, badHref: md.badHref, badText: md.badText })

  // AC-13：用户胶囊 / 成员头 / 连续发送合并
  const user = await page.evaluate(() => {
    const bubble = window.__t.bubbleOf('[[human]]')
    const row = window.__t.rowOf('[[human]]')
    const avatar = window.__t.avatarOf('[[human]]')
    const scroll = window.__t.metrics().scroll
    const rowEl = document.querySelector('[data-kind="user"]')
    return { bubble, row, avatar, scrollRight: scroll ? scroll.right : null,
      rowText: rowEl ? (rowEl.textContent || '').trim().slice(0, 160) : null }
  })
  checkAc('AC-13', '用户消息右侧胶囊', !!user.bubble && !!user.row && !!user.scrollRight
    && Math.abs(user.bubble.rect.right - user.scrollRight) <= 28, user)
  checkAc('AC-13', '用户消息无头像/名字', !user.avatar && !(user.rowText || '').includes('你'), user)
  const heads = await page.evaluate(() => {
    const block = ['[[pm-head-1]]', '[[pm-head-2]]', '[[pm-head-3]]']
    const blockPlus4 = block.concat(['[[pm-head-4]]'])
    const memberRows = window.__t.messageRows('member')
    return {
      blockHead: window.__t.headCountForMarkers(block, 'pm'),
      blockAvatars: window.__t.avatarCountForMarkers(block),
      blockPlus4Head: window.__t.headCountForMarkers(blockPlus4, 'pm'),
      blockPlus4Avatars: window.__t.avatarCountForMarkers(blockPlus4),
      memberRowCount: memberRows.length,
      headCountAll: window.__t.headCount('pm'),
    }
  })
  checkAc('AC-13', '连续发送者只显示一次头（>5min 重新显示）',
    heads.blockHead === 1 && heads.blockAvatars === 1 && heads.blockPlus4Head === 2 && heads.blockPlus4Avatars === 2,
    heads)

  // AC-14：系统条/派单行/流式/日分隔
  const compact = await page.evaluate(() => {
    const sysBubble = window.__t.bubbleOf('[[sys-task-2]]')
    const dispatchBubble = window.__t.bubbleOf('[[dispatch]]')
    const md = window.__t.metrics().text
    const dayTexts = (function () {
      const root = document.querySelector('#root > *');
      const hits = [];
      root.querySelectorAll('*').forEach((el) => {
        if (el.children.length > 0) return;
        const t = (el.textContent || '').trim();
        if (t === '今天' || t === '昨天' || /^\d{1,2}月\d{1,2}日$/.test(t)) hits.push(t);
      });
      return hits;
    })();
    return { sysBubble, dispatchBubble, md, dayTexts };
  })
  checkAc('AC-14', '系统条/派单行紧凑无气泡', !compact.sysBubble && !compact.dispatchBubble, compact)
  const stream = await page.evaluate(async () => {
    const ok = window.__t.stream('S-pm', '[[stream-live]] 流式追加片段', '[[stream-live]] 流式追加片段 已结算');
    await new Promise((r) => setTimeout(r, 60));
    const during = window.__t.metrics().text;
    await new Promise((r) => setTimeout(r, 400));
    const after = window.__t.metrics().text;
    return { ok, duringCount: during.split('[[stream-live]]').length - 1,
      afterCount: after.split('[[stream-live]]').length - 1,
      afterInputting: /输入中/.test(after), duringInputting: /输入中/.test(during) };
  })
  if (stream.ok) {
    checkAc('AC-14', '流式行显示输入中', stream.duringInputting, stream)
    checkAc('AC-14', '流式 settle 后不叠字', stream.afterCount === 1 && !stream.afterInputting, stream)
  } else {
    checkAc('AC-14', '流式行显示输入中', false, { reason: 'stream 注入失败（会话未打开）' })
    checkAc('AC-14', '流式 settle 后不叠字', false, { reason: 'stream 注入失败' })
  }
  checkAc('AC-14', '日分隔正确（今天/昨天/M月D日）', compact.dayTexts.length >= 2
    && compact.dayTexts.includes('今天') && (compact.dayTexts.includes('昨天') || compact.dayTexts.some((t) => /月/.test(t))),
    { dayTexts: compact.dayTexts })

  // AC-15：XSS 不执行/不注入
  const xss = await page.evaluate(() => ({
    scriptFlag: window.__xss_script || 0,
    imgFlag: window.__xss_img || 0,
    linkFlag: window.__xss_link || 0,
    scriptEls: document.querySelectorAll('#root script').length,
    imgEls: document.querySelectorAll('#root img').length,
    text: window.__t.metrics().text,
  }))
  checkAc('AC-15', 'script/img onerror 不执行', !xss.scriptFlag && !xss.imgFlag && !xss.linkFlag, xss)
  checkAc('AC-15', '无 DOM 注入（script/img 元素）', xss.scriptEls === 0 && xss.imgEls === 0, xss)
  checkAc('AC-15', '原始 HTML 按文本转义展示', xss.text.includes('<script>') && xss.text.includes('<img'), { sample: xss.text.slice(0, 300) })

  // AC-19：事件规则与去重
  const merge = await page.evaluate(() => ({
    human: window.__t.textCount('[[human]]'),
    dispatch: window.__t.textCount('[[dispatch]]'),
    relay: window.__t.textCount('[[relay-msg]]'),
    assistant: window.__t.textCount('[[assistant]]'),
    sysTask: window.__t.textCount('[[sys-task]]'),
    dedupe: window.__t.textCount('[[dedupe]]'),
    dedupe2: window.__t.textCount('[[dedupe2]]'),
    dispatchRowCompact: !window.__t.bubbleOf('[[dispatch]]'),
    state: window.__t.state(),
  }))
  checkAc('AC-19', '人类/派单/agent-message/assistant/team 事件均展示',
    merge.human === 1 && merge.dispatch === 1 && merge.relay === 1 && merge.assistant === 1 && merge.sysTask >= 1,
    merge)
  checkAc('AC-19', '跨会话去重不吞消息（同文去重/异文保留）',
    merge.dedupe === 1 && merge.dedupe2 === 2, merge)

  // AC-16：深浅色可读 + 气泡 token 变化
  const darkContrast = await page.evaluate(() => {
    const root = document.querySelector('#root > *');
    const assistantChain = window.__t.styleChain('[[assistant]]');
    return { theme: document.documentElement.getAttribute('data-theme'), rootBg: getComputedStyle(root).backgroundColor,
      assistantColor: assistantChain.chain.length ? assistantChain.chain[0].color : null };
  })
  checkAc('AC-16', '深色正文对比度>=4.5',
    contrastRatio(darkContrast.assistantColor, darkContrast.rootBg) >= 4.5,
    { ratio: contrastRatio(darkContrast.assistantColor, darkContrast.rootBg), ...darkContrast })

  const lightContrast = await page.evaluate(() => {
    window.__t.setTheme('light');
    const root = document.querySelector('#root > *');
    return new Promise((resolve) => setTimeout(() => {
      const bubble = window.__t.bubbleOf('[[human]]');
      const assistantChain = window.__t.styleChain('[[assistant]]');
      const tokens = window.__t.tokens();
      resolve({
        theme: document.documentElement.getAttribute('data-theme'),
        rootBg: getComputedStyle(root).backgroundColor,
        assistantColor: assistantChain.chain.length ? assistantChain.chain[0].color : null,
        bubbleBg: bubble ? bubble.bg : null,
        tokens: tokens,
        memberAvatars: window.__t.memberAvatars(),
      });
    }, 120));
  })
  const bubbleToken = lightContrast.tokens['--dsw-specific-bubble']
  checkAc('AC-16', '浅色主题生效且正文/胶囊使用 token',
    lightContrast.theme === 'light' && !!lightContrast.assistantColor && !!lightContrast.bubbleBg
    && contrastRatio(lightContrast.assistantColor, lightContrast.rootBg) >= 4.5
    && sameColor(lightContrast.assistantColor, lightContrast.tokens['--dsw-alias-label-primary'])
    && sameColor(lightContrast.bubbleBg, bubbleToken),
    { bodyRatio: contrastRatio(lightContrast.assistantColor, lightContrast.rootBg),
      assistantColor: lightContrast.assistantColor, primaryToken: lightContrast.tokens['--dsw-alias-label-primary'],
      bubble: lightContrast.bubbleBg, bubbleToken, ...lightContrast })
  const rootBgColor = parseCssColor(lightContrast.rootBg)
  const avatarContrasts = (lightContrast.memberAvatars || []).map((row) => {
    let effectiveBg = row.avatar.effectiveBg
    if (!effectiveBg) effectiveBg = colorObjectToRgb(blendColor(parseCssColor(row.avatar.bg), rootBgColor))
    const effectiveFg = row.avatar.effectiveFg || row.avatar.color
    return { text: row.text, bg: row.avatar.bg, fg: row.avatar.color,
      effectiveBg, effectiveFg,
      ratio: contrastRatio(effectiveFg, effectiveBg) }
  })
  const minAvatarContrast = avatarContrasts.length ? Math.min(...avatarContrasts.map((x) => x.ratio)) : null
  checkAc('AC-16', '角色色浅色下可读（头像/身份点对比度>=3）',
    minAvatarContrast === null ? false : minAvatarContrast >= 3, { minAvatarContrast, avatarContrasts })
  await screenshot(page, 'workbench-390-light-timeline.png')

  checkAc('AC-12', '时间线渲染过程无脚本错误', pageErrors.length === 0, pageErrors)
  await page.close()
}

/* ------------------------------------------------------------------ *
 * 7. 状态覆盖（AC-11）
 * ------------------------------------------------------------------ */
async function runStates(browser) {
  // pending
  {
    const { page } = await newHarnessPage(browser, { width: 390, height: 844, scenario: 'pending' })
    await sleep(250)
    await page.evaluate(() => window.__t.openProjects())
    await sleep(150)
    const m = await page.evaluate(() => window.__t.metrics())
    checkAc('AC-11', '项目列表 pending 文案', /加载中/.test(m.text) && m.drawer.open, { text: m.text.slice(0, 300), drawer: m.drawer })
    const tabClickable = await page.evaluate(() => window.__t.clickTab('tasks'))
    checkAc('AC-11', 'pending 不阻塞操作', tabClickable, { tabClickable })
    await page.close()
  }
  // empty list
  {
    const { page } = await newHarnessPage(browser, { width: 390, height: 844, scenario: 'emptyList' })
    await sleep(250)
    await page.evaluate(() => window.__t.openProjects())
    await sleep(150)
    const m = await page.evaluate(() => window.__t.metrics())
    checkAc('AC-11', '项目列表空态文案', /还没有带 Team 的会话/.test(m.text) && m.drawer.open, { text: m.text.slice(0, 300) })
    await page.close()
  }
  // no team projection
  {
    const { page } = await newHarnessPage(browser, { width: 390, height: 844, scenario: 'noTeam' })
    await sleep(250)
    await page.evaluate(() => window.__t.openProjects())
    await sleep(150)
    const m = await page.evaluate(() => window.__t.metrics())
    checkAc('AC-11', '只有 Lead 的会话不算 Team', /还没有带 Team 的会话/.test(m.text) && m.drawer.open, { text: m.text.slice(0, 300) })
    await page.close()
  }
  // member open failure
  {
    const { page } = await newHarnessPage(browser, { width: 390, height: 844, scenario: 'memberFail' })
    await sleep(900)
    await page.evaluate(() => window.__t.clickTab('members'))
    await sleep(150)
    const m = await page.evaluate(() => ({ metrics: window.__t.metrics(), state: window.__t.state() }))
    checkAc('AC-11', '成员打开失败有标注且不阻塞群聊',
      /(打开失败|未打开历史|agent-busy)/.test(m.metrics.text) && m.state.rowCount > 0,
      { text: m.metrics.text.slice(0, 500), state: m.state })
    await page.evaluate(() => window.__t.clickTab('chat'))
    await sleep(100)
    const chatOk = await page.evaluate(() => window.__t.state().rowCount > 0)
    checkAc('AC-11', '成员失败时群聊仍可用', chatOk, { chatOk })
    await page.close()
  }
  // list unreadable：保留现有内容 + 重连文案，不误判为空
  {
    const { page } = await newHarnessPage(browser, { width: 390, height: 844 })
    await sleep(600)
    const before = await page.evaluate(() => ({ text: window.__t.metrics().text, state: window.__t.state() }))
    await page.evaluate(() => window.__t.setScenario('unreadable'))
    await sleep(500)
    const afterClosed = await page.evaluate(() => ({ text: window.__t.metrics().text, state: window.__t.state() }))
    await page.evaluate(() => window.__t.openProjects())
    await sleep(180)
    const after = await page.evaluate(() => ({ text: window.__t.metrics().text, state: window.__t.state(), drawer: window.__t.metrics().drawer }))
    checkAc('AC-11', '列表不可读保留内容+重连文案',
      after.text.includes('[[md]]') && /(正在重新连接|重新连接|连接中)/.test(after.text),
      { closedText: afterClosed.text.slice(0, 200), beforeRows: before.state.rowCount, afterRows: after.state.rowCount,
        afterText: after.text.slice(0, 300), drawer: after.drawer })
    await page.evaluate(() => window.__t.setScenario('restoreList'))
    const tabClickable = await page.evaluate(() => window.__t.clickTab('tasks'))
    checkAc('AC-11', '列表不可读不阻塞操作', tabClickable, { tabClickable })
    await page.close()
  }
  // chat empty
  {
    const { page } = await newHarnessPage(browser, { width: 390, height: 844, scenario: 'emptyChat' })
    await sleep(600)
    const m = await page.evaluate(() => window.__t.metrics())
    checkAc('AC-11', '群聊空态有引导文案', /spawn_teammate|Team 会话|还没有内容/.test(m.text), { text: m.text.slice(0, 500) })
    await page.close()
  }
}

/* ------------------------------------------------------------------ *
 * 8. 桌面回归 + 贴底/折叠（AC-17/18）
 * ------------------------------------------------------------------ */
async function runStick(browser) {
  const { page } = await newHarnessPage(browser, { width: 390, height: 844 })
  await page.evaluate(() => window.__t.scrollBottom())
  await sleep(120)
  const atBottomBefore = await page.evaluate(() => window.__t.chatInfo())
  await page.evaluate(() => window.__t.appendMessage('S-pm', '[[follow-new]] 贴底时新消息应跟随'));
  await sleep(350)
  const afterFollow = await page.evaluate(() => ({ info: window.__t.chatInfo(), text: window.__t.metrics().text }))
  checkAc('AC-18', '贴底时新消息跟随', atBottomBefore.atBottom && afterFollow.info.atBottom
    && afterFollow.text.includes('[[follow-new]]'), { before: atBottomBefore, after: afterFollow.info })
  await page.evaluate(() => window.__t.scrollChat(0.35))
  await sleep(120)
  const beforeNoStick = await page.evaluate(() => window.__t.chatInfo())
  await page.evaluate(() => window.__t.appendMessage('S-pm', '[[follow-nostick]] 上滑后新消息不应拉回底部'));
  await sleep(350)
  const afterNoStick = await page.evaluate(() => window.__t.chatInfo())
  checkAc('AC-18', '上滑后不被拉回底部',
    Math.abs(afterNoStick.scrollTop - beforeNoStick.scrollTop) <= 2 && !afterNoStick.atBottom,
    { before: beforeNoStick, after: afterNoStick })

  // 内容塌缩不误判贴底：上滑 -> 清空 -> 恢复+新消息，不应写 scrollTop 到底
  await page.evaluate(() => { window.__t.startScrollProbe(); window.__t.resetProbe(); })
  await page.evaluate(() => window.__t.scrollChat(0.35))
  await sleep(100)
  const collapseBefore = await page.evaluate(() => window.__t.chatInfo())
  await page.evaluate(() => window.__t.collapseRestore('[[collapse-new]] 塌缩恢复后的新消息'));
  await sleep(900)
  const collapseAfter = await page.evaluate(() => ({
    info: window.__t.chatInfo(), probe: window.__t.probe(), text: window.__t.metrics().text,
  }))
  const machineToBottom = (collapseAfter.probe ? collapseAfter.probe.writes : []).filter((w) => w.max > 100 && w.to >= w.max - 2 && w.before < w.max - 100)
  checkAc('AC-18', '内容塌缩不误判贴底（无机器写到底部）',
    machineToBottom.length === 0 && !collapseAfter.info.atBottom,
    { before: collapseBefore, after: collapseAfter.info, machineToBottom })
  checkAc('AC-18', '塌缩恢复后新消息可见', collapseAfter.text.includes('[[collapse-new]]'), { sample: collapseAfter.text.slice(0, 200) })
  await page.close()

  // AC-18 补充（真实外壳同款时序）：多个成员会话异步 open，晚到的会话在时间线上方插入旧消息。
  // 用户从未上滑，贴底意图应保持，首屏必须仍是最新一条。
  const { page: staggerPage } = await newHarnessPage(browser, { width: 390, height: 844, scenario: 'stagger' })
  await sleep(2200)
  const stagger = await staggerPage.evaluate(() => ({ chat: window.__t.chatInfo(), state: window.__t.state() }))
  await screenshot(staggerPage, 'workbench-390-stagger.png')
  checkAc('AC-18', '异步会话打开后首屏仍贴底（默认最新一条）',
    !!stagger.chat && stagger.chat.atBottom, stagger)
  // 同一 stagger 页面：上滑 30% 后再追加新消息，不得被拉回底部。
  await staggerPage.evaluate(() => window.__t.scrollChat(0.3))
  await sleep(150)
  const staggerMid = await staggerPage.evaluate(() => window.__t.chatInfo())
  await staggerPage.evaluate(() => window.__t.appendMessage('S-pm', '[[stagger-nostick]] 上滑后不应拉回'))
  await sleep(450)
  const staggerAfter = await staggerPage.evaluate(() => ({ chat: window.__t.chatInfo(), text: window.__t.metrics().text }))
  checkAc('AC-18', 'stagger 场景上滑后新消息不拉回',
    Math.abs(staggerAfter.chat.scrollTop - staggerMid.scrollTop) <= 2 && !staggerAfter.chat.atBottom
    && staggerAfter.text.includes('[[stagger-nostick]]'),
    { before: staggerMid, after: staggerAfter.chat })
  await staggerPage.close()
}

/* ------------------------------------------------------------------ *
 * 9. 主流程
 * ------------------------------------------------------------------ */
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
const serverPort = server.address().port

const report = {
  generatedAt: new Date().toISOString(),
  clientPath,
  DSH,
  baseline: BASELINE,
  checks,
  screens,
  shots,
  fatal: null,
}

let browser
try {
  const source = readFileSync(clientPath, 'utf8')
  report.clientBytes = source.length
  report.clientVersionMarker = (source.match(/v0\.\d\.\d[^\n]{0,40}/) || [source.slice(0, 80)])[0]

  // 静态检查先跑（不依赖浏览器）
  runStaticChecks()

  browser = await chromium.launch({ headless: true })
  if (smokeOnly) {
    const stagger = process.env.SMOKE_STAGGER === '1'
    const { page } = await newHarnessPage(browser, { width: 390, height: 844, scenario: stagger ? 'stagger' : 'default' })
    if (stagger) {
      await sleep(1800)
      const chat = await page.evaluate(() => window.__t.chatInfo())
      const state = await page.evaluate(() => window.__t.state())
      console.log(JSON.stringify({ smoke: 'stagger', chat, state }, null, 2))
      await page.screenshot({ path: join(OUT, 'stagger-debug.png') })
      await page.close()
      report.ok = true
      report.smoke = true
      writeFileSync(join(OUT, 'stagger-debug.json'), JSON.stringify({ chat, state }, null, 2) + '\n')
      throw new Error('__SMOKE_DONE__')
    }
    const m = await metricsOf(page)
    const api = await page.evaluate(() => ({
      state: window.__t.state(),
      counters: window.__t.counters(),
      rows: window.__t.messageRows(),
      tabs: window.__t.metrics().tabs,
      status: window.__t.metrics().status,
      chat: window.__t.chatInfo(),
      sampleRows: window.__t.messageRows().slice(0, 12),
      hasTestids: {
        root: !!document.querySelector('[data-testid="devbot-root"]'),
        chat: !!document.querySelector('[data-testid="chat-scroll"]'),
        status: !!document.querySelector('[data-testid="status-bar"]'),
        tabs: document.querySelectorAll('[data-testid^="tab-"]').length,
      },
    }))
    const headsDebug = await page.evaluate(() => {
      const block = ['[[pm-head-1]]', '[[pm-head-2]]', '[[pm-head-3]]']
      const rows = window.__t.rowsForMarkers(block).map((row) => ({
        kind: row.getAttribute('data-kind'), text: (row.textContent || '').slice(0, 120),
        leaves: Array.from(row.querySelectorAll('*')).filter((el) => el.children.length === 0 && (el.textContent || '').trim() === 'pm').length,
      }))
      return { blockHead: window.__t.headCountForMarkers(block, 'pm'), blockAvatars: window.__t.avatarCountForMarkers(block), rows }
    })
    console.log(JSON.stringify({ smoke: true, metrics: m, api, headsDebug }, null, 2))
    await page.close()
    report.ok = true
    report.smoke = true
    writeFileSync(join(OUT, 'smoke.json'), JSON.stringify({ metrics: m, api }, null, 2) + '\n')
    throw new Error('__SMOKE_DONE__')
  }
  await runMatrix(browser)
  await runInteractions(browser)
  await runTimeline(browser)
  await runStates(browser)
  await runStick(browser)
} catch (error) {
  if (String(error && error.message) === '__SMOKE_DONE__') {
    fatal = null
    report.fatal = null
  } else {
    fatal = String(error && error.stack ? error.stack : error)
    report.fatal = fatal
    if (!jsonOnly) console.error('FATAL', fatal)
  }
} finally {
  if (browser) await browser.close()
  server.close()
}

const failed = checks.filter((c) => !c.ok)
report.ok = !fatal && failed.length === 0
report.failed = failed
report.stats = {
  total: checks.length,
  pass: checks.length - failed.length,
  fail: failed.length,
  byAc: Object.fromEntries([...new Set(checks.map((c) => c.ac))].map((ac) => {
    const list = checks.filter((c) => c.ac === ac)
    return [ac, { pass: list.filter((c) => c.ok).length, fail: list.filter((c) => !c.ok).length }]
  })),
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')

if (jsonOnly) {
  console.log(JSON.stringify({
    ok: report.ok,
    fatal,
    stats: report.stats,
    failed: failed.map((c) => ({ ac: c.ac, id: c.id, detail: c.detail })),
    shots: shots.map((s) => s.name),
  }, null, 2))
} else {
  console.log('\n' + (report.ok
    ? `RESULT: PASS — ${checks.length} 项检查全绿`
    : `RESULT: FAIL — ${failed.length}/${checks.length} 项失败`))
  for (const item of failed) console.log(`  ✖ ${item.ac} ${item.id}  ${fmt(item.detail).slice(0, 400)}`)
  console.log('截图：' + shots.map((s) => s.name).join(', '))
  console.log('报告：' + relative(ROOT, join(OUT, 'report.json')))
}
process.exit(report.ok ? 0 : 1)
