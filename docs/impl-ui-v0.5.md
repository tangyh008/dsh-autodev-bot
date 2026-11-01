# DevBot v0.5 实现说明：响应式工作台 + DSH 风格时间线

> 阶段门 4/5「代码实现」· task-4 · 实现者 fullstack2
> 上游：`docs/prd-ui-v0.5.md`、`docs/dsh-ui-style-spec.md`、`design/mobile-workbench.html`、`design/conversation-style.html`
> 版本：`0.5.1`（未降版、未改 `package.json`）
> 交付：`client.js`（渲染层重写，controller 语义不动）+ `test/markdown.test.mjs`、`test/layout.test.mjs`、`test/browser/workbench-responsive.mjs` + 截图 `test/browser/out/`

## 1. 改动概览

| 文件 | 改动 |
|---|---|
| `client.js` | 工作台渲染层重写：CSS class + `@container` 三断点、DSH 同族时间线、markdown 子集渲染器、四段 tab/状态条/项目抽屉、`listStale` 重连态；新增 markdown/布局纯函数并挂到 `_internals` |
| `test/markdown.test.mjs` | 新增：markdown 子集解析/渲染、链接白名单、XSS（`<script>`、`<img onerror>`） |
| `test/layout.test.mjs` | 新增：断点判定、成员头合并、状态条三态、派单首行摘要 |
| `test/browser/workbench-responsive.mjs` | 新增：真实 Chromium 六档 + 深浅色截图与 212 项几何/交互断言 |
| `test/browser/out/` | 17 张截图 + `report-responsive.json` |

未改动：`index.js`（Host 侧）、`cordis.patch.yml`、`package.json`、`docs/` 既有文档、DSH 源码；未新增依赖、无构建步骤。

## 2. 响应式布局（PRD §5–§8）

- **容器查询**：`.devbot-root{container-type:inline-size;container-name:devbot}`，所有断点用 `@container devbot (...)`，不用 viewport media query。
- **≥900 三栏**：项目列表 196 + 群聊 `flex:1` + 信息区 252；顶栏恢复 v0.4 形态（标题 / 面包屑 / 刷新 / 回到会话）；信息区内部三段（阶段门/任务/成员）用 28px 高分段。
- **560–899 两栏**：群聊 + 信息区 252；项目列表收起，顶栏项目名打开顶部浮层（`top:56px`，`max-height:min(70%,420px)`，点遮罩/关闭/Esc 关闭）。
- **<560 单栏**：顶栏 48（返回 40×40 / 项目名+▾ / 刷新 40×40）+ 四段 tab（高 44，选中=加粗+2px 底部指示条）+ 单视图 + 群聊底部状态条（单行、`white-space:nowrap`、叠加 `env(safe-area-inset-bottom)`）+ 底部抽屉（`border-radius:20px 20px 0 0`，`max-height:70%`）。
- **触控**：<900 可点元素 ≥40×40（系统行/派单行也给 40px 高，桌面仍保持 24px 紧凑行）。
- **safe-area**：顶部 `env(safe-area-inset-top)` + `--dsh-frame-top-clearance`，底部 `env(safe-area-inset-bottom)`。
- **状态保持**：切 tab 只隐藏不卸载（chat / 三个信息面板各自保 `scrollTop`）；切走时若无布局（`clientHeight<=0`）不覆盖已保存位置与贴底意图；切回时贴底→到最新，非贴底→恢复原位置。换团队 → 回最新。断点重排不重载数据。
- **贴底跟随（AC-18 修复）**：跟随 effect 以内容 revision（行数 + 首行 key + 末行 key + 末行文本长度）为依赖，晚到成员会话异步 open 把旧消息插到*上方*时也会重新贴底；`onScroll` 只在「`scrollTop` 真的变小」时清除贴底意图，内容增长/scroll anchoring/程序化滚动（`programmaticRef` 标记）不翻 stick；内容塌缩（max<=0）保持原意图；上滑后（stick=false）新消息/prepend 都不拉回。

## 3. 时间线（PRD §11 / 风格规范）

- **assistant / 成员正文**：无气泡、无边框、整列直排；14/24，`--dsw-alias-label-primary`；markdown 块间 16px。
- **用户**：右对齐胶囊，`--dsw-specific-bubble` + `--dsw-radius-xl`(20) + `padding 10×16` + 14/22，无头像/名字，上限 `min(82%,100%)`，时间 11/18 右对齐。
- **成员头合并**：仅依赖行数据（`senderId` 变化 / 同发送者 >5 分钟 / 跨日 / 上一条非成员正文）；首条显示 20px 头像（角色色仅用于头像底与字）+ 12/18 名字 + 11/18 时间；连续发送 `cont` 组内 6px、组间 12px。
- **派单 / 工具行**：24px 单行（桌面）/40px 热区（<900），图标 16（字形 14）+「派单」13/24 + 摘要 ellipsis；点击展开 `markdown-code-block` 卡片（radius-lg、11/16 mono、max-height 150、内部滚动）。
- **系统 / 门禁 / 任务事件**：居中 12/18 `label-tertiary`，单行省略，点击展开详情；无彩色气泡。
- **日分隔**：居中 11/18，上下 10/12，跨日必显示（今天/昨天/M月D日）。
- **流式**：正文按纯文本追加（避免半截 markdown 抖动）+「输入中」11/18 三点；settle 后由 controller 替换成持久消息，不叠字。
- **markdown 子集**：标题 h1–h4、段落、粗体、斜体、行内码、围栏代码块（带语言横幅）、ul/ol（含续行）、引用、链接、hr。
- **安全**：解析器只产出 React 元素/文本子节点（React 自动转义），**无 `dangerouslySetInnerHTML`**；链接白名单 `http(s)` / `mailto` / `#`，其余降级为纯文本；`_blank` 链接带 `rel="noopener noreferrer"`。

## 4. 主题与 token（AC-16）

- 颜色/边框/圆角只引用 `--dsw-alias-*` / `--dsw-specific-bubble` / `--dsw-radius-*`；CSS 中无十六进制/rgba 硬编码颜色。
- 角色色由 alias token 用 `color-mix` 派生（lead=link、pm=warn、designer=link+error、fullstack=success、tester=error），只出现在头像底/字，浅色下加透明边框与 74% 混主文字色保证可读。
- 深/浅色：组件不切换主题，只消费 DSH token；Playwright 用两套 token 快照验证正文色 ≠ 背景色。

## 5. controller 未动

以下函数体保持 v0.4 原样（git diff 可核对）：`buildRow`、`mergeRows`、`attach`/`detach`/`releaseHandle`（增量 retain/release）、`loadOlder`、`selectTeam`、`setActive`、`startWatching`、`nextStick`、`shouldFollowBottom`、流式 settle 去重、日分隔键值。

controller 仅新增 1 个**展示字段** `listStale`：会话列表快照暂时不可读时（`readTeams` 返回 pending 且旧列表被保留）置 true，用于渲染「正在重新连接…」（PRD §9 / AC-11）；可读后自动清除。不影响 retain/release/滚动语义。

## 6. 渲染层结构（便于 Tester 定位）

- 根：`[data-testid="devbot-root"]`（同时带 `data-view=chat|gates|tasks|members`、`data-projects=open|closed`）
- 顶栏：`back-btn-mobile` / `project-switcher` / `refresh-btn-mobile`；桌面 `back-btn-desktop` / `refresh-btn-desktop`
- 分段：`tabs` + `tab-chat|tab-gates|tab-tasks|tab-members`（每个 tab 带 `data-view`）；桌面/两栏信息区分段 `side-tab-gates|tasks|members`
- 群聊：`chat-scroll`（滚动容器）→ `message-list` → 行元素带 `data-kind=sys|dispatch|user|member|assistant|stream`；`status-bar`
- 项目：左栏 `team-item-sidebar`、抽屉 `team-item-drawer`（都带 `data-team-id`、`data-current`）；`project-drawer`、`project-mask`
- 面板：`.devbot-panel[data-active="true"]`（`aria-label` 阶段门/任务/成员）

`_internals` 新增纯函数：`parseMarkdown`、`parseInline`、`safeHref`、`renderMarkdown`、`breakpointOf`（→`three|two|one`）、`shouldShowMemberHead`、`statusTextOf`、`firstLine`。

## 7. 验证

```bash
npm test                                                        # 33 个单测全绿（12 旧 + 21 新）
node test/browser/workbench-responsive.mjs                      # 226 项断言 + 18 张截图
node test/browser/workbench-scroll.repro.mjs                    # 既有滚动回归（controller 语义）PASS
```

- `workbench-responsive.mjs` 覆盖 375/390/430/600/768/899/900/1024/1280/1440 + 375/1280 浅色（**226 项断言 / 18 张截图**）：
  - AC-01 页面/根/群聊无横向溢出；AC-02 群聊宽高 ≥280×300；AC-03 状态条单行不竖排；
  - AC-05 三断点列宽（196/252）与 tab 显隐；AC-06 <900 可见按钮 ≥40×40；
  - AC-07 390 抽屉开/遮罩关/切换团队/无旧消息残留，768 顶栏浮层；
  - AC-08 切 tab 保 scrollTop ±2px；AC-09 上滑加载触发一次、文案、到最早不再触发；
  - AC-11 列表不可读时保留列表 +「正在重新连接…」；
  - AC-18 每个宽度首屏打开即贴底；独立场景：晚到成员会话异步 open、旧消息插入上方、零滚动 → 仍贴底（`workbench-390-stagger.png`），上滑后新消息不拉回；
  - AC-12/13/14 markdown、用户胶囊、assistant 无气泡、成员头合并、流式、日分隔；
  - AC-15 无 dialog、注入文本仅作纯文本；AC-16 深浅色正文色 ≠ 背景；AC-17 桌面三栏与正文 760 上限。
- 截图目录：`test/browser/out/`（`workbench-<width>-<theme>.png`、`workbench-390-drawer.png`、`workbench-390-tab-gates|tasks|members.png`、`workbench-390-reconnect.png`、`workbench-768-drawer.png`）。

## 8. 已知限制

1. markdown 子集不含嵌套列表的多级缩进（子列表拍平成同级项）。表格 / 任务列表 checkbox / 删除线 / 自动链接 / 图片（降级为外链）/ h5–h6 已在 v0.5.4 补齐。
2. 流式期间按纯文本渲染（半截 markdown 不解析），settle 后恢复 markdown。
3. DSH 的「已完成，用时」TurnTail 行未实现（现有数据没有轮次耗时字段）。
4. 桌面正文列上限 760px 只在 ≥900 生效；两栏（560–899）按设计满宽。
5. 断点按容器宽度：DSH 桌面侧栏展开时可用宽度可能 <900 而进两栏，需真机/真实外壳复验（PRD §15-1）。
6. iOS 地址栏伸缩的 100vh 抖动需真机验收；当前用容器高度 + safe-area，不写死 vh。
7. `listStale` 只在「已有选中团队且旧列表被保留」时提示重连；首次加载仍显示「加载中…」。
