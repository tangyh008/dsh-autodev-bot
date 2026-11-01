#!/usr/bin/env node
/**
 * DevBot v0.5.3 真实 DSH 模式选择器回归（可选，需本机 `dsh web` 正在运行）。
 *
 * 需求：pm / designer / fullstack / tester 四个队友角色 preset 不再出现在
 * 模式选择器里；DevBot Lead 与 DSH 内置模式保留。
 *
 * 做法：连真实 DSH Web（token URL），在「新会话」页点开模式选择器，断言
 *   - 列表只有 5 项：标准 / PTC / 极简 / 创造 / DevBot Lead；
 *   - 4 个队友角色（DevBot PM / Designer / Fullstack / Tester）一项都没有；
 *   - 选择器仍可正常打开/关闭，且无脚本错误。
 * 数据全部来自真实渲染（不 mock roster），因此同时验证「Host 仍返回 9 个
 * preset、浏览器端只过滤展示」不会把选择器弄坏。
 *
 * 用法：
 *   DSH_WEB_URL='http://127.0.0.1:3080/?token=...' node test/browser/preset-picker.mjs
 *   DSH_WEB_URL=http://127.0.0.1:3080 DSH_TOKEN=... node test/browser/preset-picker.mjs
 *
 * 产物：test/browser/out/v0.5.3/preset-picker-hidden.png + preset-picker.json
 * 退出码：0 = 全绿；1 = 断言失败或页面打不开。
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH = process.env.DSH_CHECKOUT
if (!DSH) {
  console.error('需要 DSH_CHECKOUT 环境变量指向 deepseek-harness checkout（浏览器回归依赖其 node_modules/Playwright）')
  process.exit(1)
}
const PNPM_DIR = `${DSH}/node_modules/.pnpm`

/** 在 DSH checkout 的 pnpm store 里找包目录（优先稳定版）。 */
function pnpmPackage(name) {
  const names = readdirSync(PNPM_DIR).filter((n) => n.startsWith(name + '@'))
  const stable = names.filter((n) => !/(alpha|beta|rc)/i.test(n))
  const pool = (stable.length > 0 ? stable : names)
    .slice()
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  if (pool.length === 0) throw new Error(`找不到 ${name} 于 ${PNPM_DIR}`)
  return `${PNPM_DIR}/${pool[0]}/node_modules/${name}`
}
const { chromium } = await import(`${pnpmPackage('playwright')}/index.mjs`)

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const OUT = join(ROOT, 'test', 'browser', 'out', 'v0.5.3')
mkdirSync(OUT, { recursive: true })

const base = process.env.DSH_WEB_URL
if (!base) {
  console.error('缺少 DSH_WEB_URL（例：http://127.0.0.1:3080/?token=...）；模式选择器回归跳过。')
  process.exit(1)
}
const url = process.env.DSH_TOKEN && !/[?&]token=/.test(base)
  ? `${base}${base.includes('?') ? '&' : '?'}token=${process.env.DSH_TOKEN}`
  : base

const HIDDEN_ROLES = ['DevBot PM', 'DevBot Designer', 'DevBot Fullstack', 'DevBot Tester']
const EXPECTED_VISIBLE = ['标准模式', 'PTC 模式', '极简模式', '创造模式', 'DevBot Lead']

const checks = []
const record = (id, ok, detail) => {
  checks.push({ id, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
const errors = []
page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)))
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('[console] ' + msg.text()) })

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // 新会话页的 hero 区要等 client 插件装载 + roster 读取完成。
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
    .some((b) => /_seat/.test(String(b.className || ''))), null, { timeout: 15000 })
  await page.waitForTimeout(1200)

  // 打开模式选择器（hero 区的 preset chip）。
  const seatText = await page.evaluate(() => {
    const seat = Array.from(document.querySelectorAll('button')).find((b) => /_seat/.test(String(b.className || '')))
    if (!seat) return null
    const text = (seat.textContent || '').trim()
    seat.click()
    return text
  })
  await page.waitForSelector('[role="menu"]', { timeout: 5000 })
  await page.waitForTimeout(300)

  const menuTexts = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
    .map((el) => (el.textContent || '').trim()))
  const menuShown = menuTexts.length > 0
  record('模式选择器可打开', menuShown, { seat: seatText, items: menuTexts.length })

  const lacksHidden = HIDDEN_ROLES.every((role) => !menuTexts.some((text) => text.startsWith(role)))
  record('4 个队友角色 preset 不出现在选择器', lacksHidden,
    HIDDEN_ROLES.map((role) => ({ role, found: menuTexts.some((text) => text.startsWith(role)) })))

  const visible = EXPECTED_VISIBLE.filter((name) => menuTexts.some((text) => text.startsWith(name)))
  record('内置模式 + DevBot Lead 仍在选择器里', visible.length === EXPECTED_VISIBLE.length && menuTexts.length === EXPECTED_VISIBLE.length,
    { expected: EXPECTED_VISIBLE, found: visible, total: menuTexts.length })

  await page.screenshot({ path: join(OUT, 'preset-picker-hidden.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const closed = await page.evaluate(() => document.querySelector('[role="menu"]') === null)
  record('选择器可正常关闭', closed)
  record('无脚本错误', errors.length === 0, errors.slice(0, 5))
} catch (error) {
  record('模式选择器回归可执行', false, String(error && error.message ? error.message : error))
  try { await page.screenshot({ path: join(OUT, 'preset-picker-failure.png') }) } catch (ignored) { /* ignore */ }
} finally {
  await browser.close()
}

writeFileSync(join(OUT, 'preset-picker.json'), JSON.stringify({
  urlHost: new URL(url).host, checks, errors,
}, null, 2) + '\n')
const failed = checks.filter((c) => !c.ok)
console.log(failed.length === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL — ${failed.length}/${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
