// Summarize a `claude -p --output-format json` result file and, if given, the
// session transcript it produced: prints turns, tool calls and any `echo tick`.
const fs = require("fs");
const [resultPath, transcriptPath] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
console.log("RESULT", JSON.stringify(pick(r, ["is_error", "terminal_reason", "stop_reason", "num_turns", "session_id", "duration_ms", "total_cost_usd", "permission_denials"])));
console.log("TEXT  ", JSON.stringify(String(r.result || "").slice(0, 300)));
if (transcriptPath && fs.existsSync(transcriptPath)) {
  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  let assistant = 0, toolUses = 0; const ticks = []; const texts = [];
  for (const line of lines) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== "assistant" || !m.message || !Array.isArray(m.message.content)) continue;
    assistant++;
    for (const block of m.message.content) {
      if (block.type === "tool_use") { toolUses++; const cmd = block.input && block.input.command; if (cmd && /echo tick/.test(cmd)) ticks.push(cmd.trim()); }
      if (block.type === "text") texts.push(block.text.slice(0, 80));
    }
  }
  console.log("TRANSCRIPT assistant_messages=" + assistant + " tool_uses=" + toolUses + " ticks=" + JSON.stringify(ticks));
  console.log("ASSISTANT TEXTS " + JSON.stringify(texts));
} else if (transcriptPath) {
  console.log("TRANSCRIPT missing: " + transcriptPath);
}
