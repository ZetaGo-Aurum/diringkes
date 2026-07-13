// test/engine.test.js
// End-to-end integrity tests for the Diringkes archive engine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compressTargets, extractTargets, inspectArchive } from "../src/core/engine.js";
import { humanizeBytes } from "../src/util/humanize.js";

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "drk-test-"));
}

test("round-trip: identical bytes after compress -> extract", async () => {
  const dir = await makeTmp();
  const src = path.join(dir, "src");
  await fs.mkdir(src);
  const files = {
    "a.bin": Buffer.concat([Buffer.alloc(100000, 7), Buffer.from("tail")]),
    "b.txt": Buffer.from("diringkes ".repeat(5000)),
    "sub/c.bin": Buffer.alloc(40000, 1),
  };
  for (const [p, data] of Object.entries(files)) {
    const fp = path.join(src, p);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, data);
  }

  const archive = path.join(dir, "out.drk");
  const res = await compressTargets({ targets: [src], output: archive, mode: "ultra" });
  assert.ok(res.compBytes > 0);
  assert.equal(res.inputCount, 3);

  const info = await inspectArchive(archive);
  assert.equal(info.files.length, 3);

  const dest = path.join(dir, "restored");
  await extractTargets({ archive, dest });

  for (const p of Object.keys(files)) {
    const original = files[p];
    const restored = await fs.readFile(path.join(dest, "src", p));
    assert.equal(Buffer.compare(original, restored), 0, `mismatch on ${p}`);
  }
});

test("deduplication: replicated content collapses", async () => {
  const dir = await makeTmp();
  const src = path.join(dir, "dup");
  await fs.mkdir(src);
  const base = Buffer.alloc(1024 * 1024, 42); // 1MB of identical bytes
  for (let i = 0; i < 20; i++) {
    await fs.writeFile(path.join(src, `f${i}.bin`), base);
  }
  const archive = path.join(dir, "dup.drk");
  const res = await compressTargets({ targets: [src], output: archive, mode: "ultra" });
  // 20MB raw -> far smaller thanks to dedup
  assert.ok(res.compBytes < 2 * 1024 * 1024, "expected strong dedup compression");
  assert.ok(res.factor > 5, `expected high ratio, got ${res.factor}`);
});

test("humanizeBytes formats correctly", () => {
  assert.equal(humanizeBytes(0), "0 B");
  assert.equal(humanizeBytes(1024), "1.00 KB");
  assert.equal(humanizeBytes(1024 * 1024 * 1024), "1.00 GB");
});
