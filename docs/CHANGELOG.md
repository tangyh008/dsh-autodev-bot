# 版本演进记录（Changelog）

> 本文档由原 `README.md` 迁移而来，按版本记录项目的演进过程与设计决策。当前项目概览、安装与使用说明见 [README.md](../README.md)。
>
> 注：文中提到的 `docs/plan-entry-and-group-chat.md`（设计方案）与 `docs/handover.md`（会话交接文档）为内部工作文档，仅保留在本地，不随本仓库公开。

## 项目概要（原 README 开头）

**dsh-autodev-bot** — Agent Teams 上的全自动开发 Bot：Lead（项目负责人）+ PM（产品经理）+ Designer（UI 设计师）+ 全栈工程师 + Tester（测试）。

- 阶段门：需求分析→产品规划→前端设计（html 高保真 + PM 评审）→代码实现→测试验证。
- v0.5.5 起流程按任务大小收缩：小任务 Lead 直做（是否 spawn Tester 验收按风险自定）；需求/规划无分歧可合并，无前端跳设计门；硬门只剩涉前端的 PM 评审门与测试验收门。
- 执行后端调 loop-agent MCP，本仓库不搬 Engine。

### 用人流（MVP）

1. `node ./bin/devbot.mjs init --project ./my-app`（生成 prd/issues/ard + 5 份模板）
2. 装 bundle：`dsh plugin --profile web add <本目录>`（或 `devbot install --profile web`）
3. 开 Team 会话：Lead 用 `spawn_teammate` 起成员，description 必须带 `devbot_role=<pm|designer|fullstack|tester>`（例 `devbot_role=pm 产品经理`），Host 桥据它挂载对应 preset（fork 出 sub-lead 可再分队）
4. 左侧栏 **DevBot 图标** → 主栏「DevBot 工作台」：群聊时间线（人类消息 / 成员互发 / 各成员发言 / 任务·成员系统事件）+ 5 阶段门 + 任务板 + 成员状态；会话 header 的 **DevBot 按钮**仍可在会话内看阶段
5. 耐久执行走 loop-agent MCP（`request_intake_* / supervisor_* / local_agent`），群里只贴 RUN-id + 摘要

## v0.5.5 调整：流程弹性（少跳数、少打断）

五角色瀑布对大任务回本，对小任务是纯开销。这一版让流程按任务大小收缩，**硬门不降**：

- **小任务 Lead 直做**：单文件小修、文案、局部 bug 修复不经 PM/Designer/Fullstack；是否 spawn Tester 独立验收由 Lead 按风险决定——有现成测试/验证命令且全过→自验贴原始输出；无测试可验/改动有回归风险/用户质量要求高→spawn Tester（写进 Lead persona）。
- **阶段可省略**：需求无分歧时需求/规划两门合并快速通过；无前端改动跳过前端设计门；涉前端的 PM 评审门与测试验收门永不跳过。
- **回报砍到 claim / blocked / complete**：删掉硬性 50% 打卡——进度消息只在预计超过半小时的长任务上发一条；判断标准是「这条消息会不会改变 Lead 的动作」。每条进度消息唤醒的是对方一整个回合。
- **阶段内并行**：同一阶段的独立 task 拆给成员并行 claim（实现阶段允许多个 fullstack 同时领活），不默认串行排队。
- **按阶段惰性建队**：任务板可一次建全（DAG 管顺序），但成员进哪个阶段才 spawn 哪个——fork 只继承 spawn 时刻的上下文，开局全员 spawn 会让成员错过后续批复、迫使 Lead 派单时手工重发长 brief（Lumo 会话实测教训：开局 4 spawn + 7 task，designer 派单时整套已批复上下文只能靠手写 brief 重传）。

改动位置：Lead persona（`cordis.patch.yml` 生成区内 persona 行，`sync-presets.py` 会原样保留）、[team-workflow.md](team-workflow.md) §4/§7、[presets/lead.md](../presets/lead.md)。Host half 改动，需重启 DSH 生效。

## 给别人装（终态 CLI）

```sh
# 1. 发布后别人这样装（当前 v0.1 先本地链调）：
dsh plugin --profile web add @local/dsh-autodev-bot

# 2. 本仓库自带薄 CLI（Node 跨平台，无 bash 依赖）：
node ./bin/devbot.mjs install --profile web
node ./bin/devbot.mjs init --project ./my-app
node ./bin/devbot.mjs doctor
# 说明：install 先找 PATH 上的 dsh，找不到则用 DSH_CHECKOUT 源码回退：
# DSH_CHECKOUT=/path/to/deepseek-harness node ./bin/devbot.mjs install --profile web
```

## v0.5.3 新增：模式选择器里不再显示 4 个队友角色 preset

用户日常只把任务直接派给 Lead，所以 `DevBot PM / Designer / Fullstack / Tester` 四个队友角色
不再出现在**模式选择器**（Agent preset roster）里；`DevBot Lead` 与 DSH 内置模式保留。

- **preset 仍完整注册在 Host**：Lead 按 `spawn_teammate` + `devbot_role=` 派单时，v0.5 的
  队友角色 preset 桥照常按 id 挂载；已存在的队友会话 resume 也照常按 id 重新组合。
- **只过滤浏览器端 roster 应答**：DSH 的 preset 没有 hidden 标志、本仓库不改 DSH 源码，所以
  `client.js` 在 `remote.agentPresets.list` 的 namespace service 上包一层（可选 inject
  `remote.agentPresets`），把应答里这 4 个 id 滤掉。Host 定义、`resolve()`、spawn 桥、旧会话
  一概不动；DSH 升级若改变该客户端形态，过滤自动放弃（记 console error），选择器保持原行为。
- **影响面**：模式选择器与 Settings → Agent presets 共用同一份 roster，所以两处都不再列出这
  4 个角色；它们只是不再是「用户可选的模式」。旧队友会话 header 的 preset label 会退化成
  原始 id（`devbot-pm`），仅影响显示。
- **生效方式**：纯客户端 half，`client.js` 由 DSH 热重载；硬刷新页面即可，不需要重启 DSH。
  回归：`test/preset-roster-filter.test.mjs`（9 项 Node 单测）+ `test/browser/preset-picker.mjs`
  （真实 GUI，本地 `dsh web` 运行时）。

## v0.5.2 新增：群聊消息开头显示 @收件人（纯渲染层，不动提示词）

群聊时间线里每条**有明确收件人**的消息，正文开头渲染 `@收件人` chip：

- **Team 投递副本**（成员/Lead 互发）→ 消息落在谁的 Session，收件人就是谁（`lead` / `pm` / `fullstack2` …）；
- **派单**（spawn 初始 prompt 等无 rpcId 的 user/message）→ 目标成员；
- **人类消息** → 消息所在会话的主人（Lead 会话即 `@lead`）。

实现方式：`client.js` 的 `mentionOf(member)` 从「消息落在哪个会话」推导收件人，`renderMarkdown(text, prefix)` 把 chip 放进第一个可内联块的开头。**不要求成员在正文里手写 @，也不改 relay 正文 / persona / prompt**；旧 Team 会话日志回放同样生效。成员自己的 `assistant` 旁白没有投递目标，不伪造 @。

## v0.5 新增：队友角色 preset 桥（不改 DSH 源码）

DSH 的 `spawn_teammate` 工具没有 Agent preset 参数（官方 `tool-subagent` 有 `agent_preset`，Team 这条路没有），所以 teammate 默认继承 Lead 的 persona 与工具配置，5 个角色无法真正各司其职。

本版本的 Host 入口（`index.js`）在运行时包装公开服务方法 `ctx.subagents.startActivation`，在以下条件全部满足时给 fresh teammate 补上 `request.agentPreset`：

- 父会话（Lead）的 `composedPreset` 以 `devbot-` 开头；
- spawn 的 description 或 prompt 里带 `devbot_role=<pm|designer|fullstack|tester>` 标记；
- 目标 provider 声明 `capabilities.agentPreset` 且不继承父会话（`fork` teammate 不适用）；
- 调用方还没有显式指定 preset。

Lead 的 persona 已写死约定：`spawn_teammate` 时必须用 `description: "devbot_role=pm 产品经理"` 这种格式。没有标记的 spawn 保持原行为（继承 Lead）。

**v0.5.1：preset 工具集扩展（关键）**

只修 `agentPreset` 透传是不够的——Web profile 按设计禁用了部署级工具行，要求每个 preset 自己声明工具；而 DevBot 早期 preset 只有 `persona + tool-fs`，导致 Lead/teammate 都只有 18–20 个只读工具（没有 bash / write / edit / glob / grep / skill / todo / web）。现在 5 个 preset 从 DSH 的 `standard` preset 生成完整工具集，并给所有角色开放 `tool-fs` 写权限（角色差异靠 persona + 阶段门/task 门禁，而不是"没有工具"）。

- 生成脚本：`scripts/sync-presets.py`（读 `$DSH_CHECKOUT/packages/bundle/web-app/presets/standard.patch.yml`，保留本仓库的 5 段角色 persona，替换 tool-fs 配置，剔除 plugin 安装类工具）。DSH 升级后重跑一次即可。
- 生成区域在 `cordis.patch.yml` 的 `BEGIN/END GENERATED devbot presets` 注释之间，别手改。

**生效与刷新**：

- Host 插件 / preset 改动必须重启 DSH 才生效（不是热更新）。
- 重启后**恢复会话时**，DSH 会按**当前** preset 定义重新组合 Agent（源码：session-controller 的 `composeAgent` 用 `presets.mount(agentCtx, resolvedId)`；子会话冷启动同样重新 mount），所以**旧会话重新打开/继续时会拿到新的工具集**。
- 但旧 teammate 的 preset id 在创建时就固定了（当时是继承 Lead 的 `devbot-lead`），恢复后拿的是"更新后的 devbot-lead"（完整工具 + Lead persona），**不会自动变成 pm/designer 角色**；要角色 persona 必须重新 spawn。
- 已存在的 Lead 会话可以继续用：桥接是全局的，只要 Lead 按约定带 `devbot_role=`，旧会话 spawn 也会命中。
- 桥接是防御性的：DSH 升级若改变 `startActivation` 形态，会记 warning 并退化为"继承 Lead"，不会让 teammate 创建失败。

## v0.4 新增：独立入口 + 群聊时间线

- **独立入口**：左侧栏 `DevBot` 图标（`sidebar.panellist`）+ 主栏全屏工作台（`main` keyed panel，key=`devbot`）；机制与 DSH 自带 Plugins/Tasks 页相同。
- **群聊时间线**：把 Lead 会话与各 teammate 会话的**持久日志**合并成一条时间线——
  - 人类消息（source `user` + `rpcId`）、Lead 派给成员的任务（source `user` 无 rpcId，显示为「派单」）；
  - 成员之间投递的消息（source `agent-message`，剥掉 `Team message from X:` 前缀，按 `senderSessionId` 标注发送者）；
  - 各成员 `assistant/message` 的文本；
  - Lead 日志里的 `team/member`、`team/task` 事件（成员加入、任务/门禁变更）显示为系统条；
  - 运行中的成员有流式文字（`assistant/live-chunk`），结算后自动替换为持久消息；
  - 上滑加载更早（对每个成员会话 `loadOlder()` 后重建）。
- **不做第二份真值**：不新建 append-only 群日志；群聊内容全部可从 Session 日志回放（旧 Team 也能回看）。
- **不唤醒冷团队**：团队列表只读 `agentTeam` 投影；只有选中团队、且工作台打开时才 `retain` 成员会话（子会话用 `subagentAddress()` 地址）。
- 当前 v0.4 限制：文案硬编码中文；页面内发消息/新建项目/未读 badge 在 M2（见 `docs/plan-entry-and-group-chat.md`，内部文档）。

## v0.2 包含

- `preset-devbot-lead / pm / designer / fullstack / tester`：persona + 严格门 prompt
- 前端门：涉前端先经 Designer 出 html 高保真，PM 评审（功能/细节/无过度设计）approve 后才转实现
- 验收门：Tester 逐条验证 + 测试报告，不通过打回并 block 后续 task
- `skills/`：prd / issue / design / test / ard 模板（issue 标题阶段前缀供 panel 点亮用）
- `client.js`：会话 header 的 DevBot 按钮 + 下拉 panel：读 `agentTeam` 活数据点亮当前阶段（✓/▶/○）、成员与任务计数、阻塞数、群规范；无 Team 时降级静态展示

## 调而不搬

- 不抄 `loop-agent` 的 Engine/ledger/worktree/verification/PM2。
- 需要耐久执行时，teammate 起 `loop-agent mcp serve --stdio` 子进程调
  `request_intake_create → supervisor_begin/commit → local_agent inspect`，
  群里只留 `RUN-id + 摘要`。

## 团队协作节奏

派单必须说全（目标 / 交付物 / 验收标准 / 完成后回报），派完立即结束回合，不轮询 `wait_agent`；teammate 消息与 task 状态变化会自动唤醒 Lead。只有同回合串行依赖才 wait 一次（≤120s）。回报只认 claim / blocked / complete（长任务过半加一条进度，其余打卡不发）；小任务 Lead 直做，阶段门按任务收缩，阶段内并行 claim。详见 [team-workflow.md](team-workflow.md)。

## 测试

```sh
# 纯 Node 回归测试（无依赖；覆盖 attach 语义 + 贴底判定）
npm test

# 真实浏览器回归（需要本机 DSH checkout 的 node_modules / Playwright 浏览器）：
# 加载真实 client.js 组件，断言上滑后不会「闪一下并自动滚到底」
node test/browser/workbench-scroll.repro.mjs
DSH_CHECKOUT=/path/to/deepseek-harness node test/browser/workbench-scroll.repro.mjs
```

- `test/controller-attach.test.mjs`：锁住「工作台重挂会话」的旧 bug——成员 phase 变化、
  成员增删、open 失败重试都不得整体 detach/re-retain 会话（DSH 的 `retain`→`release(0)`
  会 drop 掉 Session，重新打开期间时间线空一帧，即页面「闪一下」）。
- `test/scroll-stick.test.mjs`：锁住「内容塌缩时把贴底意图打开」的旧 bug。
- `test/recipient-mention.test.mjs`：锁住 @收件人语义——投递副本/派单/用户消息按会话归属
  推导 target；成员 assistant 旁白不伪造 @；chip 进首块开头（标题/代码块降级为单独一行）。
- `test/preset-roster-filter.test.mjs`：锁住模式选择器过滤——4 个队友角色从 roster 应答里消失、
  DevBot Lead/内置模式保留；失败/畸形应答原样透传；卸载后恢复原访问器；DSH 形态变化时放弃过滤不抛错。
- `test/browser/preset-picker.mjs`：真实 `dsh web` 上的模式选择器回归（`DSH_WEB_URL` + token，
  与 `dsh-shell-check.mjs` 相同约定）——断言列表只剩 5 项、4 个队友角色一项都没有、可正常关闭且无脚本错误。
- `test/browser/workbench-scroll.repro.mjs`：端到端复现器（fake sessions 复刻 DSH
  retain/release/drop 语义），红/绿对照用 `--client <path>`；退出码 0=全绿、1=复现了 bug。
- `test/browser/workbench-responsive.mjs`：真实 React + 真实 client.js 的 256 项回归，
  含 AC-24「投递副本 / 派单 / 用户消息显示 @收件人，assistant 旁白不带 @」。

> 注：浏览器回归的截图与 JSON 报告输出到 `test/browser/out/`（设计验证产物输出到 `design/verify/`），这些为本地产物，不随仓库公开。
