// Status line command: records what Claude Code sends (rate_limits and friends).
const fs = require("fs");
const path = require("path");
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = null;
try { input = JSON.parse(raw); } catch {}
fs.writeFileSync(path.join(outDir, "statusline-last.json"), raw);
const compact = {
  at: new Date().toISOString(),
  keys: input ? Object.keys(input) : null,
  rate_limits: input ? input.rate_limits : undefined,
  model: input && input.model ? input.model.display_name || input.model.id : undefined,
  session_id: input ? input.session_id : undefined
};
fs.appendFileSync(path.join(outDir, "statusline.jsonl"), JSON.stringify(compact) + "\n");
const rl = input && input.rate_limits;
const five = rl && rl.five_hour ? rl.five_hour.used_percentage : "?";
const week = rl && rl.seven_day ? rl.seven_day.used_percentage : "?";
process.stdout.write("AC spike | 5h " + five + "% | 7d " + week + "%");
