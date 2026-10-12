# Changelog

Notable fixes and improvements to the webfetch-ai plugin and its supporting
bits. Date-based entries, newest first.

## 2026-10-12

### Fixed

- **Reddit: comment permalinks now fetch correctly.** URLs like
  `/r/<sub>/comments/<id>/comment/<commentId>/` (also the `/<slug>/<id>/`
  and `/_/<id>/` forms, with or without `utm_*`/`?context=` query strings)
  used to fail the Apify lane with `apify: no post in 1 items`: the full
  permalink path was forwarded verbatim, the actor resolves it to the anchor
  comment only (`dataType: "comment"`, no post object), and the lane
  required a post. Comment-anchored fetches now send the permalink **plus**
  the canonical thread URL in a single run, validate post-or-anchor, dedupe
  the doubled anchor, render the linked comment first with a
  `→ the linked comment` marker, and fall back to a permalink-only retry
  (1 stored item) if the anchor is somehow missing. Billing is per stored
  item — the anchor adds at most one item over a plain thread fetch; the
  ceiling is now `APIFY_MAX_COMMENTS + 2` items ≈ $0.058/fetch.
  (Verified live against the actor: dual-URL runs stored 4–8 items and the
  anchor survived a `maxItems`-bound run.)

- **Reddit: the Exa search-cache fallback could serve the WRONG thread.**
  For a comment permalink, the derived search query was `"comment r/<sub>"`
  (the literal URL segment was mistaken for the thread slug), and the
  substring scorer accepted any `/comments/` URL because the pseudo-slug
  `comment` is a substring of `/comments/` — so an unrelated thread was
  returned, labeled with its own URL. Block selection now lives in
  `pickExaThreadBlock` and requires the block URL's thread id to **equal**
  the requested thread id; the slug is only a tiebreaker among blocks of the
  matching thread. A different thread can no longer be returned, silently or
  otherwise.

### Changed

- Reddit URL parsing is centralized in `parseRedditShape` (thread / comment
  permalink / share link / other), shared by both consumers; the literal
  `comment`/`_` placeholder segment is never treated as a slug, and query
  strings (`utm_*`, `?context=N`) are stripped for classification. Reddit
  base36 ids keep their original case (they are case-sensitive); comparisons
  lowercase on both sides.
- Subreddit/user/search reddit URLs now skip the Exa search-cache layer
  immediately (it could never thread-verify them) and fall through to the
  general chain, saving one MCP call on a dead end.

### Added

- `tests/reddit-shape.test.mjs`: pure-function regression tests (URL shapes,
  case preservation, query stripping, wrong-thread rejection, slug
  tiebreaks) — no network, no Apify credits.
