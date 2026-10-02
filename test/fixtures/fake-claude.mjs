// Stands in for `claude -p` in the headless-runner tests. Behaviour from FAKE_CLAUDE_MODE.
import fs from "node:fs";

const prompt = fs.readFileSync(0, "utf8");
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const args = process.argv.slice(2);

if (mode === "sleep") {
  setTimeout(() => {}, 60000);
} else if (mode === "garbage") {
  process.stdout.write("this is not json");
} else if (mode === "error") {
  process.stdout.write(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "ran out of turns" }));
} else if (mode === "nostruct") {
  process.stdout.write(JSON.stringify({ is_error: false, result: "hello", num_turns: 2 }));
} else if (mode === "noise") {
  process.stdout.write("some warning line\n" + JSON.stringify({ is_error: false, num_turns: 1, structured_output: { ok: true } }) + "\n");
} else {
  process.stdout.write(JSON.stringify({ is_error: false, num_turns: 3, total_cost_usd: 0.012, session_id: "fake", structured_output: { prompt, role: process.env.AUTOCLAUDE_ROLE, effort: process.env.CLAUDE_EFFORT ?? null, args } }));
}
