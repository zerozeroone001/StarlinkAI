import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

if (!process.env.PLAYWRIGHT_PATH) throw new Error('Set PLAYWRIGHT_PATH to the installed Playwright package entry.')
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_PATH).href)
const buildRoot = path.resolve('.tmp/efficiency-ui-build')
const screenshots = path.resolve('.tmp/efficiency-ui-check')
await fs.mkdir(screenshots, { recursive: true })
await build({ configFile: 'scripts/chat-preview.vite.ts', build: { outDir: buildRoot, emptyOutDir: true,
  rollupOptions: { input: path.resolve('scripts/app-preview.html') } } })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  if (url.origin !== 'http://127.0.0.1:5194') return route.abort()
  const requested = decodeURIComponent(url.pathname)
  const icon = path.resolve('resources/icon.png')
  const file = requested === '/@fs/I:/code/python/grokDeskTop/resources/icon.png' ? icon : path.resolve(buildRoot, `.${requested}`)
  if (file !== icon && !file.startsWith(buildRoot + path.sep)) return route.abort()
  const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream'
  try { await route.fulfill({ status: 200, body: await fs.readFile(file), contentType }) }
  catch { await route.fulfill({ status: 404, body: '' }) }
})
try {
  await page.goto('http://127.0.0.1:5194/app-preview.html')
  await page.getByRole('textbox', { name: '对话消息', exact: true }).fill('执行统计回归')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByText('执行统计', { exact: true }).waitFor()
  assert.equal(await page.locator('.run-metrics').getAttribute('open'), null)
  await page.getByText('执行统计', { exact: true }).click()
  const panel = page.locator('.run-metrics')
  await panel.getByText('等待确认（累计）', { exact: true }).waitFor()
  assert.equal(await panel.locator('dt').count(), 10)
  assert.match(await panel.innerText(), /12,345/)
  for (const [width, height] of [[1440, 960], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height })
    const bounds = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, width: innerWidth, scroll: element.scrollWidth, client: element.clientWidth,
        clipped: [...element.querySelectorAll('dt,dd,summary')].filter((child) => {
          const rect = child.getBoundingClientRect()
          return rect.left < box.left - 1 || rect.right > box.right + 1
        }).length }
    })
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, JSON.stringify(bounds))
    assert.ok(bounds.scroll <= bounds.client + 1 && bounds.clipped === 0, JSON.stringify(bounds))
    const title = await page.locator('.workspace-titlebar').evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight }))
    assert.ok(title.scroll <= title.height + 1, JSON.stringify(title))
    await page.screenshot({ path: path.join(screenshots, `metrics-${width}.png`), fullPage: true })
    console.log(`PASS execution metrics ${width}x${height}`)
  }
  await panel.locator('summary').focus()
  await page.keyboard.press('Enter')
  assert.equal(await panel.getAttribute('open'), null)
  await page.getByRole('button', { name: '展开项目导航', exact: true }).click()
  await page.getByRole('button', { name: '收起项目导航', exact: true }).click()
  assert.deepEqual(errors, [])
  console.log('PASS metrics keyboard toggle and zero page errors; providers are mocked')
} finally { await browser.close() }
