---
name: Propose a base learning
about: Suggest a new card for the curated docs/core-learnings/ base
title: "[learning] "
labels: learning
assignees: ''
---

**Proposed principle**

State the domain-independent principle in one or two sentences — the thing
you want the card to teach, not the specific incident that taught it to you.

**Why it matters**

What goes wrong if someone doesn't know this?

**Illustrative example (optional)**

If you have a concrete example, include it here, but keep any specifics
(client names, real prompts, private data) out — per
`docs/core-learnings/README.md`'s curation rule, an example that ships in the
base is abstracted to neutral form; the principle ships, the domain doesn't.

**Where it fits**

Does this relate to or supersede an existing card (`T-XXX-NNN`)? Link it if
you know the ref.

**Are you willing to open the PR yourself?**

If yes, see "How to contribute a learning" in `CONTRIBUTING.md` — a card
section following the existing format, then `npm run ingest:base` +
`npm run retrieval:eval` before submitting. If no, that's fine — a maintainer
may pick this up, reviewed by hand either way.
