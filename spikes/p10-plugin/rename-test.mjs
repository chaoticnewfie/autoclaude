// P0.10 spike: what happens to fs.renameSync when another process holds the
// target open with no sharing (the way an editor, antivirus or PowerShell
// Get-Content can), and whether a short retry loop rides it out.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = path.join(out, "locked.json");
fs.writeFileSync(target, "{\"v\":1}");

// Hold the file open with FileShare.None for 4 seconds from another process.
const ps = "$f=[System.IO.File]::Open('" + target.replace(/\\/g, "\\\\") + "','Open','Read','None'); Start-Sleep -Seconds 4; $f.Close()";
const locker = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
await sleep(1200);

const tmp = target + ".tmp";
fs.writeFileSync(tmp, "{\"v\":2}");
const t0 = Date.now();
let attempts = 0;
const codes = [];
for (;;) {
  attempts++;
  try {
    fs.renameSync(tmp, target);
    break;
  } catch (e) {
    codes.push(e.code);
    if (Date.now() - t0 > 15000) { console.log("GAVE UP after", attempts, "attempts:", codes.slice(-3)); process.exit(1); }
    await sleep(Math.min(100 * attempts, 1000));
  }
}
const result = { attempts, error_codes_seen: [...new Set(codes)], waited_ms: Date.now() - t0, final_content: fs.readFileSync(target, "utf8") };
console.log(JSON.stringify(result));
fs.writeFileSync(path.join(out, "rename-result.json"), JSON.stringify(result, null, 2));
locker.on("exit", () => {});
