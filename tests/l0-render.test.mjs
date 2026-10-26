// L0 render tests — offline: no network, no Apify/Exa credits, no playwright.
// Same loader trick as reddit-shape.test.mjs: the plugin is plain-JS-in-.ts,
// so copy it to a tmp .mjs and import the __tests hook.
//
// Regression origin (2026-10-26 incident): a 1,155,377-byte JSON body
// (harrier-oss-v1-270m tokenizer_config.json, whose added_tokens_decoder holds
// 6,322 "<pad>"-style pseudo-HTML token strings) passed gateL0 as textual and
// was fed to node-html-markdown's translate() UNCONDITIONALLY. translate() is
// superlinear on tag soup (measured: 100KB→165ms; full body→>30s, never
// finished) and synchronous, so it froze the serve event loop and the client
// watchdog killed/respawned the process three times. These tests pin both
// guards: non-markup bodies never enter the converter, and converter input is
// bounded by NHM_MAX_INPUT (oversize markup degrades to linear text extraction).
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const src = new URL("../opencode/plugins/webfetch-ai.ts", import.meta.url)
const dir = mkdtempSync(join(tmpdir(), "wfai-l0-"))
// renderL0 writes a "rendered" diagnostics line on successful conversion; keep
// the box's live ~/.local/share/opencode/webfetch-cycle.log out of the test path.
process.env.WEBFETCH_LOG_FILE = join(dir, "webfetch-cycle.log")
writeFileSync(join(dir, "webfetch-ai.mjs"), readFileSync(src, "utf8"))
const { __tests } = await import(join(dir, "webfetch-ai.mjs"))
const { classifyBody, renderL0 } = __tests

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// Synthetic incident-shaped body: ~1.2MB of JSON with 6,000 "<tokN>" entries.
// Deterministic, built here — the real incident body is session scratch and
// must not be a test dependency.
const JSON_ENTRIES = Array.from(
  { length: 6_000 },
  (_, i) => `  {"id": ${i}, "content": "<tok${i}>", "pad": "${"x".repeat(150)}"}`,
)
const JSON_BODY = `{\n"added_tokens_decoder": {\n${JSON_ENTRIES.join(",\n")}\n}\n}`
const l0Of = (body, verdict, contentType = "application/json") => ({
  body,
  verdict,
  contentType,
  status: 200,
})

// --- A. classification --------------------------------------------------------
const k = classifyBody("application/json", JSON_BODY)
ok("A1 json body is not html", k.isHtml === false)
ok("A2 json body is textual", k.textual === true)
ok("A3 json body is not pdf", k.isPdf === false)
ok("A4 json body is not xml", k.isXml === false)
ok("A5 xml content-type classifies as xml", classifyBody("application/xml", "<root/>").isXml === true)
ok("A6 xml prolog sniffed on empty content-type", classifyBody("", '<?xml version="1.0"?><root/>').isXml === true)

// --- B. non-markup verbatim: the incident shape (regression guard) -------------
ok("B0 fixture is incident-scale", JSON_BODY.length > 1_000_000, `${JSON_BODY.length} bytes`)
{
  const t0 = Date.now()
  const out = renderL0(l0Of(JSON_BODY, { ok: true, isHtml: false, isXml: false }), "markdown")
  const ms = Date.now() - t0
  ok("B1 non-markup body never enters the converter", ms < 5_000, `${ms}ms`)
  ok("B2 json returned verbatim, capped at MAX_CHARS", out.content === JSON_BODY.slice(0, 400_000))
  ok("B3 metadata marks the non-markup path", /non-markup/.test(String(out.metadata.format)), String(out.metadata.format))
}

// --- C. small HTML still converts ---------------------------------------------
{
  const html = "<html><body><h1>Title</h1><p>Para</p></body></html>"
  const out = renderL0(l0Of(html, { ok: true, isHtml: true, isXml: false }, "text/html"), "markdown")
  // getConverter() anchors at the DEPLOYED vendor path by design: on this box
  // it resolves; elsewhere accept the non-empty text degrade.
  const converted = out.content.includes("# Title")
  const degraded = out.metadata.format === "text (converter unavailable)" && out.content.trim().length > 0
  ok("C small HTML converts to markdown (or degrades to non-empty text)", converted || degraded, JSON.stringify(out.metadata))
}

// --- D. oversize markup degrades ----------------------------------------------
{
  const big = "<p>x</p>".repeat(40_000) // 320KB > NHM_MAX_INPUT (262,144)
  ok("D0 fixture exceeds the converter bound", big.length > 262_144, `${big.length} bytes`)
  const t0 = Date.now()
  const out = renderL0(l0Of(big, { ok: true, isHtml: true, isXml: false }, "text/html"), "markdown")
  const ms = Date.now() - t0
  ok("D1 oversize markup returns without conversion", ms < 5_000, `${ms}ms`)
  ok("D2 metadata marks the oversize path", /oversize/.test(String(out.metadata.format)), String(out.metadata.format))
  ok("D3 oversize content is non-empty", typeof out.content === "string" && out.content.length > 0)
}

// --- E. xml keeps the converter path ------------------------------------------
{
  const xml = '<?xml version="1.0"?><root><item>a</item></root>'
  let out
  let thrown = null
  try {
    out = renderL0(l0Of(xml, { ok: true, isHtml: false, isXml: true }, "application/xml"), "markdown")
  } catch (error) {
    thrown = error
  }
  ok(
    "E xml stays on the converter path (no throw, non-empty)",
    thrown === null && typeof out?.content === "string" && out.content.length > 0,
    thrown ? String(thrown) : "",
  )
}

// --- F. format=text ignores markup ambiguity for non-markup bodies ------------
// Deliberate change in specs/2026-10-26-nhm-hang-fix.md §2.4: stripping
// "<pad>"-style strings out of JSON is data corruption.
{
  const out = renderL0(l0Of(JSON_BODY, { ok: true, isHtml: false, isXml: false }), "text")
  ok("F1 format=text on json is verbatim, not tag-stripped", out.content === JSON_BODY.slice(0, 400_000))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
