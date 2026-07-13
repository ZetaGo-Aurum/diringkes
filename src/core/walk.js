// src/core/walk.js
// Filesystem walker that produces the input descriptor list consumed by the
// archive engine. Strips a common base path to keep stored paths tidy.

import { promises as fs } from "node:fs";
import path from "node:path";

export async function gatherInputs(targets, { base = null } = {}) {
  const inputs = [];
  const seen = new Set();

  async function walk(abs, relBase) {
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === "." || e.name === "..") continue;
        await walk(path.join(abs, e.name), relBase);
      }
    } else if (st.isFile()) {
      const rel = path.relative(relBase, abs) || path.basename(abs);
      const key = path.normalize(rel);
      if (seen.has(key)) return;
      seen.add(key);
      inputs.push({
        path: abs,
        relPath: rel.split(path.sep).join("/"),
        size: st.size,
        mode: st.mode & 0o777,
        mtimeMs: st.mtimeMs,
      });
    }
    // symlinks / specials: skipped for safety.
  }

  for (const t of targets) {
    const abs = path.resolve(t);
    const relBase = base ? path.resolve(base) : path.dirname(abs);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) {
      throw new Error(`No such file or directory: ${t}`);
    }
    if (st.isFile()) {
      const rel = path.basename(abs);
      if (!seen.has(rel)) {
        seen.add(rel);
        inputs.push({
          path: abs,
          relPath: rel,
          size: st.size,
          mode: st.mode & 0o777,
          mtimeMs: st.mtimeMs,
        });
      }
    } else {
      await walk(abs, relBase);
    }
  }

  // Stable, deterministic order => reproducible archives.
  inputs.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return inputs;
}
