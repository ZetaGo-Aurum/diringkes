#!/usr/bin/env node
// Diringkes primary entry. The `drks` bin symlinks to this same file.

// Grow the libuv thread pool so concurrent Brotli block compression actually
// runs in parallel. This must be set before the pool is first used, so we set
// it here and load the CLI via dynamic import (ESM imports are hoisted).
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "8";
}

const { runCli } = await import("../src/cli.js");

runCli(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
