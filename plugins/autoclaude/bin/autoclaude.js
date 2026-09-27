#!/usr/bin/env node
// AutoClaude CLI. Node built-ins only. Every command is small and delegates to lib/.
import { runCli } from "../lib/cli.js";

const code = await runCli(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
process.exit(code);
