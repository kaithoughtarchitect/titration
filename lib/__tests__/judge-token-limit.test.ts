// Titration MCP — OpenRouter token ceiling (no network: fetch is stubbed; ideal-model
// transport, because this only inspects the request the engine sends).
// A ceiling low enough for a reasoning model's thinking to use it up cuts off the
// answer, and the judge drops off the panel with invalid JSON.
// Run: npx tsx lib/__tests__/judge-token-limit.test.ts

export {};

process.env.OPENROUTER_API_KEY = "test-key-not-real";

const { callJudge } = await import("../judge");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

let body: { max_tokens?: number; reasoning?: { effort?: string } } = {};
globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
  body = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"PASS"}' } }] }), { status: 200 });
}) as unknown as typeof fetch;

const answer = await callJudge(
  { id: "x-ai/grok-4.7", family: "x-ai", door: "openrouter", model: "x-ai/grok-4.7", effort: "high" },
  "system",
  "user",
);

check("the stubbed call returns the parsed answer", answer?.label === "PASS", JSON.stringify(answer));
check("the effort is still sent", body.reasoning?.effort === "high", JSON.stringify(body));
check("the ceiling leaves room for thinking and the answer", body.max_tokens === 16_000, String(body.max_tokens));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
