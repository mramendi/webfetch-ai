// webfetch-ai — layered web fetching for OpenCode (v2.0.26).
// SPDX-License-Identifier: Unlicense
//
// Registers a tool named `webfetch` that REPLACES the built-in (verified:
// user plugins activate after internal tools; Editor.add is Map.set).
//
// Chain:
//   special paths  → GitHub URL algebra (raw/API, no auth) | Reddit → Apify → Exa
//   L0 plain fetch → deterministic quality gate (no LLM in the loop)
//   L1 playwright-ai container (stealth chromium render, local :8899)
//   L2 Exa /contents ($1/1k pages, free-tier credits; live crawl)
//
// Diagnostics: JSONL per-attempt log ~/.local/share/opencode/webfetch-cycle.log
// Env overrides: WEBFETCH_PLAYWRIGHT_URL, WEBFETCH_LOG_FILE, WEBFETCH_EXA_MAX_PAGES
//
// Zero npm imports at module top: node-html-markdown is loaded lazily via
// createRequire(../node_modules) so a missing vendor tree degrades to text
// instead of killing the whole plugin.

import { appendFileSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import path from "node:path"

// ---------------------------------------------------------------- constants

const HOME = homedir()
const LOG_FILE = process.env.WEBFETCH_LOG_FILE || path.join(HOME, ".local/share/opencode/webfetch-cycle.log")
const PLAYWRIGHT_URL = process.env.WEBFETCH_PLAYWRIGHT_URL || "http://127.0.0.1:8899/fetch"
const EXA_CONTENTS_URL = "https://api.exa.ai/contents"
const MAX_CHARS = 400_000
const MIN_TEXT_HTML = 120
const MIN_TEXT_PLAIN = 50

// node-html-markdown's translate() is superlinear on tag-soup inputs (measured
// 2026-10-26: 100KB→165ms; a 1.1MB JSON with pseudo-HTML token strings → >30s,
// never finished). translate() is synchronous, so a hang of that scale freezes
// the whole OpenCode serve process — the client watchdog then kills and
// respawns it. Two guards: never feed NON-markup bodies to the converter at
// all, and bound the converter's input size (oversize degrades to text
// extraction, which is linear and bounded).
const NHM_MAX_INPUT = 262_144 // 256KB

// Chrome-family UA without any bot tell (plain fetch layer only; L1 has its own).
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// deterministic challenge/bot-wall markers, checked on the first 4KB of body text
const CHALLENGE_MARKERS = [
  "just a moment",
  "attention required",
  "cf-chl",
  "checking your browser",
  "checking if the site connection is secure",
  "enable javascript and cookies to continue",
  "datadome",
  "incapsula",
  "px-captcha",
  "captcha-delivery",
  "perimeterx",
  "request unsuccessful. incapsula",
  "verify you are a human",
  "access denied",
]

// ---------------------------------------------------------------- diagnostics

function fileLog(entry) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
  } catch {
    /* diagnostics must never break the fetch */
  }
}

// ---------------------------------------------------------------- html utils

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed",
  "svg", "canvas", "link", "meta", "head",
])

function stripHtmlToText(html) {
  let out = ""
  let i = 0
  const n = html.length
  // stack-based skip: a <style> inside <head> must not be un-skipped by a
  // stray </head> before its own closer (attribute values may contain ">").
  // Void elements never get closing tags; a push-based stack would never pop
  // them. Only push tags that have real closers; void and self-closed tags
  // just toggle nothing.
  const VOID_TAGS = new Set([
    "meta", "link", "br", "hr", "img", "input", "source", "wbr", "col", "area", "base", "embed", "track", "param",
  ])
  const skipStack = []
  while (i < n) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i)
      if (close === -1) break
      const rawTag = html.slice(i + 1, close)
      if (rawTag.startsWith("/")) {
        const name = rawTag.slice(1).trim().toLowerCase().split(/\s/)[0]
        if (skipStack[skipStack.length - 1] === name) skipStack.pop()
      } else if (!rawTag.startsWith("!") && !rawTag.endsWith("/")) {
        const name = rawTag.trim().toLowerCase().split(/[\s/]/)[0]
        if (SKIP_TAGS.has(name) && !VOID_TAGS.has(name)) skipStack.push(name)
        if (/^(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|table)$/.test(name)) out += "\n"
      }
      i = close + 1
      continue
    }
    if (skipStack.length === 0) out += html[i]
    i++
  }
  return out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** markdown converter, lazily bound from the vendored tree; null = unavailable */
let nhm = undefined
function getConverter() {
  if (nhm !== undefined) return nhm
  try {
    const req = createRequire(path.join(HOME, ".config/opencode/plugins/webfetch-ai.ts"))
    const mod = req("node-html-markdown")
    nhm = mod.NodeHtmlMarkdown || mod.default?.NodeHtmlMarkdown || mod.default || mod
  } catch (error) {
    fileLog({ event: "converter_unavailable", error: String(error).slice(0, 160) })
    nhm = null
  }
  return nhm
}

function htmlToMarkdown(html) {
  const conv = getConverter()
  if (conv) {
    try {
      return conv.translate(html, { bulletMarker: "-" })
    } catch (error) {
      fileLog({ event: "converter_error", error: String(error).slice(0, 160) })
    }
  }
  return null
}

// ---------------------------------------------------------------- http helper

async function timedFetch(url, init, ms, outerSignal) {
  const signals = [AbortSignal.timeout(ms)]
  if (outerSignal) signals.push(outerSignal)
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  return fetch(url, { ...init, signal, redirect: "follow" })
}

// ---------------------------------------------------------------- L0 gate

function classifyBody(contentType, body) {
  const ct = (contentType || "").toLowerCase()
  const head = body.slice(0, 4096).toLowerCase()
  const challenge = CHALLENGE_MARKERS.some((m) => head.includes(m))
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml")
  const isPdf = ct.includes("application/pdf") || head.startsWith("%pdf-")
  const isXml = ct.includes("xml") || head.trimStart().startsWith("<?xml")
  const textual =
    ct.includes("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("javascript") ||
    ct === "" && !isPdf
  return { ct, isHtml, isXml, isPdf, textual, challenge }
}

function gateL0(status, contentType, body, elapsedMs) {
  if (status === 404 || status === 410) return { ok: false, terminal: true, reason: `http ${status} not found` }
  if (status >= 400) return { ok: false, reason: `http ${status}` }
  const k = classifyBody(contentType, body)
  if (k.isPdf) return { ok: false, reason: "pdf (needs L2)", pdf: true }
  if (!k.textual) return { ok: false, reason: `non-textual mime: ${k.ct || "unknown"}` }
  if (k.challenge) return { ok: false, reason: "challenge/bot-wall markers" }
  const text = k.isHtml ? stripHtmlToText(body) : body
  const min = k.isHtml ? MIN_TEXT_HTML : MIN_TEXT_PLAIN
  if (text.length < min) return { ok: false, reason: `visible text ${text.length} < ${min}` }
  if (k.isHtml && body.length > 20_000) {
    const ratio = text.length / body.length
    if (ratio < 0.02) return { ok: false, reason: `text/markup ratio ${(ratio * 100).toFixed(1)}% < 2%` }
  }
  return { ok: true, isHtml: k.isHtml, isXml: k.isXml, textLen: text.length, elapsedMs }
}

// ---------------------------------------------------------------- L0 fetch

async function fetchPlain(url, budgetMs, outerSignal) {
  const t0 = Date.now()
  const res = await timedFetch(
    url,
    {
      headers: {
        "user-agent": CHROME_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
    },
    budgetMs,
    outerSignal,
  )
  const contentType = res.headers.get("content-type") || ""
  const cfMitigated = res.headers.get("cf-mitigated") || ""
  if (cfMitigated === "challenge") {
    return { verdict: { ok: false, reason: "cf-mitigated challenge header" }, status: res.status, contentType }
  }
  const body = await res.text()
  const verdict = gateL0(res.status, contentType, body, Date.now() - t0)
  return { verdict, status: res.status, contentType, body }
}

// ---------------------------------------------------------------- L1 fetch

async function fetchPlaywright(url, budgetMs, outerSignal) {
  const t0 = Date.now()
  const res = await timedFetch(
    PLAYWRIGHT_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, timeout_ms: Math.min(60_000, Math.round(budgetMs * 1000)) }),
    },
    Math.round(budgetMs * 1000) + 5_000,
    outerSignal,
  )
  const data = await res.json()
  if (!res.ok) {
    return { ok: false, reason: `playwright-ai ${res.status}: ${String(data?.error || "").slice(0, 120)}` }
  }
  // The container returns {status, finalUrl, title, markdown, textLen, ms} —
  // it has no `ok` field; a 200 from the service IS the success signal.
  // (Missing this made every L1 success invisible: gate read l1.ok ===
  // undefined → always-false → successes were discarded and L2 re-fetched.)
  return { ok: true, ...data, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- L2 Exa

async function fetchExa(url, budgetMs, outerSignal, maxChars) {
  const key = process.env.EXA_API_KEY
  if (!key) return { ok: false, reason: "no EXA_API_KEY" }
  const t0 = Date.now()
  const res = await timedFetch(
    EXA_CONTENTS_URL,
    {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        urls: [url],
        text: { maxCharacters: Math.min(maxChars, 100_000) },
        // maxAgeHours forces a live crawl when the cache entry is older; fresh
        // cache still serves fast. (livecrawl option is deprecated and
        // mutually exclusive with this.)
        maxAgeHours: 24,
      }),
    },
    Math.round(budgetMs * 1000) + 5_000,
    outerSignal,
  )
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = data ? JSON.stringify(data).slice(0, 160) : res.statusText
    return { ok: false, reason: `exa ${res.status}: ${detail}` }
  }
  const first = data?.results?.[0]
  if (!first || !first.text) return { ok: false, reason: "exa: empty results" }
  return {
    ok: true,
    title: first.title || "",
    text: first.text,
    publishedDate: first.publishedDate || null,
    ms: Date.now() - t0,
  }
}

// ---------------------------------------------------------------- Reddit via Exa search cache

/**
 * Reddit direct fetch is dead (2026 lockdown), and keyed /contents returns
 * SOURCE_NOT_AVAILABLE for reddit URLs — but Exa still surfaces indexed
 * post text with highlights via the KEYLESS MCP search endpoint (mcp.exa.ai,
 * the same one search-cycle uses). Keyed /search with category "reddit" was
 * probed and does NOT return the reddit originals (its reddit index looks
 * gutted); the MCP endpoint demonstrably does. So: exact-URL /contents
 * first (works if Exa re-permits later), then MCP search-cache extraction.
 */
// ---------------------------------------------------------------- Reddit URL algebra

/**
 * Single source of truth for reddit URL shapes (thread / comment / share).
 *
 *   thread            /r/<sub>/comments/<id>[/slug]
 *   comment permalink /r/<sub>/comments/<id>/(<slug>|comment|_)/<commentId>
 *   share link        /s/<code> or /r/<sub>/s/<code>   (resolved by the actor)
 *
 * The literal "comment" or "_" segment is reddit's share-button placeholder
 * for a missing slug, NOT a slug — treating it as one broke both consumers
 * (2026-10-12): the Apify lane forwarded /comment/<id>/ verbatim (the actor
 * then returns only the anchor comment, no post) and the Exa-cache query
 * became "comment r/<sub>", whose scorer then accepted any /comments/ URL.
 * Query strings (utm_*, ?context=N) are ignored for classification. Returns
 * null for non-reddit URLs; kind "other" for subreddit/user/search pages.
 * Ids keep their original case — reddit base36 ids are case-sensitive;
 * comparisons lowercase on both sides.
 */
function parseRedditShape(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return null
  const path = u.pathname
  const share = path.match(/^\/(?:r\/[^/]+\/)?s\/([A-Za-z0-9]+)/i)
  if (share) return { kind: "share", sub: null, threadId: null, slug: null, commentId: null, path }
  const seg = path.split("/").filter(Boolean)
  if (seg[0] !== "r" || seg[2]?.toLowerCase() !== "comments" || !seg[3])
    return { kind: "other", sub: null, threadId: null, slug: null, commentId: null, path }
  const sub = seg[1]
  const threadId = seg[3]
  const extra = seg.slice(4)
  let slug = extra[0] ?? null
  let commentId = extra.length >= 2 ? extra[extra.length - 1] : null
  if (slug && /^(comment|_)$/i.test(slug)) slug = null
  return { kind: commentId ? "comment" : "thread", sub, threadId, slug, commentId, path }
}

/**
 * Pick the Exa search-cache block that really is the requested thread.
 * HARD RULE: a block is eligible only when its own URL's thread id equals
 * the requested one — substring scoring alone served a different thread
 * (the pseudo-slug "comment" is a substring of every /comments/ URL).
 * Within the matching thread, a slug match breaks ties.
 */
function pickExaThreadBlock(blocks, threadId, slug) {
  let best = null
  let bestScore = 0
  for (const block of blocks) {
    const blockUrl = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!blockUrl) continue
    const blockId = blockUrl.match(/\/comments\/([a-z0-9]+)/i)?.[1]?.toLowerCase()
    const want = threadId?.toLowerCase()
    if (!want || !blockId || blockId !== want) continue
    let v = 10
    if (slug && blockUrl.toLowerCase().includes(slug.toLowerCase())) v += 5
    if (v > bestScore) {
      bestScore = v
      best = { blockUrl, block }
    }
  }
  return best
}

async function redditViaExaSearch(url, budgetMs, outerSignal, maxChars) {
  const t0 = Date.now()

  // Search-query derivation via parseRedditShape (its docstring records the
  // bug this replaces). Subreddit/user/search URLs are not matchable here —
  // they fall through to the general chain instead of burning an MCP call
  // that could never be thread-verified.
  const shape = parseRedditShape(url)
  if (!shape || (shape.kind !== "thread" && shape.kind !== "comment"))
    return { ok: false, reason: "exa mcp: only thread/comment URLs are matchable" }
  const query = [shape.slug?.replace(/[-_]+/g, " "), `r/${shape.sub}`].filter(Boolean).join(" ")

  try {
    // keyless MCP — no metered credit, same endpoint search-cycle uses
    const res = await timedFetch(
      "https://mcp.exa.ai/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "web_search_exa", arguments: { query, numResults: 10 } },
        }),
      },
      budgetMs * 1000,
      outerSignal,
    )
    const raw = await res.text()
    let payload = null
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          payload = JSON.parse(line.slice(5))
          break
        } catch {}
      }
    }
    if (!payload && raw.startsWith("{")) payload = JSON.parse(raw)
    const text = payload?.result?.content?.find((c) => c.type === "text")?.text || ""
    if (!text) return { ok: false, reason: "exa mcp: empty response" }

    // match blocks against the requested thread — pickExaThreadBlock
    // hard-rejects any block whose thread id differs from the requested one
    const blocks = text.split(/\n\n---\n\n/)
    const best = pickExaThreadBlock(blocks, shape.threadId, shape.slug)
    if (!best) return { ok: false, reason: "exa mcp: thread not in search index" }

    // block shape: Title / URL / Published / Author / Highlights
    const title = best.block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || ""
    const author = best.block.match(/^Author:\s*(.+)$/m)?.[1]?.trim() || ""
    const published = best.block.match(/^Published:\s*(.+)$/m)?.[1]?.trim() || ""
    const highlights = best.block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim() || ""
    const body = [title && `# ${title}`, author && `by ${author}${published ? ` — ${published}` : ""}`, highlights]
      .filter(Boolean)
      .join("\n\n")
    if (highlights.length < 50) return { ok: false, reason: "exa mcp: matched but highlights too thin" }
    return {
      ok: true,
      matchedUrl: best.blockUrl,
      content: `[retrieved via Exa search cache (reddit direct is 403-blocked); thread: ${best.blockUrl}]\n\n${body}`,
      ms: Date.now() - t0,
    }
  } catch (error) {
    return { ok: false, reason: `exa mcp: ${String(error).slice(0, 120)}` }
  }
}

// ---------------------------------------------------------------- Reddit via Apify (primary)

/**
 * Full-fidelity thread fetch via Apify's pay-per-result actor
 * (trudax/reddit-scraper-lite). Probed live 2026-10-11: post body + comments
 * with authors/votes, 5 items ≈ $0.017 of the free $5 monthly credit.
 * Preferred over the Exa cache path, which only surfaces truncated
 * highlights and no comments. Cost is capped: maxComments (env
 * APIFY_MAX_COMMENTS, default 15) × $0.0034/result ≈ $0.05/fetch ceiling;
 * the free plan covers roughly 100 capped fetches/month. Note the comchat
 * search-only actor was rejected for this lane: it cannot fetch by URL.
 *
 * Comment permalinks (/comments/<id>/(slug|comment|_)/<commentId>) are
 * anchored: the run sends the permalink plus the canonical thread URL and
 * the linked comment is validated, deduped and rendered first. Billing is
 * per stored item — the permalink adds at most ONE item over a plain thread
 * fetch (probes 2026-10-12: dual-URL runs stored 4–8 items, ceiling
 * maxComments + 2 ≈ $0.058; the anchor survived a maxItems-bound run).
 */
const APIFY_RUN_URL =
  "https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items"
const APIFY_USD_PER_RESULT = 0.0034

async function redditViaApify(url, budgetMs, outerSignal) {
  const t0 = Date.now()
  const token = process.env.APIFY_TOKEN
  if (!token) return { ok: false, reason: "no APIFY_TOKEN" }
  const shape = parseRedditShape(url)
  if (!shape || (shape.kind !== "thread" && shape.kind !== "comment" && shape.kind !== "share"))
    return { ok: false, reason: "not a thread URL; skipping apify" }
  const maxComments = Math.max(1, Math.min(50, Number(process.env.APIFY_MAX_COMMENTS) || 15))
  // Actor-facing URLs: canonical host (the actor's stealth browser also
  // resolves /s/ share links, which reddit 403s to plain clients — verified
  // 2026-10-11), query strings stripped via parseRedditShape's pathname.
  // Comment permalinks additionally pass the canonical thread URL: one run
  // yields post + top comments AND the anchored comment.
  const actorUrl = `https://www.reddit.com${shape.path}`
  const threadUrl =
    shape.sub && shape.threadId ? `https://www.reddit.com/r/${shape.sub}/comments/${shape.threadId}/` : null
  const anchorId = shape.commentId ? shape.commentId.toLowerCase() : null
  // Actor ids look like "t1_<base36>"; parsedId carries the bare form.
  const normId = (it) => String(it?.parsedId ?? it?.id ?? "").replace(/^t[13]_/i, "").toLowerCase()
  try {
    // Browser-based scrape: runs legitimately take 30-90s — longer than any
    // single chain layer, so give the run the whole budget plus slack.
    // ONE retry on 5xx after a fixed 5 s wait — the run-sync endpoint has
    // shown transient 502s (actor platform flakiness, observed live
    // 2026-10-11). 4xx is never retried. Each attempt gets the full budget;
    // the caller's own timeout remains the hard ceiling.
    const runInput = (startUrls, maxItems) => ({
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        startUrls,
        maxItems,
        maxPostCount: 1,
        maxComments,
        skipCommunity: true,
        includeMediaLinks: false,
        navigationTimeout: 30,
        proxy: { useApifyProxy: true },
      }),
    })
    const runBudget = Math.min(budgetMs + 60_000, 180_000)
    const runOnce = async (startUrls, maxItems) => {
      let res = await timedFetch(APIFY_RUN_URL, runInput(startUrls, maxItems), runBudget, outerSignal)
      if (res.status >= 500) {
        try {
          await res.body?.cancel()
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        res = await timedFetch(APIFY_RUN_URL, runInput(startUrls, maxItems), runBudget, outerSignal)
      }
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data)) {
        const detail = data ? JSON.stringify(data).slice(0, 160) : res.statusText
        throw new Error(`${res.status}: ${detail}`)
      }
      return data
    }
    const items = await runOnce(
      shape.kind === "comment" ? [{ url: actorUrl }, { url: threadUrl }] : [{ url: actorUrl }],
      shape.kind === "comment" ? maxComments + 2 : maxComments + 1,
    )
    const post = items.find((it) => it?.dataType === "post" && it.body)
    let anchor = anchorId
      ? items.find((it) => it?.dataType === "comment" && it.body && normId(it) === anchorId)
      : undefined
    // Guarantee the anchor: URL-processing order inside the actor is not
    // documented and has been observed both first and last, so a binding
    // maxItems could in principle drop it. A permalink-only retry costs
    // 1 stored item and cannot be starved.
    if (anchorId && !anchor) {
      try {
        const retry = await runOnce([{ url: actorUrl }], 2)
        anchor = retry.find((it) => it?.dataType === "comment" && it.body && normId(it) === anchorId)
        if (anchor) items.push(anchor)
      } catch {}
    }
    if (!post && !anchor)
      return { ok: false, reason: `apify: no post${anchorId ? " or anchor comment" : ""} in ${items.length} items` }
    // dedupe — the anchored comment is emitted twice across the two start URLs
    const seen = new Set()
    const comments = items
      .filter((it) => it?.dataType === "comment" && it.body)
      .filter((it) => {
        const k = normId(it)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
    const anchorKey = anchor ? normId(anchor) : null
    const contextComments = comments.filter((c) => normId(c) !== anchorKey)
    const meta = [
      post?.communityName || (shape.sub ? `r/${shape.sub}` : ""),
      post?.username ? `u/${post.username}` : "",
      post && Number.isFinite(post.upVotes) ? `${post.upVotes} upvotes` : "",
      post?.createdAt ? String(post.createdAt).slice(0, 10) : "",
    ]
      .filter(Boolean)
      .join(" · ")
    const header = [
      post?.title ? `# ${post.title}` : anchor ? "# Comment permalink (thread body not returned by the actor)" : "",
      meta,
      post?.url || threadUrl || "",
    ]
      .filter(Boolean)
      .join("\n\n")
    const renderComment = (c, lead) =>
      `${lead ? `${lead}\n\n` : ""}**u/${c.username || "unknown"}**${
        Number.isFinite(c.upVotes) ? ` · ${c.upVotes} points` : ""
      }\n\n${c.body}`
    const commentBlocks = [
      ...(anchor ? [renderComment(anchor, "→ **the linked comment**")] : []),
      ...contextComments.map((c) => renderComment(c)),
    ]
    const content = [
      `[retrieved via Apify reddit-scraper-lite: ${items.length} results, ~$${(items.length * APIFY_USD_PER_RESULT).toFixed(3)}]`,
      header,
      post?.body ?? "",
      commentBlocks.length
        ? `## Comments${anchor ? " — linked comment first" : ""} (${commentBlocks.length}${
            Number.isFinite(post?.numberOfComments) ? ` of ${post.numberOfComments}` : ""
          })\n\n${commentBlocks.join("\n\n---\n\n")}`
        : "",
      anchor
        ? "_Comment-anchored fetch: sibling context is the top comments as scraped; the scraper does not return the ancestor chain._"
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
    return {
      ok: true,
      items: items.length,
      content,
      resolvedUrl: post?.url || threadUrl || actorUrl,
      ms: Date.now() - t0,
    }
  } catch (error) {
    return { ok: false, reason: `apify: ${String(error?.message || error).slice(0, 120)}` }
  }
}

// ---------------------------------------------------------------- GitHub algebra

const GH_API = "https://api.github.com"

function ghParse(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname !== "github.com" && u.hostname !== "raw.githubusercontent.com" && u.hostname !== "gist.github.com")
    return null
  const seg = u.pathname.split("/").filter(Boolean)
  if (u.hostname === "raw.githubusercontent.com") {
    // o/r/branch/path... — already raw
    return { kind: "raw-direct", url }
  }
  if (u.hostname === "gist.github.com") return { kind: "fallback" } // gists render fine; skip algebra
  const [owner, repo, ...rest] = seg
  if (!owner || !repo) return { kind: "fallback" }
  if (rest.length === 0) return { kind: "repo", owner, repo }
  const [a, b, ...tail] = rest
  if ((a === "blob" || a === "tree") && b) {
    const p = tail.join("/")
    return { kind: a === "blob" ? "blob" : "tree", owner, repo, ref: b, path: p }
  }
  if ((a === "issues" || a === "pull") && b && /^\d+$/.test(b)) return { kind: "issue", owner, repo, num: b, isPr: a === "pull" }
  if (a === "releases" || a === "tags" || a === "commits") return { kind: "fallback" } // server-rendered OK
  return { kind: "fallback" }
}

async function ghJson(pathname, budgetMs, outerSignal) {
  const res = await timedFetch(
    `${GH_API}${pathname}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": CHROME_UA,
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    },
    budgetMs,
    outerSignal,
  )
  if (!res.ok) throw new Error(`gh api ${res.status} ${pathname}`)
  return res.json()
}

async function fetchGitHub(parsed, budgetMs, outerSignal) {
  const slice = (ms) => Math.max(3_000, Math.round(budgetMs * 0.4))
  if (parsed.kind === "raw-direct" || parsed.kind === "fallback") return null // caller falls through to chain
  try {
    if (parsed.kind === "blob") {
      const raw = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.path}`
      const t0 = Date.now()
      const res = await timedFetch(raw, { headers: { "user-agent": CHROME_UA } }, slice(), outerSignal)
      if (!res.ok) throw new Error(`raw ${res.status}`)
      const body = await res.text()
      return {
        layer: "github",
        content: body.slice(0, MAX_CHARS) + (body.length > MAX_CHARS ? "\n\n[truncated]" : ""),
        meta: { kind: "blob", bytes: body.length, ms: Date.now() - t0 },
      }
    }
    if (parsed.kind === "tree") {
      const data = await ghJson(
        `/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${encodeURIComponent(parsed.ref)}`,
        slice(),
        outerSignal,
      )
      const lines = (Array.isArray(data) ? data : [data]).map((e) => `- ${e.type === "dir" ? "[dir] " : ""}${e.name} (${e.size}B)`)
      return {
        layer: "github",
        content: `Directory /${parsed.path} @ ${parsed.ref}:\n\n${lines.join("\n")}`,
        meta: { kind: "tree", entries: lines.length },
      }
    }
    if (parsed.kind === "repo") {
      const meta = await ghJson(`/repos/${parsed.owner}/${parsed.repo}`, slice(), outerSignal)
      const readmeRes = await timedFetch(
        `${GH_API}/repos/${parsed.owner}/${parsed.repo}/readme`,
        {
          headers: {
            accept: "application/vnd.github.raw",
            "user-agent": CHROME_UA,
            ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
          },
        },
        slice(),
        outerSignal,
      )
      const readme = readmeRes.ok ? await readmeRes.text() : "(readme fetch failed)"
      const head =
        `# ${meta.full_name}\n\n${meta.description || "(no description)"}\n\n` +
        `stars: ${meta.stargazers_count} | forks: ${meta.forks_count} | language: ${meta.language} | default branch: ${meta.default_branch}\n` +
        (meta.topics?.length ? `topics: ${meta.topics.join(", ")}\n` : "")
      return {
        layer: "github",
        content: `${head}\n## README\n\n${readme.slice(0, MAX_CHARS)}`,
        meta: { kind: "repo", stars: meta.stargazers_count },
      }
    }
    if (parsed.kind === "issue") {
      const issue = await ghJson(`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.num}`, slice(), outerSignal)
      const comments = await ghJson(
        `/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.num}/comments?per_page=30`,
        slice(),
        outerSignal,
      ).catch(() => [])
      const body =
        `# ${issue.title} (${issue.state})\n\n` +
        `${parsed.isPr ? "pull request" : "issue"} #${issue.number} by ${issue.user?.login || "?"} — created ${issue.created_at}\n\n` +
        `${issue.body || "(no body)"}\n`
      const thread = (comments || [])
        .map((c) => `---\n${c.user?.login || "?"} at ${c.created_at}:\n\n${c.body || ""}`)
        .join("\n\n")
      return {
        layer: "github",
        content: `${body}${comments?.length ? `\n## Comments (${comments.length})\n\n${thread}` : ""}`.slice(0, MAX_CHARS),
        meta: { kind: parsed.isPr ? "pr" : "issue", comments: comments?.length || 0 },
      }
    }
  } catch (error) {
    fileLog({ event: "github_fail", kind: parsed.kind, error: String(error).slice(0, 160) })
    return null // fall through to the general chain
  }
  return null
}

// ---------------------------------------------------------------- router

function route(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return { special: null }
  }
  const host = u.hostname.replace(/^www\./, "")
  if (host === "github.com" || host === "raw.githubusercontent.com" || host === "gist.github.com") {
    return { special: "github" }
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) return { special: "reddit" }
  return { special: null }
}

// ---------------------------------------------------------------- chain

function budgetFor(totalSec) {
  const totalMs = totalSec * 1000
  return {
    l0: Math.max(4_000, Math.round(totalMs * 0.15)),
    l1: Math.max(12_000, Math.round(totalMs * 0.4)),
    l2: Math.max(10_000, Math.round(totalMs * 0.35)),
  }
}

/**
 * Shape a passing L0 fetch into a tool result. Pure: module-level helpers and
 * constants only (no closure over fetchChain).
 *
 * Markdown is the only format that runs the HTML→markdown converter, and the
 * converter only ever sees real markup inside the size bound — see §2.4 of
 * specs/2026-10-26-nhm-hang-fix.md and NHM_MAX_INPUT for the incident.
 */
function renderL0(l0, format) {
  const body = l0.body
  const verdict = l0.verdict
  const contentType = l0.contentType
  const isMarkup = !!(verdict.isHtml || verdict.isXml)
  // Non-markup bodies are already text: stripping/compiling them through an HTML
  // pipeline is wrong (mangles JSON pseudo-tags) and, at scale, hazardous.
  const finalText =
    format === "html" ? body
    : format === "text" ? (isMarkup ? stripHtmlToText(body) : body)
    : null
  if (format !== "markdown") {
    return {
      content: (finalText || "").slice(0, MAX_CHARS),
      metadata: { layer: "L0", contentType, format },
    }
  }
  if (!isMarkup || body.length > NHM_MAX_INPUT) {
    // JSON/plain/javascript → verbatim; oversize markup → linear text
    // extraction instead of risking the converter hang.
    const text = isMarkup ? stripHtmlToText(body) : body
    return {
      content: text.slice(0, MAX_CHARS),
      metadata: {
        layer: "L0",
        contentType,
        format: isMarkup ? "text (oversize, converter skipped)" : "text (non-markup, verbatim)",
      },
    }
  }
  const t0 = Date.now()
  const md = htmlToMarkdown(body)
  if (md !== null) {
    fileLog({ event: "rendered", layer: "L0", ms: Date.now() - t0, outLen: md.length })
    return { content: md.slice(0, MAX_CHARS), metadata: { layer: "L0", contentType } }
  }
  // converter unavailable: degrade to text rather than burning L1 for cosmetics
  return {
    content: stripHtmlToText(body).slice(0, MAX_CHARS),
    metadata: { layer: "L0", contentType, format: "text (converter unavailable)" },
  }
}

async function fetchChain(input, signal) {
  const url = input.url
  const format = input.format || "markdown"
  const totalSec = Math.min(120, Math.max(5, Number(input.timeout) || 60))
  const budget = budgetFor(totalSec)
  const maxChars = Number(process.env.WEBFETCH_EXA_MAX_CHARS) || MAX_CHARS

  const { special } = route(url)
  const attempts = []
  const note = (layer, ok, extra = {}) => {
    attempts.push({ layer, ok, ...extra })
    fileLog({ event: "attempt", url, layer, ok, ...extra })
  }

  // ---- special paths ------------------------------------------------------
  if (special === "github") {
    const parsed = ghParse(url)
    if (parsed && parsed.kind !== "raw-direct" && parsed.kind !== "fallback") {
      const result = await fetchGitHub(parsed, budget.l0 + budget.l1, signal)
      if (result) {
        note("github", true, { kind: result.meta.kind, ms: result.meta.ms })
        return { content: result.content, metadata: { layer: result.layer, ...result.meta } }
      }
      note("github", false, { note: "algebra failed; falling through to chain" })
    }
  }

  if (special === "reddit") {
    // Reddit 403s everything since the 2026 lockdown: L0, L1 AND Exa
    // /contents (SOURCE_NOT_AVAILABLE — verified repeatedly). Preferred:
    // Apify reddit-scraper-lite (full thread + comments, pay-per-result,
    // free-plan credits). Fallbacks: exact-URL Exa /contents (works if Exa
    // re-permits later), then the MCP search-cache extraction.
    const apify = await redditViaApify(url, budget.l1 + budget.l2, signal)
    note("apify", apify.ok, { ms: apify.ms, items: apify.items, reason: apify.reason })
    if (apify.ok) {
      return {
        content: apify.content.slice(0, MAX_CHARS),
        metadata: { layer: "apify", finalUrl: apify.resolvedUrl || url, items: apify.items },
      }
    }
    const exa = await fetchExa(url, budget.l2, signal, maxChars)
    note("exa-reddit", exa.ok, { ms: exa.ms, reason: exa.reason })
    if (exa.ok) {
      return {
        content: `${exa.title ? `${exa.title}\n\n` : ""}${exa.text}`.slice(0, MAX_CHARS),
        metadata: { layer: "exa", finalUrl: url },
      }
    }
    const cached = await redditViaExaSearch(url, budget.l2, signal, maxChars)
    note("exa-reddit-cached", cached.ok, { ms: cached.ms, reason: cached.reason })
    if (cached.ok) {
      return {
        content: cached.content.slice(0, MAX_CHARS),
        metadata: { layer: "exa-search", finalUrl: url, matchedUrl: cached.matchedUrl },
      }
    }
    // fall through to general chain as a last resort
  }

  // ---- L0 -----------------------------------------------------------------
  let l0
  try {
    l0 = await fetchPlain(url, budget.l0, signal)
  } catch (error) {
    l0 = {
      verdict: { ok: false, reason: signal?.aborted ? "aborted" : `transport: ${String(error).slice(0, 120)}` },
      status: 0,
      contentType: "",
      body: "",
    }
  }
  note("L0", !!l0.verdict.ok, { status: l0.status, reason: l0.verdict.reason, ms: l0.verdict.elapsedMs })

  if (l0.verdict.terminal) {
    return {
      content: `[webfetch-ai] HTTP ${l0.status} (not found): ${url}\nThe resource does not exist; no fallback attempted.`,
      metadata: { layer: "L0", status: l0.status, terminal: true },
    }
  }

  if (l0.verdict.ok) {
    return renderL0(l0, format)
  }

  if (l0.verdict.pdf) {
    const exa = await fetchExa(url, budget.l2, signal, maxChars)
    note("L2-pdf", exa.ok, { ms: exa.ms, reason: exa.reason })
    if (exa.ok) {
      return { content: `${exa.title ? `${exa.title}\n\n` : ""}${exa.text}`.slice(0, MAX_CHARS), metadata: { layer: "L2", kind: "pdf" } }
    }
    throw new Error(`Unable to fetch PDF ${url}: L2 Exa failed (${exa.reason})`)
  }

  // ---- L1 -----------------------------------------------------------------
  let l1
  try {
    l1 = await fetchPlaywright(url, budget.l1, signal)
  } catch (error) {
    l1 = { ok: false, reason: signal?.aborted ? "aborted" : `playwright-ai unreachable: ${String(error).slice(0, 120)}` }
  }
  note("L1", !!l1.ok, { status: l1.status, ms: l1.ms, reason: l1.reason, textLen: l1.textLen })

  const l1Usable =
    l1.ok &&
    l1.status < 400 &&
    (l1.textLen || 0) >= MIN_TEXT_PLAIN &&
    !CHALLENGE_MARKERS.some((m) => (l1.markdown || "").slice(0, 4096).toLowerCase().includes(m))

  if (l1Usable) {
    if (l1.status === 404 || l1.status === 410) {
      return {
        content: `[webfetch-ai] HTTP ${l1.status} (not found): ${url}`,
        metadata: { layer: "L1", status: l1.status, terminal: true },
      }
    }
    let content = l1.markdown
    if (format === "text") content = stripHtmlToText(content) // markdown → plain-ish text
    if (format === "html") content = `<!-- rendered by playwright-ai; original HTML not retained -->\n${content}`
    return {
      content: content.slice(0, MAX_CHARS),
      metadata: { layer: "L1", status: l1.status, finalUrl: l1.finalUrl, title: l1.title, ms: l1.ms },
    }
  }

  // ---- L2 -----------------------------------------------------------------
  const exa = await fetchExa(url, budget.l2, signal, maxChars)
  note("L2", exa.ok, { ms: exa.ms, reason: exa.reason })
  if (exa.ok) {
    return {
      content: `${exa.title ? `${exa.title}\n\n` : ""}${exa.text}`.slice(0, MAX_CHARS),
      metadata: { layer: "L2", title: exa.title, publishedDate: exa.publishedDate, ms: exa.ms },
    }
  }

  const tried = attempts.map((a) => `${a.layer}${a.ok ? "✓" : `✗(${a.reason || ""})`}`).join(" → ")
  const err = new Error(`Unable to fetch ${url}. Attempts: ${tried}. Last error: ${l1.reason || l0.verdict.reason}`)
  err.recoverable = false
  throw err
}

// ---------------------------------------------------------------- plugin

export const WebfetchAiPlugin = {
  id: "local.webfetch-ai",
  async setup(context) {
    context.tool.transform((editor) => {
      editor.add({
        name: "webfetch",
        description:
          "Fetch content from an HTTP or HTTPS URL and return it as markdown (default), text, or HTML. " +
          "Layered resilient fetching: plain HTTP first; JavaScript-rendered, PDF, and anti-bot pages escalate " +
          "to a headless-Chromium service, then to the Exa extract API as a last resort. GitHub and Reddit URLs " +
          "use dedicated paths. Read-only. Large results are truncated at ~400KB. Default timeout 60s, max 120s.",
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "The HTTP or HTTPS URL to fetch" },
            format: {
              type: "string",
              enum: ["text", "markdown", "html"],
              description: "The format to return. Defaults to markdown (html passes through raw on L0; L1 returns rendered markdown).",
            },
            timeout: {
              type: "number",
              description: "Optional total time budget in seconds (1-120). Default 60.",
            },
          },
          required: ["url"],
        },
        options: { codemode: false },
        execute: async (input, ctx) => {
          const content = await fetchChain(input || {}, ctx?.signal)
          return { content: content.content, metadata: content.metadata }
        },
      })
    })
  },
}

export default WebfetchAiPlugin

// test hook: the harness imports this directly (no plugin runtime needed)
export const __tests = {
  fetchChain,
  ghParse,
  gateL0,
  classifyBody,
  route,
  stripHtmlToText,
  parseRedditShape,
  pickExaThreadBlock,
  renderL0,
}
