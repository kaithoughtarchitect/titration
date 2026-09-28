// Titration MCP — one-command self-hosted bootstrap: migrate -> ingest the base -> embed.
//
// Run: npm run setup   (idempotent; safe to re-run against the same database)
//
// Missing OPENROUTER_API_KEY is NOT a setup failure: the curated base still loads
// (ingest-base's own inline embed attempt fails open, and the explicit embed step
// below is skipped), just unembedded — cardSearch filters `embedding is not null`,
// so the cards exist but are not yet vector-searchable. This prints one clear line
// naming the follow-up (set the key, then `npm run embed`) and exits 0 either way.

import "../server/bootstrap-env";

import { migrationUrlFromEnvironment, runMigrations } from "./migrate";
import { ingestBase } from "../ingest/ingest-base";
import { embedAllUnembedded } from "../ingest/embed-cards";

async function main(): Promise<void> {
  if (!process.env.TITRATION_DATABASE_URL?.trim()) {
    console.error("Set TITRATION_DATABASE_URL before running `npm run setup` (see .env.example).");
    process.exitCode = 1;
    return;
  }

  console.log("[setup] applying migrations...");
  await runMigrations({
    mode: "apply",
    databaseUrl: migrationUrlFromEnvironment(),
    applyConfirmation: process.env.TITRATION_MIGRATION_CONFIRM,
  });

  console.log("[setup] loading the curated base (__base__)...");
  await ingestBase();

  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      "[setup] OPENROUTER_API_KEY is not set — the base is loaded but UNEMBEDDED, so vector "
      + "search stays off. Set OPENROUTER_API_KEY and run `npm run embed` to finish.",
    );
    return;
  }

  console.log("[setup] embedding any remaining unembedded cards...");
  await embedAllUnembedded();
  console.log("[setup] done — the base is loaded and searchable.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
