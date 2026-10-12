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
  127.0.0.1:8899:8080 loopback-only, Restart=on-failure).
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

Final deploy check (03:16 UTC): the deployed
~/.config/opencode/plugins/webfetch-ai.ts passes a fresh L0 + github-lane
probe against the live service. Overnight arc complete.

---
## Post-report corrections (2026-10-11 morning, user follow-up)

1. **CRITICAL L1 bug found & fixed** (`fa617c6`): fetchPlaywright never set
   `ok:true` on success — `l1.ok` was always `undefined`, so EVERY L1
   success was discarded and L2 re-fetched it (paying Exa for content we
   already had). framer.com now resolves at L1 (12.1KB rendered markdown,
   7.7s). User's question "did we even test L1 does something?" — the
   container worked (health + direct curl), but the chain never USED it.
2. **Reddit partially un-dead** (`aa67072`): keyed /search category=reddit
   does NOT return reddit originals (index gutted — probed with several
   query shapes), BUT the keyless mcp.exa.ai endpoint DOES surface exact
   threads with title/author/highlights. Added a cache-extraction step:
   /contents (future-proof) -> MCP search-cache with id+slug URL matching
   -> general chain. Verified on r/Rag thread 1f9281b: real cached text,
   zero metered cost. Highlights are truncated excerpts, not full threads
   — partial win, honest label in the output header.

---
## Apify lane (2026-10-11 evening)

8. **Reddit primary lane: Apify reddit-scraper-lite**
   (`trudax~reddit-scraper-lite`, pay-per-result ~$0.0034/item).
   comchat/reddit-api-scraper was REJECTED for this lane — keyword/subreddit
   search only, cannot fetch by URL. trudax takes startUrls and returns post
   body + comments with authors/votes; Reddit IDs are global so any host
   (old./np./www) or bare-ID URL redirects fine. Lane order: apify →
   exa /contents → exa mcp search-cache → general chain. Cost cap:
   maxComments 15 (env APIFY_MAX_COMMENTS), ~$0.05/fetch ceiling; free plan
   $5/mo ≈ ~100 capped fetches. Runtime 60-90s (browser-based) — call
   webfetch with timeout≥120 for reddit URLs. Live-verified: r/Rag 1f9281b
   (5 items, ~$0.017) and a redirect case via old.reddit (16 items, 68s).
   Token: APIFY_TOKEN in load-secrets.sh; service restart required after
   adding (TUI restart spawning the server suffices). Single 5xx retry
   after a fixed 5 s wait implemented in-lane (transient 502 observed live
   2026-10-11; retry succeeded).
9. **Share links closed (2026-10-11 evening):** `/r/<sub>/s/<token>` URLs
   now pass the lane gate. They CANNOT be resolved locally — reddit 403s
   the short URL itself (verified, even with browser UA) — but the actor's
   stealth browser resolves them; post.url in the dataset is the canonical
   thread and is surfaced as finalUrl metadata. One transient 502 observed
   from the run-sync endpoint (retry succeeded); actor output quality
   varies run-to-run in fast-RSS mode (entities, missing upVotes).
10. **LICENSE = The Unlicense (2026-10-11):** the code is AI-generated, so
    "is it copyrightable" is a live debate the owner declines to enter —
    least of all over infrastructure. The Unlicense (OSI-approved
    2020-06-12, SPDX `Unlicense`) has the CC0-shaped property that makes
    the debate moot: if no copyright subsists there is nothing to
    dedicate; if some does, it is all given away. Chosen over CC0 because
    the Unlicense IS OSI-approved while CC0 never reached consensus
    (patent non-waiver), and a patent grant is moot for this artifact.
    MIT-style headers rejected because a `Copyright (c)` line asserts
    ownership — precisely the contested claim.

## 2026-10-12 — comment permalinks + wrong-thread cache fix

Two bugs found by a real-world comment-permalink fetch
(`/comments/<id>/comment/<commentId>/`):

1. **Apify lane**: the full permalink path was forwarded verbatim; the actor
   resolves it to the anchor comment only (`dataType: "comment"`, no post),
   and the post-only validation rejected the result (`no post in 1 items`).
2. **Exa-cache fallback**: the URL-shape parser mistook the literal `comment`
   segment for the thread slug → query `comment r/<sub>`; the substring
   scorer then accepted any `/comments/` URL (slug `comment` ⊂ `/comments/`)
   and served a DIFFERENT thread, labeled with that thread's URL.

Probes (run-sync, ~$0.04 of credit): a dual-URL input (permalink + canonical
thread) returns post + comments + anchor in ONE run — the anchor is emitted
twice (dedupe by id), and it survived a maxItems-bound run (anchor present
even with maxComments capped at 2 of 7). Actor ordering between the two URLs
is nondeterministic (anchor observed both first and last). `parentId` is
absent in fast mode (`includeMediaLinks: false`), so ancestor chains are not
reconstructible on this actor. Billing is per stored item: the second URL
adds at most one item (+$0.0034) over a plain thread fetch.

Shipped: `parseRedditShape` (single URL-algebra source; `comment`/`_`
placeholders never treated as slug; ids case-preserved), comment-aware
Apify lane (dual-URL, maxItems = maxComments + 2, post-or-anchor validation,
permalink-only retry guarantee, anchor rendered first, honest context note),
`pickExaThreadBlock` hard thread-id equality rule, unit tests
(`tests/reddit-shape.test.mjs`, 25 cases, no network). CHANGELOG.md started.
