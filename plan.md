# webfetch-ai — locked plan (approved in discussion, 2026-10-11)

## Goal

Research-grade fetching for OpenCode: the built-in `webfetch` is a plain HTTPS
GET with an announced-bot UA (`OpenCode-User/1.0`) — friendly sites only.
Replace it (shadow by name) with a layered chain that escalates deterministically.

## Integration mechanism (VERIFIED empirically, 2026-10-11)

**v2.0.26 has NO tools/-directory loader** — `custom-tools.mdx` in the docs
tree describes a later version (docs drift). The `tools/` route is dead at
this tag.

**Verified plugin route** (marker test passed; standalone run returned
`PLUGIN-SHADOW-OK`):
- Plugin file `~/.config/opencode/plugins/webfetch-ai.ts`, shape
  `{id, async setup(context)}` (search-cycle.ts is the working template —
  default export, zero npm imports).
- Inside setup: `context.tool.transform(editor => editor.add({name:
  "webfetch", input: <JSON Schema>, description, execute}))`.
- `Editor.add` is `Map.set` — same-name OVERWRITES silently; user plugins
  activate after internal-pre tools, so our add wins (supervisor.ts boot
  order + schema/tool.ts Info shape verified in source).
- `input` accepts plain JSON Schema (ValueSchema union: Codec |
  StandardSchema | JsonSchema). `execute(input, ctx)` returns
  `{content: string}` (schema/tool.ts Result.content allows string).
- Options `{codemode: false}` to match built-in behavior; Code Mode catalog
  picks up the custom tool too (observed: `tools.webfetch` carried the
  marker description).
- Permission config `"webfetch": "allow"` matches by tool name → unchanged.
- **Hot-reload applies live**: plugins/ dir is watched; deploy/unload takes
  effect for all sessions immediately (observed in this session). So:
  validate outside the service first; never leave a broken/beta shadow live.
- Keep built-in arg/output contract: `{url, format?: text|markdown|html
  (default markdown), timeout?: ≤120s}`; content string output.

## Chain

```
webfetch.ts
 ├─ classify(url):
 │    github.com/githubusercontent → GitHub path (below)
 │    reddit.com                   → straight to L2 (Exa)  [OAuth path reserved]
 │    else                         → general chain
 ├─ L0 plain fetch (~8s budget, normal Chrome UA, Accept-Language) + gate
 │     PASS → in-process HTML→markdown (node-html-markdown, zero-DOM dep) → return
 ├─ L1 POST http://127.0.0.1:8899/fetch {url, timeout_ms} (≤20s)
 │     PASS → return markdown (+ title)
 └─ L2 POST https://api.exa.ai/contents {urls:[url], text, maxAgeHours:24} (≤25s)
       PASS → return text
 all failed → structured per-layer diagnostics (model judges)
```

## L0 deterministic gate (the user's "no LLM cycle" condition — YES)

Fail to next layer when ANY of:
- transport error / timeout
- HTTP ≥400: 403/429/503, or `cf-mitigated: challenge` header, or
  challenge markers in first 4KB (Just a moment / cf-chl / Attention Required /
  Datadome / Incapsula / px-captcha / captcha-delivery / Enable JavaScript…)
- non-textual mime (PDF is textual-enough to skip L0/L1 → straight to L2;
  Exa handles PDFs)
- visible text < ~300 chars (HTML) / < 50 chars (plain/JSON)
- HTML shell heuristic: text/markup ratio < ~2% on >20KB pages
404/410 → terminal "not found", NO failover (don't burn a browser on it).

## L1 playwright-ai container (independent, NOT the OWUI bundle)

- `mcr.microsoft.com/playwright` (current stable noble tag, ~2GB) + baked
  Node service: POST /fetch {url, timeout_ms} → {status, final_url, title,
  markdown}; GET /healthz.
- scrape-smart tricks (from misha-llm-tools/smart_scrape.py): real Chrome UA,
  stealth patches (navigator.webdriver etc.), goto domcontentloaded →
  wait body → networkidle (bounded) — plus: scroll-to-bottom loop (lazy
  load), @mozilla/readability + node-html-markdown in-container,
  concurrency semaphore 2, per-request timeout, stateless container.
- quadlet: `.build` (ImageTag localhost/playwright-ai:latest) + `.container`
  (Network=ai.network, ContainerName=playwright-ai, PublishPort
  127.0.0.1:8899:8080 loopback-only, Restart=on-failure). Future REST layer
  reaches it as `playwright-ai:8899` via container DNS.
- Chromium flags: --no-sandbox, --disable-dev-shm-usage (rootless podman).

## L2 provider — Exa (chosen in discussion)

- `$10/mo free credits + $20 signup, no card`; `/contents` $1/1k pages
  (≈10k pages/mo headroom). Cache-first; `maxAgeHours: 24` to force live
  crawl when cache is stale. Handles JS-rendered pages and PDFs.
- Response shape verified: `{requestId, results:[{url,title,text,author…}]}`.
- search-cycle.ts edit (BEFORE any keyed call): stop reading EXA_API_KEY so
  Exa search stays permanently keyless via mcp.exa.ai (fetch-only split).
- Key: `EXA_API_KEY` in load-secrets.sh — ADDED + verified in service env.

## GitHub path (URL algebra, no auth)

- `/blob/<br>/<path>` → `raw.githubusercontent.com/<o>/<r>/<br>/<path>` (plain)
- repo root → `api.github.com/repos/o/r` + `/readme` (decoded markdown)
- `issues/N`, `pull/N` → `api.github.com/repos/o/r/issues/N` + `/comments`
  (compact formatting; issues endpoint covers PRs)
- discussions → no unauth API → normal chain (playwright renders GH fine)
- unauth: 60 req/hr on api.github.com; raw unlimited. Optional future:
  GITHUB_TOKEN.

## Test matrix (overnight)

friendly docs page / Cloudflare-protected / SPA shell / GitHub blob + repo +
issue / reddit thread / PDF / genuine 404 (fast-terminal) / oversized
response. Measure per-layer latency + bytes; log every call to
`~/.local/share/opencode/webfetch-cycle.log` (JSONL: layer, ms, bytes,
status, reason) — search-cycle.log pattern.

## Build order

1. marker shadow test → 2. search-cycle keyless guard → 3. playwright-ai
   build+start+health → 4. webfetch.ts chain + deps → 5. matrix + latency
   report → 6. deploy-by-copy + daemon-reload + real-session verification →
   7. commit misha-vps + AGENTS.md → 8. morning report (layer distribution).

## Conventions honored

No sudo, no Caddy changes, legacy stack untouched, secrets only via
load-secrets.sh, config repo committed+pushed as deployment record, test
scratch in /srv/ssd/tmp/opencode/.

---
## Build deviations & discoveries (2026-10-11, post-build addendum)

1. **Integration**: verified plugin route (see top section). Deployed file:
   `~/.config/opencode/plugins/webfetch-ai.ts`. Verified in a real LLM
   session (standalone run: github layer served repo request; JSONL log).
2. **node-html-markdown vendored** (2.0.0 + 14 transitive pkgs, 1.5MB):
   no node/npm/bun on the box, so no npm install path. `deploy-vendor.sh`
   flattens vendor/<pkg>/<ver>/ -> ~/.config/opencode/node_modules/<pkg>/
   (standard layout; nested version dirs FAIL node CJS resolution — tested).
   Plugin loads NHM lazily via createRequire; missing tree degrades to text.
3. **L0 gate floor**: MIN_TEXT_HTML 300 -> 120. example.com has 156 visible
   chars; the 300 floor pushed healthy small pages to L2.
4. **Exa /contents params** (live-probed): `livecrawl` is deprecated and
   mutually exclusive with `maxAgeHours` — use `maxAgeHours: 24` only.
5. **playwright-ai**: playwright pkg must be installed IN the image (ESM
   can't resolve the image's global install); version must match the image
   tag (1.64.0) with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1. `browser.userAgent()`
   was removed — UA derived from browser.version(). seccomp=unconfined +
   shm 1g works under rootless podman (no custom seccomp profile needed).
6. **External reality (2026)**: reddit now 403s L0, L1 AND Exa
   (SOURCE_NOT_AVAILABLE) — the reddit→Exa shortcut can't succeed today;
   hook point remains for an OAuth path. nowsecure.nl (bot test site)
   legitimately fails all gates — its entire content is 33 chars.
7. **Test matrix** (live): friendly/spa/notfound/gh_repo/gh_blob/gh_issue/pdf
   pass; reddit + bot-wall documented as expected-fail. Latencies: L0
   10-80ms, github 10-460ms, L1 0.9-1.5s, L2 0.2-0.3s.
