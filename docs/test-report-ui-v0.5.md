# DevBot v0.5 UI 验收报告（阶段门 5/5 · 测试验证）

> 被测对象：`client.js` v0.5（task-4 rev7 修复后）｜仓库 HEAD 基线：`e0f8ef7` + task-4 开工前快照
> 验收人：tester2｜完成时间：2026-10-31 01:35（Asia/Shanghai）
> 验收依据：`docs/prd-ui-v0.5.md` §13（AC-01 ~ AC-23）、`docs/dsh-ui-style-spec.md`
> 结论：**PASS** —— AC-01 ~ AC-23 全部通过，无打回项；AC-18 曾打回 task-4 一次，修复后已复验通过。

## 1. 结论摘要

- **AC-01 ~ AC-23：23/23 PASS**。独立 Playwright 验收器 209 项断言 0 失败；fullstack 回归 226 项 0 失败；`npm test` 33/33；既有滚动 repro PASS。
- **真实 DSH 外壳已验**（`http://127.0.0.1:3080` token 登录，非 fake 环境）：1280 三栏、390/430 单栏+四段 tab、页面无横溢、状态条单行、首屏贴底均通过（20/20）。
- **曾 FAIL 1 条并打回**：AC-18「首次打开/异步 attach 时未贴底」。task-4 reopen 后由 fullstack2 修复（内容 revision 依赖 + onScroll 几何判定 + 程序化滚动标记），本轮受控 stagger 与真实外壳均复验 PASS。详见 §5。
- **待用户真机项**：iOS Safari 地址栏 100vh 抖动、真实刘海/手势条（已用 CDP 注入 47/34px 模拟）、真实 DSH 浅色主题点击切换。见 §6。

## 2. 环境与验收方法

| 项 | 值 |
|---|---|
| OS / Node | macOS（Apple Silicon）/ Node v25.8.1 |
| 浏览器 | Playwright 自带 Chromium 149.0.7827.55（headless） |
| React | DSH checkout 内 React UMD development build（真实 client.js 组件） |
| DSH checkout | 本机 deepseek-harness checkout，由 `DSH_CHECKOUT` 指定（只读复用 Playwright/React，未改 DSH） |
| 真实外壳 | `dsh web` @ `127.0.0.1:3080`，token URL 登录（token 不落库） |
| 断点依据 | `.devbot-root` 容器宽度（@container），不是 viewport media query |
| 基线 | task-4 开工前快照：`/tmp/devbot-tester2`（client.js/package.json/test 全量 hash + git status） |

三层独立验证，不只复跑 fullstack2 的断言：

1. **独立 fake-sessions harness**：`test/browser/workbench-visual.mjs`。
   - 用真实 `client.js` + 真实 React 渲染；fake `ctx.sessions` 复刻异步 open / retain-release / loadOlder / prepend / 流式 settle 语义。
   - 构造 5 会话群聊（人类/派单/agent-message/assistant/team 事件、markdown 全子集、XSS、跨日、连续发送、流式、blocked 任务、成员打开失败、列表不可读等）。
   - 断点矩阵 375/390/430/559/600/768/899/900/1024/1280/1440 × 深/浅色；截图 `test/browser/out/v0.5/workbench-*.png`。
2. **fullstack 回归复核**：`test/browser/workbench-responsive.mjs`、`test/browser/workbench-scroll.repro.mjs`、`npm test`，只做复核与记录，不替代独立断言。
3. **真实 DSH 外壳**：`test/browser/dsh-shell-check.mjs`（需 `DSH_WEB_URL`），在真实侧栏/主栏宽度下量断点与贴底。
4. **safe-area 注入**：Chromium CDP `Emulation.setSafeAreaInsetsOverride` 注入顶部 47px / 底部 34px，验证顶栏/底栏不遮挡。

## 3. 命令与结果（证据）

| 命令 | 结果 | 证据文件 |
|---|---|---|
| `npm test` | **33/33 PASS**（12 旧 + 21 新） | `test/browser/out/v0.5/npm-test.log` |
| `node test/browser/workbench-responsive.mjs` | **226 项检查，0 失败**；18 张截图 | `test/browser/out/v0.5/workbench-responsive.log` |
| `node test/browser/workbench-scroll.repro.mjs` | **PASS**（上滑/retry/streaming/loadOlder/换团队均不跳底、无塌缩、无重挂） | `test/browser/out/v0.5/workbench-scroll-repro.log` |
| `node test/browser/workbench-visual.mjs` | **209/209 项断言 PASS**；46 张截图 | `test/browser/out/v0.5/workbench-visual.log`、`report.json` |
| `DSH_WEB_URL=… node test/browser/dsh-shell-check.mjs` | **20/20 PASS**（1280/390/430） | `test/browser/out/v0.5/real-shell.log`、`real-shell.json` |

关键表格（独立 harness，`report.json` 的 `stats.byAc`）：

```
AC-01 17/17  AC-02 7/7   AC-03 21/21  AC-04 22/22  AC-05 37/37  AC-06 15/15
AC-07 9/9    AC-08 4/4   AC-09 7/7    AC-10 4/4    AC-11 9/9    AC-12 5/5
AC-13 3/3    AC-14 4/4   AC-15 3/3    AC-16 10/10  AC-17 12/12  AC-18 6/6
AC-19 2/2    AC-20 3/3   AC-21 1/1    AC-22 4/4    AC-23 4/4
```

## 4. AC 逐条验收

### R1 响应式与移动端可用性

| AC | 结论 | 证据（实测值） |
|---|---|---|
| **AC-01** 375/390/430 无横向溢出 | **PASS** | 三档 `page.scrollWidth == clientWidth`（375/390/430）、`.devbot-root` 同宽、`chat-scroll.scrollWidth == clientWidth`；另覆盖 559/600/768/899/900/1024/1280/1440 × 深/浅色，共 17 项。截图 `workbench-{375,390,430}-{dark,light}.png` |
| **AC-02** 群聊宽≥280 高≥300 | **PASS** | chat 375×720 / 390×720 / 430×720（clientWidth×clientHeight）；7 项含浅色。 |
| **AC-03** 无逐字竖排 | **PASS** | 375 宽正文容器最小 327px（段落 p/li/blockquote 实测 327–343）；状态条 88×18px、`white-space:nowrap`、`singleLine=true`；全页 `writing-mode: vertical-*` 元素 0。 |
| **AC-04** 阶段门/任务/成员可滚到最后无裁切 | **PASS** | 375/390/430 深/浅色各视图末项 `lastVisible=true`、`horizontalOverflow=false`；另加 32 条任务长列表：375 下任务面板 `scrollable=true`、`max=1567`、滚到 `finalTop=1567` 后末项 bottom 828≤容器 844，无裁切（`workbench-375-longtasks.png`）。 |
| **AC-05** 三断点与缩放保状态 | **PASS** | 900/1024/1280/1440 三栏；600/768/899 两栏且项目列表不常驻；375/390/430/559 单栏+四段 tab；390→768→1280→390 缩放后当前项目与选中 tab 保持。37 项。 |
| **AC-06** 热区≥40×40 + safe-area | **PASS** | <900 导航控件（返回/刷新/项目切换/四段 tab/侧栏分段/抽屉项）均 ≥40×40（tab 375 下 94×44，图标 40×40，项目按钮 283×40）；CDP 注入 top=47/bottom=34 后：appbar 高 88（padding-top 47）、status 高 65（padding-bottom 40）、chat 646 高、按钮 top=47 不被刘海遮挡、页面无横溢。真机刘海/手势条见 §6。 |
| **AC-07** 项目切换三断点可用 | **PASS** | ≥900 左栏常驻；560–899 顶栏项目入口可见（600/768/899 实测宽 508/676/807×40）；<560 抽屉可开、`data-current=true` 高亮、点遮罩关闭且不切换、切到「支付流程重构」后时间线只含 `[[teamb]]` 且 `[[md]]` 不残留。9 项。 |
| **AC-08** 切 tab 保状态 | **PASS** | 390：群聊 scrollTop 764 → 切任务 → 切回仍 764（±0）；贴底 2182 → 切任务 → 切回仍 2182/2182；切换期间无 scroll 塌缩事件、状态条无 loading 文案。 |
| **AC-09** 上滑加载 | **PASS** | 距顶<48 触发 1 次（每会话 `loadOlder` 计数 +1）；loading 文案「正在加载更早消息…」；到最早「已到当前会话窗口最早处」且再滚不触发；失败场景 0 弹窗、内容 scrollHeight 不缩、计数不增长（无无限重试）。 |
| **AC-10** 刷新/返回 | **PASS** | 刷新按钮 `disabled=true` + `data-busy=true`，完成后文本完全一致（不清空）；点返回 `layout.selectPanel(null)`；返回按钮 40×40。 |
| **AC-11** 状态覆盖 | **PASS** | pending「加载中…」、空「还没有带 Team 的会话」、仅 Lead 不算 Team、群聊空引导 3 行、成员打开失败标注（失败·未打开历史·打开失败）且群聊仍 33 行、列表不可读保留 34 行 +「正在重新连接…」且切 tab 不阻塞。9 项。 |

### R2 时间线风格统一

| AC | 结论 | 证据（实测值） |
|---|---|---|
| **AC-12** assistant 无气泡 + markdown | **PASS** | `bubble=null`（article 背景透明、border 0、padding 0、无头像）；markdown 实测渲染 `h1/h2/h3/p/strong/em/code/pre/ul/ol/blockquote/hr` 全存在；安全链接 href=`https://example.com/docs`，`javascript:` 链接无 href（降级文本）；源码无 markdown 库 require。 |
| **AC-13** 用户胶囊/成员头合并 | **PASS** | 用户胶囊 294×64、右边缘 374（容器右 390-16）、圆角 20、无头像/无「你」；连续 3 条 pm 消息只 1 个头/1 个头像，间隔 >5min 第 4 条重新显示（head=2/avatar=2）。 |
| **AC-14** 系统/派单/流式/日分隔 | **PASS** | 系统条与派单行 `bubble=null`（紧凑无气泡）；流式期间出现「输入中」，settle 后 `[[stream-live]]` 计数=1、无「输入中」残留；日分隔实测「10月27日/10月28日/10月29日/昨天/今天」。 |
| **AC-15** XSS | **PASS** | `<script>`、`<img onerror>`、`javascript:` 链接三个执行标记均为 0；`#root` 内 `script/img` 元素 0；原始 HTML 以文本形式可见（转义展示）。 |
| **AC-16** 深/浅色可读 | **PASS** | 深色正文对比度 17.45:1；浅色正文 18.9:1（`rgb(15,17,21)` on `#FFFFFF`）；用户胶囊浅色=`#EDF3FE` token 精确匹配；角色头像最低对比度 3.19:1（浅色）；新增区域无硬编码白底/黑字（基线 1 处旧色，当前 0 新增）。浅色 token 取自设计实测表，真实 DSH 浅色按钮未点击（见 §6）。 |

### R3 行为不回退

| AC | 结论 | 证据（实测值） |
|---|---|---|
| **AC-17** 桌面三栏不回退 | **PASS** | 1280/1440：项目列表 196、chat flex（1280 下 832）、信息区 252；侧栏阶段门/任务/成员可切换；无四段移动 tab。12 项。 |
| **AC-18** 贴底跟随/上滑不回弹/塌缩不误判 | **PASS（修复后）** | 贴底追加：2182→2212 仍 atBottom；上滑 774 后追加：774 不变、不拉回；内容塌缩：机器写到底部次数 0、恢复后不跳底；**异步 stagger**：首屏 2182/2182 atBottom，上滑 30% 后追加仍不拉回。修复前 FAIL 证据见 §5。 |
| **AC-19** 事件规则/去重 | **PASS** | human=1、dispatch=1、agent-message relay=1、assistant=1、team sys=1；同文跨会话去重 `[[dedupe]]`=1，异文 `[[dedupe2]]`=2（不吞消息）；流式 settle 后计数 1。 |

### R4 验证方式与交付约束

| AC | 结论 | 证据（实测值） |
|---|---|---|
| **AC-20** npm test + 新增单测 | **PASS** | `npm test` 33/33；新增 `test/markdown.test.mjs`（parseMarkdown/parseInline/safeHref/renderMarkdown/XSS）、`test/layout.test.mjs`（breakpointOf/shouldShowMemberHead/statusTextOf/firstLine），无溢出断言在响应式套件中。 |
| **AC-21** 六档 + 深/浅色截图 | **PASS** | 375/390/430/768/1280/1440 六档 × dark/light 共 12 张必需截图全部存在（`workbench-<w>-<theme>.png`），另有 34 张交互/断点/真实外壳截图；`report.json` 约 138KB。 |
| **AC-22** 与设计稿/DSH 差异 ≤5 且为 DevBot 特有 | **PASS** | 设计基线 `design/conversation-style.html` 差异清单 5 条：成员身份头、系统/门禁/任务事件行、派单行、流式「输入中」、日分隔；人工对照实际截图，正文/用户胶囊/间距/token 与设计一致，无额外视觉体系。无外部 CDN；`package.json` 无新增依赖。 |
| **AC-23** 改动范围 | **PASS** | 相对 task-4 开工前基线：**task-4 UI diff** 仅 `client.js`、`test/*`、`docs/impl-ui-v0.5.md`、截图；`bin/`、`index.js` 无改动；`package.json` 未变（保持 0.5.1，task-4 前即为 0.5.1 preset 桥版本）；无 `localStorage/sessionStorage/indexedDB/cookie`，无第二份群日志。**归属说明**：task-4 complete 后 Lead 直接指派了「团队协作节奏」改动（新增 `docs/team-workflow.md`、`README.md` 3 行、`cordis.patch.yml` 5 处 persona 文案），不计入 task-4 UI diff；host 接口/入口文件无新增。 |

## 5. 打回记录：AC-18（唯一 FAIL）与修复复验

### 5.1 Round 1（01:10）FAIL

- **受控 stagger**（成员会话异步 open，晚到会话只在时间线上方插入旧消息，用户零滚动）390×844：`scrollTop=0 / max=2210 / atBottom=false`。
- **真实 DSH 外壳** 1280×900：`scrollTop=25581 / max=28671`，距底约 3090px，6s 内不跟到底。
- 根因（只读定位）：`DevbotWorkbench` 跟随 effect 依赖 `[lastKey, detail.leadId]`；晚到会话在上方插入旧消息时 `lastKey` 不变 → effect 不跑；异步内容增长触发的 scroll 又会让 `nextStick` 在 max 变大后把 stick 误翻 false。
- 处置：**task-4 打回 reopen**，block 后续；未口头放行。
- 证据：`test/browser/out/v0.5/workbench-visual-round1-ac18-fail.log`、`workbench-390-stagger-round1-fail.png`、`real-shell-round1-ac18.json`、`real-shell-round1-open.json`。

### 5.2 修复（fullstack2，01:16）

1. 跟随 effect 改为内容 revision（行数 + 首行 key + 末行 key + 末行文本长度），覆盖「上方插入旧内容」与「流式文本变长」；
2. `onScroll` 仅当 `top < prev.top - 2`（用户真的上移）才清除 stick，内容增长/scroll anchoring 不误翻；
3. 程序化滚动用 `programmaticRef` 标记，忽略对应 scroll 事件；
4. loadOlder prepend 时保持阅读位置，不跳底。

### 5.3 Round 2（01:31）PASS

- 受控 stagger：首屏 `scrollTop=2182 / max=2182 / atBottom=true`；同页上滑 30% 后追加新消息，scrollTop 不变、不拉回。
- 真实 DSH 外壳 1280：`scrollTop=33285 / max=33285 / atBottom=true`；390/430 页面无横溢、chat 334/374×720、四段 tab 84/94×44。
- 复跑全部：`npm test 33/33`、responsive 226/226、scroll repro PASS、独立 harness 209/209。

## 6. 待用户真机确认（不影响本轮 AC 判定）

1. **iOS Safari 地址栏伸缩 / 100vh**：headless 无法复现；实现用容器高度 + `env(safe-area-inset-bottom)`，需真机确认滚动时不跳动。
2. **真实刘海/手势条**：已用 Chromium CDP 注入 47/34px 验证布局不遮挡；真机物理裁切仍需用户看一眼。
3. **真实 DSH 浅色主题点击切换**：浅色验证使用设计实测 token 集（`data-theme=light`）+ computed 对比度；真实 GUI 本轮为深色截图，建议用户切一次浅色确认观感。
4. **长按/滚动惯性/字体渲染**：桌面 Chromium 与 iOS 有差异，属观感确认项。

## 7. 复核命令与产物

```bash
# 独立验收（真实 client.js + fake sessions；209 断言 + 46 截图）
node test/browser/workbench-visual.mjs

# fullstack 回归复核
npm test
node test/browser/workbench-responsive.mjs
node test/browser/workbench-scroll.repro.mjs

# 真实 DSH 外壳（token 从 ~/Library/Logs/dsh-web.log 取，重启会轮换）
DSH_WEB_URL='http://127.0.0.1:3080/?token=…' node test/browser/dsh-shell-check.mjs
```

产物目录：`test/browser/out/v0.5/`

- `report.json`：独立 harness 209 项断言明细；
- `workbench-visual.log` / `workbench-responsive.log` / `npm-test.log` / `workbench-scroll-repro.log` / `real-shell.log`；
- 截图：`workbench-<width>-<theme>.png`、`workbench-390-tab-*.png`、`workbench-390-drawer.png`、`workbench-390-refresh-busy.png`、`workbench-390-safearea.png`、`workbench-375-longtasks.png`、`workbench-390-stagger.png`、`real-shell-{1280,390,430}.png`；
- Round 1 FAIL 证据：`*-round1-*`、`workbench-390-stagger-round1-fail.png`。

## 8. 非阻塞观察（P3，不要求本轮修）

1. 首次启动 pending 时，项目抽屉会同时出现「正在重新连接…」与「加载中…」；两段文案语义有重叠，建议后续仅在「已有旧列表但列表暂不可读」时显示重连，首次加载只显示「加载中…」。
2. 正文内 markdown 行内链接不扩大为 40px 热区（按文本链接处理，与 DSH 一致）；导航/按钮/分段 tab 均 ≥40×40。若产品要求链接也满足 40px，可后续加 padding。
3. 已知限制（与 `docs/impl-ui-v0.5.md` §8 一致）：markdown 不含表格/任务列表 checkbox/嵌套多级/图片；流式期间纯文本；无 DSH TurnUp「已完成，用时」行；760 正文上限仅 ≥900；断点按容器宽需真实外壳复验（本轮已验 1280/390/430）。
4. **task-4 完成后的 Lead 协作节奏改动**：`docs/team-workflow.md`（新增）、`README.md`（+3 行链接）、`cordis.patch.yml`（5 处 persona 文案）发生在 task-4 complete 之后，不属于 task-4 UI diff；AC-23 已按归属单独记录（独立验收器的 `postTask4` 字段）。YAML 由 fullstack2 用 js-yaml 校验 6 个 preset 通过，UI 验收未改这些文件。

## 9. 签署

- **task-5 验收结论：PASS，可进入下一阶段/交付。**
- 无阻塞打回项；AC-18 已按「打回 → 修复 → 复验」闭环。
- 待用户真机项见 §6，不阻塞本轮 AC 判定。
