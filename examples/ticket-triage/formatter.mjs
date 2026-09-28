// Turns the model's raw reply into the triage record the helpdesk imports.

const WORD = /^[a-z]+$/;

export function formatReply(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const category = String(parsed.category ?? "").trim().toLowerCase();
  const priority = String(parsed.priority ?? "").trim().toLowerCase();
  return {
    category: WORD.test(category) ? category : "",
    priority,
  };
}
