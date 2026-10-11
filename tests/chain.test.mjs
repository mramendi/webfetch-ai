// Integration harness for the webfetch-ai chain — runs the REAL module code
// against live L0/L1 (playwright-ai) and L2 (Exa, if EXA_API_KEY in env).
// Usage: node tests/chain.test.mjs [case ...]   (default: all)
// The plugin file is plain-JS-in-.ts; load via tmp .mjs copy (node has no ts loader).
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

const src = new URL("../opencode/plugins/webfetch-ai.ts", import.meta.url)
const dir = mkdtempSync(join(tmpdir(), "wfai-"))
const tmp = join(dir, "webfetch-ai.mjs")
writeFileSync(tmp, readFileSync(src, "utf8"))
const { __tests } = await import(tmp)
const { fetchChain } = __tests

const CASES = {
  friendly:   { url: "https://example.com", expect: (r) => r.metadata.layer === "L0" },
  spa:        { url: "https://svelte.dev", expect: (r) => ["L0","L1"].includes(r.metadata.layer) && r.content.length > 500 },
  notfound:   { url: "https://example.com/nonexistent-page-xyz", expect: (r) => /404/.test(r.content) },
  gh_repo:    { url: "https://github.com/microsoft/monaco-editor", expect: (r) => r.metadata.layer === "github" && /README/.test(r.content) },
  gh_blob:    { url: "https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt", expect: (r) => r.metadata.layer === "github" && /MIT|Apache|Copyright/i.test(r.content) },
  gh_issue:   { url: "https://github.com/microsoft/monaco-editor/issues/1", expect: (r) => r.metadata.layer === "github" },
  reddit:     { url: "https://www.reddit.com/r/selfhosted/comments/1abcXYZ/does_not_matter/", expect: (r) => ["L2","exa"].includes(String(r.metadata.layer)) || r.content.length > 200 },
  cloudflare: { url: "https://nowsecure.nl", expect: (r) => r.content.length > 100 },
  pdf:        { url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", expect: (r) => r.content.length > 50 },
}

const only = process.argv.slice(2)
const run = only.length ? only : Object.keys(CASES)
let pass = 0, fail = 0
for (const name of run) {
  const spec = CASES[name]
  if (!spec) { console.log(`? unknown case ${name}`); continue }
  const t0 = Date.now()
  try {
    const r = await fetchChain({ url: spec.url, timeout: 60 }, undefined)
    const ms = Date.now() - t0
    const ok = spec.expect(r)
    ok ? pass++ : fail++
    console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(10)} layer=${r.metadata.layer} ${String(r.content.length).padStart(6)}B ${ms}ms ${ok ? "" : "EXPECTATION MISS"}`)
  } catch (e) {
    fail++
    console.log(`FAIL ${name.padEnd(10)} threw: ${String(e.message).slice(0, 140)} (${Date.now() - t0}ms)`)
  }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
