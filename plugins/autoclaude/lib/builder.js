// Which Claude Code session is the builder. The hooks run in every session on the machine, and a
// person may open their own session in a project while a supervised run is going; that session
// must get none of the run's rules, gate, guard or markers. The supervisor sets
// AUTOCLAUDE_BUILDER=1 in the builder's environment (lib/supervisor.js childEnv). Without it, a
// live supervisor for the project means "someone else's session"; no supervisor means a run
// started by hand in this very session, which keeps working as before. Node built-ins only.
import fs from "node:fs";
import { projectPaths } from "./paths.js";
import { isPidAlive } from "./proc.js";

// The pid in <root>/.autoclaude/supervisor.pid when that process is alive, else null.
export function liveSupervisorPid(root) {
  let pid = NaN;
  try { pid = Number(String(fs.readFileSync(projectPaths(root).supervisorPidFile, "utf8")).trim()); } catch {}
  return Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
}

export function isBuilderSession(root, env = process.env) {
  if (env && env.AUTOCLAUDE_BUILDER === "1") return true;
  return liveSupervisorPid(root) === null;
}
