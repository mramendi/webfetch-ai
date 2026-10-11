# webfetch-ai

Multi-layer web fetching for OpenCode on this box: plain HTTP → playwright-ai
container → Exa extract, with deterministic (no-LLM) quality gates between
layers. Replaces the built-in `webfetch` tool by shadowing its name.

## Layout

- `opencode/tools/webfetch.ts` — the orchestrator tool (shadows built-in
  `webfetch` when deployed to `~/.config/opencode/tools/`); needs
  `~/.config/opencode/package.json` for npm deps.
- `playwright-ai/` — Containerfile + Node fetch service (stealth Chromium,
  waits, scroll, readability→markdown) baked into
  `localhost/playwright-ai:latest`.
- `quadlet/` — `playwright-ai.build` + `playwright-ai.container` units.
- `tests/` — layer probes and the URL test matrix; run with `node`/`bun`.

## Deploy flow

Dev here → copy into `~/.config` (tools file, package.json, Containerfile +
service dir, quadlet units) → `systemctl --user daemon-reload` → commit the
config repo (misha-vps) as the deployment record. Live config never holds
broken intermediate states: iterate here first.

## Secrets / env

- `EXA_API_KEY` — in `~/.config/ai/load-secrets.sh`, consumed by the webfetch
  tool (layer 3) only. search-cycle keeps Exa search keyless (guard edit).
- GitHub layer: unauthenticated (`raw.githubusercontent.com` + api.github.com
  60 req/hr). Optional future: `GITHUB_TOKEN`.
- Reddit: intentionally via Exa for now; classifier hook point reserved for a
  future Reddit OAuth path.

## Diagnostics

JSONL attribution log at `~/.local/share/opencode/webfetch-cycle.log`
(layer used, ms, bytes, status) — audit layer distribution there. Test
artifacts live in `/srv/ssd/tmp/opencode/webfetch-tests/` (not committed).

## Repo notes

Local git only for now (no GitHub creds on the box to create a remote).
Add a private remote later; deployment safety net is the misha-vps config
repo.
