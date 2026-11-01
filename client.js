/** DevBot Web half v0.5.4 — 独立入口 + 群聊时间线 + 模式选择器过滤 + markdown GFM 扩展（浏览器 half，plain loader 格式，无构建）。
 *
 * 三部分：
 * 1. 会话 header 的 DevBot 按钮 + 下拉 panel（v0.5.4 起仅在 DevBot preset / Team 会话显示，
 *    标准模式不出现）：看当前会话的阶段门。
 * 2. 独立入口：左侧栏 DevBot 图标（sidebar.panellist）+ 主栏全屏「DevBot 工作台」
 *    （main keyed slot，key=devbot）。工作台把 Lead 会话 + 各成员会话的持久日志
 *    合并成一条群聊时间线；同时展示 5 阶段门、任务板、成员状态。
 * 3. 模式选择器过滤（v0.5.3）：pm/designer/fullstack/tester 四个队友角色 preset
 *    仍注册在 Host（spawn 桥、旧会话 resume 照常），但不再出现在用户可见的
 *    Agent preset roster 里——浏览器端包一层 remote.agentPresets.list 过滤应答。
 * 4. markdown GFM 扩展（v0.5.4）：成员消息的子集解析器补齐 DSH 主聊天已有能力——
 *    GFM 表格（对齐/转义竖线）、~~删除线~~、任务列表复选框、http(s)/www/邮箱
 *    自动链接、__粗体__/_斜体_、![alt](url) 图片降级为外链、标题 h1–h6。
 *
 * 数据来源（全部是 DSH 已有 client 服务，无 Host 改动）：
 * - 团队发现：ctx.sessions.list 快照的 projectionsBySession[*].values.agentTeam
 *   （判据 members.length > 1 || tasks.length > 0；每个会话都有一条只有 Lead 的空 team）。
 * - 消息读取：ctx.sessions.retain(target,{source}) → binding.eventSource。
 *   子会话（teammate）必须用 subagentAddress() 的地址，裸 SessionId 会被 Host 以
 *   session/agent-busy 拒绝。
 * - 系统事件：Lead 日志里的 team/member、team/task 事件（member 加入、任务/门禁变更）。
 *
 * 关键约束：
 * - 不能在 apply 里裸调 ctx.slots.register（slot 未声明会让 Web 启动审计失败），一律走
 *   ctx.slots.inject。
 * - 跨会话排序只能用 event.time；seq 只在单会话内单调。压缩产生的 replacement 事件
 *   （surfaceOp 为 replace）不渲染。流式 transient 行在 settle-assistant 时按 attemptId 删除。
 * - 切换主面板会卸载页面组件：选中团队等状态放 controller（apply 世界），组件只订阅。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-autodev-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;

    /* ------------------------------------------------------------------ *
     * 0. 常量与纯函数（可被 Node harness 单独测）
     * ------------------------------------------------------------------ */

    const PANEL_ID = 'devbot';
    const SOURCE = 'devbotWorkbench';
    const RENDER_LIMIT = 600;

    const STAGES = [
      { n: 1, key: '需求', name: '需求分析', gate: 'Lead 对齐方向，approve 进规划' },
      { n: 2, key: '规划', name: '产品规划', gate: 'PM 输出 PRD，不过度设计' },
      { n: 3, key: '设计', name: '前端设计', gate: 'Designer 出 html 高保真 + PM 评审 approve' },
      { n: 4, key: '实现', name: '代码实现', gate: 'Fullstack 按 Issue 实现，群贴 RUN-id + 摘要' },
      { n: 5, key: '测试', name: '测试验证', gate: 'Tester 逐条验收，打回 block 后续' },
    ];
    const PREFIX_RE = /^\s*[［\[]\s*(需求|规划|设计|实现|测试)/;
    const KEYWORDS = [
      { n: 5, re: /测试|验收|打回|bug|回归/ },
      { n: 3, re: /设计|html|交互|原型|ui|样式/ },
      { n: 4, re: /实现|开发|代码|run-|提交|重构/ },
      { n: 2, re: /规划|prd|竞品|调研|演进/ },
      { n: 1, re: /需求|方向|立项|目标/ },
    ];
    const ROLE_COLORS = {
      lead: '#1f6feb', pm: '#8b5cf6', designer: '#ec4899',
      fullstack: '#10b981', tester: '#f59e0b', human: '#64748b', system: '#94a3b8',
    };
    const ROLE_TEXT = {
      lead: 'Lead', pm: 'PM', designer: '设计', fullstack: '全栈', tester: '测试',
      system: '系统', human: '你',
    };

    /* --- v0.5.3 模式选择器：隐藏 4 个队友角色 preset（Host 仍注册，spawn 桥照常挂载） --- */

    /**
     * 只在「模式选择器」里隐藏的队友角色 preset。
     * 它们必须继续注册在 Host：Lead 的 spawn 桥按 devbot_role= 用 id 挂载；
     * 已存在的队友会话 resume 时也要按 id 重新组合。隐藏的只是 roster 展示。
     */
    const HIDDEN_ROLE_PRESETS = ['devbot-pm', 'devbot-designer', 'devbot-fullstack', 'devbot-tester'];

    /**
     * 从 agentPresets/list 的应答里剔除队友角色 preset。
     * DSH 的 preset 没有 hidden 标志，插件也不改 DSH 源码，所以在浏览器端过滤
     * roster 应答：Host 侧定义、resolve、spawn 桥、旧会话全部不受影响。
     * @param {any} answer - RemoteResult<AgentPresetRoster>（{ok:true,value} 或 {ok:false,error}）。
     * @returns {any} 无需隐藏时原样返回，否则返回过滤后的浅拷贝。
     */
    function withoutHiddenRolePresets(answer) {
      if (!answer || answer.ok !== true || !answer.value || !Array.isArray(answer.value.presets)) return answer;
      const presets = answer.value.presets.filter(
        (row) => !(row && HIDDEN_ROLE_PRESETS.indexOf(row.id) >= 0),
      );
      if (presets.length === answer.value.presets.length) return answer;
      return Object.assign({}, answer, {
        value: Object.assign({}, answer.value, { presets }),
      });
    }

    /**
     * 包一层浏览器侧的 `remote.agentPresets.list`，让它返回的 roster 不含队友角色。
     *
     * 生成式 Remote 客户端把方法装成 namespace service 实例上的访问器（每次读取返回
     * 一个绑定当前调用方 ctx 的函数），这里在拿到的 service 上重定义同一个访问器：
     * 原样调用原访问器，再过滤它返回的 Promise 结果。防御式设计——DSH 升级若改变
     * 该形态（没有自有访问器/不是函数），直接放弃过滤并保持原行为，绝不让选择器坏掉。
     * @param {any} ctx - 浏览器插件 ctx（apply 拿到的那一个）。
     */
    function installPresetRosterFilter(ctx) {
      // 宿主没有 ctx.inject（老版本/极简测试桩）时静默跳过：这是可选能力，不是错误。
      if (!ctx || typeof ctx.inject !== 'function') return;
      try {
        // 可选依赖：没有 agentPresets 的部署（老 profile / 非 web）照常跑其它功能。
        ctx.inject(['remote.agentPresets'], (child) => {
          try {
            const service = child.get('remote.agentPresets');
            const descriptor = service && Object.getOwnPropertyDescriptor(service, 'list');
            if (!descriptor || typeof descriptor.get !== 'function') return;
            const readRoster = descriptor.get;
            Object.defineProperty(service, 'list', {
              configurable: true,
              enumerable: descriptor.enumerable === true,
              get() {
                const request = readRoster.call(this);
                if (typeof request !== 'function') return request;
                return async (...args) => withoutHiddenRolePresets(await request(...args));
              },
            });
            child.effect(() => () => {
              try {
                Object.defineProperty(service, 'list', descriptor);
              } catch (ignored) { /* namespace service 可能已经随 DSH 卸载 */ }
            }, 'devbot: hide teammate-role presets');
          } catch (error) {
            try {
              // eslint-disable-next-line no-console
              console.error('[devbot] preset roster filter failed:', error);
            } catch (ignored) { /* ignore */ }
          }
        });
      } catch (error) {
        try {
          // eslint-disable-next-line no-console
          console.error('[devbot] preset roster filter unavailable:', error);
        } catch (ignored) { /* ignore */ }
      }
    }

    /* --- v0.5 纯函数：markdown 子集 / 断点 / 成员头合并 / 状态条文案 --- */

    const MEMBER_HEAD_GAP = 5 * 60 * 1000;
    const MD_ALLOWED_HREF = /^(https?:\/\/|mailto:|#)/i;

    /** 链接白名单：只允许 http(s) / mailto / #；其它（javascript:、data: 等）返回 null。 */
    function safeHref(raw) {
      const url = String(raw == null ? '' : raw).trim();
      if (!url) return null;
      if (/[\u0000-\u0020\u007f]/.test(url)) return null;
      return MD_ALLOWED_HREF.test(url) ? url : null;
    }

    /* --- GFM 表格 --- */

    /** 分隔行：只含 | : - 和空白（如 |---|:---:|--:|）。 */
    const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

    function isTableDelimiterRow(line) {
      const value = String(line == null ? '' : line);
      if (!TABLE_DELIM_RE.test(value)) return false;
      const body = value.trim().replace(/^\|/, '').replace(/\|$/, '');
      return body.includes('-');
    }

    /** 本行有 |、下一行是分隔行、且列数与分隔行一致才开表格；裸 --- 仍是 hr。 */
    function isTableStart(line, next) {
      const head = String(line == null ? '' : line);
      if (!head.includes('|') || !isTableDelimiterRow(next)) return false;
      return splitTableRow(head).length === splitTableRow(next).length;
    }

    /** 按未转义 | 切单元格；\| 是竖线字面量，\\ 是反斜杠字面量；首尾围栏 | 去掉。 */
    function splitTableRow(line) {
      let rest = String(line == null ? '' : line).trim();
      if (rest.startsWith('|')) rest = rest.slice(1);
      if (rest.endsWith('|') && !rest.endsWith('\\|')) rest = rest.slice(0, -1);
      const cells = [];
      let current = '';
      for (let i = 0; i < rest.length; i += 1) {
        const char = rest[i];
        if (char === '\\' && (rest[i + 1] === '|' || rest[i + 1] === '\\')) {
          current += rest[i + 1];
          i += 1;
        } else if (char === '|') {
          cells.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    }

    /** 分隔行单元格 → 列对齐（:--- 左 / :---: 中 / ---: 右 / 其余 null）。 */
    function cellAlignOf(cell) {
      const value = String(cell == null ? '' : cell).trim();
      const left = value.startsWith(':');
      const right = value.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return null;
    }

    /**
     * markdown 子集 → 块 AST。支持：围栏代码、标题 h1–h6（渲染收敛到 h4）、hr、引用、
     * ul/ol（含任务列表 [ ]/[x]）、GFM 表格、段落。
     * 不解析内联 HTML；文本原样交给渲染层（React children 自动转义）。
     * @returns {Array<{type:string}>}
     */
    function parseMarkdown(input) {
      const text = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      const blocks = [];
      let index = 0;
      const isListItem = (line) => /^(\s*)([-*+]|\d+[.)])\s+/.test(line);
      const isSpecialStart = (line, next) => /^#{1,6}\s/.test(line) || /^\s*>/.test(line)
        || /^\s*```/.test(line) || isListItem(line)
        || /^\s*(---+|\*\*\*+|___+)\s*$/.test(line)
        || isTableStart(line, next);
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === '') { index += 1; continue; }
        // 围栏代码：3 个及以上反引号才算开栏（````markdown 这种用长围栏包住短围栏的
        // 写法也合法）。闭合行必须是「纯反引号、数量不少于开栏」的围栏行。
        // 旧实现只认正好 3 个反引号：````markdown 既匹配不上 fence，又被 isSpecialStart
        // 判成特殊行，段落分支原地不前进 → 无限 push 直到渲染进程 OOM（工作台上滑
        // 加载历史、回放出这种消息时整页卡死然后白屏）。
        const fence = /^\s*(`{3,})[ \t]*([^`]*)$/.exec(line);
        if (fence) {
          const marker = fence[1];
          const info = (fence[2] || '').trim();
          const lang = (/^[A-Za-z0-9_+.-]*/.exec(info) || [''])[0];
          const body = [];
          index += 1;
          while (index < lines.length) {
            const trimmed = lines[index].trim();
            if (trimmed.length >= marker.length && /^`+$/.test(trimmed)) break;
            body.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          else if (body.length > 0 && body[body.length - 1] === '') body.pop();
          blocks.push({ type: 'code', lang, text: body.join('\n') });
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
          index += 1;
          continue;
        }
        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
          blocks.push({ type: 'hr' });
          index += 1;
          continue;
        }
        if (/^\s*>/.test(line)) {
          const body = [];
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            body.push(lines[index].replace(/^\s*>\s?/, ''));
            index += 1;
          }
          blocks.push({ type: 'quote', lines: body });
          continue;
        }
        if (isListItem(line)) {
          const ordered = /\d/.test(/^(\s*)([-*+]|\d+[.)])\s+/.exec(line)[2]);
          const items = [];
          while (index < lines.length && isListItem(lines[index])) {
            const itemMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
            if (/\d/.test(itemMatch[2]) !== ordered) break;
            items.push(itemMatch[3]);
            index += 1;
            // 列表项续行：缩进的普通行并入上一项（不吞空行/其它块）
            while (index < lines.length && lines[index].trim() !== '' && !isSpecialStart(lines[index], lines[index + 1])) {
              items[items.length - 1] += '\n' + lines[index].trim();
              index += 1;
            }
            if (index < lines.length && lines[index].trim() === '') {
              let probe = index;
              while (probe < lines.length && lines[probe].trim() === '') probe += 1;
              if (probe < lines.length && isListItem(lines[probe])) index = probe;
              else break;
            }
          }
          blocks.push({ type: 'list', ordered, items });
          continue;
        }
        if (isTableStart(line, lines[index + 1])) {
          const align = splitTableRow(lines[index + 1]).map(cellAlignOf);
          const width = align.length;
          const head = splitTableRow(line).slice(0, width);
          while (head.length < width) head.push('');
          const rows = [];
          index += 2;
          // 表体行：有 | 且不是其它块开始（空行/列表/标题/新表格等都会断表）。
          while (index < lines.length && lines[index].trim() !== ''
            && lines[index].includes('|') && !isSpecialStart(lines[index], lines[index + 1])) {
            const row = splitTableRow(lines[index]).slice(0, width);
            while (row.length < width) row.push('');
            rows.push(row);
            index += 1;
          }
          blocks.push({ type: 'table', align, head, rows });
          continue;
        }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() !== '' && !isSpecialStart(lines[index], lines[index + 1])) {
          paragraph.push(lines[index]);
          index += 1;
        }
        if (paragraph.length === 0) {
          // 终止性兜底：isSpecialStart 判成特殊行、但上面没有任何分支接手的行
          // （畸形围栏、将来新增块类型的漏接等），必须消费当前行——否则 while
          // 原地死循环，会把页面拖进无限分配直到渲染进程 OOM 白屏。
          paragraph.push(lines[index]);
          index += 1;
        }
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      }
      return blocks;
    }

    /** 从 openIndex（'(' 之后）开始配对括号，返回匹配的 ')' 下标；找不到返回 -1。 */
    function matchCloseParen(text, start) {
      let depth = 1;
      for (let i = start; i < text.length; i += 1) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') {
          depth -= 1;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    /* --- 自动链接（GFM autolink literal 的保守子集） --- */

    /** URL 尾部标点剥离（。，.;:!?*_'~ 等）；')' 仅在不配对时剥离。 */
    function trimUrlTail(url) {
      let end = url.length;
      while (end > 0) {
        const char = url[end - 1];
        if (char === ')' || char === '(') {
          const opened = (url.slice(0, end).match(/\(/g) || []).length;
          const closed = (url.slice(0, end).match(/\)/g) || []).length;
          if (closed > opened) { end -= 1; continue; }
          break;
        }
        if (/[.,;:!?*_'~。，、；：！？）】》”’]$/.test(char)) { end -= 1; continue; }
        break;
      }
      return url.slice(0, end);
    }

    const AUTOLINK_URL_RE = /^(?:https?:\/\/|www\.)[^\u0000-\u0020<>"'`\\]+/i;
    const AUTOLINK_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

    /** 位置 index 起的自动链接 → link 节点（href 过白名单）；不是链接开头返回 null。 */
    function matchAutolink(text, index) {
      if (index > 0 && /[A-Za-z0-9._%+-]/.test(text[index - 1])) return null;
      const rest = text.slice(index);
      let raw = null;
      let href = null;
      const url = AUTOLINK_URL_RE.exec(rest);
      if (url) {
        raw = trimUrlTail(url[0]);
        // URL 只收敛到 ASCII 可见字符：紧随其后的 CJK/全角交还正文，再补剥一轮尾部标点。
        const nonAscii = /[^\x21-\x7e]/.exec(raw);
        if (nonAscii) raw = trimUrlTail(raw.slice(0, nonAscii.index));
        if (/^www\./i.test(raw)) {
          if (!/^www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(raw)) return null;
          href = 'http://' + raw;
        } else {
          href = raw;
        }
      } else {
        const mail = AUTOLINK_EMAIL_RE.exec(rest);
        if (mail) {
          raw = trimUrlTail(mail[0]);
          href = 'mailto:' + raw;
        }
      }
      if (!raw || !href) return null;
      const safe = safeHref(href);
      if (!safe) return null;
      return { type: 'link', href: safe, children: [{ type: 'text', text: raw }], raw };
    }

    /**
     * 行内 markdown → inline AST：text / code / strong / em / del / link / image。
     * 链接白名单之外的写法降级为纯文本（不产出 href）。
     * GFM 扩展：~~删除线~~、__粗体__ / _斜体_（词内下划线不生效）、
     * http(s):// 与 www. 与邮箱自动链接、![alt](url) 图片降级为外链。
     */
    function parseInline(input) {
      const text = String(input == null ? '' : input);
      const out = [];
      let buffer = '';
      let index = 0;
      const flush = () => {
        if (buffer !== '') { out.push({ type: 'text', text: buffer }); buffer = ''; }
      };
      const isWordChar = (value) => value !== undefined && /[\p{L}\p{N}_]/u.test(value);
      while (index < text.length) {
        const char = text[index];
        if (char === '`') {
          const end = text.indexOf('`', index + 1);
          if (end > index) {
            flush();
            out.push({ type: 'code', text: text.slice(index + 1, end) });
            index = end + 1;
            continue;
          }
        }
        if (char === '[') {
          const close = text.indexOf(']', index + 1);
          if (close > index && text[close + 1] === '(') {
            const end = matchCloseParen(text, close + 2);
            if (end > close) {
              const label = text.slice(index + 1, close);
              const href = safeHref(text.slice(close + 2, end));
              flush();
              if (href) out.push({ type: 'link', href, children: parseInline(label) });
              else out.push({ type: 'text', text: label });
              index = end + 1;
              continue;
            }
          }
        }
        if (char === '!' && text[index + 1] === '[') {
          const close = text.indexOf(']', index + 2);
          if (close > index + 1 && text[close + 1] === '(') {
            const end = matchCloseParen(text, close + 2);
            if (end > close) {
              const alt = text.slice(index + 2, close);
              const href = safeHref(text.slice(close + 2, end));
              flush();
              if (href) out.push({ type: 'image', href, alt });
              else out.push({ type: 'text', text: alt });
              index = end + 1;
              continue;
            }
          }
        }
        if (text.startsWith('~~', index)) {
          const end = text.indexOf('~~', index + 2);
          if (end > index + 2) {
            flush();
            out.push({ type: 'del', children: parseInline(text.slice(index + 2, end)) });
            index = end + 2;
            continue;
          }
        }
        if (text.startsWith('__', index)) {
          const end = text.indexOf('__', index + 2);
          if (end > index + 2 && !isWordChar(index > 0 ? text[index - 1] : undefined)
            && !isWordChar(text[end + 2])) {
            flush();
            out.push({ type: 'strong', children: parseInline(text.slice(index + 2, end)) });
            index = end + 2;
            continue;
          }
        }
        if (text.startsWith('**', index)) {
          const end = text.indexOf('**', index + 2);
          if (end > index + 2) {
            flush();
            out.push({ type: 'strong', children: parseInline(text.slice(index + 2, end)) });
            index = end + 2;
            continue;
          }
        }
        if (char === '_' && text[index + 1] !== '_') {
          const opens = index === 0 || !isWordChar(text[index - 1]);
          if (opens) {
            let end = -1;
            for (let probe = index + 1; probe < text.length; probe += 1) {
              if (text[probe] === '_' && text[probe + 1] !== '_' && !isWordChar(text[probe + 1])) { end = probe; break; }
            }
            if (end > index + 1) {
              flush();
              out.push({ type: 'em', children: parseInline(text.slice(index + 1, end)) });
              index = end + 1;
              continue;
            }
          }
        }
        if (char === '*' && text[index + 1] !== '*') {
          const end = text.indexOf('*', index + 1);
          if (end > index + 1) {
            flush();
            out.push({ type: 'em', children: parseInline(text.slice(index + 1, end)) });
            index = end + 1;
            continue;
          }
        }
        const auto = matchAutolink(text, index);
        if (auto) {
          flush();
          out.push(auto);
          index += auto.raw.length;
          continue;
        }
        buffer += char;
        index += 1;
      }
      flush();
      return out;
    }

    /** 容器宽度 → 断点（≥900 three / 560–899 two / <560 one）。 */
    function breakpointOf(width) {
      const value = Number(width);
      if (!Number.isFinite(value)) return 'one';
      if (value >= 900) return 'three';
      if (value >= 560) return 'two';
      return 'one';
    }

    function isBodyRow(row) {
      return !!row && (row.kind === 'msg' || row.kind === 'stream') && row.human !== true;
    }

    /**
     * 成员头是否显示：发送者变化 / 同一发送者 >5 分钟 / 跨日 / 上一条不是成员正文行。
     * 只看行数据，不读 DOM 几何（PRD §11.1、风格规范 §5）。
     */
    function shouldShowMemberHead(prev, row) {
      if (!isBodyRow(row)) return false;
      if (!isBodyRow(prev)) return true;
      const prevSender = prev.senderId || prev.sessionId;
      const sender = row.senderId || row.sessionId;
      if (prevSender !== sender) return true;
      if (dayKey(prev.time) !== dayKey(row.time)) return true;
      return (Number(row.time) - Number(prev.time)) > MEMBER_HEAD_GAP;
    }

    /** 底部状态条三态文案（PRD §6）。 */
    function statusTextOf(detail) {
      if (!detail) return '';
      if (detail.loadingOlder) return '正在加载更早消息…';
      if (detail.hasMore) return '上滑加载更早消息';
      return '已到当前会话窗口最早处';
    }

    /** 取首行摘要（派单/工具行单行展示）。 */
    function firstLine(text) {
      const value = String(text == null ? '' : text).trim();
      const end = value.indexOf('\n');
      return end >= 0 ? value.slice(0, end) : value;
    }

    const TEAM_PREFIX_RE = /^Team message from (.+?):\s*$/;
    const AGENT_PREFIX_RE = /^Agent .+? sent a message:\s*$/;

    function stageOf(task) {
      const text = String(task.subject || '') + '\n' + String(task.description || '');
      const m = text.match(PREFIX_RE);
      if (m) {
        const hit = STAGES.find((s) => s.key === m[1]);
        if (hit) return { n: hit.n, via: 'prefix' };
      }
      const lower = text.toLowerCase();
      for (const k of KEYWORDS) {
        if (k.re.test(text) || k.re.test(lower)) return { n: k.n, via: 'keyword' };
      }
      return { n: 0, via: 'none' };
    }

    /** 与 header panel 相同的阶段推导。 */
    function derive(team) {
      const tasks = (team && team.tasks ? team.tasks : []).filter((t) => t.status !== 'deleted');
      const members = team && team.members ? team.members : [];
      const byStage = { 1: [], 2: [], 3: [], 4: [], 5: [] };
      tasks.forEach((t) => {
        const s = stageOf(t);
        if (s.n > 0) byStage[s.n].push({ task: t, via: s.via });
      });
      const active = tasks.filter((t) => t.status === 'in_progress');
      const done = tasks.filter((t) => t.status === 'completed');
      let current = 0;
      active.forEach((t) => { current = Math.max(current, stageOf(t).n); });
      if (current === 0) {
        let top = 0;
        done.forEach((t) => { top = Math.max(top, stageOf(t).n); });
        current = top >= 5 ? 5 : top + 0;
      }
      const blocked = tasks.filter((t) => t.status === 'pending' && t.ready === false).length;
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'completed');
      return { tasks, members, byStage, active, done, current, blocked, allDone };
    }

    function roleOfMember(member) {
      if (!member) return 'lead';
      if (member.role === 'lead') return 'lead';
      const name = String(member.name || '').toLowerCase();
      if (name.indexOf('pm') >= 0) return 'pm';
      if (name.indexOf('design') >= 0) return 'designer';
      if (name.indexOf('full') >= 0 || name.indexOf('dev') >= 0) return 'fullstack';
      if (name.indexOf('test') >= 0 || name.indexOf('qa') >= 0) return 'tester';
      return 'fullstack';
    }

    function displayName(member) {
      if (!member) return '未知';
      if (member.role === 'lead') return 'Lead';
      return String(member.name || member.id || '成员');
    }

    /**
     * 一条消息的收件人（@提及）：由「消息落在哪个会话」推出来，不读消息正文、
     * 也不要求成员在正文里手写 @。Lead 用真实 target 名 `lead`（与 send_message
     * 的 target 一致），成员用 spawn 时的 name（如 pm / fullstack2）。
     * @param {any} member 会话所属成员
     * @returns {{id:string,name:string,role:string}|undefined}
     */
    function mentionOf(member) {
      if (!member) return undefined;
      const name = member.role === 'lead' ? 'lead' : String(member.name || member.id || '').trim();
      if (!name) return undefined;
      return { id: String(member.id || name), name, role: roleOfMember(member) };
    }

    function avatarOf(name) {
      const s = String(name || '?').trim();
      if (!s) return '?';
      if (/^[A-Za-z]/.test(s)) return s.slice(0, 1).toUpperCase();
      return s.slice(0, 1);
    }

    function contentText(blocks) {
      if (!Array.isArray(blocks)) return '';
      const parts = [];
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          parts.push(block.text);
        }
      }
      return parts.join('\n');
    }

    function stripRelayPrefix(text) {
      if (typeof text !== 'string' || text === '') return { text: '', senderName: undefined };
      const lines = text.split('\n');
      const first = lines[0] || '';
      const team = TEAM_PREFIX_RE.exec(first);
      if (team) return { text: lines.slice(1).join('\n').replace(/^\s*\n/, ''), senderName: team[1] };
      const agent = AGENT_PREFIX_RE.exec(first);
      if (agent) return { text: lines.slice(1).join('\n').replace(/^\s*\n/, ''), senderName: undefined };
      return { text, senderName: undefined };
    }

    function isAppendOrigin(event) {
      if (!event) return false;
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return true;
      return event.surfaceOp === undefined || event.surfaceOp === 'append';
    }

    function normalizeFingerprint(text) {
      return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    }

    function fmtTime(time) {
      const d = new Date(time);
      if (Number.isNaN(d.getTime())) return '';
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    }

    function dayKey(time) {
      const d = new Date(time);
      if (Number.isNaN(d.getTime())) return '';
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }

    function fmtDay(time) {
      const d = new Date(time);
      if (Number.isNaN(d.getTime())) return '';
      const now = new Date();
      if (dayKey(time) === dayKey(now.getTime())) return '今天';
      const y = new Date(now.getTime() - 86400000);
      if (dayKey(time) === dayKey(y.getTime())) return '昨天';
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    const STATUS_TEXT = {
      pending: '待办', in_progress: '进行中', completed: '已完成', deleted: '已删除',
    };
    const PHASE_TEXT = {
      provisioning: '启动中', active: '已就绪', failed: '失败',
    };

    const STICK_THRESHOLD = 64;

    /**
     * 由滚动几何推导「是否贴底」（自动跟随新消息）。
     * 内容塌缩到不可滚动（max<=0）时保持原意图：浏览器会把 scrollTop 夹到 0 并
     * 触发 scroll 事件，但那不是用户行为，不能据此把贴底打开，否则内容恢复后
     * 页面会闪一下并自动滚到底。
     * @param {boolean} stick - 之前的贴底意图
     * @param {number} scrollTop - 当前滚动位置
     * @param {number} scrollHeight - 内容总高
     * @param {number} clientHeight - 可视区高
     * @returns {boolean} 新的贴底意图
     */
    function nextStick(stick, scrollTop, scrollHeight, clientHeight) {
      const max = scrollHeight - clientHeight;
      if (max <= 0) return stick;
      return max - scrollTop < STICK_THRESHOLD;
    }

    /**
     * 内容变化后是否需要跟随到底部：只有用户本来就贴底、且内容可滚动时才跟随。
     * @param {boolean} stick - 贴底意图
     * @param {number} scrollTop - 当前滚动位置
     * @param {number} scrollHeight - 内容总高
     * @param {number} clientHeight - 可视区高
     * @returns {boolean} 是否应写入 scrollTop = scrollHeight
     */
    function shouldFollowBottom(stick, scrollTop, scrollHeight, clientHeight) {
      if (!stick) return false;
      const max = scrollHeight - clientHeight;
      return max > 0 && scrollTop < max;
    }

    /**
     * 单条事件 → 时间线行。返回 null 表示不展示。
     * @param {{type:'event'|'transient',event:any}} entry
     * @param {{sessionId:string, member:any, memberById:Map<string,any>}} info
     */
    function buildRow(entry, info) {
      const event = entry && entry.event;
      if (!event || typeof event.type !== 'string') return null;
      const sessionId = info.sessionId;
      const member = info.member;
      const memberById = info.memberById || new Map();
      const time = typeof event.time === 'number' ? event.time : Date.now();
      const seq = typeof event.seq === 'number' ? event.seq : 0;

      if (entry.type === 'transient') {
        const data = event.data || {};
        const chunk = data.chunk;
        if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return null;
        return {
          key: sessionId + ':stream:' + String(data.attemptId),
          kind: 'stream',
          time, seq, sessionId,
          senderId: member ? member.id : undefined,
          name: displayName(member),
          role: roleOfMember(member),
          text: chunk.text,
          attemptId: String(data.attemptId),
          streaming: true,
          msgSource: 'stream',
        };
      }

      if (!isAppendOrigin(event)) return null;

      if (event.type === 'user/message') {
        const data = event.data || {};
        const source = data.source || {};
        const blocks = data.content;
        if (source.kind === 'user') {
          const text = contentText(blocks);
          if (!text) return null;
          const human = member ? member.role === 'lead' || source.rpcId !== undefined : true;
          if (human) {
            return {
              key: sessionId + ':' + seq, kind: 'msg', human: true, time, seq, sessionId,
              name: '你', role: 'human', senderId: 'human', text, msgSource: 'user',
              // 用户消息被投进哪个会话，收件人就是哪个成员（Lead 会话 = @lead）。
              target: mentionOf(member),
            };
          }
          return {
            key: sessionId + ':' + seq, kind: 'task', time, seq, sessionId,
            name: '派单', role: 'system', senderId: 'dispatch', text, msgSource: 'dispatch',
            // 派单永远落在目标成员自己的会话里 → 会话主人即收件人。
            target: mentionOf(member),
          };
        }
        if (source.kind === 'agent-message' || source.kind === 'team-message') {
          const parsed = stripRelayPrefix(contentText(blocks));
          if (!parsed.text) return null;
          const senderId = source.senderSessionId || source.senderId;
          const sender = senderId ? memberById.get(senderId) : undefined;
          const name = sender ? displayName(sender) : (parsed.senderName || (source.senderName) || '成员');
          return {
            key: sessionId + ':' + seq, kind: 'msg', human: false, time, seq, sessionId,
            name, role: roleOfMember(sender), senderId: senderId || ('relay:' + name), text: parsed.text,
            msgSource: source.kind === 'agent-message' ? 'agent-message' : 'team-message',
            // Team 投递把消息写进收件人会话 → 会话主人就是 target；不依赖正文里的 @。
            target: mentionOf(member),
          };
        }
        return null; // goal / schedule / runtime-context 等上下文注入不进群聊
      }

      if (event.type === 'assistant/message') {
        const data = event.data || {};
        const message = data.message || {};
        const text = contentText(message.content);
        if (!text) return null;
        return {
          key: sessionId + ':' + seq, kind: 'msg', human: false, time, seq, sessionId,
          name: displayName(member), role: roleOfMember(member),
          senderId: member ? member.id : undefined, text, msgSource: 'assistant',
        };
      }

      if (event.type === 'team/member') {
        const m = event.data && event.data.member;
        if (!m) return null;
        const phase = PHASE_TEXT[m.phase] || m.phase || '';
        const text = '成员 ' + String(m.name || m.id) + ' ' + phase + (m.error ? '：' + String(m.error) : '');
        return { key: sessionId + ':' + seq, kind: 'sys', time, seq, sessionId, name: '系统', role: 'system', text };
      }

      if (event.type === 'team/task') {
        const t = event.data && event.data.task;
        if (!t) return null;
        const status = STATUS_TEXT[t.status] || String(t.status || '');
        const text = '任务 ' + String(t.id || '') + '「' + String(t.subject || '') + '」→ ' + status
          + (t.ownerId ? '（owner: ' + String(t.ownerId).slice(0, 8) + '）' : '');
        return { key: sessionId + ':' + seq, kind: 'sys', time, seq, sessionId, name: '系统', role: 'system', text };
      }

      return null;
    }

    /**
     * 合并各会话行：按 time 排序；对「发送方 assistant 文本」与「目标会话投递副本」做保守去重。
     * 去重只匹配同 senderId + 同正文指纹（≥8 字），宁可多一条也不吞消息。
     * @param {Array<{rows:any[]}>} handles
     * @param {number} [limit]
     */
    function mergeRows(handles, limit) {
      const all = [];
      for (const handle of handles || []) {
        const rows = handle && handle.rows ? handle.rows : [];
        for (const row of rows) {
          if (row && typeof row.text === 'string' && row.text !== '') all.push(row);
        }
      }
      const delivered = new Set();
      for (const row of all) {
        if (row.msgSource !== 'agent-message' && row.msgSource !== 'team-message') continue;
        const fp = normalizeFingerprint(row.text);
        if (fp.length >= 8 && row.senderId) delivered.add(row.senderId + '|' + fp);
      }
      const kept = all.filter((row) => {
        if (row.msgSource !== 'assistant') return true;
        const fp = normalizeFingerprint(row.text);
        if (fp.length < 8 || !row.senderId) return true;
        return !delivered.has(row.senderId + '|' + fp);
      });
      kept.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
        return (a.seq || 0) - (b.seq || 0);
      });
      if (limit && kept.length > limit) return kept.slice(kept.length - limit);
      return kept;
    }

    /* ------------------------------------------------------------------ *
     * 1. 极简 observable store（getSnapshot/subscribe，渲染层用 hooks.xxx）
     * ------------------------------------------------------------------ */

    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot() { return snapshot; },
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          if (next === snapshot) return;
          snapshot = next;
          for (const listener of Array.from(listeners)) {
            try { listener(); } catch (error) { /* 单个订阅失败不影响其他 */ }
          }
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 2. Controller：团队发现、会话 retain、事件归并（apply 世界）
     * ------------------------------------------------------------------ */

    function emptyDetail() {
      return {
        leadId: null, team: null, stage: null, tasks: [], members: [], rows: [],
        status: 'idle', error: null, hasMore: false, loadingOlder: false,
        teamsPhase: 'pending',
      };
    }

    function createController(ctx) {
      const teamsStore = createStore({ phase: 'pending', items: [] });
      const detailStore = createStore(emptyDetail());
      const state = {
        selectedLeadId: null,
        current: null,
        memberSig: '',
        active: false,
        handles: [],
        loadingOlder: false,
        listStale: false,
        disposed: false,
        publishQueued: false,
        retryTimer: null,
        retryCount: 0,
      };

      function safeListSnapshot() {
        try {
          const list = ctx.sessions && ctx.sessions.list;
          return list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
        } catch (error) {
          return null;
        }
      }

      function teamOf(listState, id) {
        const projection = listState.projectionsBySession && listState.projectionsBySession[id];
        const values = projection && projection.values;
        if (values && values.agentTeam) return values.agentTeam;
        const row = listState.byId && listState.byId[id];
        if (row && row.projectionValues && row.projectionValues.agentTeam) return row.projectionValues.agentTeam;
        return undefined;
      }

      /** 从 list 快照扫描团队（root 会话；members>1 或 tasks 非空）。 */
      function readTeams() {
        const listState = safeListSnapshot();
        if (!listState) return { phase: 'pending', items: [] };
        const items = [];
        const ids = Array.isArray(listState.ids) ? listState.ids : [];
        for (const id of ids) {
          const row = listState.byId ? listState.byId[id] : undefined;
          if (row && row.parentId) continue; // 跳过子会话
          const team = teamOf(listState, id);
          if (!team || !Array.isArray(team.members)) continue;
          if (team.members.length <= 1 && (!Array.isArray(team.tasks) || team.tasks.length === 0)) continue;
          const stage = derive(team);
          items.push({
            leadId: id,
            title: (row && (row.displayTitle || row.title)) || String(id).slice(0, 8),
            cwd: row && row.cwd,
            running: !!(row && row.running),
            updatedAt: (row && row.updatedAt) || 0,
            team,
            stage,
            memberCount: team.members.length,
            taskCount: Array.isArray(team.tasks) ? team.tasks.length : 0,
            activeCount: Array.isArray(team.tasks) ? team.tasks.filter((t) => t.status === 'in_progress').length : 0,
          });
        }
        items.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.leadId < b.leadId ? -1 : 1));
        const phase = listState.phase === 'ready' ? 'ready' : (listState.phase || 'pending');
        return { phase, items };
      }

      function publish() {
        if (state.disposed) return;
        const item = state.current;
        const team = item ? item.team : null;
        const rows = mergeRows(state.handles, RENDER_LIMIT + 200);
        const members = team ? team.members.map((m) => {
          const handle = state.handles.find((x) => x.member && x.member.id === m.id);
          const snap = handle && handle.binding ? handle.binding.session.getSnapshot() : null;
          return {
            id: m.id, name: m.name, role: m.role, phase: m.phase,
            running: !!(snap && snap.running),
            merged: !!(handle && handle.binding),
            openError: handle && handle.error ? String(handle.error) : null,
            member: m,
          };
        }) : [];
        const hasMore = state.handles.some((x) => {
          if (!x.binding) return false;
          try { return !!x.binding.session.getSnapshot().hasMore; } catch (error) { return false; }
        });
        detailStore.set({
          leadId: state.selectedLeadId,
          team,
          stage: team ? derive(team) : null,
          tasks: team && Array.isArray(team.tasks) ? team.tasks : [],
          members,
          rows,
          status: item ? 'ready' : (teamsStore.getSnapshot().items.length > 0 ? 'ready' : 'empty'),
          error: null,
          hasMore,
          loadingOlder: state.loadingOlder,
          listStale: state.listStale,
          teamsPhase: teamsStore.getSnapshot().phase,
        });
      }

      function schedulePublish() {
        if (state.disposed || state.publishQueued) return;
        state.publishQueued = true;
        const run = () => {
          state.publishQueued = false;
          publish();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 16);
      }

      /** 单会话窗口变化：replace/prepend 重建；append/transient 增量；settle 换掉流式行。 */
      function onWindowChange(handle) {
        if (!handle || !handle.binding || state.disposed) return;
        let win;
        try { win = handle.binding.eventSource.getSnapshot(); } catch (error) { return; }
        if (!win || !Array.isArray(win.entries)) return;
        const change = win.change || { kind: 'replace', entries: win.entries };
        if (change.kind === 'replace' || change.kind === 'prepend') {
          rebuildHandleRows(handle, win.entries);
        } else if (change.kind === 'append') {
          const entries = change.entries || [];
          for (const entry of entries) ingestEntry(handle, entry);
        } else if (change.kind === 'settle-assistant') {
          const attemptKey = String(change.attemptId);
          const streamingRow = handle.streaming.get(attemptKey);
          if (streamingRow) {
            handle.streaming.delete(attemptKey);
            handle.rows = handle.rows.filter((row) => row !== streamingRow);
          }
          if (change.entry) ingestEntry(handle, change.entry);
        }
        schedulePublish();
      }

      function ingestEntry(handle, entry) {
        if (!entry || !entry.event) return;
        if (entry.type === 'transient') {
          const row = buildRow(entry, handle.info);
          if (!row) return;
          const existing = handle.streaming.get(row.attemptId);
          if (existing) {
            existing.text += row.text;
            existing.time = row.time;
          } else {
            handle.streaming.set(row.attemptId, row);
            handle.rows.push(row);
          }
          return;
        }
        const row = buildRow(entry, handle.info);
        if (row) handle.rows.push(row);
        schedulePublish();
      }

      function rebuildHandleRows(handle, entries) {
        handle.rows = [];
        handle.streaming = new Map();
        for (const entry of entries || []) {
          if (!entry || !entry.event) continue;
          if (entry.type === 'transient') {
            const row = buildRow(entry, handle.info);
            if (!row) continue;
            const existing = handle.streaming.get(row.attemptId);
            if (existing) { existing.text += row.text; existing.time = row.time; }
            else { handle.streaming.set(row.attemptId, row); handle.rows.push(row); }
            continue;
          }
          const row = buildRow(entry, handle.info);
          if (row) handle.rows.push(row);
        }
      }

      function clearRetry() {
        if (state.retryTimer) {
          try { clearTimeout(state.retryTimer); } catch (error) { /* ignore */ }
          state.retryTimer = null;
        }
      }

      function scheduleRetry() {
        if (state.retryTimer || state.retryCount >= 8 || state.disposed || !state.active) return;
        state.retryCount += 1;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          if (!state.disposed && state.active) attach();
        }, 2000);
      }

      function releaseHandle(handle) {
        if (!handle) return;
        for (const unsub of handle.unsubs) {
          try { unsub(); } catch (error) { /* ignore */ }
        }
        handle.unsubs = [];
        handle.binding = null;
        try { handle.ref.release(); } catch (error) { /* ignore */ }
      }

      function detach() {
        clearRetry();
        const handles = state.handles;
        state.handles = [];
        for (const handle of handles) releaseHandle(handle);
      }

      /**
       * 增量 attach：按成员 id 复用已有会话引用，只 retain 新成员、release 离开的成员。
       *
       * 不能整体 detach 后重建：release 到 0 会让 Session Controller drop 掉 Session
       * （见 dsh packages/api/session-controller/src/client/sessions/service.ts:retireScope
       * → manager.ts:drop），再次 retain 必须重新 open；在 open 完成前 eventSource 是
       * 空窗口，时间线会先渲染成空态再跳回内容（用户看到的「闪一下」），且滚动位置被
       * 浏览器夹到 0，随后被误判成「用户回到底部」而自动滚到底。
       */
      function attach() {
        if (state.disposed) return;
        const item = state.current;
        if (!item || !state.active) { detach(); publish(); return; }
        const team = item.team;
        const memberById = new Map();
        for (const m of team.members) memberById.set(m.id, m);

        const previous = new Map();
        for (const handle of state.handles) previous.set(String(handle.member.id), handle);

        const next = [];
        let missing = 0;
        for (const member of team.members) {
          const key = String(member.id);
          const existing = previous.get(key);
          if (existing && !existing.error) {
            previous.delete(key);
            existing.member = member;
            existing.info.member = member;
            existing.info.memberById = memberById;
            next.push(existing);
            continue;
          }
          if (existing) { previous.delete(key); releaseHandle(existing); }
          const isLead = member.role === 'lead';
          let target = member.id;
          if (!isLead) {
            let address;
            try { address = ctx.sessions.subagentAddress(member.id); } catch (error) { address = undefined; }
            target = address || { parentSessionId: item.leadId, childSessionId: member.id, mode: 'unknown' };
          }
          let ref;
          try {
            ref = ctx.sessions.retain(target, { source: SOURCE });
          } catch (error) {
            missing += 1; // spawn 竞态：列表/地址未到，稍后只补这个成员
            continue;
          }
          const handle = {
            member, ref, binding: null, unsubs: [], rows: [], streaming: new Map(),
            error: null, info: { sessionId: member.id, member, memberById },
          };
          next.push(handle);
          const settle = (binding) => {
            if (state.disposed || handle.binding) return;
            if (state.handles.indexOf(handle) < 0) { releaseHandle(handle); return; }
            handle.binding = binding;
            let snap = null;
            try { snap = binding.session.getSnapshot(); } catch (error) { snap = null; }
            if (snap && snap.openState === 'error') {
              handle.error = snap.openError && snap.openError.message ? snap.openError.message : '打开失败';
              scheduleRetry();
              schedulePublish();
              return;
            }
            try {
              handle.unsubs.push(binding.eventSource.subscribe(() => onWindowChange(handle)));
              handle.unsubs.push(binding.session.subscribe(() => schedulePublish()));
            } catch (error) { /* ignore */ }
            onWindowChange(handle);
          };
          try {
            Promise.resolve(ref.ready).then(settle, () => {
              // 已被替换/释放的旧引用：忽略它的失败，别触发无意义的重试。
              if (state.disposed || state.handles.indexOf(handle) < 0) return;
              handle.error = '打开失败';
              scheduleRetry();
              schedulePublish();
            });
          } catch (error) {
            handle.error = '打开失败';
            missing += 1;
          }
        }
        for (const handle of previous.values()) releaseHandle(handle);
        state.handles = next;
        if (missing > 0) scheduleRetry();
        else if (!next.some((handle) => handle.error)) state.retryCount = 0;
        schedulePublish();
      }

      function publishMetaOnly() {
        // 未激活页面时也要让团队列表/静态阶段门可见。
        schedulePublish();
      }

      function syncTeams() {
        if (state.disposed) return;
        const next = readTeams();
        // 会话列表快照暂时不可读（重连/刷新过渡）：保持现状，别把当前团队误判成消失。
        if (state.selectedLeadId && next.phase !== 'ready' && next.items.length === 0) {
          state.listStale = true; // 渲染层据此显示「正在重新连接…」（PRD §9 / AC-11）
          schedulePublish();
          return;
        }
        state.listStale = next.phase !== 'ready';
        const prev = teamsStore.getSnapshot();
        const same = prev.phase === next.phase && prev.items.length === next.items.length
          && prev.items.every((item, index) => {
            const other = next.items[index];
            return other && other.leadId === item.leadId && other.updatedAt === item.updatedAt
              && other.team === item.team && other.running === item.running;
          });
        if (!same) teamsStore.set(next);
        if (!state.selectedLeadId) {
          if (next.items.length > 0) selectTeam(next.items[0].leadId);
          else publish();
          return;
        }
        const item = next.items.find((candidate) => candidate.leadId === state.selectedLeadId);
        if (!item) {
          if (next.items.length > 0) selectTeam(next.items[0].leadId);
          else {
            state.current = null;
            detach();
            publish();
          }
          return;
        }
        state.current = item;
        // 只有成员集合（谁在团队里）变化才需要重新 retain；单人 phase 变化
        // 只是展示信息，重挂会话反而会把时间线空一帧。
        const sig = item.team.members.map((m) => String(m.id)).join(',');
        if (sig !== state.memberSig) {
          state.memberSig = sig;
          if (state.active) attach();
          else publishMetaOnly();
        } else {
          schedulePublish();
        }
      }

      function selectTeam(leadId) {
        if (state.disposed) return;
        const changing = leadId !== state.selectedLeadId;
        if (!changing && state.handles.length > 0) return;
        clearRetry();
        state.retryCount = 0;
        state.selectedLeadId = leadId || null;
        const teams = teamsStore.getSnapshot();
        state.current = leadId ? teams.items.find((item) => item.leadId === leadId) || null : null;
        state.memberSig = state.current
          ? state.current.team.members.map((m) => String(m.id)).join(',')
          : '';
        if (changing) detach(); // 换团队：旧团队的引用整体释放，再增量挂新团队
        if (state.active) attach();
        else { detach(); publish(); }
      }

      function setActive(active) {
        if (state.disposed) return;
        state.active = !!active;
        if (state.active) {
          if (state.current) attach();
          else { syncTeams(); }
        } else {
          detach();
          publish();
        }
      }

      function refresh() {
        try {
          const result = ctx.sessions && typeof ctx.sessions.refresh === 'function' ? ctx.sessions.refresh() : null;
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (error) { /* ignore */ }
        syncTeams();
      }

      function loadOlder() {
        if (state.disposed || state.loadingOlder) return;
        const binds = state.handles.filter((handle) => handle.binding);
        if (binds.length === 0) return;
        state.loadingOlder = true;
        schedulePublish();
        const tasks2 = binds.map((handle) => {
          try {
            const result = handle.binding.session.loadOlder();
            return result && typeof result.catch === 'function' ? result.catch(() => {}) : result;
          } catch (error) { return null; }
        });
        Promise.all(tasks2).then(() => {
          state.loadingOlder = false;
          schedulePublish();
        }, () => {
          state.loadingOlder = false;
          schedulePublish();
        });
      }

      function backToConversation() {
        try {
          if (ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(null);
        } catch (error) { /* ignore */ }
      }

      function startWatching() {
        let unsubscribe = null;
        try {
          if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.subscribe === 'function') {
            unsubscribe = ctx.sessions.list.subscribe(syncTeams);
          }
        } catch (error) { /* ignore */ }
        syncTeams();
        return () => {
          if (typeof unsubscribe === 'function') {
            try { unsubscribe(); } catch (error) { /* ignore */ }
          }
        };
      }

      function dispose() {
        state.disposed = true;
        clearRetry();
        detach();
      }

      return {
        stores: { teams: teamsStore, detail: detailStore },
        actions: { selectTeam, setActive, refresh, loadOlder, backToConversation },
        startWatching,
        dispose,
        _state: state,
      };
    }

    /* ------------------------------------------------------------------ *
     * 3. 组件
     * ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ *
     * 3. 样式与组件（v0.5：CSS class + 容器查询，颜色/圆角只用 DSH token）
     * ------------------------------------------------------------------ */

    const WORKBENCH_CSS = `
.devbot-root{flex:1 1 auto;min-width:0;min-height:0;position:relative;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:14px;line-height:24px;overflow:hidden;container-type:inline-size;container-name:devbot;--role-lead:var(--dsw-alias-link);--role-pm:var(--dsw-alias-state-warn-primary);--role-designer:color-mix(in srgb,var(--dsw-alias-link) 55%,var(--dsw-alias-state-error-primary));--role-fullstack:var(--dsw-alias-state-success-primary);--role-tester:var(--dsw-alias-state-error-primary);--role-system:var(--dsw-alias-label-caption);--devbot-mono:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei"}
.devbot-root *{box-sizing:border-box}
.devbot-root button{font-family:inherit;color:inherit}
.devbot-root ::-webkit-scrollbar{width:8px;height:8px}
.devbot-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.devbot-dim{color:var(--dsw-alias-label-secondary)}
.devbot-spacer{flex:1 1 auto}

/* 顶栏：<900 返回 / 项目▾ / 刷新；≥900 标题 / 面包屑 / 刷新 / 回到会话 */
.devbot-appbar{flex:none;display:flex;align-items:center;gap:2px;min-height:48px;padding:calc(var(--dsh-frame-top-clearance,0px) + env(safe-area-inset-top,0px)) 4px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.devbot-mobile-head{display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0}
.devbot-desktop-head{display:none;align-items:center;gap:10px;flex:1 1 auto;min-width:0;padding:0 12px}
.devbot-iconbtn{width:40px;height:40px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.devbot-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.devbot-iconbtn[data-busy="true"] svg{animation:devbot-spin 900ms linear infinite}
@keyframes devbot-spin{to{transform:rotate(360deg)}}
.devbot-project-btn{flex:1 1 auto;min-width:0;height:40px;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:15px;line-height:20px;font-weight:600;cursor:pointer}
.devbot-project-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.devbot-project-btn .devbot-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-project-btn svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.devbot-title{margin:0;font-size:15px;line-height:22px;font-weight:700;white-space:nowrap}
.devbot-crumb{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.devbot-headbtn{min-height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.devbot-headbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.devbot-headbtn:disabled{opacity:.6;cursor:default}

/* 移动端四等分分段 tab：高 44，选中=加粗+2px 底部指示条 */
.devbot-tabs{flex:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:.5px solid var(--dsw-alias-border-l1)}
.devbot-tab{position:relative;min-width:0;height:44px;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;white-space:nowrap;cursor:pointer}
.devbot-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:700}
.devbot-tab[aria-selected="true"]::after{content:"";position:absolute;left:14px;right:14px;bottom:0;height:2px;border-radius:1px;background:var(--dsw-alias-label-primary)}
.devbot-tab:hover{color:var(--dsw-alias-label-primary)}

/* 主体三块：项目列表 / 群聊 / 信息区 */
.devbot-body{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}
.devbot-teams{display:none}
.devbot-teams-label{margin:2px 0 8px;padding-left:2px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.devbot-team-btn{display:block;width:100%;padding:8px;margin-bottom:2px;text-align:left;border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer}
.devbot-team-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.devbot-team-btn[data-current="true"]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.devbot-team-name{font-size:12px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-team-meta{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-chat{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l1)}
.devbot-stream{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px 16px 20px;scrollbar-width:thin}
.devbot-stream-inner{width:100%;min-width:0}
.devbot-status{flex:none;display:flex;align-items:center;gap:6px;min-height:30px;padding:6px 16px calc(6px + env(safe-area-inset-bottom,0px));border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;white-space:nowrap}
.devbot-status-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-side{display:none}
.devbot-side-tabs{display:none;gap:4px;padding:10px 12px 0;flex:none}
.devbot-side-tab{min-height:40px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer}
.devbot-side-tab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.devbot-side-tab:hover{color:var(--dsw-alias-label-primary)}
.devbot-panels{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}
.devbot-panel{display:none;flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px}
.devbot-panel[data-active="true"]{display:block}
.devbot-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px}
.devbot-panel-head h2{margin:0;font-size:12px;line-height:20px;font-weight:700}
.devbot-panel-meta{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}

/* 时间线：日分隔 / 系统行 / 成员头合并 / 正文直排 */
.devbot-day{text-align:center;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:10px 0 12px}
.devbot-sys{display:flex;flex-direction:column;align-items:center;min-width:0;margin:8px 0}
.devbot-sys-row{max-width:100%;display:inline-flex;align-items:center;gap:6px;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}
.devbot-sys-row:hover,.devbot-sys-row:focus-visible{color:var(--dsw-alias-label-secondary)}
.devbot-sys-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-sys-detail{max-width:100%;margin-top:4px;padding:6px 10px;border:.5px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
.devbot-msg{min-width:0}
.devbot-msg--member{margin-top:12px}
.devbot-msg--cont{margin-top:6px}
.devbot-member-head{display:flex;align-items:center;gap:6px;margin-bottom:2px;min-width:0}
.devbot-avatar{width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:color-mix(in srgb,var(--role) 16%,transparent);border:.5px solid color-mix(in srgb,var(--role) 34%,transparent);color:color-mix(in srgb,var(--role) 74%,var(--dsw-alias-label-primary));font-size:10px;line-height:1;font-weight:700}
.devbot-role-lead{--role:var(--role-lead)}
.devbot-role-pm{--role:var(--role-pm)}
.devbot-role-designer{--role:var(--role-designer)}
.devbot-role-fullstack{--role:var(--role-fullstack)}
.devbot-role-tester{--role:var(--role-tester)}
.devbot-role-system{--role:var(--role-system)}
.devbot-role-human{--role:var(--role-system)}
.devbot-member-name{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.devbot-member-time{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* 收件人 @chip：代码按会话归属生成；角色色只上到 chip/圆点，不影响正文。 */
.devbot-at{display:inline-block;flex:none;margin-right:6px;padding:0 6px;border:.5px solid color-mix(in srgb,var(--role) 30%,transparent);border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--role) 12%,transparent);color:color-mix(in srgb,var(--role) 78%,var(--dsw-alias-label-primary));font-size:12px;line-height:18px;font-weight:600;white-space:nowrap;vertical-align:1px;user-select:none}
.devbot-at-row{margin-bottom:4px}
.devbot-tool-row .devbot-at{margin-right:0}
.devbot-md{min-width:0;overflow-wrap:anywhere;font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary)}
.devbot-md > *{margin:0}
.devbot-md > * + *{margin-top:16px}
.devbot-md > :first-child{margin-top:0}
.devbot-md > :last-child{margin-bottom:0}
.devbot-md p{white-space:pre-wrap}
.devbot-md h1{margin:32px 0 16px;font-size:21px;line-height:30px;font-weight:700}
.devbot-md h2{margin:32px 0 16px;font-size:19px;line-height:28px;font-weight:700}
.devbot-md h3{margin:32px 0 16px;font-size:18px;line-height:26px;font-weight:700}
.devbot-md h4{margin:16px 0;font-size:16px;line-height:24px;font-weight:600}
.devbot-md strong{font-weight:600}
.devbot-md em{font-style:italic}
.devbot-md ul,.devbot-md ol{margin:16px 0;padding-left:18px}
.devbot-md li + li{margin-top:6px}
.devbot-md li::marker{color:var(--dsw-alias-label-secondary)}
.devbot-md blockquote{margin:16px 0 0;padding-left:14px;border-left:2px solid var(--dsw-alias-label-caption);color:var(--dsw-alias-label-secondary)}
.devbot-md code{padding:0 5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-inline-code);font-family:var(--devbot-mono);font-size:.875em}
.devbot-md a{color:var(--dsw-alias-link);font-weight:500;text-decoration:none}
.devbot-md a:hover,.devbot-md a:focus-visible{text-decoration:underline dotted;text-underline-offset:3px}
.devbot-md hr{height:.5px;margin:32px 0;border:0;background:var(--dsw-alias-border-l2)}
.devbot-md del{text-decoration:line-through}
.devbot-md input[type=checkbox]{margin:0 8px 0 0;accent-color:var(--dsw-alias-label-secondary)}
.devbot-table{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}
.devbot-table table{border-collapse:collapse;width:max-content;max-width:max-content;font-size:13px;line-height:22px}
.devbot-table[data-fill="true"] table{width:100%;max-width:none}
.devbot-table th{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3);text-align:start;font-weight:500;max-width:min(30vw,320px);min-width:100px}
.devbot-table td{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);max-width:min(30vw,320px);min-width:100px}
.devbot-table th:first-child,.devbot-table td:first-child{padding-left:0}
.devbot-table td:last-child{padding-right:0}
.devbot-table table code{font-size:11px}
.devbot-codeblock{max-width:100%;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);overflow:hidden}
.devbot-codeblock-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.devbot-codeblock pre{margin:0;padding:16px;overflow-x:auto;overflow-y:hidden;color:var(--dsw-alias-label-secondary);font-family:var(--devbot-mono);font-size:11px;line-height:19px;white-space:pre}

/* 用户消息：右侧胶囊，无头像 */
.devbot-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-top:12px}
.devbot-bubble{max-width:min(82%,100%);padding:10px 16px;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;white-space:pre-wrap;word-break:break-word}
.devbot-user-time{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* 工具 / 派单行：24px 紧凑行 */
.devbot-tool-row{width:100%;min-height:24px;display:flex;align-items:center;gap:6px;margin-top:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:24px;text-align:left;cursor:pointer}
.devbot-tool-row:hover,.devbot-tool-row:focus-visible{color:var(--dsw-alias-label-secondary)}
.devbot-tool-icon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center}
.devbot-tool-icon svg{width:14px;height:14px}
.devbot-tool-title{flex:none}
.devbot-tool-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-tool-detail{max-width:100%;margin-top:6px;padding:12px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font-family:var(--devbot-mono);font-size:11px;line-height:16px;max-height:150px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap}

/* 流式：正文直排 + “输入中” */
.devbot-streaming-text{font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.devbot-typing{display:inline-flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.devbot-typing-dots{display:inline-flex;gap:2px}
.devbot-typing-dots i{width:3px;height:3px;border-radius:50%;background:currentColor;animation:devbot-blink 1.2s infinite ease-in-out}
.devbot-typing-dots i:nth-child(2){animation-delay:.15s}
.devbot-typing-dots i:nth-child(3){animation-delay:.3s}
@keyframes devbot-blink{0%,60%,100%{opacity:.2}30%{opacity:1}}

/* 阶段门 / 任务 / 成员 */
.devbot-gate-list{display:flex;flex-direction:column;gap:2px}
.devbot-gate{display:flex;gap:10px;padding:10px 8px;border-radius:var(--dsw-radius-sm);min-width:0}
.devbot-gate[data-now="true"]{background:color-mix(in srgb,var(--dsw-alias-link) 8%,transparent)}
.devbot-gate-mark{width:20px;height:20px;flex:none;margin-top:2px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-caption);font-size:11px;line-height:1}
.devbot-gate[data-done="true"] .devbot-gate-mark{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.devbot-gate[data-now="true"] .devbot-gate-mark{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.devbot-gate-main{min-width:0;flex:1 1 auto}
.devbot-gate-title{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;font-size:13px;line-height:20px}
.devbot-gate-title b{font-weight:600}
.devbot-gate-count{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.devbot-gate-desc{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.devbot-notice{margin-top:14px;padding:10px 12px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.devbot-notice[data-warn="true"]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,transparent)}
/* 会话 header 的 DevBot 阶段按钮 + 下拉面板（仅 DevBot preset / Team 会话渲染） */
.devbot-hwrap{position:relative;display:inline-block}
.devbot-hbtn{min-height:24px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.devbot-hbtn:hover,.devbot-hbtn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.devbot-hbtn .devbot-hbtn-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.devbot-hbtn .devbot-hbtn-icon svg{width:14px;height:14px}
.devbot-hbtn .devbot-hbtn-warn{color:var(--dsw-alias-state-warn-primary)}
.devbot-hbackdrop{position:fixed;inset:0;z-index:60;display:block;width:100%;border:0;background:transparent;padding:0;cursor:default}
.devbot-hpanel{position:absolute;right:0;top:calc(100% + 6px);width:330px;z-index:61;padding:12px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);font-size:12px;line-height:18px;text-align:left}
.devbot-hpanel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
.devbot-hpanel-title{margin:0;font-size:12px;line-height:20px;font-weight:700}
.devbot-hpanel-meta{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.devbot-hpanel-empty{margin:0 0 6px;padding:8px 10px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.devbot-hpanel-note{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.devbot-hpanel-note b{color:var(--dsw-alias-label-secondary);font-weight:600}
.devbot-hpanel-note .devbot-hpanel-warn{color:var(--dsw-alias-state-warn-primary)}
.devbot-task-list,.devbot-member-list{display:flex;flex-direction:column}
.devbot-task{display:flex;gap:10px;padding:10px 0;min-width:0}
.devbot-task + .devbot-task{border-top:.5px solid var(--dsw-alias-border-l1)}
.devbot-dot{width:7px;height:7px;flex:none;margin-top:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.devbot-dot[data-state="done"]{background:var(--dsw-alias-state-success-primary)}
.devbot-dot[data-state="doing"]{background:var(--dsw-alias-link)}
.devbot-dot[data-state="blocked"]{background:var(--dsw-alias-state-warn-primary)}
.devbot-task-main{min-width:0;flex:1 1 auto}
.devbot-task-title{font-size:13px;line-height:20px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.devbot-task-id{font-weight:600;color:var(--dsw-alias-label-secondary)}
.devbot-task-meta{margin-top:2px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.devbot-member-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;min-width:0}
.devbot-member-row + .devbot-member-row{border-top:.5px solid var(--dsw-alias-border-l1)}
.devbot-member-row .devbot-dot{margin-top:10px}
.devbot-member-row .devbot-avatar{margin-top:2px}
.devbot-member-main{min-width:0;flex:1 1 auto}
.devbot-member-title{display:flex;align-items:baseline;gap:6px;font-size:13px;line-height:20px}
.devbot-member-title b{font-weight:600}
.devbot-member-title .devbot-role{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.devbot-member-meta{margin-top:2px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.devbot-member-meta[data-warn="true"]{color:var(--dsw-alias-state-warn-primary)}
.devbot-empty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.devbot-empty p{margin:0}
.devbot-empty p + p{margin-top:6px}

/* 项目切换层：<560 底部抽屉，560–899 顶栏下浮层，≥900 左栏常驻 */
.devbot-pop-layer{position:absolute;inset:0;z-index:30;display:none;flex-direction:column;justify-content:flex-end}
.devbot-root[data-projects="open"] .devbot-pop-layer{display:flex}
.devbot-pop-mask{position:absolute;inset:0;border:0;padding:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 38%,transparent);cursor:pointer}
.devbot-sheet{position:relative;display:flex;flex-direction:column;max-height:70%;border-radius:var(--dsw-radius-xl) var(--dsw-radius-xl) 0 0;background:var(--dsw-alias-bg-layer-1);border-top:.5px solid var(--dsw-alias-border-l1);padding-bottom:env(safe-area-inset-bottom,0px)}
.devbot-sheet-grab{width:36px;height:4px;margin:8px auto 0;border-radius:2px;background:var(--dsw-alias-border-l3);flex:none}
.devbot-sheet-head{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 16px;flex:none}
.devbot-sheet-head h2{margin:0;flex:1 1 auto;font-size:15px;line-height:22px;font-weight:700}
.devbot-sheet-list{list-style:none;margin:0;padding:0 8px 8px;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:2px}
.devbot-project-item{width:100%;min-height:56px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;text-align:left;cursor:pointer}
.devbot-project-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.devbot-project-item[data-current="true"]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
.devbot-project-name{display:flex;align-items:center;gap:6px;max-width:100%;font-size:13px;line-height:20px;font-weight:600}
.devbot-project-name span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devbot-project-meta{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.devbot-sheet-empty{padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.devbot-reconnect{padding:4px 16px 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.devbot-role-mark{flex:none;color:var(--dsw-alias-link)}

/* 断点：按容器宽度重排（不是视口） */
@container devbot (min-width:900px){
  .devbot-mobile-head{display:none}
  .devbot-desktop-head{display:flex}
  .devbot-teams{display:block;width:196px;flex:none;padding:10px 8px;overflow-y:auto;border-right:.5px solid var(--dsw-alias-border-l1)}
  .devbot-side{display:flex;flex-direction:column;width:252px;flex:none;min-height:0;overflow:hidden}
  .devbot-side-tabs{display:flex}
  .devbot-side-tab{min-height:28px}
  .devbot-stream{padding:16px 24px 20px}
  .devbot-stream-inner{max-width:760px;margin:0 auto}
  .devbot-pop-layer{display:none!important}
}
@container devbot (min-width:560px){
  .devbot-tabs{display:none}
}
@container devbot (min-width:560px) and (max-width:899.98px){
  .devbot-side{display:flex;flex-direction:column;width:252px;flex:none;min-height:0;overflow:hidden}
  .devbot-side-tabs{display:flex}
  .devbot-root[data-projects="open"] .devbot-pop-layer{display:flex;align-items:flex-start;justify-content:flex-start;padding:56px 8px 0}
  .devbot-pop-mask{background:transparent}
  .devbot-sheet{margin:0;width:100%;max-height:min(70%,420px);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
  .devbot-sheet-grab{display:none}
}
@container devbot (max-width:899.98px){
  .devbot-sys-row{min-height:40px;padding:8px 0}
  .devbot-tool-row{min-height:40px;padding:8px 0}
}
@container devbot (max-width:559.98px){
  .devbot-root[data-view="gates"] .devbot-chat,.devbot-root[data-view="tasks"] .devbot-chat,.devbot-root[data-view="members"] .devbot-chat{display:none}
  .devbot-root[data-view="chat"] .devbot-side{display:none}
  .devbot-chat{border-right:0}
  .devbot-side{display:flex;flex-direction:column;flex:1 1 auto;width:auto;min-width:0;min-height:0;overflow:hidden}
  .devbot-panel{padding:16px}
}

@media (prefers-reduced-motion:reduce){
  .devbot-iconbtn[data-busy="true"] svg{animation:none}
  .devbot-typing-dots i{animation:none;opacity:.8}
}
`;

    const TABS = [
      { key: 'chat', label: '群聊' },
      { key: 'gates', label: '阶段门' },
      { key: 'tasks', label: '任务' },
      { key: 'members', label: '成员' },
    ];

    /** 侧栏入口图标（sidebar.panellist 用）。 */
    function DevbotIcon({ size }) {
      const s = typeof size === 'number' ? size : 16;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 2, y: 3, width: 12, height: 8.5, rx: 2 }),
        h('path', { d: 'M4.6 8.1h.01M6.8 8.1h.01M9 8.1h.01M11.2 8.1h.01' }),
        h('path', { d: 'M8 11.5v2M5.5 13.5h5' }),
      );
    }

    function DevbotIconBack() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M10 3 5 8l5 5' }));
    }

    function DevbotIconRefresh() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M13 6.5A5 5 0 1 0 13.4 9' }),
        h('path', { d: 'M13 2.8v3.9H9.1' }));
    }

    function DevbotIconCaret() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'm3 4.5 3 3 3-3' }));
    }

    function DevbotIconClose() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'm4 4 8 8M12 4l-8 8' }));
    }

    function DevbotIconTool() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 4.5h11M2.5 8h7M2.5 11.5h5' }),
        h('path', { d: 'm10 10.5 2 2 2-2' }));
    }

    /* markdown AST → React 元素：文本一律走 React children（自动转义），不用
     * dangerouslySetInnerHTML；链接 href 已由 safeHref 白名单过滤。 */
    function renderInlineNodes(nodes) {
      return (nodes || []).map((node, index) => {
        if (node.type === 'text') return node.text;
        if (node.type === 'code') return h('code', { key: 'i' + index }, node.text);
        if (node.type === 'strong') return h('strong', { key: 'i' + index }, renderInlineNodes(node.children));
        if (node.type === 'em') return h('em', { key: 'i' + index }, renderInlineNodes(node.children));
        if (node.type === 'del') return h('del', { key: 'i' + index }, renderInlineNodes(node.children));
        if (node.type === 'image') {
          // 图片降级为外链：不出 <img>（不自动拉远端资源），alt 作链接文本。
          return h('a', {
            key: 'i' + index, href: node.href, target: '_blank', rel: 'noopener noreferrer',
          }, node.alt || node.href);
        }
        if (node.type === 'link') {
          return h('a', {
            key: 'i' + index, href: node.href, target: '_blank', rel: 'noopener noreferrer',
          }, renderInlineNodes(node.children));
        }
        return null;
      });
    }

    /**
     * @收件人 chip：一条消息只由代码按「会话归属」生成，不要求成员在正文里写 @。
     * @param {{name:string,role:string}|undefined} mention mentionOf() 的结果
     * @returns {any} React 节点或 null
     */
    function mentionChip(mention) {
      if (!mention || !mention.name) return null;
      return h('span', {
        className: 'devbot-at devbot-role-' + (mention.role || 'system'),
        'data-mention': mention.name,
        title: '发给 @' + mention.name,
      }, '@' + mention.name);
    }

    /**
     * markdown → React 元素。`prefix`（如 @收件人）放在**第一个能内联的块**开头，
     * 这样每条消息的开头就是 @目标成员；首块是代码块/hr 时降级成单独一行标记。
     * @param {string} text markdown 正文
     * @param {any} [prefix] 前缀 React 节点（无 key，作为首块 child）
     * @returns {any[]}
     */
    function renderMarkdown(text, prefix) {
      const blocks = parseMarkdown(text);
      const out = [];
      let pending = prefix || null;
      const take = () => { const value = pending; pending = null; return value; };
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const key = 'b' + index;
        if (block.type === 'code') {
          const lead = take();
          if (lead) out.push(h('div', { key: key + 'at', className: 'devbot-at-row' }, lead));
          out.push(h('div', { key, className: 'devbot-codeblock' },
            block.lang ? h('div', { className: 'devbot-codeblock-head' }, h('span', null, block.lang)) : null,
            h('pre', null, h('code', null, block.text))));
        } else if (block.type === 'heading') {
          const tag = 'h' + Math.min(4, Math.max(1, block.level));
          out.push(h(tag, { key }, take(), renderInlineNodes(parseInline(block.text))));
        } else if (block.type === 'hr') {
          const lead = take();
          if (lead) out.push(h('div', { key: key + 'at', className: 'devbot-at-row' }, lead));
          out.push(h('hr', { key }));
        } else if (block.type === 'quote') {
          out.push(h('blockquote', { key }, block.lines.map((line, lineIndex) => h('p', { key: 'q' + lineIndex },
            lineIndex === 0 ? take() : null, renderInlineNodes(parseInline(line))))));
        } else if (block.type === 'list') {
          out.push(h(block.ordered ? 'ol' : 'ul', { key }, block.items.map((item, itemIndex) => {
            const task = /^\[( |x|X)\]\s+/.exec(item);
            return h('li', { key: 'l' + itemIndex },
              itemIndex === 0 ? take() : null,
              task ? h('input', { key: 'cb' + itemIndex, type: 'checkbox', checked: task[1] !== ' ', disabled: true }) : null,
              renderInlineNodes(parseInline(task ? item.slice(task[0].length) : item)));
          })));
        } else if (block.type === 'table') {
          // 列宽策略与 DSH 主聊天一致：<4 列充满容器换行，≥4 列自然宽度横向滚动。
          const cellStyle = (align) => (align ? { textAlign: align } : undefined);
          const lead = take();
          if (lead) out.push(h('div', { key: key + 'at', className: 'devbot-at-row' }, lead));
          out.push(h('div', { key, className: 'devbot-table', 'data-fill': block.align.length < 4 ? 'true' : 'false' },
            h('table', null,
              h('thead', null, h('tr', null, block.head.map((cell, col) =>
                h('th', { key: 'h' + col, style: cellStyle(block.align[col]) },
                  renderInlineNodes(parseInline(cell)))))),
              block.rows.length > 0 ? h('tbody', null, block.rows.map((row, rowIndex) =>
                h('tr', { key: 'r' + rowIndex }, block.align.map((align, col) =>
                  h('td', { key: 'c' + col, style: cellStyle(align) },
                    row[col] === undefined ? null : renderInlineNodes(parseInline(row[col]))))))) : null)));
        } else {
          out.push(h('p', { key }, take(), renderInlineNodes(parseInline(block.text))));
        }
      }
      if (pending) out.push(h('div', { key: 'at-tail', className: 'devbot-at-row' }, pending));
      return out;
    }

    function DevbotGatesPanel(props) {
      const detail = props.detail || emptyDetail();
      const stage = detail.stage;
      return h('div', { className: 'devbot-panel', 'data-active': props.active ? 'true' : 'false', role: 'tabpanel', 'aria-label': '阶段门' },
        h('div', { className: 'devbot-panel-head' },
          h('h2', null, '阶段门 · Phase Gates'),
          stage ? h('span', { className: 'devbot-panel-meta' }, stage.allDone ? '5/5 已完成' : '阶段 ' + stage.current + '/5') : null),
        h('div', { className: 'devbot-gate-list' }, STAGES.map((s) => {
          const list = stage ? (stage.byStage[s.n] || []) : [];
          const doneCount = list.filter((x) => x.task.status === 'completed').length;
          const isNow = !!stage && stage.current === s.n && !stage.allDone;
          const isDone = !!stage && (stage.allDone || (s.n < stage.current && list.length > 0));
          return h('div', {
            key: s.n, className: 'devbot-gate',
            'data-now': isNow ? 'true' : 'false', 'data-done': isDone ? 'true' : 'false',
          },
            h('span', { className: 'devbot-gate-mark', 'aria-hidden': 'true' }, isDone ? '✓' : (isNow ? '▶' : '○')),
            h('span', { className: 'devbot-gate-main' },
              h('div', { className: 'devbot-gate-title' },
                h('b', null, s.n + '.' + s.name),
                h('span', { className: 'devbot-gate-count' }, doneCount + '/' + list.length)),
              h('p', { className: 'devbot-gate-desc' }, s.gate)));
        })),
        stage && stage.blocked > 0
          ? h('div', { className: 'devbot-notice', 'data-warn': 'true' }, '· ' + stage.blocked + ' 个任务被阻塞')
          : null,
        detail.team && detail.team.failure
          ? h('div', { className: 'devbot-notice' }, '项目记录异常：' + detail.team.failure)
          : null,
        !detail.team ? h('div', { className: 'devbot-empty' }, '未选择团队') : null);
    }

    function DevbotTasksPanel(props) {
      const detail = props.detail || emptyDetail();
      const tasks = detail.tasks || [];
      return h('div', { className: 'devbot-panel', 'data-active': props.active ? 'true' : 'false', role: 'tabpanel', 'aria-label': '任务' },
        h('div', { className: 'devbot-panel-head' },
          h('h2', null, '任务板 · Task Board'),
          h('span', { className: 'devbot-panel-meta' }, tasks.length + ' 项')),
        tasks.length === 0
          ? h('div', { className: 'devbot-empty' }, '暂无任务')
          : h('div', { className: 'devbot-task-list' }, tasks.map((task) => {
            const state = task.status === 'completed' ? 'done'
              : task.status === 'in_progress' ? 'doing'
                : (task.status === 'pending' && task.ready === false ? 'blocked' : 'todo');
            return h('div', { key: task.id, className: 'devbot-task' },
              h('span', { className: 'devbot-dot', 'data-state': state, 'aria-hidden': 'true' }),
              h('div', { className: 'devbot-task-main' },
                h('div', { className: 'devbot-task-title' },
                  h('span', { className: 'devbot-task-id' }, String(task.id) + ' '), String(task.subject || '')),
                h('div', { className: 'devbot-task-meta' },
                  (STATUS_TEXT[task.status] || String(task.status || ''))
                  + (task.ownerName ? ' · ' + task.ownerName : '')
                  + ' · 阶段 ' + (stageOf(task).n || '?'))));
          })));
    }

    function DevbotMembersPanel(props) {
      const detail = props.detail || emptyDetail();
      const members = detail.members || [];
      return h('div', { className: 'devbot-panel', 'data-active': props.active ? 'true' : 'false', role: 'tabpanel', 'aria-label': '成员' },
        h('div', { className: 'devbot-panel-head' },
          h('h2', null, '成员 · Members'),
          h('span', { className: 'devbot-panel-meta' }, members.length + ' 人')),
        members.length === 0
          ? h('div', { className: 'devbot-empty' }, '暂无成员')
          : h('div', { className: 'devbot-member-list' }, members.map((member) => {
            const model = member.member || member;
            const name = displayName(model);
            const role = roleOfMember(model);
            const meta = [
              PHASE_TEXT[member.phase] || member.phase || '',
              member.running ? '运行中' : '',
              member.merged ? '' : '未打开历史',
              member.openError ? String(member.openError) : '',
            ].filter(Boolean);
            return h('div', { key: member.id, className: 'devbot-member-row' },
              h('span', { className: 'devbot-dot', 'data-state': member.running ? 'doing' : 'todo', 'aria-hidden': 'true' }),
              h('span', { className: 'devbot-avatar devbot-role-' + role, 'aria-hidden': 'true' }, avatarOf(name)),
              h('div', { className: 'devbot-member-main' },
                h('div', { className: 'devbot-member-title' }, h('b', null, name), h('span', { className: 'devbot-role' }, ROLE_TEXT[role] || role)),
                h('div', { className: 'devbot-member-meta', 'data-warn': member.openError ? 'true' : 'false' }, meta.join(' · '))));
          })));
    }

    function DevbotWorkbench(props) {
      const useTeams = typeof props.useTeams === 'function' ? props.useTeams : () => undefined;
      const useDetail = typeof props.useDetail === 'function' ? props.useDetail : () => undefined;
      const teams = useTeams((snapshot) => snapshot) || { phase: 'pending', items: [] };
      const detail = useDetail((snapshot) => snapshot) || emptyDetail();
      const selectTeam = props.selectTeam;
      const setActive = props.setActive;
      const refresh = props.refresh;
      const loadOlder = props.loadOlder;
      const backToConversation = props.backToConversation;

      const scrollRef = useRef(null);
      const stickRef = useRef(true);
      const teamRef = useRef(detail.leadId);
      const chatTopRef = useRef(0);
      const geomRef = useRef({ top: 0, height: 0, client: 0 });
      const programmaticRef = useRef(false);
      const viewRef = useRef('chat');
      const refreshTimer = useRef(null);
      const [view, setView] = useState('chat');
      const [infoTab, setInfoTab] = useState('gates');
      const [busy, setBusy] = useState(false);
      const [projectsOpen, setProjectsOpen] = useState(false);
      const [expanded, setExpanded] = useState({});

      useEffect(() => {
        if (typeof setActive === 'function') setActive(true);
        return () => { if (typeof setActive === 'function') setActive(false); };
      }, []);

      useEffect(() => () => {
        if (refreshTimer.current) {
          try { clearTimeout(refreshTimer.current); } catch (error) { /* ignore */ }
          refreshTimer.current = null;
        }
      }, []);

      useEffect(() => {
        if (!projectsOpen) return undefined;
        const onKey = (event) => {
          if (event && event.key === 'Escape') setProjectsOpen(false);
        };
        try { window.addEventListener('keydown', onKey); } catch (error) { return undefined; }
        return () => { try { window.removeEventListener('keydown', onKey); } catch (error) { /* ignore */ } };
      }, [projectsOpen]);

      const rows = detail.rows || [];
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      // 内容 revision：行数 + 首行 key + 末行 key/文本长度。
      // 晚到成员会话异步 open 时，旧消息只会插到时间线*上方*（末行 key 不变），
      // 只看 lastKey 会漏掉这类增长；流式文本变长则靠末行文本长度感知。
      const contentRev = rows.length
        + ':' + (rows.length > 0 ? rows[0].key : '')
        + ':' + (lastRow ? lastRow.key : '')
        + ':' + (lastRow && typeof lastRow.text === 'string' ? lastRow.text.length : 0);

      useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        // 换团队 = 看新会话，回到最新一条。
        if (teamRef.current !== detail.leadId) {
          teamRef.current = detail.leadId;
          stickRef.current = true;
        }
        const max = el.scrollHeight - el.clientHeight;
        // 空态/塌缩：不写 scrollTop，也不改变贴底意图。
        if (max <= 0) return;
        // 用户上滑离开底部后不拉回（stick 由 onScroll 只按「用户上移」清除）。
        if (!stickRef.current) return;
        if (el.scrollTop >= max - 1) return;
        programmaticScroll(el, max);
      }, [contentRev, detail.leadId]);

      // 切 tab：群聊/信息视图只隐藏不卸载（保 scrollTop），切回时按贴底意图恢复。
      useEffect(() => {
        if (viewRef.current !== view) {
          const el = scrollRef.current;
          if (viewRef.current === 'chat' && el && el.clientHeight > 0) chatTopRef.current = el.scrollTop;
          viewRef.current = view;
        }
        if (view !== 'chat') return;
        const el = scrollRef.current;
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) return;
        programmaticScroll(el, stickRef.current ? max : Math.min(chatTopRef.current, max));
      }, [view]);

      const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        // display:none 期间浏览器会把 scrollTop 夹到 0 并派发 scroll；那不是用户行为，
        // 不能覆盖保存的滚动位置与贴底意图（否则切回群聊会跳回顶部并误触 loadOlder）。
        if (el.clientHeight <= 0) return;
        const top = el.scrollTop;
        const height = el.scrollHeight;
        const client = el.clientHeight;
        const max = height - client;
        const prev = geomRef.current;
        geomRef.current = { top, height, client };
        chatTopRef.current = top;
        if (programmaticRef.current) {
          // 我们自己的跟随/恢复滚动，不是用户手势。
        } else if (max <= 0) {
          // 内容塌缩（浏览器把 scrollTop 夹到 0）：保持原意图，不能误判成回到底部。
        } else if (max - top < STICK_THRESHOLD) {
          stickRef.current = true;
        } else if (top < prev.top - 2) {
          // 只有用户真的往上滚（scrollTop 变小）才离开底部；
          // 内容在上方插入导致 max 变大、scroll anchoring 推大 scrollTop 都不算。
          stickRef.current = false;
        }
        if (top < 48 && max > 0 && detail.hasMore && !detail.loadingOlder && typeof loadOlder === 'function') {
          loadOlder();
        }
      };

      /** 程序化写 scrollTop：标记后忽略紧随的 scroll 事件，避免被误判成用户上滑。 */
      const programmaticScroll = (el, value) => {
        programmaticRef.current = true;
        el.scrollTop = value;
        geomRef.current = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
        const clear = () => { programmaticRef.current = false; };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear);
        else setTimeout(clear, 16);
      };

      const doRefresh = () => {
        if (busy) return;
        setBusy(true);
        try { if (typeof refresh === 'function') refresh(); } catch (error) { /* ignore */ }
        if (refreshTimer.current) {
          try { clearTimeout(refreshTimer.current); } catch (error) { /* ignore */ }
        }
        refreshTimer.current = setTimeout(() => { refreshTimer.current = null; setBusy(false); }, 900);
      };

      const chooseTeam = (leadId) => {
        setProjectsOpen(false);
        stickRef.current = true;
        if (typeof selectTeam === 'function') selectTeam(leadId);
      };

      const selectInfo = (key) => {
        setInfoTab(key);
        if (view !== 'chat') setView(key);
      };

      const selectTab = (key) => {
        setView(key);
        if (key !== 'chat') setInfoTab(key);
      };

      const toggleExpanded = (key) => {
        setExpanded((previous) => {
          const next = Object.assign({}, previous);
          next[key] = !next[key];
          return next;
        });
      };

      const items = Array.isArray(teams.items) ? teams.items : [];
      const selectedLeadId = detail.leadId;
      const current = items.find((item) => item.leadId === selectedLeadId);
      const teamTitle = current ? current.title : (selectedLeadId ? String(selectedLeadId).slice(0, 8) : '');
      const stageInfo = detail.stage;
      const crumbText = current
        ? teamTitle + ' · ' + (stageInfo ? (stageInfo.allDone ? '5/5 已完成' : '阶段 ' + stageInfo.current + '/5') : '')
        : '未选择团队';
      const activeInfo = view === 'chat' ? infoTab : view;

      const rowEls = [];
      let prevRow = null;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (!prevRow || dayKey(prevRow.time) !== dayKey(row.time)) {
          rowEls.push(h('div', { key: 'day-' + dayKey(row.time) + '-' + String(index), className: 'devbot-day' }, fmtDay(row.time)));
        }
        if (row.kind === 'sys') {
          const open = !!expanded[row.key];
          rowEls.push(h('div', { key: row.key + '-sys', className: 'devbot-sys' },
            h('button', {
              type: 'button', className: 'devbot-sys-row', 'data-kind': 'sys', title: row.text,
              'aria-expanded': open ? 'true' : 'false', onClick: () => toggleExpanded(row.key),
            }, h('span', { className: 'devbot-sys-text' }, row.text)),
            open ? h('div', { className: 'devbot-sys-detail' }, row.text) : null));
        } else if (row.kind === 'task') {
          const open = !!expanded[row.key];
          rowEls.push(h('div', { key: row.key + '-tool' },
            h('button', {
              type: 'button', className: 'devbot-tool-row', 'data-kind': 'dispatch', title: row.text,
              'aria-expanded': open ? 'true' : 'false', onClick: () => toggleExpanded(row.key),
            },
              h('span', { className: 'devbot-tool-icon', 'aria-hidden': 'true' }, h(DevbotIconTool)),
              h('span', { className: 'devbot-tool-title' }, '派单'),
              mentionChip(row.target),
              h('span', { className: 'devbot-tool-summary' }, firstLine(row.text))),
            open ? h('div', { className: 'devbot-tool-detail' }, row.text) : null));
        } else if (row.human === true) {
          rowEls.push(h('div', { key: row.key, className: 'devbot-user', 'data-kind': 'user' },
            h('div', { className: 'devbot-bubble' }, mentionChip(row.target), row.text),
            h('time', { className: 'devbot-user-time' }, fmtTime(row.time))));
        } else {
          const showHead = shouldShowMemberHead(prevRow, row);
          const streaming = row.kind === 'stream';
          rowEls.push(h('article', {
            key: row.key,
            'data-kind': streaming ? 'stream' : (row.msgSource === 'assistant' ? 'assistant' : 'member'),
            className: 'devbot-msg devbot-msg--member' + (showHead ? '' : ' devbot-msg--cont'),
          },
            showHead ? h('header', { className: 'devbot-member-head' },
              h('span', { className: 'devbot-avatar devbot-role-' + (row.role || 'system'), 'aria-hidden': 'true' }, avatarOf(row.name)),
              h('span', { className: 'devbot-member-name' }, row.name),
              h('time', { className: 'devbot-member-time' }, fmtTime(row.time))) : null,
            h('div', { className: 'devbot-md' },
              streaming ? h('div', { className: 'devbot-streaming-text' }, row.text) : renderMarkdown(row.text, mentionChip(row.target)),
              streaming ? h('div', { className: 'devbot-typing', 'aria-label': '对方正在输入' },
                h('span', { className: 'devbot-typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
                h('span', null, '输入中')) : null)));
        }
        prevRow = row;
      }

      const teamMeta = (item) => item.memberCount + ' 人 · ' + item.taskCount + ' 任务'
        + (item.activeCount > 0 ? ' · ' + item.activeCount + ' 进行中' : '')
        + (item.running ? ' · 运行中' : '');

      const projectList = items.length === 0
        ? h('div', { className: 'devbot-sheet-empty' }, teams.phase === 'ready' ? '还没有带 Team 的会话' : '加载中…')
        : h('div', { className: 'devbot-sheet-list' }, items.map((item) => h('button', {
          key: item.leadId,
          type: 'button',
          className: 'devbot-project-item',
          'data-testid': 'team-item-drawer',
          'data-team-id': item.leadId,
          'data-current': item.leadId === selectedLeadId ? 'true' : 'false',
          onClick: () => chooseTeam(item.leadId),
        },
          h('div', { className: 'devbot-project-name' },
            item.leadId === selectedLeadId ? h('span', { className: 'devbot-role-mark', 'aria-hidden': 'true' }, '✓') : null,
            h('span', null, item.title)),
          h('div', { className: 'devbot-project-meta' }, teamMeta(item)))));
      const projectItems = detail.listStale
        ? h('div', null, h('div', { className: 'devbot-reconnect' }, '正在重新连接…'), projectList)
        : projectList;

      return h('div', {
        className: 'devbot-root',
        'data-testid': 'devbot-root',
        'data-view': view,
        'data-projects': projectsOpen ? 'open' : 'closed',
      },
        h('div', { className: 'devbot-appbar' },
          h('div', { className: 'devbot-mobile-head' },
            typeof backToConversation === 'function'
              ? h('button', { type: 'button', className: 'devbot-iconbtn', 'data-testid': 'back-btn-mobile', 'aria-label': '返回会话', title: '返回会话', onClick: backToConversation }, h(DevbotIconBack))
              : null,
            h('button', {
              type: 'button', className: 'devbot-project-btn', 'data-testid': 'project-switcher',
              'aria-haspopup': 'dialog', 'aria-expanded': projectsOpen ? 'true' : 'false',
              onClick: () => setProjectsOpen(!projectsOpen),
            },
              h('span', { className: 'devbot-name' }, teamTitle || '未选择团队'),
              h(DevbotIconCaret)),
            h('button', {
              type: 'button', className: 'devbot-iconbtn', 'data-testid': 'refresh-btn-mobile', 'aria-label': '刷新', title: '刷新',
              'data-busy': busy ? 'true' : 'false', disabled: busy, onClick: doRefresh,
            }, h(DevbotIconRefresh))),
          h('div', { className: 'devbot-desktop-head' },
            h('h1', { className: 'devbot-title' }, 'DevBot 工作台'),
            h('span', { className: 'devbot-crumb' }, crumbText),
            h('span', { className: 'devbot-spacer' }),
            typeof refresh === 'function'
              ? h('button', { type: 'button', className: 'devbot-headbtn', 'data-testid': 'refresh-btn-desktop', disabled: busy, onClick: doRefresh }, busy ? '刷新中…' : '刷新')
              : null,
            typeof backToConversation === 'function'
              ? h('button', { type: 'button', className: 'devbot-headbtn', 'data-testid': 'back-btn-desktop', onClick: backToConversation }, '回到会话')
              : null)),
        h('nav', { className: 'devbot-tabs', 'data-testid': 'tabs', role: 'tablist', 'aria-label': '工作台视图' },
          TABS.map((tab) => h('button', {
            key: tab.key,
            type: 'button',
            role: 'tab',
            className: 'devbot-tab',
            'data-testid': 'tab-' + tab.key,
            'data-view': tab.key,
            'aria-selected': view === tab.key ? 'true' : 'false',
            onClick: () => selectTab(tab.key),
          }, tab.label))),
        h('div', { className: 'devbot-body' },
          h('div', { className: 'devbot-teams' },
            h('div', { className: 'devbot-teams-label' }, 'DevBot 项目（按最近活动）'),
            items.length === 0
              ? h('div', { className: 'devbot-dim' }, teams.phase === 'ready' ? '还没有带 Team 的会话' : '加载中…')
              : items.map((item) => h('button', {
                key: item.leadId,
                type: 'button',
                className: 'devbot-team-btn',
                'data-testid': 'team-item-sidebar',
                'data-team-id': item.leadId,
                'data-current': item.leadId === selectedLeadId ? 'true' : 'false',
                onClick: () => chooseTeam(item.leadId),
              },
                h('div', { className: 'devbot-team-name' }, item.title),
                h('div', { className: 'devbot-team-meta' }, teamMeta(item)))),
            (detail.listStale || teams.phase !== 'ready') && items.length > 0
              ? h('div', { className: 'devbot-reconnect' }, '正在重新连接…')
              : null),
          h('div', { className: 'devbot-chat' },
            h('div', { className: 'devbot-stream', 'data-testid': 'chat-scroll', ref: scrollRef, onScroll, role: 'log', 'aria-label': '群聊时间线' },
              h('div', { className: 'devbot-stream-inner', 'data-testid': 'message-list' },
                rows.length === 0
                  ? h('div', { className: 'devbot-empty' },
                    h('p', null, '这里显示 Lead 与 4 个角色的群聊时间线：人类消息、成员互发、成员发言，以及任务/成员系统事件。'),
                    h('p', null, '还没有内容时：先开一个 Team 会话，用 spawn_teammate 起 pm / designer / fullstack / tester。'),
                    h('p', null, '也可以从会话 header 的 DevBot 按钮查看当前阶段门。'))
                  : rowEls)),
            h('div', { className: 'devbot-status', 'data-testid': 'status-bar' },
              h('span', { className: 'devbot-status-text' }, statusTextOf(detail)))),
          h('div', { className: 'devbot-side' },
            h('div', { className: 'devbot-side-tabs', role: 'tablist', 'aria-label': '项目信息' },
              ['gates', 'tasks', 'members'].map((key) => h('button', {
                key,
                type: 'button',
                role: 'tab',
                className: 'devbot-side-tab',
                'data-testid': 'side-tab-' + key,
                'aria-selected': activeInfo === key ? 'true' : 'false',
                onClick: () => selectInfo(key),
              }, key === 'gates' ? '阶段门' : key === 'tasks' ? '任务' : '成员'))),
            h('div', { className: 'devbot-panels' },
              h(DevbotGatesPanel, { detail, active: activeInfo === 'gates' }),
              h(DevbotTasksPanel, { detail, active: activeInfo === 'tasks' }),
              h(DevbotMembersPanel, { detail, active: activeInfo === 'members' })))),
        h('div', { className: 'devbot-pop-layer', 'data-testid': 'project-drawer', 'aria-hidden': projectsOpen ? 'false' : 'true' },
          h('button', { type: 'button', className: 'devbot-pop-mask', 'data-testid': 'project-mask', 'aria-label': '关闭项目列表', tabIndex: projectsOpen ? undefined : -1, onClick: () => setProjectsOpen(false) }),
          h('div', { className: 'devbot-sheet', role: 'dialog', 'aria-label': 'DevBot 项目' },
            h('div', { className: 'devbot-sheet-grab', 'aria-hidden': 'true' }),
            h('div', { className: 'devbot-sheet-head' },
              h('h2', null, 'DevBot 项目'),
              h('button', { type: 'button', className: 'devbot-iconbtn', 'aria-label': '关闭', onClick: () => setProjectsOpen(false) }, h(DevbotIconClose))),
            projectItems)));
    }

    /* ------------------------------------------------------------------ *
     * 4. 会话 header 的 DevBot 按钮 + 阶段 panel（仅 DevBot 会话显示）
     * ------------------------------------------------------------------ */

    /**
     * 标准模式等非 DevBot 会话不显示阶段按钮：
     * 会话 agentPreset 以 devbot- 开头，或带「真实团队」——与工作台发现同判据
     * （members>1 或 tasks 非空；每个会话都有一条只有 Lead 的空 team，不算）。
     */
    function isDevbotSession(preset, team) {
      if (typeof preset === 'string' && preset.startsWith('devbot-')) return true;
      if (!team || !Array.isArray(team.members)) return false;
      return team.members.length > 1 || (Array.isArray(team.tasks) && team.tasks.length > 0);
    }

    function HeaderStageRows(d) {
      return h('div', { className: 'devbot-gate-list' }, STAGES.map((s) => {
        const list = d.byStage[s.n] || [];
        const doneCount = list.filter((x) => x.task.status === 'completed').length;
        const isDone = d.allDone || (s.n < d.current && list.length > 0);
        const isNow = d.current === s.n && !d.allDone;
        return h('div', { key: s.n, className: 'devbot-gate', 'data-now': isNow ? 'true' : 'false', 'data-done': isDone ? 'true' : 'false' },
          h('span', { className: 'devbot-gate-mark', 'aria-hidden': 'true' }, isDone ? '✓' : (isNow ? '▶' : '○')),
          h('div', { className: 'devbot-gate-main' },
            h('div', { className: 'devbot-gate-title' },
              h('b', null, s.n + '.' + s.name),
              h('span', { className: 'devbot-gate-count' }, doneCount + '/' + list.length)),
            h('p', { className: 'devbot-gate-desc' }, s.gate)));
      }));
    }

    function DevbotGates(props) {
      const useS = typeof props.useSessions === 'function' ? props.useSessions : () => undefined;
      const useOne = typeof props.useSession === 'function' ? props.useSession : () => undefined;
      const sessionId = props.sessionId;
      const [open, setOpen] = useState(false);
      const leadId = useOne((s) => (s && s.subagent && s.subagent.address
        ? s.subagent.address.parentSessionId : undefined)) ?? sessionId;
      const team = useS((st) => (st && st.projectionsBySession && leadId
        ? (st.projectionsBySession[leadId] || {}).values?.agentTeam : undefined));
      const preset = useS((st) => {
        if (!st || !sessionId) return undefined;
        const row = st.byId ? st.byId[sessionId] : undefined;
        const values = st.projectionsBySession ? st.projectionsBySession[sessionId] : undefined;
        return (row && row.projectionValues ? row.projectionValues.agentPreset : undefined)
          ?? (values && values.values ? values.values.agentPreset : undefined);
      });
      // 钩子全部先执行再早退：标准模式等非 DevBot 会话不渲染任何东西。
      if (!isDevbotSession(preset, team)) return null;
      const d = derive(team);
      const label = d.allDone ? 'DevBot · 5/5 ✓'
        : team && d.current > 0 ? 'DevBot · 阶段' + d.current + '/5'
          : 'DevBot · 阶段门';
      return h('span', { className: 'devbot-hwrap' },
        h('button', {
          type: 'button', className: 'devbot-hbtn', title: 'DevBot 阶段门',
          'aria-haspopup': 'dialog', 'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'devbot-hbtn-icon', 'aria-hidden': 'true' }, h(DevbotIcon, { size: 14 })),
          label,
          team && d.blocked > 0 ? h('span', { className: 'devbot-hbtn-warn' }, '· 阻塞 ' + d.blocked) : null),
        open ? h('button', {
          type: 'button', className: 'devbot-hbackdrop', 'aria-label': '关闭阶段门面板', tabIndex: -1,
          onClick: () => setOpen(false),
        }) : null,
        open ? h('div', { className: 'devbot-hpanel', 'data-menu-material': 'translucent', role: 'dialog', 'aria-label': 'DevBot 阶段门' },
          h('div', { className: 'devbot-hpanel-head' },
            h('h3', { className: 'devbot-hpanel-title' }, '阶段门 · Phase Gates'),
            team && d.tasks.length > 0
              ? h('span', { className: 'devbot-hpanel-meta' }, d.allDone ? '5/5 已完成' : '阶段 ' + d.current + '/5')
              : null),
          !team ? h('p', { className: 'devbot-hpanel-empty' }, '当前会话还没有 Team：spawn 成员后这里显示阶段进度。') : null,
          team && d.tasks.length === 0
            ? h('p', { className: 'devbot-hpanel-empty' }, '暂无任务：Lead 建任务（team_task_create）后点亮进度。')
            : null,
          HeaderStageRows(d),
          team ? h('div', { className: 'devbot-hpanel-note' },
            h('b', null, '成员 ' + d.members.length + ' · 任务 ' + d.tasks.length
              + '（进行 ' + d.active.length + ' / 完成 ' + d.done.length + '）'),
            d.blocked > 0 ? h('div', { className: 'devbot-hpanel-warn' }, '有 ' + d.blocked + ' 个任务被阻塞。') : null,
            h('div', null, '完整看板：左侧栏 DevBot 图标打开群聊工作台。')) : null,
        ) : null);
    }

    /* ------------------------------------------------------------------ *
     * 5. apply
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'layout', 'sessions'],
      apply(ctx) {
          try {
          // 模式选择器过滤：队友角色 preset 不进入用户可见的 roster（v0.5.3）
          installPresetRosterFilter(ctx);

          // 全局样式：随插件卸载移除（不放进组件里，避免每次切面板重建）
          ctx.effect(() => {
            if (typeof document === 'undefined' || !document.head) return () => {};
            const el = document.createElement('style');
            el.setAttribute('data-plugin', '@local/dsh-autodev-bot');
            el.textContent = WORKBENCH_CSS;
            document.head.appendChild(el);
            return () => { el.remove(); };
          }, 'devbot: styles');

          const controller = createController(ctx);
          ctx.effect(() => () => controller.dispose(), 'devbot: controller');
          ctx.effect(() => {
            const stop = controller.startWatching();
            return () => { if (typeof stop === 'function') stop(); };
          }, 'devbot: team watcher');

          const face = () => ({
            hooks: { teams: controller.stores.teams, detail: controller.stores.detail },
            selectTeam: controller.actions.selectTeam,
            setActive: controller.actions.setActive,
            refresh: controller.actions.refresh,
            loadOlder: controller.actions.loadOlder,
            backToConversation: controller.actions.backToConversation,
          });

          // 注册失败时只丢自己的贡献，不让整个 Web 启动审计失败（boot safety）。
          const registerSafely = (label, callback) => {
            try {
              return callback();
            } catch (error) {
              try {
                // eslint-disable-next-line no-console
                console.error('[devbot] slot registration failed (' + label + '):', error);
              } catch (ignored) { /* ignore */ }
              return () => {};
            }
          };

          // 独立入口：侧栏图标 + 主栏整页（同一个 id/key）
          ctx.slots.inject('main', () => registerSafely('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: face,
          }, DevbotWorkbench)));

          ctx.slots.inject('sidebar.panellist', () => registerSafely('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => 'DevBot',
          }, DevbotIcon)));

          // 会话 header 的阶段门按钮（v0.3 保留）
          ctx.slots.inject('conversation.session.header.actions', () => registerSafely('header', () => ctx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'devbot-gates',
            order: 10,
          }, DevbotGates)));
        } catch (error) {
          try { console.error('[devbot] apply failed:', error); } catch (ignored) { /* ignore */ }
        }
      },
      _internals: {
        PANEL_ID, SOURCE, STAGES, stageOf, derive, roleOfMember, displayName, mentionOf, avatarOf,
        contentText, stripRelayPrefix, isAppendOrigin, normalizeFingerprint, buildRow, mergeRows,
        emptyDetail, createStore, createController, nextStick, shouldFollowBottom,
        parseMarkdown, parseInline, safeHref, renderMarkdown, mentionChip, breakpointOf, shouldShowMemberHead,
        statusTextOf, firstLine,
        HIDDEN_ROLE_PRESETS, withoutHiddenRolePresets, installPresetRosterFilter,
        isDevbotSession, HeaderStageRows, DevbotGates,
      },
    };
  },
});
