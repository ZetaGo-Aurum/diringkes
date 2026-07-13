// src/core/engine.js
// Public, framework-agnostic API used by both the CLI and the TUI. This is the
// "system-level" orchestration layer: it wires the walker, the chunker, the
// deduplication table, the codec and the archive writer/reader together.

import { gatherInputs } from "./walk.js";
import { createArchive, extractArchive, listArchive, renameInArchive } from "./archive.js";
import path from "node:path";
import { repack, modeToLevel } from "./repack.js";
import { humanizeBytes, compressionFactor } from "../util/humanize.js";

export { renameInArchive };

export async function compressTargets({
  targets,
  output,
  mode = "ultra",
  format = "drk",
  level = null,
  base = null,
  onProgress = () => {},
  tmpDir,
} = {}) {
  const inputs = await gatherInputs(targets, { base });
  // Never pack the output file into itself (e.g. compressing a directory that
  // already holds a previous run's archive).
  const outResolved = path.resolve(output);
  const filtered = inputs.filter((f) => path.resolve(f.path) !== outResolved);
  if (filtered.length === 0) {
    throw new Error("No files to compress.");
  }
  const totalRaw = filtered.reduce((a, f) => a + f.size, 0);
  let result;
  if (format === "drk") {
    result = await createArchive({
      inputs: filtered,
      output,
      mode,
      onProgress,
      tmpDir,
    });
  } else {
    const lvl = level != null ? level : modeToLevel(mode);
    result = await repack({ inputs: filtered, output, format, level: lvl, onProgress });
  }
  result.inputCount = filtered.length;
  result.factor = compressionFactor(totalRaw, result.compBytes);
  result.savedPercent = totalRaw > 0 ? (1 - result.compBytes / totalRaw) * 100 : 0;
  result.format = format;
  return result;
}

export async function extractTargets({ archive, dest, onProgress, onlyFiles }) {
  return extractArchive({ archive, dest, onProgress, onlyFiles });
}

export async function inspectArchive(archive) {
  const { header, files } = await listArchive(archive);
  const totalRaw = files.reduce((a, f) => a + f.rawSize, 0);
  return {
    header,
    files,
    totalRaw,
    totalComp: header.totalComp,
    factor: compressionFactor(totalRaw, header.totalComp),
    savedPercent: totalRaw > 0 ? (1 - header.totalComp / totalRaw) * 100 : 0,
  };
}

export { humanizeBytes };
