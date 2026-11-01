# DSH 主会话 UI 风格规范（DevBot v0.5 实现参考）

> 用途：client.js 纯 JS 复刻 DSH 主会话视觉的数值基线；来源为 DSH checkout 的 ui-chat / ui-conversation / ui-primitives 实际 CSS 与 token（只读实测）。
> 原则：只用 --dsw-alias-* / --dsw-specific-bubble / --dsw-radius-*；不硬编码颜色；深色默认，浅色只换 token。

## 1. 列宽与水平间距
- 内容列：`max-width: clamp(680px, 会话列宽 × 0.64, 920px); margin: 0 auto;`
- 滚动区水平 padding：16px + 16px = 32px（ChatView `--dsh-composer-side-clearance` 16 + 16）。
- 嵌入/窄容器：`min(100% - 32px, 920px)`；窄屏靠 max() 与百分比收缩，无固定 720/760 上限。
- 移动端消息列 = 容器宽 − 32px，不再二次居中。

## 2. 行距节奏（纵向）
| 场景 | 间距 |
|---|---|
| 普通流节点 | 6px |
| assistant 回复与相邻过程行 | 12px |
| 过程组内工具/命令行之间 | 6px |
| 展开组标题与内容 | 8px |
| 轮次尾/操作页脚 | 16px（操作行与正文 20px） |
| markdown 块之间 | 16px |

## 3. 字号 / 行高
- 正文 14/24 w400，strong w600；标题 h1 21/30、h2 19/28、h3 18/26（w700），h4 14/24 w600。
- meta 13/20、12/18；时间 12–13/24；代码行内 12/19、代码块 11/19、工具卡 11/16；表格 13/22（表头 w500）。
- 字体栈：-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif。
- 等宽栈："SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"（刻意不带 monospace 尾）。

## 4. assistant 正文 / 用户胶囊
assistant（无气泡、无头像、无名字）：
```css
.assistant { display:flex; flex-direction:column; gap:16px;
  font-size: var(--dsh-content-font-size,14px);
  line-height: calc(24px + var(--dsh-content-font-delta,0px));
  color: var(--dsw-alias-label-primary); }
```
用户（右对齐、无头像）：
```css
.userRow { display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
.userStack { display:flex; flex-direction:column; align-items:flex-end; gap:8px; min-width:0;
  max-width: min(calc(var(--dsh-chat-content-width,748px) * .702), 82%); }
.bubble { max-width:100%; background: var(--dsw-specific-bubble);
  border-radius: var(--dsw-radius-xl); /* 20px */ padding: 10px 16px;
  font-size: var(--dsh-content-font-size,14px);
  line-height: calc(22px + var(--dsh-content-font-delta,0px));
  color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
```
- 时间：用户 13/24 label-tertiary 右对齐；assistant 12/24 尾部；群聊统一 11–12/18。

## 5. 成员头合并规则（DevBot 扩展，DSH 无先例）
- 显示条件：发送者变化，或同一发送者距上一条 > 5 分钟，或跨日（日分隔处强制显示）。
- 头部：18–20px 圆头像（角色色底 + 首字）+ 12/18 label-secondary 名字 + 11/18 label-tertiary HH:mm。
- 头部距正文 2–4px；正文同 assistant 直排（14/24 label-primary），不用彩色气泡。
- 连续同一发送者：不重复头像/名字，正文对齐同一 x；角色色仅用于头像底或 4–6px 圆点。
- 合并判定只依赖行数据（senderId/time/跨日），不依赖 DOM 测量，纯 JS 可单测。

## 6. 工具 / 派单行
- 行高 24px；标题 13/24；前景 label-tertiary，hover/focus label-secondary；行间 6px。
- 前置图标盒 16px、字形 14px、右间距 6px；无水平 padding；摘要 ellipsis、max-width:100%。
- 展开卡：背景 markdown-code-block、0.5px border-l1、圆角 16、11/16 等宽、padding 12/16、max-height:150px; overflow:auto。
- “已完成，用时”折叠行：高 33px、padding:0 0 8px、下边框 0.5px border-l2、14/24 label-tertiary、箭头 14px（展开 rotate 180°）、时长 tabular-nums；展开内容距页眉 16px。
- 派单行复用工具行：图标 14 + “派单 · PM” 13px + 摘要省略；正文只在目标会话投递副本出现一次。

## 7. 系统行 / 日分隔 / 流式（DevBot 扩展）
- 系统/任务/成员事件：居中 11–12/18 label-tertiary，无边框气泡；默认单行省略，点击展开详情。
- 日分隔：居中 11/18 label-tertiary，上下 10–12px；跨日显示“M月D日”，当日不显示。
- 流式：正文同 assistant + “输入中”11px label-tertiary；减少动态效果时用静态三点。

## 8. Markdown 各级 CSS
- 段落：margin:16px 0；首块 margin-top:0、末块 margin-bottom:0。
- 标题：margin:32px 0 16px；h1 21/30、h2 19/28、h3 18/26、h4 16/24；首个标题 margin-top:0。
- 列表：margin:16px 0; padding-left:18px；li+li margin-top:6px；嵌套列表 margin-top:4px；marker 色 label-secondary。
- 引用：border-left:2px solid var(--dsw-alias-label-caption); margin:16px 0 0; padding-left:14px。
- 行内 code：背景 markdown-inline-code、0.5px border-l1、圆角 var(--dsw-radius-sm)（8px）、padding:0 5px、font-size:.875em。
- 代码块：背景 markdown-code-block、圆角 var(--dsw-radius-lg)（16px）、pre padding:16px、11/19 等宽、overflow-x:auto、white-space:pre-wrap; word-break:break-all；横幅 11/18、padding:9px 14px。
- 表格：th/td padding:10px 16px、首列 padding-left:0、末列 padding-right:0；边框 0.5px（th border-l3、td border-l2）；th w500；列 max-width:min(30vw,320px)、min-width:100px；容器 overflow-x:auto。
- 链接：color: var(--dsw-alias-link); font-weight:500；hover/focus 点状下划线 offset 3px；只允许 http(s)/mailto/#。
- hr：height:0.5px、background:border-l2、margin:32px 0；图片 max-width:100%、圆角 var(--dsw-radius-md)（12px）。

## 9. Token 表（浅色 / 深色）
| token | 浅色 | 深色 |
|---|---|---|
| --dsw-alias-label-primary | #0F1115 | #F9FAFB |
| --dsw-alias-label-secondary | #61666B | #CFD3D6 |
| --dsw-alias-label-tertiary | #81858C | #ADB2B8 |
| --dsw-alias-label-caption | #ADB2B8 | #81858C |
| --dsw-alias-bg-base | #FFFFFF | #151517 |
| --dsw-alias-bg-layer-1 | #FFFFFF | #232324 |
| --dsw-alias-bg-layer-2 | #FFFFFF | #2C2C2E |
| --dsw-alias-bg-overlay | #E9ECF2 | #61666B |
| --dsw-alias-border-l1 | rgba(0,0,0,.04) | rgba(255,255,255,.06) |
| --dsw-alias-border-l2 | rgba(0,0,0,.10) | rgba(255,255,255,.12) |
| --dsw-alias-border-l3 | rgba(0,0,0,.12) | rgba(255,255,255,.16) |
| --dsw-alias-border-l4 | rgba(0,0,0,.16) | rgba(255,255,255,.20) |
| --dsw-alias-link | #4176E6 | #7AAAFF |
| --dsw-alias-state-success-primary | #22C55E | #22C55E |
| --dsw-alias-state-warn-primary | #F59E0B | #F59E0B |
| --dsw-alias-state-error-primary | #EC1313 | #F25A5A |
| --dsw-alias-markdown-code-block | #F9FAFB | #1B1B1C |
| --dsw-alias-markdown-code-block-banner | #F9FAFB | #2C2C2E |
| --dsw-alias-markdown-inline-code | #FAFAFA | #292929 |
| --dsw-alias-interactive-bg-hover | rgba(38,49,72,.06) | rgba(255,255,255,.08) |
| --dsw-specific-bubble | #EDF3FE | #2C2C2E |

- 圆角：xs 4、sm 8、md 12、lg 16、xl 20、panel 28（base.css）；用户胶囊/消息容器用 xl，代码块/卡片用 lg，行内 code/小控件用 sm；禁止自造 --dsw-surface（不存在，HANDOVER 配色事故）。

## 10. 响应式事实
- 主会话按容器宽度而非视口：可用宽度 ≤900px 时隐藏轮次轨道（ui-chat README）；内容列 clamp(680px, 列宽×0.64, 920px)、嵌入态 min(100% - 32px, 920px)，可由 --dsh-chat-user-width 覆盖；DevBot 用 @container（.devbot-root{container-type:inline-size}）：≥900 三栏 / 560–899 两栏 / <560 单栏，不按 viewport media query。
- DSH 外壳在窄屏（1024px 量级）折叠左侧栏、主栏变宽；DevBot 位于主栏内，必须按容器宽度重排，不复制该断点。
- DSH 主会话未发现 safe-area 先例（无 env(safe-area-inset-*)）；DevBot 自加 env(safe-area-inset-bottom) 到固定底栏，顶部保留 --dsh-frame-top-clearance。

## 11. 纯 JS 复刻要点
- 用 React.createElement + CSS class/内联 style；markdown 子集解析器返回 React 元素（标题/段落/列表/引用/代码块/行内码/链接/hr/表格/删除线/任务列表复选框/自动链接/图片外链），先转义 HTML，链接白名单 http(s)/mailto/#；不 require 非 seed 包、不加构建、不改 DSH 源码。
- 连续发送者合并、时间显示、角色色、token 全部由行数据 + 主题变量决定，不读 DOM 几何。
- 移动端三栏用 CSS 容器查询重排，不用 JS 测量；触控目标 ≥40×40；底部状态条 white-space:nowrap + min-width:0 防竖排。
- 保留 controller 的 retain/release/attach、loadOlder、nextStick/shouldFollowBottom 语义；样式/渲染层改动不回写数据层。

## 12. 与 DSH 的差异与已知缺口
- DSH 主会话不显示发送者名/头像；DevBot 群聊必须补成员头（§5），这是唯一有意的视觉扩展。
- DSH 无群系统条/日分隔先例；DevBot 用低对比单行（§7），不引入彩色气泡。
- DSH 代码块 white-space:pre-wrap + break-all 与横向滚动并存；移动端 DevBot 优先 overflow-x:auto 保代码结构，避免强制断词。
