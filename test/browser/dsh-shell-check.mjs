#!/usr/bin/env node
/**
 * DevBot v0.5 真实 DSH 外壳验收（可选，需本机 `dsh web` 正在运行）。
 *
 * 与 workbench-visual.mjs 的 fake sessions 不同：这里连真实 DSH Web，
 * 用 token URL 建立会话，点侧栏 DevBot，在真实外壳（左侧栏/主栏宽度）里量
 * 容器断点、三栏/单栏、chat 宽高、状态条单行、页面横向溢出与首屏贴底。
 *
 * 用法：
 *   # token URL 在 `dsh web` 启动日志里（或 ~/Library/Logs/dsh-web.log 最后一行）
 *   DSH_WEB_URL='http://127.0.0.1:3080/?token=...' node test/browser/dsh-shell-check.mjs
 *   # 或只给 token：
 *   DSH_WEB_URL=http://127.0.0.1:3080 DSH_TOKEN=... node test/browser/dsh-shell-check.mjs
 *
 * 产物：test/browser/out/v0.5/real-shell-{1280,390,430}.png + real-shell.json
 * 退出码：0 = 检查通过；1 = 有失败或拿不到真实外壳。
 *
 * 注意：token 会随 dsh web 重启轮换；本脚本不保存 token，只读环境变量。
 * 真机 safe-area / iOS 100vh 不在本脚本能力内（仍待用户真机）。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH = process.env.DSH_CHECKOUT
if (!DSH) {
  console.error('需要 DSH_CHECKOUT 环境变量指向 deepseek-harness checkout（浏览器回归依赖其 node_modules/Playwright）')
  process.exit(1)
}
const PNPM_DIR = `${DSH}/node_modules/.pnpm`
function pnpmPackage(name) {
  const names = readdirSync(PNPM_DIR).filter((n) => n.startsWith(name + '@'))
  const stable = names.filter((n) => !/(alpha|beta|rc)/i.test(n))
  const pool = (stable.length > 0 ? stable : names).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  if (pool.length === 0) throw new Error(`找不到 ${name} 于 ${PNPM_DIR}`)
  return `${PNPM_DIR}/${pool[0]}/node_modules/${name}`
}
const { chromium } = await import(`${pnpmPackage('playwright')}/index.mjs`)

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const OUT = join(ROOT, 'test', 'browser', 'out', 'v0.5')
mkdirSync(OUT, { recursive: true })

const base = process.env.DSH_WEB_URL
if (!base) {
  console.error('缺少 DSH_WEB_URL（例：http://127.0.0.1:3080/?token=...）；真实外壳验证跳过。')
  process.exit(1)
}
const url = process.env.DSH_TOKEN && !/[?&]token=/.test(base)
  ? `${base}${base.includes('?') ? '&' : '?'}token=${process.env.DSH_TOKEN}`
  : base

const checks = []
const record = (id, ok, detail) => {
  checks.push({ id, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('[console] ' + msg.text()) })

const metrics = () => page.evaluate(() => {
  const root = document.querySelector('.devbot-root,[data-testid="devbot-root"]')
  const chat = document.querySelector('[data-testid="chat-scroll"]')
  const status = document.querySelector('[data-testid="status-bar"]')
  const statusText = document.querySelector('.devbot-status-text')
  const tabs = Array.from(document.querySelectorAll('[data-testid^="tab-"]'))
    .filter((b) => b.getBoundingClientRect().width > 0)
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
  }
  const cs = status ? getComputedStyle(status) : null
  return {
    viewport: { w: innerWidth, h: innerHeight },
    page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    root: root ? Object.assign(rect(root), { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth }) : null,
    chat: chat ? Object.assign(rect(chat), {
      clientWidth: chat.clientWidth, clientHeight: chat.clientHeight,
      scrollWidth: chat.scrollWidth, scrollHeight: chat.scrollHeight, scrollTop: Math.round(chat.scrollTop),
      atBottom: chat.scrollHeight - chat.clientHeight - chat.scrollTop < 8,
    }) : null,
    status: status ? { rect: rect(status), text: (status.textContent || '').trim(), nowrap: cs.whiteSpace,
      scrollWidth: status.scrollWidth, clientWidth: status.clientWidth,
      textH: statusText ? Math.round(statusText.getBoundingClientRect().height) : null } : null,
    tabs: tabs.map((t) => ({ text: (t.textContent || '').trim(), rect: rect(t),
      selected: t.getAttribute('aria-selected') === 'true', view: t.getAttribute('data-view') })),
    teams: rect(document.querySelector('.devbot-teams')),
    side: rect(document.querySelector('.devbot-side')),
    rows: document.querySelectorAll('[data-kind]').length,
    text: (root ? root.innerText : '').slice(0, 300),
  }
})

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div'))
      .filter((el) => (el.textContent || '').trim() === 'DevBot' || el.getAttribute('aria-label') === 'DevBot')
    const el = candidates.find((e) => e.closest('button,[role="button"],a')) || candidates[0]
    const target = el && (el.closest('button,[role="button"],a') || el)
    if (target) { target.click(); return true }
    return false
  })
  record('真实外壳：侧栏 DevBot 入口可点开', clicked, { clicked })
  await page.waitForFunction(() => !!document.querySelector('.devbot-root,[data-testid="devbot-root"]'), null, { timeout: 10000 })
    .catch(() => {})
  // 等成员会话异步 open/首屏 settle（真实外壳里 7 个会话不是同一帧就绪）。
  await sleep(6000)

  for (const [width, height] of [[1280, 900], [390, 844], [430, 844]]) {
    await page.setViewportSize({ width, height })
    await sleep(1200)
    const m = await metrics()
    await page.screenshot({ path: join(OUT, `real-shell-${width}.png`) })
    const containerWidth = m.root ? m.root.clientWidth : 0
    const three = containerWidth >= 900
    const one = containerWidth < 560
    record(`真实外壳 ${width}: 工作台已挂载`, !!m.root, { containerWidth })
    record(`真实外壳 ${width}: 页面无横向溢出`, m.page.scrollWidth <= m.page.clientWidth + 1, m.page)
    record(`真实外壳 ${width}: chat 宽高>0`, !!m.chat && m.chat.clientWidth > 0 && m.chat.clientHeight > 0,
      m.chat ? { w: m.chat.clientWidth, h: m.chat.clientHeight } : null)
    record(`真实外壳 ${width}: 状态条单行`, !!m.status && m.status.nowrap === 'nowrap'
      && (!m.status.textH || m.status.textH <= 20), m.status)
    if (three) {
      record(`真实外壳 ${width}: ≥900 三栏（196/flex/252）`,
        !!m.teams && !!m.side && !!(m.chat && m.teams.x < m.chat.x && m.chat.x < m.side.x)
        && Math.abs(m.teams.w - 196) <= 2 && Math.abs(m.side.w - 252) <= 2,
        { teams: m.teams, side: m.side, chat: m.chat })
    } else if (one) {
      record(`真实外壳 ${width}: <560 单栏 + 四段 tab`,
        (!m.teams || m.teams.w === 0) && m.tabs.length === 4 && m.tabs.every((t) => t.rect.h >= 40) && m.tabs.every((t) => t.rect.w >= 40),
        { tabs: m.tabs.map((t) => ({ text: t.text, w: t.rect.w, h: t.rect.h })) })
    }
    if (width === 1280) record('真实外壳 1280: 首屏贴底（默认最新一条）', !!m.chat && m.chat.atBottom,
      { scrollTop: m.chat ? m.chat.scrollTop : null, max: m.chat ? m.chat.scrollHeight - m.chat.clientHeight : null })
    record(`真实外壳 ${width}: 无脚本错误`, errors.length === 0, errors.slice(0, 5))
  }
} catch (error) {
  record('真实外壳：可访问（未卡住/未跳登录）', false, String(error && error.message ? error.message : error))
} finally {
  await browser.close()
}

writeFileSync(join(OUT, 'real-shell.json'), JSON.stringify({ urlHost: new URL(url).host, checks, errors }, null, 2) + '\n')
const failed = checks.filter((c) => !c.ok)
console.log(failed.length === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL — ${failed.length}/${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
