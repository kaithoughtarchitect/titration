# Titration MCP — Core Learnings (the curated universal base)

**Version:** 0.5
**Date:** 2026-08-04
**Status:** Curated source for the read-only universal base (`__base__`).

This folder is the **deliberately curated, domain-agnostic universal base** available in the read-only `__base__` project. Each card is a distilled principle from real evaluation practice, generalized so it applies to any codebase — the domain-specific example behind a card is not carried forward.

## The curation rule

A card belongs in the base **only if its principle is domain-independent.** When a base-eligible card carries a worked example, the example is **abstracted to neutral form and explicitly marked `Illustrative (one domain)`** — the principle ships, the domain does not.

Rough test: *"would this card help a team doing legal bots, support bots, or RAG, with no edit beyond swapping the example?"* If yes → base. If the principle only makes sense inside one specific product, it stays out of the base.

## Card format

Each card below carries: `id`, `type`, `confidence`, `tags`, a domain-independent **Principle**, **Why it matters**, an optional **Illustrative (one domain)** block (clearly not part of the principle), **Relationships** (edges to other base cards + `documented_in` spec sections), and **Origin** (a short traceability note, not shipped to project-visible reads).

At ingestion the cards become rows under `tenant_id = '__base__'`, stored once in the read-only `__base__` project and never joined into project-visible reads.

## Provenance & privacy

- The `Origin` field on each card records a short provenance note for traceability only; it never carries private data.
- The base improves by **curation only** — it never ingests project data, and a project's failures never pool here.

## Status — curated Base source (66 cards across five batches)

- `CORE-LEARNINGS-v0.1.md` — 11 cards (judge-discipline + measurement-integrity cluster).
- `CORE-LEARNINGS-v0.2.md` — 16 cards (corpus discipline, verdict cluster, judge calibration, diagnostic/edit discipline).
- `CORE-LEARNINGS-v0.3.md` — 22 cards (remaining base-eligible methodology + universal findings; completes the base).
- `CORE-LEARNINGS-v0.4.md` — 1 card (the engine-grades / harness-captures boundary).
- `CORE-LEARNINGS-v0.5.md` — 16 cards (retirement curation batch plus one prior database-only card).

The Base covers domain-agnostic evaluation methodology. Curation is deliberate: source-specific examples, model profiles, and infrastructure observations stay out of the base; only generalized principles ship here.

`ingest:base` synchronizes these batches as one set of rows under `tenant_id = '__base__'`, stored once in the read-only `__base__` project and never joined into project-visible reads.
