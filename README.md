# webfetch-ai

> **⚠️ EXPERIMENTAL — not yet human reviewed.**
> This project was built end-to-end by an AI coding agent (OpenCode + GLM)
> under human direction. No human has yet read the code line-by-line. It is
> public because it works and is live-tested, but the author does not stand
> over it yet. Read before you trust it with anything that matters.

Layered web fetching for [OpenCode](https://opencode.ai), replacing the
built-in `webfetch` tool with a resilient chain: plain HTTP first, then a
headless-Chromium service, then the Exa extract API — plus dedicated lanes
for GitHub and Reddit. Built and deployed from this repo; the live config
(`~/.config/opencode`) only ever receives verified, committed states.

## How it attaches to OpenCode

One TypeScript file is the entire integration. OpenCode loads every `.ts`
in `~/.config/opencode/plugins/` into the server process, after its internal
tools. The plugin's whole surface is:

```ts
export const WebfetchAiPlugin = {
  async setup(context) {
    context.tool.transform((editor) => {
      editor.add({ name: "webfetch", /* full tool schema + execute */ })
    })
  },
}
```

`editor.add` with the **same name as the built-in `webfetch` tool overwrites
it** — a deliberate shadow. The model-facing contract is identical to the
stock tool (`url`, `format`, `timeout`), so nothing upstream changes; only
the backend is different.

Lifecycle notes learned the hard way:

- **Editing the plugin file hot-reloads into the running service.** Deploy is
  a file copy; no restart needed.
- **Environment variables do not hot-reload.** The plugin runs inside the
  server process, whose env is a snapshot from launch. Adding a key requires
  restarting the service from a shell that has the new env.
- **Version coupling is real.** The plugin API (`setup` + `tool.transform`)
  is tied to OpenCode 2.x; this repo is built and pinned against
  **v2.0.26**. A future OpenCode upgrade that reshapes the plugin API will
  break this loudly at load time (by design: a broken shadow must never load
  silently).
- `codemode: false` keeps the tool out of agent code-execution catalogs —
  it should be *the* webfetch, not a building block inside scripts.
- `__tests` exports internals so the test harness can import them without a
  plugin runtime.

## Fetching chain

```
request
  │
  ├─ github.com / raw.githubusercontent.com ──► URL algebra (unauthenticated,
  │    no scraping: blob→raw CDN, tree→contents API, repo→meta+README,
  │    issue/PR→API+comments; failure falls through to the general chain)
  │
  ├─ reddit.com ──────────────────────────────► Apify reddit-scraper-lite
  │    (full thread: post body + comments with authors/votes. Accepts
  │     classic /comments/<id> URLs AND /s/ share links — the short form
  │     is 403'd to plain clients but resolved by the actor's browser.
  │     fallbacks: Exa /contents → Exa keyless MCP search-cache → chain.
  │     Reddit 403s all direct fetching since the 2026 lockdown)
  │
  └─ general chain:
       L0 plain fetch (Chrome UA) ── deterministic quality gate:
         http≥400, cf-mitigated header, challenge markers (first 4KB),
         non-textual mime, visible-text floor (120 html / 50 plain),
         text/markup ratio <2% on >20KB pages, PDF→L2
         │ pass → html→markdown (vendored node-html-markdown) → result
         │ 404/410 → terminal "not found" (no failover)
         ▼
       L1 playwright-ai container (localhost:8899, stealth chromium,
         domcontentloaded→body→networkidle→scroll, readability+markdown,
         concurrency 2) ── post-render re-gate (status, text floor, markers)
         │ pass → markdown → result
         ▼
       L2 Exa /contents (maxAgeHours 24 = live crawl when stale,
         handles PDFs + bot-walls) → result
         ▼
       all failed → structured error with per-layer attribution
```

Total failure is honest and loud: the error names every layer attempted and
why each was rejected.

## Costs & external services

| Layer | Service | Cost |
|---|---|---|
| GitHub lane | api.github.com + raw CDN | free (60 req/h unauthenticated; `GITHUB_TOKEN` raises it) |
| L0 | plain fetch | free |
| L1 | your own playwright-ai container | free (local compute) |
| Reddit lane | Apify `trudax/reddit-scraper-lite` | pay-per-result ≈ $0.0034/item; comment count is capped (`APIFY_MAX_COMMENTS`, default 15) → ≈ $0.05/fetch ceiling |
| L2 | Exa `/contents` | $1/1k pages; only spent when L0/L1 fail the gate |

Every API is optional and the chain degrades gracefully: no `EXA_API_KEY`
skips L2, no `APIFY_TOKEN` skips the Reddit lane (falling back to the Exa
search-cache path), no playwright-ai container skips L1.

**Runtime expectation:** the Reddit lane is browser-based and takes
**60–90 s** — call it with `timeout: 120` or higher. Everything else
completes in seconds. A transient 5xx from the Apify run endpoint is
retried exactly once (fixed 5 s wait; 4xx never retried).

Every attempt is logged (JSONL) to `~/.local/share/opencode/webfetch-cycle.log`
including which layer served the result. Note for adopters: this means
**every fetched URL is recorded locally** — point `WEBFETCH_LOG_FILE`
somewhere disposable if you mind.

## Layout

    plan.md              full spec + decision log (the honest history, including
                         dead ends — Reddit lockdown, the L1 bug, actor choices)
    opencode/plugins/
      webfetch-ai.ts     the tool (single file; node builtins only; node-html-markdown
                         loaded lazily via createRequire; deploys to ~/.config/opencode/plugins/)
      vendor/            pinned dependency tree, 15 pkgs (node-html-markdown 2.0.0
                         + transitive deps), integrity-verified, committed to this repo —
                         no registry access needed
    opencode/config/
      deploy-vendor.sh   flattens vendor/ → ~/.config/opencode/node_modules/<pkg>/
      package.json       written to ~/.config/opencode/package.json
    playwright-ai/       L1 container: Containerfile, fetch-server.mjs, package.json
    quadlet/             playwright-ai.build / playwright-ai.container systemd units (podman rootless)
    tests/chain.test.mjs live integration harness (node 22, real L0/L1/L2)

The vendor directory is committed **flat by version** (`vendor/<pkg>/<version>/`)
and deployed flat by package (`node_modules/<pkg>/`) — nested version dirs
break Node module resolution; this was tested and is why the deploy script
exists.

## Deploy

    # deps (idempotent, offline, no npm required):
    opencode/config/deploy-vendor.sh
    # tool (hot-reloads into the running service):
    cp opencode/plugins/webfetch-ai.ts ~/.config/opencode/plugins/
    # L1 container (first time or after changes):
    cp playwright-ai/* ~/.config/containers/playwright-ai/
    cp quadlet/* ~/.config/containers/systemd/
    systemctl --user daemon-reload && systemctl --user start playwright-ai-build
    systemctl --user start playwright-ai && curl -s localhost:8899/healthz

Without the container, the chain still works — L0 and L2 cover most pages;
L1 exists for JavaScript-rendered sites, anti-bot walls, and PDFs.

## Env

    EXA_API_KEY               L2 extract API (set via your env/secrets file)
    APIFY_TOKEN               Reddit lane (Apify account token, FREE plan is enough)
    APIFY_MAX_COMMENTS        Reddit comment cap per fetch (default 15, max 50)
    GITHUB_TOKEN              optional; raises GH API rate limit from 60/h
    WEBFETCH_PLAYWRIGHT_URL   default http://127.0.0.1:8899/fetch
    WEBFETCH_LOG_FILE         default ~/.local/share/opencode/webfetch-cycle.log
    WEBFETCH_EXA_MAX_CHARS    L2 text truncation limit

Remember: env changes need a service restart from a shell that has them.
File changes hot-reload. (If the service is spawned by your TUI, restarting
the TUI suffices.)

## Verify

    node tests/chain.test.mjs                 # live matrix (needs playwright-ai up)
    tail -f ~/.local/share/opencode/webfetch-cycle.log

The live matrix covers: friendly static page, SPA (L1), 404, GitHub
repo/blob/issue, PDF, Reddit thread, and a documented expected-fail
(bot-wall site whose entire content is 33 chars).

## Verification status (as of 2026-10-11)

- GitHub lane: repo / blob / issue live-verified, 10–460 ms, zero cost.
- General chain: L0 gate pass/fail behavior live-verified; L1 post-render
  path live-verified after an early bug (L1 results were being discarded —
  fixed); L2 metered path exercised only when lower layers fail.
- Reddit lane: full-thread fetch live-verified on real threads, including
  cross-host redirects (`old.reddit.com` → canonical) and `/s/` share
  links (resolved by the actor's browser — the short URL 403s locally).
- All external endpoints are probed at runtime with graceful degradation;
  nothing is assumed reachable.

## Limitations & honest notes

- **Unreviewed.** See the banner. The code is ~830 lines of plain JS in one
  file plus a small fetch server — a deliberate choice to keep the review
  surface small.
- **Reddit is a workaround era.** The official Reddit API access request is
  pending; the Apify actor is third-party, paid-per-result, and could change
  or vanish. The lane order and caps make that survivable.
- **The Exa MCP search-cache fallback** returns truncated highlights, not
  full threads; it is labeled honestly in its output header when it serves.
- **Built for one home server.** Paths assume `~/.config/opencode` and a
  rootless-podman systemd-user setup. It is not a packaged product.
- **No anonymity guarantees.** L0 sends a Chrome UA; L1 uses a stealth
  chromium; Reddit lane goes through Apify's infrastructure. Pick per your
  threat model.
