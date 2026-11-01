/**
 * v0.5 markdown 子集渲染器单测。
 *
 * 目标（PRD §11.1 / AC-12 / AC-15）：
 *  - 解析标题 / 段落 / 粗体 / 斜体 / 行内码 / 代码块 / ul / ol / 引用 / 链接 / hr；
 *  - 链接走白名单 http(s) / mailto / #，javascript: / data: 等降级为纯文本；
 *  - 不产出 HTML：正文里的 <script>、<img onerror> 只能作为文本子节点，
 *    渲染树中不允许出现 dangerouslySetInnerHTML。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * 用记录型 React stub 加载 client.js，便于断言 createElement 的产物。
 * 不复用 test/helpers.mjs：那里的 createElement 返回 {}，看不到 props/children。
 */
function loadRecorder() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let recorded
  const fakeWindow = { __ModuleLoader__: { load: (mod) => { recorded = mod } } }
  new Function('window', source)(fakeWindow)
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState() {},
    useEffect() {},
    useRef() {},
  }
  const plugin = recorded.factory(() => react)
  return plugin._internals
}

const { parseMarkdown, parseInline, safeHref, renderMarkdown } = loadRecorder()

/** 递归收集渲染树里的元素类型与 props（用于断言没有 dangerouslySetInnerHTML）。 */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (Array.isArray(node)) { node.forEach((item) => walk(item, visit)); return }
  if (typeof node === 'object' && node.type) {
    visit(node)
    if (node.props && node.props.dangerouslySetInnerHTML) {
      throw new Error('渲染树出现 dangerouslySetInnerHTML')
    }
    node.children.forEach((child) => walk(child, visit))
  }
}

test('safeHref：只放行 http(s) / mailto / #', () => {
  assert.equal(safeHref('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c')
  assert.equal(safeHref('http://example.com'), 'http://example.com')
  assert.equal(safeHref('MAILTO:a@b.c'), 'MAILTO:a@b.c')
  assert.equal(safeHref('#section'), '#section')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('JaVaScRiPt:alert(1)'), null)
  assert.equal(safeHref('data:text/html;base64,PHNjcmlwdD4='), null)
  assert.equal(safeHref('/relative/path'), null)
  assert.equal(safeHref('vbscript:msgbox(1)'), null)
  assert.equal(safeHref(''), null)
  assert.equal(safeHref('   '), null)
  assert.equal(safeHref('https://example.com/a b'), null, '链接里不允许空白')
})

test('parseMarkdown：标题 h1–h4、段落、hr', () => {
  const blocks = parseMarkdown('# 一级\n## 二级\n\n第一段\n第二行\n\n---\n')
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'heading', 'paragraph', 'hr'])
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].text, '一级')
  assert.equal(blocks[1].level, 2)
  assert.equal(blocks[2].text, '第一段\n第二行', '段落内换行保留')
})

test('parseMarkdown：ul / ol 各自成块，续行并入列表项', () => {
  const blocks = parseMarkdown('- 一\n- 二\n  续行\n\n1. 甲\n2. 乙\n')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'list')
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(blocks[0].items, ['一', '二\n续行'])
  assert.equal(blocks[1].ordered, true)
  assert.deepEqual(blocks[1].items, ['甲', '乙'])
})

test('parseMarkdown：引用与围栏代码块（保留语言与原始文本）', () => {
  const blocks = parseMarkdown('> 引用一\n> 引用二\n\n```css\n.a{color:red}\n```\n')
  assert.equal(blocks[0].type, 'quote')
  assert.deepEqual(blocks[0].lines, ['引用一', '引用二'])
  assert.equal(blocks[1].type, 'code')
  assert.equal(blocks[1].lang, 'css')
  assert.equal(blocks[1].text, '.a{color:red}')
})

test('parseMarkdown：未闭合围栏也能收尾，不丢内容', () => {
  const blocks = parseMarkdown('```js\nconsole.log(1)\n')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].text, 'console.log(1)')
})

test('parseInline：粗体 / 斜体 / 行内码 / 链接', () => {
  const nodes = parseInline('**粗** 与 *斜* 与 `code` 与 [链接](https://example.com)')
  const types = nodes.map((n) => n.type)
  assert.deepEqual(types, ['strong', 'text', 'em', 'text', 'code', 'text', 'link'])
  assert.equal(nodes[0].children[0].text, '粗')
  assert.equal(nodes[2].children[0].text, '斜')
  assert.equal(nodes[4].text, 'code')
  assert.equal(nodes[6].href, 'https://example.com')
  assert.equal(nodes[6].children[0].text, '链接')
})

test('parseInline：非白名单链接降级为纯文本（无 href）', () => {
  const nodes = parseInline('[点我](javascript:alert(1))')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].type, 'text')
  assert.equal(nodes[0].text, '点我')
})

test('renderMarkdown：产生标题 / 列表 / 代码块 / 链接元素', () => {
  const tree = renderMarkdown('# 标题\n\n- 一\n- 二\n\n```css\n.a{}\n```\n\n[链接](https://example.com)')
  const kinds = []
  walk(tree, (node) => { if (node.type) kinds.push(node.type) })
  for (const expected of ['h1', 'ul', 'li', 'div', 'pre', 'code', 'p', 'a']) {
    assert.ok(kinds.includes(expected), '缺少元素 ' + expected + '：' + kinds.join(','))
  }
  const anchor = []
  walk(tree, (node) => { if (node.type === 'a') anchor.push(node) })
  assert.equal(anchor[0].props.href, 'https://example.com')
  assert.equal(anchor[0].props.rel, 'noopener noreferrer')
})

test('XSS：<script> / <img onerror> 只作为文本节点，绝不产出可执行 HTML', () => {
  const payload = '<script>alert(1)</script> 与 <img src=x onerror=alert(2)>'
  const tree = renderMarkdown(payload + '\n\n[坏链接](javascript:alert(3))')
  const texts = []
  walk(tree, (node) => {
    if (node.text !== undefined) texts.push(node.text)
    if (node.type === 'a') throw new Error('javascript: 链接不应渲染成 <a>')
  })
  const joined = texts.join('')
  assert.ok(joined.includes('<script>alert(1)</script>'), '必须原样保留为文本')
  assert.ok(joined.includes('<img src=x onerror=alert(2)>'), '必须原样保留为文本')
  assert.ok(joined.includes('坏链接'), '坏链接降级为文本但保留标题')
})

test('parseMarkdown：长围栏（````）包短围栏——内层围栏留在代码块里，不得死循环', () => {
  // 真实历史里的 Designer 回报用 ````markdown 包住含 ```css 的文档。
  // 旧实现只认正好 3 个反引号，` ````markdown` 既匹配不上 fence，又被
  // isSpecialStart 判成特殊行，段落分支原地不前进 → 无限 push 直到 OOM。
  const text = [
    '前言',
    '',
    '````markdown',
    '# 标题',
    '```css',
    '.a{color:red}',
    '```',
    '````',
    '',
    '结尾',
  ].join('\n')
  const blocks = parseMarkdown(text)
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'code', 'paragraph'])
  assert.equal(blocks[1].lang, 'markdown')
  assert.ok(blocks[1].text.includes('```css'), '内层三个反引号必须作为代码正文保留')
  assert.ok(blocks[1].text.includes('.a{color:red}'))
  assert.equal(blocks[2].text, '结尾')
})

test('parseMarkdown：任何以 ``` 开头的畸形行都必须前进（终止性回归）', () => {
  // 回归锁：只要一行被 isSpecialStart 判为特殊、却没有分支接手，
  // 解析必须仍然消费它；否则外层 while 空转会把页面拖进 OOM（白屏）。
  const lines = ['````markdown', '``` js', '```a`b', '````', '```', '``````', '```   ']
  for (const line of lines) {
    const blocks = parseMarkdown(line + '\n正文')
    assert.ok(Array.isArray(blocks), line)
    assert.ok(blocks.length >= 1 && blocks.length < 100, line + ' 解析块数应为有限值')
  }
})


/* ---- v0.5.4 GFM 扩展：表格 / 删除线 / 任务列表 / 自动链接 / 图片 / h5-h6 ---- */

test('parseMarkdown：GFM 表格（列数校验、对齐、转义竖线、续行）', () => {
  const blocks = parseMarkdown(
    '| # | 名称 | 用途 | 结果 |\n|---|:---:|---:|---|\n| 7 | Recon | 摸 CSS/token | 读了 |\n| 8 | Draft | 代写文档 | 失败 |\n')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'table')
  assert.deepEqual(blocks[0].align, [null, 'center', 'right', null])
  assert.deepEqual(blocks[0].head, ['#', '名称', '用途', '结果'])
  assert.deepEqual(blocks[0].rows, [['7', 'Recon', '摸 CSS/token', '读了'], ['8', 'Draft', '代写文档', '失败']])

  // \| 是竖线字面量，不切单元格
  const escaped = parseMarkdown('| a | b |\n|---|---|\n| 段 \\| 集 | 正文 |\n')
  assert.deepEqual(escaped[0].rows, [['段 | 集', '正文']])

  // 表体行数可少列；空位补空单元格
  const short = parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 | 2 |\n')
  assert.deepEqual(short[0].rows[0], ['1', '2', ''])

  // 表体在空行/列表/标题处断开
  const broken = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n后续段落\n')
  assert.deepEqual(broken.map((b) => b.type), ['table', 'paragraph'])
})

test('parseMarkdown：不是表格的情况（列数不一致 / 裸 --- / 单行管道）', () => {
  // 表头 2 列 vs 分隔行 1 列 → 不是表格，还是段落 + hr
  assert.deepEqual(parseMarkdown('a | b\n---\n').map((b) => b.type), ['paragraph', 'hr'])
  // 没有分隔行 → 普通段落
  assert.deepEqual(parseMarkdown('| a | b |\n| x | y |\n').map((b) => b.type), ['paragraph'])
  // 无管道的行 + --- → 段落 + hr（不是单列表格）
  assert.deepEqual(parseMarkdown('标题文字\n---\n').map((b) => b.type), ['paragraph', 'hr'])
})

test('renderMarkdown：表格 → table/thead/tbody，<4 列充满、≥4 列滚动，@chip 不进 th', () => {
  const chip = { type: 'span', props: {}, children: [] }
  const tree = renderMarkdown('| 名称 | 结果 |\n|:---|---:|\n| **A** | `x` |\n', chip)
  const tables = []
  walk(tree, (node) => { if (node.type === 'table' || node.type === 'div') tables.push(node) })
  const wrapper = tables.find((n) => n.type === 'div' && n.props['data-fill'] === 'true')
  assert.ok(wrapper, '2 列表格应 data-fill=true')
  assert.equal(wrapper.props.className, 'devbot-table')
  const kinds = []
  walk([wrapper], (node) => { if (node.type) kinds.push(node.type) })
  for (const expected of ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'code']) {
    assert.ok(kinds.includes(expected), '缺少 ' + expected + '：' + kinds.join(','))
  }
  // 列对齐进 style（按列断言：第 0 列 :--- 左对齐、第 1 列 ---: 右对齐）
  const headCells = []
  const bodyCells = []
  walk([wrapper], (node) => {
    if (node.type === 'th') headCells.push(node.props.style)
    if (node.type === 'td') bodyCells.push(node.props.style)
  })
  assert.deepEqual(headCells, [{ textAlign: 'left' }, { textAlign: 'right' }])
  assert.deepEqual(bodyCells, [{ textAlign: 'left' }, { textAlign: 'right' }])
  // 首块是表格时 @chip 独立成行，不塞进 th
  assert.deepEqual(tree[0].props.className, 'devbot-at-row')

  const wide = renderMarkdown('| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n')
  const wideWrap = wide.find((n) => n.type === 'div' && String(n.props.className || '').includes('devbot-table'))
  assert.equal(wideWrap.props['data-fill'], 'false', '4 列表格 data-fill=false')
})

test('parseInline / renderMarkdown：~~删除线~~ → del', () => {
  const nodes = parseInline('~~作废~~')
  assert.equal(nodes[0].type, 'del')
  assert.equal(nodes[0].children[0].text, '作废')
  let hasDel = false
  walk(renderMarkdown('前 ~~gone~~ 后'), (node) => { if (node.type === 'del') hasDel = true })
  assert.ok(hasDel)
})

test('parseInline：__粗体__ / _斜体_ 生效，词内下划线不生效', () => {
  assert.equal(parseInline('__强调__')[0].type, 'strong')
  assert.equal(parseInline('_着重_')[0].type, 'em')
  // snake_case 词内不拆
  const snake = parseInline('foo_bar_baz')
  assert.equal(snake.length, 1)
  assert.equal(snake[0].type, 'text')
  assert.equal(snake[0].text, 'foo_bar_baz')
  // 词边界外的 __init__：与 Commonmark / DSH 主聊天一致，加粗
  const py = parseInline('调用 __init__ 完成')
  assert.equal(py.some((n) => n.type === 'strong'), true)
})

test('parseInline：自动链接 http(s):// www. 邮箱，尾部标点不进链接', () => {
  const cases = parseInline('看 https://example.com/a?b=1。完了')
  assert.equal(cases[0].text, '看 ')
  assert.equal(cases[1].type, 'link')
  assert.equal(cases[1].href, 'https://example.com/a?b=1')
  assert.equal(cases[1].children[0].text, 'https://example.com/a?b=1')
  assert.equal(cases[2].text, '。完了')

  const www = parseInline('访问 www.example.com/x 好了')
  assert.equal(www[1].type, 'link')
  assert.equal(www[1].href, 'http://www.example.com/x')
  assert.equal(www[2].text, ' 好了')

  const mail = parseInline('发到 a.b+c@example.com 就行')
  assert.equal(mail[1].type, 'link')
  assert.equal(mail[1].href, 'mailto:a.b+c@example.com')

  // 不配对右括号留在链接外
  const paren = parseInline('(见 https://example.com/a(1))')
  assert.equal(paren.find((n) => n.type === 'link').href, 'https://example.com/a(1)')

  // 代码 span 里的 URL 不链接
  const inCode = parseInline('`https://example.com`')
  assert.equal(inCode[0].type, 'code')

  // 紧跟词后的 www 不链接（无边界）
  assert.equal(parseInline('awww.example.com').length, 1)
  assert.equal(parseInline('awww.example.com')[0].type, 'text')
})

test('parseInline / renderMarkdown：图片 ![alt](url) 降级为外链，不产出 <img>', () => {
  const nodes = parseInline('前 ![截图](https://example.com/a.png) 后')
  assert.equal(nodes[1].type, 'image')
  assert.equal(nodes[1].href, 'https://example.com/a.png')
  assert.equal(nodes[1].alt, '截图')
  const tree = renderMarkdown('![截图](https://example.com/a.png)')
  walk(tree, (node) => { if (node.type === 'img') throw new Error('不允许渲染 <img>') })
  const anchor = []
  walk(tree, (node) => { if (node.type === 'a') anchor.push(node) })
  assert.equal(anchor[0].props.href, 'https://example.com/a.png')
  assert.ok(anchor[0].children.includes('截图'))
  // 非白名单图片地址 → 纯文本 alt
  const bad = parseInline('![坏](javascript:alert(1))')
  assert.equal(bad[0].type, 'text')
  assert.equal(bad[0].text, '坏')
})

test('renderMarkdown：任务列表 [ ] / [x] → 复选框；普通列表不受影响', () => {
  const tree = renderMarkdown('- [x] PRD 定稿\n- [ ] 设计评审\n- 普通项')
  const boxes = []
  walk(tree, (node) => { if (node.type === 'input') boxes.push(node) })
  assert.equal(boxes.length, 2)
  assert.equal(boxes[0].props.type, 'checkbox')
  assert.equal(boxes[0].props.checked, true)
  assert.equal(boxes[0].props.disabled, true)
  assert.equal(boxes[1].props.checked, false)
  const texts = []
  walk(tree, (node) => { if (node.text !== undefined) texts.push(node.text) })
  assert.ok(texts.join('').includes('PRD 定稿'))
  assert.ok(!texts.join('').includes('[x]'), '复选框标记不再出现在文本里')
})

test('parseMarkdown / renderMarkdown：h5 h6 收敛到 h4 渲染，不出原始 # 号', () => {
  const blocks = parseMarkdown('##### 五级\n###### 六级\n')
  assert.deepEqual(blocks.map((b) => b.level), [5, 6])
  const tree = renderMarkdown('##### 五级')
  const heads = []
  walk(tree, (node) => { if (node.type && /^h[1-6]$/.test(node.type)) heads.push(node.type) })
  assert.deepEqual(heads, ['h4'])
})

test('renderMarkdown：整条 4 列表格消息（回归截图场景）不再出现原始管道文本', () => {
  const message = '| # | 名称 | 用途 | 结果 |\n'
    + '|---|---|---|---|\n'
    + '| 7 | Recon（第一版） | 摸 CSS/token/字号/间距 | 读到了，cwd 不对 |\n'
    + '| 8 | Draft doc | 代写需求文档 | **失败** |\n'
    + '| 11 | Probe | 确认能不能写 | `DENIED` |\n'
    + '| 12 | Write probe | 换 generic subagent | **WRITE_OK** |\n'
  const raw = []
  walk(renderMarkdown(message), (node) => { if (node.text !== undefined) raw.push(node.text) })
  const joined = raw.join('')
  assert.ok(!joined.includes('|---|'), '分隔行不能作为文本出现')
  assert.ok(!joined.includes('| 7 |'), '表行不能作为文本出现')
  assert.ok(joined.includes('WRITE_OK'))
})

/* ---- v0.5.4 会话 header 阶段按钮：仅 DevBot 会话显示 ---- */

test('isDevbotSession：标准模式不显示，DevBot preset / 真实团队会话显示', () => {
  const { isDevbotSession } = loadRecorder()
  assert.equal(isDevbotSession('devbot-lead', undefined), true, 'DevBot Lead preset')
  assert.equal(isDevbotSession('devbot-pm', undefined), true, '队友角色 preset')
  assert.equal(isDevbotSession('standard', undefined), false, '标准模式')
  assert.equal(isDevbotSession('ptc', undefined), false, 'PTC')
  assert.equal(isDevbotSession(undefined, undefined), false, '无 preset 无 team（未知会话不显示）')
  assert.equal(isDevbotSession(undefined, { members: [{ id: 'lead' }], tasks: [] }), false,
    '每个会话都有的「只有 Lead 的空 team」不算（否则标准模式也会显示）')
  assert.equal(isDevbotSession('standard', { members: [{ id: 'lead' }, { id: 'pm' }], tasks: [] }), true,
    '多成员团队即使 preset 投影缺失也显示（旧 DevBot 会话）')
  assert.equal(isDevbotSession('standard', { members: [{ id: 'lead' }], tasks: [{ id: 't1' }] }), true,
    '有任务的团队显示')
})
