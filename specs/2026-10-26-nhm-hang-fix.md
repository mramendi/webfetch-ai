# Spec: never feed non-markup bodies through the HTML→markdown converter (event-loop hang fix)

Date: 2026-10-26 · Author: primary session (GLM 5.3 Flash) · Status: stabilized, ready for implementation
Implementer: grunter lane, spec-only (no other context). If anything here is ambiguous or contradictory,
STOP and return `STATUS: questions` — do not guess.

## 0. Incident summary (all facts verified 2026-10-26)

The OpenCode serve process died silently three times tonight (boots 02:13:50, 02:14:55, 02:16:32 UTC),
each ~45–55s after a *successful* L0 `webfetch` of:

    https://huggingface.co/microsoft/harrier-oss-v1-270m/raw/main/tokenizer_config.json

Verified causal chain:

1. That URL's body is **1,155,377 bytes of JSON** whose `added_tokens_decoder` embeds
   **6,322 pseudo-HTML token strings** (`"<pad>"`, `"<eos>"`, …).
2. `gateL0` correctly classifies it textual and passes it (`ok: true`).
3. The L0-ok markdown path in `fetchChain` calls `htmlToMarkdown(l0.body)` **unconditionally** —
   including for non-HTML bodies. JSON goes into the HTML→markdown converter.
4. `node-html-markdown`'s `translate()` is superlinear-pathological on this input:
   **100 KB slice → 165 ms; full 1.1 MB body → killed at >30 s, never finished**
   (node 22.14, vendored copy, exact body, `timeout` exit 124).
5. `translate()` is synchronous → the serve process **event loop freezes**.
6. The TUI client (`opencode -c`, parent of `opencode serve --service`) detects the stall
   ("event stream stalled" ~45s), kills the child, respawns it. No kernel OOM, no systemd
   unit, nothing in opencode.log — a pure silent freeze.
7. Diagnostic trap: the per-attempt fileLog (`note("L0", …)`) is written **before** conversion,
   so `webfetch-cycle.log` shows `ok: true` right up to each death.

A copy of the exact incident body is at `/srv/ssd/tmp/opencode/tok.json` (session scratch —
may be deleted anytime; tests must synthesize their own input, see §3).

## 1. Scope

Single file: `opencode/plugins/webfetch-ai.ts` (this repo's copy — verified byte-identical to the
deployed shadow on 2026-10-26). Plus one new offline test file under `tests/`.

Out of scope — do not touch: L1/L2 paths, reddit/github paths, retry logic, `MAX_CHARS`,
gate thresholds, `vendor/` tree, any file outside this repo, the deployed plugin at
`~/.config/opencode/plugins/webfetch-ai.ts` (owner deploys after review), the public remote
(owner pushes after review). Do not restart any service.

## 2. Code changes (all in `opencode/plugins/webfetch-ai.ts`)

### 2.1 New constant (next to the other constants)

```js
// node-html-markdown's translate() is superlinear on tag-soup inputs (measured
// 2026-10-26: 100KB→165ms; a 1.1MB JSON with pseudo-HTML token strings → >30s,
// never finished). translate() is synchronous, so a hang of that scale freezes
// the whole OpenCode serve process — the client watchdog then kills and
// respawns it. Two guards: never feed NON-markup bodies to the converter at
// all, and bound the converter's input size (oversize degrades to text
// extraction, which is linear and bounded).
const NHM_MAX_INPUT = 262_144 // 256KB
```

### 2.2 `classifyBody`: expose `isXml`

XML is genuine markup — the converter keeps handling it (behavior preservation), but the
decision needs to see it. After the existing `isHtml`/`isPdf` lines add:

```js
  const isXml = ct.includes("xml") || head.trimStart().startsWith("<?xml")
```

and include `isXml` in the returned object.

### 2.3 `gateL0`: pass `isXml` through the ok verdict

The success return becomes `{ ok: true, isHtml: k.isHtml, isXml: k.isXml, textLen: text.length, elapsedMs }`.

### 2.4 Extract the L0-ok return-shaping into a pure helper `renderL0(l0, format)` — and fix it

Move the body of the `if (l0.verdict.ok) { … }` block in `fetchChain` into a module-level
pure function; `fetchChain`'s branch reduces to:

```js
  if (l0.verdict.ok) {
    return renderL0(l0, format)
  }
```

`l0` is the object returned by `fetchPlain` (`{ verdict, status, contentType, body }`). New logic:

```js
function renderL0(l0, format) {
  const body = l0.body
  const verdict = l0.verdict
  const contentType = l0.contentType
  const isMarkup = !!(verdict.isHtml || verdict.isXml)
  // Non-markup bodies are already text: stripping/compiling them through an HTML
  // pipeline is wrong (mangles JSON pseudo-tags) and, at scale, hazardous (§0).
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
    // extraction instead of risking the converter hang (§0).
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
```

Notes:
- The `fileLog({ event: "rendered", … })` line closes the §0(7) forensic gap: the attempt log
  currently shows `ok: true` before conversion runs; the rendered log marks conversion completion.
- The `format === "text"` non-markup change (verbatim instead of stripped) is deliberate:
  same pathology class, and stripping `<pad>`-style strings out of JSON is data corruption.
  It must be visible in the spec review.
- `renderL0` must not reference anything from `fetchChain`'s scope (pure: only module-level
  helpers/constants).

### 2.5 `__tests` export

Add `renderL0` to the exported `__tests` object. Keep every existing export unchanged.

## 3. Tests — new file `tests/l0-render.test.mjs` (offline, NO network)

Follow the repo loader trick used by `tests/reddit-shape.test.mjs`: copy the `.ts` to a temp
`.mjs`, `import` the `__tests` hook. Run with the box node:
`/srv/ssd/tools/node-v22.14.0-linux-x64/bin/node tests/l0-render.test.mjs`
(no npm/node on PATH otherwise; print PASS/FAIL per case and exit nonzero on failure).

Cases:

- **A. classification**: `classifyBody("application/json", body)` on a synthetic tag-soup JSON →
  `isHtml === false`, `textual === true`, `isPdf === false`.
- **B. non-markup verbatim (the incident shape, regression guard)**: synthesize ~1.2 MB of JSON
  with ~6,000 `"content": "<tokN>"` entries (deterministic; do NOT read
  `/srv/ssd/tmp/opencode/tok.json` from the test). `renderL0({ body, verdict: { ok: true, isHtml: false, isXml: false }, contentType: "application/json", status: 200 }, "markdown")`
  must return in **< 5000 ms**, with `content === body.slice(0, 400_000)` (verbatim, capped) and
  `metadata.format` matching `/non-markup/`.
- **C. small HTML still converts**: `renderL0` on `"<html><body><h1>Title</h1><p>Para</p></body></html>"`
  with verdict `{ ok: true, isHtml: true, isXml: false }` → content mentions `Title` as markdown
  (`# Title`) when the converter resolves. NOTE: `getConverter()` anchors at the DEPLOYED vendor
  path (`~/.config/opencode/node_modules`) by design — on this box it resolves; make the assert
  tolerant for portability: if the converter is unavailable, accept a non-empty text degrade.
- **D. oversize markup degrades**: HTML string larger than `NHM_MAX_INPUT` (e.g. `"<p>x</p>".repeat(...)`)
  → returns < 5000 ms, `metadata.format` matches `/oversize/`, content non-empty.
- **E. xml keeps the converter path**: `<?xml version="1.0"?><root><item>a</item></root>` with
  verdict `{ ok: true, isHtml: false, isXml: true }` → non-empty content, no throw (loose assert;
  exact markdown shape may vary).

Also run the existing offline suite and require it unchanged-green:
`node tests/reddit-shape.test.mjs`. Do **not** run `tests/chain.test.mjs` (live network, paid lanes).

## 4. Acceptance criteria

1. `tests/l0-render.test.mjs` — all cases pass.
2. `tests/reddit-shape.test.mjs` — all cases pass, file untouched.
3. `git -C /srv/ssd/repos/webfetch-ai status --short` shows exactly two changes:
   modified `opencode/plugins/webfetch-ai.ts`, new `tests/l0-render.test.mjs` (plus the spec file
   if uncommitted at kickoff).
4. The plugin module still loads (the test loader proves it).
5. Commit locally with message: `fix: never feed non-markup/oversize bodies to the markdown converter (event-loop hang, incident 2026-10-26)` — **do not push**.

## 5. Report contract

Final response: `STATUS` first line (done | questions | blocked), then CHANGES / QUESTIONS / ASSUMPTIONS.
Include the test output summary and the exact git hash.
