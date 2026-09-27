// Print the user prompts, assistant texts and tool uses in one or more session
// transcripts (JSONL), oldest first. Usage: node transcript-texts.js <path>...
const fs = require("fs");
for (const p of process.argv.slice(2)) {
  console.log("=== " + p.split(/[\\/]/).pop());
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const c = m.message && m.message.content;
    if (m.type === "user" && c) {
      if (typeof c === "string") console.log("USER      " + JSON.stringify(c.slice(0, 160)));
      else for (const b of c) {
        if (b.type === "text") console.log("USER      " + JSON.stringify(b.text.slice(0, 160)));
        if (b.type === "tool_result") console.log("RESULT    " + JSON.stringify(String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 160)));
      }
    }
    if (m.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "text") console.log("ASSISTANT " + JSON.stringify(b.text.slice(0, 160)));
        if (b.type === "tool_use") console.log("TOOL_USE  " + b.name + " " + JSON.stringify(b.input).slice(0, 120));
      }
    }
    if (m.type === "system" && m.subtype) console.log("SYSTEM    " + m.subtype + " " + JSON.stringify(m.content || "").slice(0, 120));
  }
}
