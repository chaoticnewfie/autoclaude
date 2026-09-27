// Per-machine registry of projects that use AutoClaude: <config dir>/autoclaude/registry.json
// { "projects": [ { "root", "name", "addedAt" } ] }. Used by `status --all` and the backstop watchdog.
import path from "node:path";
import { readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { machinePaths } from "./paths.js";

export function loadRegistry(file = machinePaths().registryFile) {
  try {
    const j = readJson(file, null);
    return j && Array.isArray(j.projects) ? { projects: j.projects } : { projects: [] };
  } catch {
    return { projects: [] };
  }
}

export function registerProject(root, { file = machinePaths().registryFile, now = new Date() } = {}) {
  const resolved = path.resolve(root);
  const reg = loadRegistry(file);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  let entry = reg.projects.find((p) => same(p.root, resolved));
  let added = false;
  if (!entry) {
    entry = { root: resolved, name: path.basename(resolved), addedAt: now.toISOString() };
    reg.projects.push(entry);
    added = true;
  }
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, reg);
  return { entry, added, projects: reg.projects };
}

export function unregisterProject(root, { file = machinePaths().registryFile } = {}) {
  const reg = loadRegistry(file);
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => path.resolve(p.root).toLowerCase() !== path.resolve(root).toLowerCase());
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, reg);
  return before !== reg.projects.length;
}
