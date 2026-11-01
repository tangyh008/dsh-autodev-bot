# DevBot（dsh-autodev-bot）

**Agent Teams 上的全自动开发 Bot** —— 一个 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)插件，为 DSH 增加一套开箱即用的「5 角色软件研发团队」：

> **Lead（负责人）+ PM（产品经理）+ Designer（UI 设计师）+ Fullstack（全栈工程师）+ Tester（测试）**
> 按 **严格阶段门** 协作：需求分析 → 产品规划 → 前端设计（html 高保真 + PM 评审）→ 代码实现 → 测试验收。
> 并提供独立的 **DevBot 工作台 UI**：群聊时间线、阶段门可视化、任务板、成员状态。

- **不改 DSH 源码**：以 DSH 插件（bundle + client 插件）形式安装，Host half（`index.js`）+ Client half（`client.js`）。
- **调而不搬**：耐久执行后端复用 loop-agent 生态（经 `loop-agent mcp serve --stdio` 调用 `request_intake_* / supervisor_* / local_agent`），不搬运其 Engine/ledger/worktree；群聊里只贴 RUN-id + 摘要。loop-agent 为独立项目，不在本仓库内。
- **流程按任务大小收缩（v0.5.5）**：小任务 Lead 直做；需求/规划无分歧可合并；无前端跳设计门。涉前端的 **PM 评审门**与**测试验收门**永不跳过。

## 功能特性

- **5 角色团队 preset**：`preset-devbot-lead / pm / designer / fullstack / tester`，各角色 persona + 阶段门/门禁 prompt，工具集从 DSH `standard` preset 生成（bash / fs 读写 / search / skill / todo / web 等）。
- **队友角色 preset 桥**：Lead 用 `spawn_teammate` 派单时在 description 带 `devbot_role=<role>` 标记，Host 入口运行时给 fresh teammate 注入对应 `agentPreset`——不改 DSH 源码、对无标记 spawn 完全向后兼容。
- **独立工作台**：左侧栏 DevBot 图标进入全屏工作台——
  - **群聊时间线**：合并 Lead 与各成员会话的持久日志（人类消息 / 派单 / 成员互发 / 系统事件 / 流式输出），支持上滑加载更早；有明确收件人的消息渲染 `@收件人` chip（纯渲染层推导，不改提示词）；
  - **阶段门 / 任务板 / 成员状态**：从 `agentTeam` 活投影点亮 ✓/▶/○，阻塞数、成员任务计数一目了然；
  - 会话 header 的 **DevBot 按钮**提供会话内的轻量视图。
- **模式选择器净化**：4 个队友角色 preset 不再出现在浏览器端模式选择器（仍注册在 Host，spawn 桥照常挂载）。
- **薄 CLI（`devbot`）**：`install`（装 bundle，找不到 `dsh` 时按 `DSH_CHECKOUT` 源码回退）/ `init`（生成 prd/issues/ard + 5 份模板）/ `doctor`（环境自检），纯 Node 实现、跨平台。

## 安装

要求：Node ≥ 22.13，本机已部署 DSH（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。

```sh
# 方式一：用 dsh 直接装本仓库目录
dsh plugin --profile web add <本仓库目录>

# 方式二：用自带 CLI（先找 PATH 上的 dsh，找不到则用 DSH_CHECKOUT 源码回退）
node ./bin/devbot.mjs install --profile web
# DSH_CHECKOUT=/path/to/deepseek-harness node ./bin/devbot.mjs install --profile web
```

> Host 插件 / preset 改动需重启 DSH 生效；`client.js` 这类客户端插件由 DSH 热重载，硬刷新页面即可。

## 快速开始

1. **初始化项目**：`node ./bin/devbot.mjs init --project ./my-app`（生成 prd/issues/ard + 5 份模板）。
2. **开 Team 会话**：选择 `DevBot Lead` preset，把需求直接派给 Lead。
3. **建队**：Lead 用 `spawn_teammate` 起成员，description 必须带角色标记，例如 `devbot_role=pm 产品经理`（fork 出 sub-lead 可再分队）。建队按阶段惰性进行——成员进哪个阶段才 spawn 哪个。
4. **盯工作台**：左侧栏 **DevBot 图标** → 主栏工作台查看群聊时间线、5 阶段门、任务板与成员状态。
5. **耐久执行**（可选）：需要长任务耐久跑时，成员经 loop-agent MCP 执行，群里只贴 RUN-id + 摘要。

团队协作节奏（派单要素、回报约定 claim/blocked/complete、并行 claim 等）详见 [docs/team-workflow.md](docs/team-workflow.md)。

## 仓库结构

```
.
├── index.js            # Host half：插件入口，队友角色 preset 桥（包装 startActivation）
├── client.js           # Client half：DevBot 工作台 / 群聊时间线 / @收件人 / 模式选择器过滤
├── cordis.patch.yml    # bundle patch：5 角色 preset 定义（BEGIN/END GENERATED 区由脚本生成，勿手改）
├── presets/            # 5 角色的 persona 文档（lead/pm/designer/fullstack/tester）
├── skills/             # prd / issue / design / test / ard 模板
├── bin/                # devbot CLI（install / init / doctor）+ loop-agent MCP 薄客户端
├── locale/             # locale 资源（zh / en）
├── scripts/            # sync-presets.py（DSH 升级后重新生成 preset 工具集）、设计截图脚本
├── design/             # 前端设计门产物：html 高保真稿
├── docs/               # 设计/实现/测试文档、团队协作规范、版本演进记录
└── test/               # Node 单测 + 真实浏览器回归（Playwright）
```

## 测试

```sh
# 纯 Node 回归测试（无依赖）
npm test

# 真实浏览器回归（需要本机 DSH checkout 的 node_modules / Playwright 浏览器）
DSH_CHECKOUT=/path/to/deepseek-harness node test/browser/workbench-scroll.repro.mjs
```

覆盖范围包括：工作台会话 attach 语义（不得整体 detach/re-retain）、贴底判定、@收件人推导、模式选择器过滤，以及真实 `dsh web` 外壳上的端到端回归。各测试文件说明见 [docs/CHANGELOG.md](docs/CHANGELOG.md) 的「测试」一节。

浏览器回归的截图 / JSON 报告输出到 `test/browser/out/` 与 `design/verify/`，为本地产物，不入库。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/team-workflow.md](docs/team-workflow.md) | 团队协作规范：派单、回报、阶段门、并行策略 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本演进记录（v0.2 → v0.5.5 的设计决策与变更明细） |
| [docs/prd-ui-v0.5.md](docs/prd-ui-v0.5.md) | 工作台 UI v0.5 产品需求 |
| [docs/ui-redesign-requirements.md](docs/ui-redesign-requirements.md) | UI 重设计需求 |
| [docs/impl-ui-v0.5.md](docs/impl-ui-v0.5.md) | 工作台 UI v0.5 实现说明 |
| [docs/test-report-ui-v0.5.md](docs/test-report-ui-v0.5.md) | 工作台 UI v0.5 测试报告 |
| [docs/dsh-ui-style-spec.md](docs/dsh-ui-style-spec.md) | DSH UI 样式规范速查（token 表） |

## License

[MIT](./LICENSE)
