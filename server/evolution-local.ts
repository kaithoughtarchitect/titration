// Titration MCP (OSS) — the local (self-hosted) evolution-capture adapter.
//
// Replaces server/server.ts's former inline no-op adapter. Wires lib/evolution-local.ts's
// preflight + write into the McpEvolutionAdapter interface server/mcp-server.ts's
// goal_titrate_step dispatch already calls: `prepare` runs BEFORE grading (the
// completeness preflight against the job's latest existing turn); `capture` runs
// AFTER grading (the note upsert for the turn stepGoalTitrate just created).
// mcp-server.ts's dispatch code and its existing try/catch around `capture` are
// untouched.
//
// No separate web app, no local push client, no prompt_content table: `prompt_file`
// (if the caller sends one) is accepted by the published schema for shape parity but
// is never read here — exact prompt text is never stored in this build.

import { nextGoalTitrateTurnNo, preflightEvolution, upsertChangeNote } from "../lib/evolution-local";
import type {
  CaptureEvolutionInput,
  EvolutionCapture,
  McpEvolutionAdapter,
  PreparedEvolutionInput,
} from "./mcp-server";

export interface LocalPreparedEvolution {
  nextTurnNo: number;
}

async function prepareLocalEvolution(
  input: PreparedEvolutionInput<"trusted-local">,
): Promise<LocalPreparedEvolution> {
  const nextTurnNo = await nextGoalTitrateTurnNo(input.tenant, input.jobId);
  await preflightEvolution(input.tenant, input.jobId, nextTurnNo);
  return { nextTurnNo };
}

async function captureLocalEvolution(
  input: CaptureEvolutionInput<LocalPreparedEvolution, "trusted-local">,
): Promise<EvolutionCapture> {
  await upsertChangeNote(input.tenant, input.jobId, input.turn, input.note, input.artifactKind);
  return { complete: true };
}

export function createLocalEvolutionAdapter():
  McpEvolutionAdapter<LocalPreparedEvolution, "trusted-local"> {
  return {
    mode: "trusted-local",
    prepare: prepareLocalEvolution,
    capture: captureLocalEvolution,
  };
}
