#!/usr/bin/env node
/**
 * DevBot v0.5 设计稿截图 + 溢出自查。
 *
 * 用本机 DSH checkout 的 Playwright（与 test/browser/workbench-scroll.repro.mjs
 * 相同的 pnpm store 依赖解析方式），无头 Chromium 打开两份静态 HTML：
 *   - design/mobile-workbench.html
 *   - design/conversation-style.html
 * 在 375 / 390 / 430 三档视口截图并断言无页面级横向溢出、无竖排、无裁切；
 * 另附 1280 桌面缩略与浅色截图。
 *
 * 用法：
 *   node scripts/shot-design.mjs            # 截图 + 自查
 *   node scripts/shot-design.mjs --json     # 只输出 JSON 报告
 *   DSH_CHECKOUT=/path/to/deepseek-harness node scripts/shot-design.mjs
 *
 * 产物：design/verify/*.png + design/verify/report.json
 * 退出码：0 = 全部检查通过；1 = 有检查失败。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DSH = process.env.DSH_CHECKOUT
if (!DSH) {
  console.error('需要 DSH_CHECKOUT 环境变量指向 deepseek-harness checkout（截图依赖其 node_modules/Playwright）')
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

const PW = `${pnpmPackage('playwright')}/index.mjs`
const { chromium } = await import(PW)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'design', 'verify')
const WORKBENCH = join(ROOT, 'design', 'mobile-workbench.html')
const CONVERSATION = join(ROOT, 'design', 'conversation-style.html')
const jsonOnly = process.argv.includes('--json')

mkdirSync(OUT, { recursive: true })
const toUrl = (path) => 'file://' + path.split('/').map(encodeURIComponent).join('/')
const shots = []
const report = { generatedAt: new Date().toISOString(), playwright: PW, screens: {}, checks: [], shots }

function check(id, ok, detail) {
  const row = { id, ok: !!ok, detail }
  report.checks.push(row)
  if (!jsonOnly) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
  return row
}

async function shot(page, name, opts = {}) {
  const path = join(OUT, name)
  await page.screenshot({ path, ...opts })
  shots.push({ name, path })
  return path
}

async function shotEl(page, selector, name, opts = {}) {
  const path = join(OUT, name)
  await page.locator(selector).screenshot({ path, ...opts })
  shots.push({ name, path })
  return path
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------------------------------------------------- 工作台 */
async function measureWorkbench(page) {
  return page.evaluate(() => {
    const $ = (s) => document.querySelector(s)
    const doc = document.documentElement
    const app = $('#app')
    const phone = $('#phone')
    const stream = $('#stream')
    const statusbar = $('#statusbar')
    const statusText = $('#statusText')
    const tabs = Array.from(document.querySelectorAll('.tab'))
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }
    const bottomRows = Array.from(document.querySelectorAll('#stream .msg, #stream .sys, #stream .tool-row'))
    const last = bottomRows.length ? bottomRows[bottomRows.length - 1] : null
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      page: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, scrollHeight: doc.scrollHeight },
      app: { scrollWidth: app.scrollWidth, clientWidth: app.clientWidth, clientHeight: app.clientHeight },
      phone: rect(phone),
      stream: { w: Math.round(stream.clientWidth), h: Math.round(stream.clientHeight), scrollWidth: stream.scrollWidth, scrollHeight: stream.scrollHeight, scrollTop: Math.round(stream.scrollTop) },
      status: {
        w: Math.round(statusbar.clientWidth), scrollWidth: statusbar.scrollWidth,
        textW: Math.round(statusText.clientWidth), textScrollWidth: statusText.scrollWidth,
        textH: Math.round(statusText.getBoundingClientRect().height),
        singleLine: statusText.scrollWidth <= statusText.clientWidth + 1 && statusText.getBoundingClientRect().height <= 20,
        text: statusText.textContent,
      },
      tabs: tabs.map((t) => ({ text: t.textContent, ...rect(t), overflow: t.scrollWidth > t.clientWidth + 1 })),
      targets: ['#backBtn', '#refreshBtn', '#projectBtn'].map((s) => ({ selector: s, ...rect($(s)) })),
      lastRowVisible: last ? last.getBoundingClientRect().bottom <= statusbar.getBoundingClientRect().top + 2 : true,
      pageOverflow: doc.scrollWidth > doc.clientWidth + 1,
      appOverflow: app.scrollWidth > app.clientWidth + 1,
    }
  })
}

async function runWorkbench(browser) {
  const result = { widths: {}, interaction: {} }

  for (const width of [375, 390, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push('[console] ' + msg.text()) })
    await page.goto(toUrl(WORKBENCH), { waitUntil: 'load' })
    await sleep(350)
    const m = await measureWorkbench(page)
    result.widths[width] = m
    report.screens[`workbench-${width}`] = { width, metrics: m, errors }

    await shotEl(page, '#phone', `workbench-${width}.png`)
    if (width === 390) await shot(page, 'workbench-390-page.png', { fullPage: true })

    check(`workbench-${width}: 页面无横向溢出`, !m.pageOverflow, m.page)
    check(`workbench-${width}: 工作台无横向溢出`, !m.appOverflow, m.app)
    check(`workbench-${width}: 手机宽 = ${width}`, Math.abs(m.phone.w - width) <= 1, m.phone)
    check(`workbench-${width}: 群聊宽≥280 高≥300`, m.stream.w >= 280 && m.stream.h >= 300, { w: m.stream.w, h: m.stream.h })
    check(`workbench-${width}: 状态条单行不竖排`, m.status.singleLine, m.status)
    check(`workbench-${width}: 四段 tab 不换行`, m.tabs.every((t) => !t.overflow), m.tabs)
    check(`workbench-${width}: 顶栏热区≥40`, m.targets.every((t) => t.w >= 40 && t.h >= 40), m.targets)
    check(`workbench-${width}: tab 高≥40`, m.tabs.every((t) => t.h >= 40), m.tabs.map((t) => t.h))
    check(`workbench-${width}: 默认贴底且最后一条不被状态条遮挡`, m.stream.scrollTop + m.stream.h >= m.stream.scrollHeight - 2 && m.lastRowVisible, { scrollTop: m.stream.scrollTop, streamH: m.stream.h, scrollH: m.stream.scrollHeight })
    check(`workbench-${width}: 无页面错误`, errors.length === 0, errors)
    await page.close()
  }

  /* 交互：tab、抽屉、状态条、浅色 */
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  await page.goto(toUrl(WORKBENCH), { waitUntil: 'load' })
  await sleep(350)

  for (const tab of ['gates', 'tasks', 'members']) {
    await page.click(`.tab[data-view="${tab}"]`)
    await sleep(120)
    const info = await page.evaluate(() => {
      const view = Array.from(document.querySelectorAll('.view')).find((v) => !v.hidden)
      const scroll = view ? view.querySelector('.view-scroll') : null
      return {
        visible: view ? view.getAttribute('data-view') : null,
        selected: document.querySelector('.tab[aria-selected="true"]').getAttribute('data-view'),
        viewScrollWidth: scroll ? scroll.scrollWidth : null,
        viewClientWidth: scroll ? scroll.clientWidth : null,
      }
    })
    result.interaction[tab] = info
    await shotEl(page, '#phone', `workbench-390-tab-${tab}.png`)
    check(`workbench tab=${tab}: 视图可见且选中`, info.visible === tab && info.selected === tab, info)
    check(`workbench tab=${tab}: 视图无横向溢出`, info.viewScrollWidth <= info.viewClientWidth + 1, info)
  }

  await page.click('.tab[data-view="chat"]')
  await sleep(150)

  /* 抽屉：打开、遮罩不切换、选中项切换 */
  await page.click('#projectBtn')
  await sleep(260)
  const drawerOpen = await page.evaluate(() => {
    const layer = document.getElementById('drawerLayer')
    const sheet = document.getElementById('drawerSheet')
    return {
      hidden: layer.hidden,
      open: layer.getAttribute('data-open'),
      sheetVisible: sheet.getBoundingClientRect().height > 100,
      expanded: document.getElementById('projectBtn').getAttribute('aria-expanded'),
    }
  })
  result.interaction.drawerOpen = drawerOpen
  await shotEl(page, '#phone', 'workbench-390-drawer.png')
  check('项目抽屉：打开且不裁切', drawerOpen.hidden === false && drawerOpen.sheetVisible && drawerOpen.expanded === 'true', drawerOpen)

  await page.click('#drawerMask')
  await sleep(260)
  const maskClose = await page.evaluate(() => ({
    hidden: document.getElementById('drawerLayer').hidden,
    title: document.getElementById('projectName').textContent,
    expanded: document.getElementById('projectBtn').getAttribute('aria-expanded'),
  }))
  check('项目抽屉：点遮罩关闭且不切换', maskClose.hidden === true && maskClose.title === '移动端 UI 重设计' && maskClose.expanded === 'false', maskClose)

  await page.click('#projectBtn')
  await sleep(260)
  await page.click('.project-item[data-project="支付流程重构"]')
  await sleep(260)
  const switched = await page.evaluate(() => ({
    hidden: document.getElementById('drawerLayer').hidden,
    title: document.getElementById('projectName').textContent,
    current: document.querySelector('.project-item.current .pi-name span').textContent,
  }))
  check('项目抽屉：选中项目后关闭并高亮', switched.hidden === true && switched.title === '支付流程重构' && switched.current === '支付流程重构', switched)

  await page.click('#resetDemo')
  await sleep(500)
  const afterReset = await page.evaluate(() => ({
    title: document.getElementById('projectName').textContent,
    theme: document.documentElement.getAttribute('data-theme'),
    status: document.getElementById('statusText').textContent,
    tab: document.querySelector('.tab[aria-selected="true"]').getAttribute('data-view'),
  }))
  check('重置演示状态', afterReset.title === '移动端 UI 重设计' && afterReset.theme === 'dark' && afterReset.tab === 'chat', afterReset)

  /* 上滑加载三态 */
  await page.click('#topDemo')
  await sleep(120)
  const loadingState = await page.evaluate(() => ({
    text: document.getElementById('statusText').textContent,
    single: document.getElementById('statusText').scrollWidth <= document.getElementById('statusText').clientWidth + 1,
  }))
  await sleep(1000)
  const earliestState = await page.evaluate(() => ({
    text: document.getElementById('statusText').textContent,
    single: document.getElementById('statusText').scrollWidth <= document.getElementById('statusText').clientWidth + 1,
    top: Math.round(document.getElementById('stream').scrollTop),
  }))
  result.interaction.loadOlder = { loadingState, earliestState }
  check('状态条：加载中单行', /正在加载更早消息/.test(loadingState.text) && loadingState.single, loadingState)
  check('状态条：已到最早单行', /已到当前会话窗口最早处/.test(earliestState.text) && earliestState.single, earliestState)

  /* 浅色：先重置演示状态（回底部 + hasMore），清掉 toast，再切浅色 */
  await page.click('#resetDemo')
  await sleep(550)
  await page.evaluate(() => { document.getElementById('toast').removeAttribute('data-show') })
  await page.click('#themeBtn')
  await sleep(250)
  await page.evaluate(() => {
    document.getElementById('toast').removeAttribute('data-show')
    const stream = document.getElementById('stream')
    stream.scrollTop = stream.scrollHeight
  })
  await sleep(180)
  const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.getElementById('stream')).color,
    docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    status: document.getElementById('statusText').textContent,
    single: document.getElementById('statusText').scrollWidth <= document.getElementById('statusText').clientWidth + 1,
  }))
  await shotEl(page, '#phone', 'workbench-390-light.png')
  result.interaction.light = light
  check('浅色可切换且无横向溢出', light.theme === 'light' && !light.docOverflow, light)
  await page.close()

  /* 桌面 1280 */
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await desk.goto(toUrl(WORKBENCH), { waitUntil: 'load' })
  await sleep(400)
  const deskInfo = await desk.evaluate(() => {
    const wrap = document.getElementById('deskWrap')
    const frame = document.getElementById('deskFrame')
    const r = frame.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    return {
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      wrap: { w: Math.round(w.width), h: Math.round(w.height) },
      frameVisual: { w: Math.round(r.width), h: Math.round(r.height) },
      scale: r.width / 1280,
    }
  })
  await shot(desk, 'workbench-1280-page.png', { fullPage: true })
  result.desktop = deskInfo
  check('桌面 1280：三栏缩略等比缩放且页面无横向溢出', !deskInfo.pageOverflow && deskInfo.frameVisual.w <= deskInfo.wrap.w + 2 && deskInfo.scale > 0.5, deskInfo)
  await desk.close()

  report.screens['workbench-interaction'] = { result, errors }
  return result
}

/* ---------------------------------------------------------------- 样式对照 */
async function measureConversation(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const panes = Array.from(document.querySelectorAll('.pane'))
    const bodies = Array.from(document.querySelectorAll('.member-body'))
    const annos = Array.from(document.querySelectorAll('.anno'))
    const pres = Array.from(document.querySelectorAll('.md pre'))
    // 无竖排判定：正文段落宽度足够，且每行至少 6 个字符（逐字竖排 ≈ 1 字/行）
    const textBlocks = Array.from(document.querySelectorAll('.member-body p, .member-body li, .member-body blockquote, .streaming-text'))
      .filter((el) => !el.closest('pre'))
      .map((el) => {
        const r = el.getBoundingClientRect()
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 24
        const lines = Math.max(1, Math.round(r.height / lh))
        const chars = el.textContent.replace(/\s/g, '').length
        return { w: Math.round(r.width), lines, chars, charsPerLine: Math.round((chars / lines) * 10) / 10 }
      })
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      page: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
      panes: panes.map((p) => ({ cls: p.className, ...rect(p) })),
      bodies: bodies.map((b) => rect(b)),
      textBlocks,
      annos: annos.map((a) => ({ ...rect(a), overflow: a.scrollWidth > a.clientWidth + 1 })),
      preOverflowContained: pres.every((pre) => pre.scrollWidth >= pre.clientWidth),
      pageOverflow: doc.scrollWidth > doc.clientWidth + 1,
      theme: doc.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
    }
  })
}

async function runConversation(browser) {
  const result = { widths: {}, checks: {} }
  for (const width of [375, 390, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push('[console] ' + msg.text()) })
    await page.goto(toUrl(CONVERSATION), { waitUntil: 'load' })
    await sleep(300)
    const m = await measureConversation(page)
    result.widths[width] = m
    report.screens[`conversation-${width}`] = { width, metrics: m, errors }
    await shot(page, `conversation-${width}.png`, { fullPage: true })
    if (width === 390) {
      await shotEl(page, '.pane.old', 'conversation-390-old-pane.png')
      await shotEl(page, '.pane.new', 'conversation-390-new-pane.png')
      await shotEl(page, 'section#spec-title', 'conversation-390-spec.png')
      await shotEl(page, 'section.section:has(#token-title)', 'conversation-390-token.png')
      await shotEl(page, 'section.section:has(#css-title)', 'conversation-390-snippets.png')
      await shotEl(page, 'section.section:has(#diff-title)', 'conversation-390-diff.png')
      await page.click('#annoBtn')
      await sleep(120)
      await shotEl(page, '.pane.new', 'conversation-390-new-clean.png')
      await page.click('#annoBtn')
      await sleep(120)
    }
    check(`conversation-${width}: 页面无横向溢出`, !m.pageOverflow, m.page)
    check(`conversation-${width}: 对照栏纵向堆叠（窄屏）`, m.panes.length === 2 && m.panes[0].w <= m.page.clientWidth, m.panes)
    check(`conversation-${width}: 正文宽≥200 不竖排`, m.bodies.every((b) => b.w >= 200) && m.textBlocks.every((b) => b.w >= 200 && b.charsPerLine >= 6), m.textBlocks)
    check(`conversation-${width}: 标注不横向溢出`, m.annos.every((a) => !a.overflow), m.annos.filter((a) => a.overflow))
    check(`conversation-${width}: 无页面错误`, errors.length === 0, errors)
    if (width === 390) {
      await page.evaluate(() => { document.body.removeAttribute('data-anno') })
      await page.click('#themeBtn')
      await sleep(200)
      const light = await measureConversation(page)
      await shot(page, 'conversation-390-light.png', { fullPage: true })
      result.light = light
      check('conversation 浅色：可切换且无横向溢出', light.theme === 'light' && !light.pageOverflow, { theme: light.theme, overflow: light.pageOverflow, bg: light.bg })
    }
    await page.close()
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
  await page.goto(toUrl(CONVERSATION), { waitUntil: 'load' })
  await sleep(300)
  const m = await measureConversation(page)
  await shot(page, 'conversation-1280.png', { fullPage: true })
  result.wide = m
  check('conversation-1280: 左右两栏并排', m.panes.length === 2 && Math.abs(m.panes[0].y - m.panes[1].y) <= 2 && m.panes[0].x < m.panes[1].x, m.panes)
  check('conversation-1280: 页面无横向溢出', !m.pageOverflow, m.page)
  check('conversation-1280: 无页面错误', errors.length === 0, errors)
  await page.close()
  report.screens['conversation-wide'] = { metrics: m, errors }
  return result
}

/* ---------------------------------------------------------------- main */
let browser
try {
  browser = await chromium.launch({ headless: true })
  report.workbench = await runWorkbench(browser)
  report.conversation = await runConversation(browser)
} catch (error) {
  report.fatal = String(error && error.stack ? error.stack : error)
  if (!jsonOnly) console.error('FATAL', report.fatal)
} finally {
  if (browser) await browser.close()
}

const failed = report.checks.filter((c) => !c.ok)
report.ok = !report.fatal && failed.length === 0
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')

if (jsonOnly) {
  console.log(JSON.stringify({ ok: report.ok, failed, shots: shots.map((s) => s.name), fatal: report.fatal || null }, null, 2))
} else {
  console.log('\n' + (report.ok ? `RESULT: PASS — ${report.checks.length} 项检查全绿` : `RESULT: FAIL — ${failed.length}/${report.checks.length} 项失败`))
  console.log('截图：' + shots.map((s) => s.name).join(', '))
  console.log('报告：design/verify/report.json')
}
process.exit(report.ok ? 0 : 1)
