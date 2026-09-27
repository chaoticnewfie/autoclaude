#!/usr/bin/env node
// AutoClaude CLI. Node built-ins only. Every command is small and delegates to lib/.
import { runCli } from "../lib/cli.js";

// Set the exit code and let the event loop drain: a forced process.exit() right after a
// fetch crashes Node on Windows with a libuv assertion while the connection is closing.
process.exitCode = await runCli(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
