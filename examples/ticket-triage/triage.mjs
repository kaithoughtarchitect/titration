// Triage support tickets: ask a model for {category, priority}, then format the reply.
// Usage: node triage.mjs [tickets.jsonl]   (needs OPENROUTER_API_KEY in the environment or .env)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { formatReply } from "./formatter.mjs";

const MODEL = process.env.TRIAGE_MODEL ?? "deepseek/deepseek-v4-flash-0731";

function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (existsSync(".env")) {
    const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith("OPENROUTER_API_KEY="));
    if (line) return line.slice("OPENROUTER_API_KEY=".length).trim();
  }
  throw new Error("OPENROUTER_API_KEY is not set");
}

async function ask(key, system, ticket) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: ticket }],
    }),
  });
  if (!res.ok) throw new Error(`model call failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.choices[0].message.content;
}

const key = loadKey();
const system = readFileSync("prompt.txt", "utf8");
const file = process.argv[2] ?? "tickets.jsonl";
const tickets = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const rows = [];
for (const t of tickets) {
  const raw = await ask(key, system, t.text);
  const triage = formatReply(raw);
  rows.push({ id: t.id, text: t.text, raw, triage });
  console.log(`${t.id}\t${triage.category || "(none)"}\t${triage.priority}`);
}

mkdirSync("runs", { recursive: true });
const out = `runs/run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nwrote ${out}`);
