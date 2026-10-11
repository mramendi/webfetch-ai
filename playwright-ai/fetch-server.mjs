// playwright-ai fetch service — POST /fetch {url, timeout_ms?} ->
//   {status, finalUrl, title, markdown, textLen, ms}  |  {error, ms}
// GET /healthz -> {ok, active, queue}
//
// Resilience tricks carried over from misha-llm-tools smart_scrape.py:
// real Chrome UA (Headless stripped), stealth init patches, two-phase waits
// (domcontentloaded -> body -> networkidle). Additions: lazy-load scroll
// loop, resource blocking (image/media/font), readability main-content
// extraction with whole-document fallback, concurrency semaphore.
import http from "node:http"
import { chromium } from "playwright"
import { JSDOM } from "jsdom"
import { Readability } from "@mozilla/readability"
import { NodeHtmlMarkdown } from "node-html-markdown"

const PORT = 8080
const MAX_CONCURRENCY = 2
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_RESPONSE_CHARS = 400_000

let browser = null
let browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

async function launch() {
  browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  })
  // playwright's default UA advertises "HeadlessChrome" — strip the tell.
  const ua = await browser.userAgent()
  if (ua) browserUA = ua.replace("HeadlessChrome/", "Chrome/")
  console.log(`fetch-server: browser ready, UA=${browserUA}`)
}

const STEALTH_INIT = `
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(Navigator.prototype, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`

// ---- concurrency semaphore ------------------------------------------------
let active = 0
const queue = []
async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active++
    return
  }
  await new Promise((resolve) => queue.push(resolve))
  active++
}
function release() {
  active--
  const next = queue.shift()
  if (next) next()
}

// ---- extraction ------------------------------------------------------------
function extract(html, finalUrl) {
  let doc = null
  try {
    doc = new JSDOM(html, { url: finalUrl })
  } catch {
    doc = null
  }
  let contentHtml = html
  let textLen = 0
  if (doc) {
    try {
      const article = new Readability(doc.window.document.cloneNode(true)).parse()
      const articleText = (article?.textContent || "").replace(/\s+/g, " ").trim()
      const bodyText = (doc.window.document.body?.textContent || "").replace(/\s+/g, " ").trim()
      textLen = articleText.length || bodyText.length
      // recall-first: fall back to the whole document when readability
      // finds nothing substantial (same favor_recall spirit as smart_scrape).
      if (article?.content && articleText.length >= 300) contentHtml = article.content
    } catch {
      /* keep whole-document html */
    }
    try {
      doc.window.close()
    } catch {
      /* ignore */
    }
  } else {
    textLen = html.length
  }
  let markdown = NodeHtmlMarkdown.translate(contentHtml, { bulletMarker: "-" })
  if (markdown.length > MAX_RESPONSE_CHARS) markdown = markdown.slice(0, MAX_RESPONSE_CHARS) + "\n\n[truncated]"
  return { markdown, textLen }
}

// ---- page fetch ------------------------------------------------------------
async function fetchUrl(url, timeoutMs) {
  const ctx = await browser.newContext({
    userAgent: browserUA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  })
  try {
    await ctx.addInitScript(STEALTH_INIT)
    const page = await ctx.newPage()
    await page.route("**/*", (route) => {
      const type = route.request().resourceType()
      if (type === "image" || type === "media" || type === "font") {
        route.abort().catch(() => {})
        return
      }
      route.continue().catch(() => {})
    })

    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    const status = resp ? resp.status() : 0

    await page.waitForSelector("body", { timeout: Math.min(8000, timeoutMs) }).catch(() => {})
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(9000, Math.max(2000, timeoutMs - 8000)) })
      .catch(() => {})

    // lazy-load: scroll toward the bottom in small steps (bounded)
    await page
      .evaluate(
        () =>
          new Promise((resolve) => {
            let total = 0
            const step = () => {
              window.scrollBy(0, 900)
              total += 900
              const bottom = document.documentElement.scrollHeight - window.innerHeight - 200
              if (total >= 7000 || window.scrollY >= bottom) return resolve()
              setTimeout(step, 130)
            }
            step()
            setTimeout(resolve, 3500)
          }),
      )
      .catch(() => {})
    await page.waitForTimeout(300)

    const html = await page.content()
    const finalUrl = page.url()
    const title = (await page.title().catch(() => "")) || ""
    await ctx.close().catch(() => {})
    return { status, finalUrl, title, ...extract(html, finalUrl) }
  } catch (e) {
    await ctx.close().catch(() => {})
    throw e
  }
}

// ---- http server -----------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/healthz")) {
    const ok = !!(browser && browser.isConnected())
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok, active, queue: queue.length }))
    return
  }
  if (req.method !== "POST" || !req.url?.startsWith("/fetch")) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "POST /fetch {url, timeout_ms?} or GET /healthz" }))
    return
  }
  let body = ""
  let oversized = false
  req.on("data", (chunk) => {
    body += chunk
    if (body.length > 100_000) {
      oversized = true
      req.destroy()
    }
  })
  req.on("end", async () => {
    if (oversized) return
    let input
    try {
      input = JSON.parse(body)
    } catch {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid JSON" }))
      return
    }
    const url = input?.url
    if (!/^https?:\/\//i.test(url || "")) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "url must be http(s)" }))
      return
    }
    const timeoutMs = Math.min(60_000, Math.max(5_000, Number(input?.timeout_ms) || DEFAULT_TIMEOUT_MS))
    await acquire()
    const t0 = Date.now()
    try {
      const result = await fetchUrl(url, timeoutMs)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ...result, ms: Date.now() - t0 }))
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(e).slice(0, 500), ms: Date.now() - t0 }))
    } finally {
      release()
    }
  })
})
server.requestTimeout = 90_000
server.headersTimeout = 95_000

await launch()
server.listen(PORT, "0.0.0.0", () => console.log(`fetch-server: listening on :${PORT}`))
