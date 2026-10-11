# webfetch-ai

Layered web fetching for OpenCode, replacing the built-in `webfetch` tool
with a resilient chain. Built and deployed from this repo; live config
(`~/.config/opencode`) only ever receives verified, committed states.

## Architecture

```
request
  │
  ├─ github.com / raw.githubusercontent.com ──► URL algebra (unauthenticated
  │    blob→raw, tree→contents API, repo→meta+readme, issue/PR→API+comments;
  │    failure falls through to the general chain)
  │
  ├─ reddit.com ──────────────────────────────► L2 Exa directly
  │    (reddit 403s everything else since the 2026 lockdown; Exa too —
  │     documented limitation, hook point reserved for a future OAuth path)
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
       L2 Exa /contents (EXA_API_KEY, maxAgeHours 24 = live crawl when stale,
         handles PDFs + bot-walls) → result
         ▼
       all failed → structured error with per-layer attribution
```

Every attempt is logged (JSONL) to `~/.local/share/opencode/webfetch-cycle.log`.

## Layout

    plan.md              full locked spec
    opencode/plugins/
      webfetch-ai.ts     the tool (single file, node builtins only; NHM loaded
                         lazily via createRequire; deploys to ~/.config/opencode/plugins/)
      vendor/            pinned dependency tree, 15 pkgs (node-html-markdown 2.0.0
                         + transitive deps), integrity-verified, no registry access
    opencode/config/
      deploy-vendor.sh   flattens vendor/ → ~/.config/opencode/node_modules/<pkg>/
      package.json       written to ~/.config/opencode/package.json
    playwright-ai/       L1 container: Containerfile, fetch-server.mjs, package.json
    quadlet/             playwright-ai.build / playwright-ai.container units
    tests/chain.test.mjs live integration harness (node 22, real L0/L1/L2)

## Deploy

    # deps (idempotent, offline):
    opencode/config/deploy-vendor.sh
    # tool (hot-reloads into the running service):
    cp opencode/plugins/webfetch-ai.ts ~/.config/opencode/plugins/
    # L1 container (first time or after changes):
    cp playwright-ai/* ~/.config/containers/playwright-ai/
    cp quadlet/* ~/.config/containers/systemd/
    systemctl --user daemon-reload && systemctl --user start playwright-ai-build
    systemctl --user start playwright-ai && curl -s localhost:8899/healthz

## Verify

    node tests/chain.test.mjs                 # live matrix (needs playwright-ai up)
    tail -f ~/.local/share/opencode/webfetch-cycle.log

## Env

    EXA_API_KEY               L2 (via ~/.config/ai/load-secrets.sh)
    GITHUB_TOKEN              optional, raises GH API rate limit from 60/h
    WEBFETCH_PLAYWRIGHT_URL   default http://127.0.0.1:8899/fetch
    WEBFETCH_LOG_FILE         default ~/.local/share/opencode/webfetch-cycle.log
