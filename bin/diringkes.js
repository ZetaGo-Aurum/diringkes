#!/usr/bin/env node
// Diringkes primary entry. The `drks` bin symlinks to this same file.
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
