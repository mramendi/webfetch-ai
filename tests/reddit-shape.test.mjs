// Pure-function tests for the reddit URL algebra — no network, no Apify credits.
// Same loader trick as chain.test.mjs: the plugin is plain-JS-in-.ts, so copy
// to a tmp .mjs and import the __tests hook.
//
// Regression origin (2026-10-12): a comment-permalink fetch
//   /comments/1x3auj0/comment/pfb2jc8/
// failed the Apify lane ("no post in 1 items") AND fell through to the Exa
// search-cache layer, whose URL-derived query was "comment r/opencode" (the
// literal segment was mistaken for a slug) and whose substring scorer then
// accepted a DIFFERENT thread ("comment" ⊂ "/comments/"). These tests pin
// both behaviors closed.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const src = new URL("../opencode/plugins/webfetch-ai.ts", import.meta.url)
const dir = mkdtempSync(join(tmpdir(), "wfai-"))
writeFileSync(join(dir, "webfetch-ai.mjs"), readFileSync(src, "utf8"))
const { __tests } = await import(join(dir, "webfetch-ai.mjs"))
const { parseRedditShape, pickExaThreadBlock } = __tests

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`)
  }
}
const ok = (name, cond, detail) => {
  if (cond) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}
const shapeOf = (url) => {
  const s = parseRedditShape(url)
  return s && { kind: s.kind, sub: s.sub, threadId: s.threadId, slug: s.slug, commentId: s.commentId }
}

const B = "https://www.reddit.com/r/opencode/comments/1x3auj0"
const SLUG = "glm_53_flash_on_opencode_go_q"

// --- parseRedditShape: threads -------------------------------------------------
eq("thread bare", shapeOf(`${B}/`), { kind: "thread", sub: "opencode", threadId: "1x3auj0", slug: null, commentId: null })
eq("thread with slug", shapeOf(`${B}/${SLUG}/`), { kind: "thread", sub: "opencode", threadId: "1x3auj0", slug: SLUG, commentId: null })
eq("thread no trailing slash", shapeOf(B), { kind: "thread", sub: "opencode", threadId: "1x3auj0", slug: null, commentId: null })
eq("old.reddit host", shapeOf("https://old.reddit.com/r/OpenWebUI/comments/1m3sv1a/whats_your_favorite_things_about_open_webui/"), {
  kind: "thread", sub: "OpenWebUI", threadId: "1m3sv1a", slug: "whats_your_favorite_things_about_open_webui", commentId: null,
})
eq("placeholder without comment id stays a thread", shapeOf(`${B}/comment/`), { kind: "thread", sub: "opencode", threadId: "1x3auj0", slug: null, commentId: null })
eq("ids keep original case", shapeOf("https://Old.Reddit.com/r/OpenWebUI/comments/1M3SV1A/"), {
  kind: "thread", sub: "OpenWebUI", threadId: "1M3SV1A", slug: null, commentId: null,
})

// --- parseRedditShape: comment permalinks --------------------------------------
eq("comment share form", shapeOf(`${B}/comment/pfb2jc8/`), { kind: "comment", sub: "opencode", threadId: "1x3auj0", slug: null, commentId: "pfb2jc8" })
eq("comment slug form", shapeOf(`${B}/${SLUG}/pfb2jc8/`), { kind: "comment", sub: "opencode", threadId: "1x3auj0", slug: SLUG, commentId: "pfb2jc8" })
eq("comment underscore form", shapeOf(`${B}/_/pfb2jc8/`), { kind: "comment", sub: "opencode", threadId: "1x3auj0", slug: null, commentId: "pfb2jc8" })
eq("comment with utm + context query", shapeOf(`${B}/comment/pfb2jc8/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&context=3`), {
  kind: "comment", sub: "opencode", threadId: "1x3auj0", slug: null, commentId: "pfb2jc8",
})
eq("comment ids keep original case", shapeOf(`${B}/comment/PFB2JC8/`).commentId, "PFB2JC8")

// --- parseRedditShape: shares, non-threads, non-reddit -------------------------
eq("share link under sub", shapeOf("https://www.reddit.com/r/opencode/s/t2p9i2RJsj"), { kind: "share", sub: null, threadId: null, slug: null, commentId: null })
eq("share link at root", shapeOf("https://www.reddit.com/s/t2p9i2RJsj"), { kind: "share", sub: null, threadId: null, slug: null, commentId: null })
eq("subreddit URL is other", shapeOf("https://www.reddit.com/r/OpenWebUI/").kind, "other")
ok("subreddit URL not matchable as thread", shapeOf("https://www.reddit.com/r/OpenWebUI/").threadId === null)
eq("user URL is other", shapeOf("https://www.reddit.com/user/lukaskrivka").kind, "other")
eq("non-reddit URL is null", parseRedditShape("https://example.com/foo"), null)
eq("garbage URL is null", parseRedditShape("not a url at all"), null)

// --- pickExaThreadBlock --------------------------------------------------------
const BLOCKS = [
  "Title: Why do people use OpenCode?\nURL: https://www.reddit.com/r/opencode/comments/1w1hqva/why_do_people_use_opencode/\nHighlights: plenty of agents, model agnostic, by far the best TUI available…",
  "Title: GLM 5.3 Flash on OpenCode Go - quality/quant, speed?\nURL: https://www.reddit.com/r/opencode/comments/1x3auj0/glm_53_flash_on_opencode_go_q/\nHighlights: I am getting good results with GLM 5.3 Flash, on NanoGPT PAYG…",
]
const blockWith = (id) => BLOCKS.find((b) => b.includes(`/comments/${id}/`))

// THE regression: slug "comment" is a substring of every /comments/ URL —
// the old scorer picked the 1w1hqva block for a 1x3auj0 request.
eq("wrong-thread block rejected despite slug substring", blockWith(pickExaThreadBlock(BLOCKS, "1x3auj0", "comment")?.blockUrl && "1x3auj0"), blockWith("1x3auj0"))
ok("picked block really is the requested thread", pickExaThreadBlock(BLOCKS, "1x3auj0", "comment")?.blockUrl?.includes("/comments/1x3auj0/") === true)
eq("other thread picked on its own request", pickExaThreadBlock(BLOCKS, "1w1hqva", null)?.blockUrl?.includes("/comments/1w1hqva/"), true)
eq("unknown thread yields null", pickExaThreadBlock(BLOCKS, "zzzzzzz", null), null)
eq("no threadId yields null", pickExaThreadBlock(BLOCKS, undefined, "comment"), null)

// slug tiebreak within one thread: same thread linked with and without slug
const TIE = [
  "Title: t\nURL: https://www.reddit.com/r/opencode/comments/1x3auj0/\nHighlights: aaaaaa aaaaaa aaaaaa",
  "Title: t\nURL: https://www.reddit.com/r/opencode/comments/1x3auj0/glm_53_flash_on_opencode_go_q/\nHighlights: bbbbbb bbbbbb bbbbbb",
]
ok("slug match breaks ties inside the matching thread", pickExaThreadBlock(TIE, "1x3auj0", SLUG)?.blockUrl?.includes(SLUG) === true)
ok("blocks without a URL line are skipped", pickExaThreadBlock(["no url here", ...TIE], "1x3auj0", SLUG) !== null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
