// src/core/engine.js
// Public, framework-agnostic API used by both the CLI and the TUI. This is the
// "system-level" orchestration layer: it wires the walker, the chunker, the
// deduplication table, the codec and the archive writer/reader together.

import { gatherInputs } from "./walk.js";
import { createArchive, extractArchive, listArchive, renameInArchive } from "./archive.js";
import { humanizeBytes, compressionFactor } from "../util/humanize.js";

export { renameInArchive };

export async function compressTargets({
  targets,
  output,
  mode = "ultra",
  base = null,
  onProgress = () => {},
  tmpDir,
} = {}) {
  const inputs = await gatherInputs(targets, { base });
  if (inputs.length === 0) {
    throw new Error("No files to compress.");
  }
  const totalRaw = inputs.reduce((a, f) => a + f.size, 0);
  const result = await createArchive({
    inputs,
    output,
    mode,
    onProgress,
    tmpDir,
  });
  result.inputCount = inputs.length;
  result.factor = compressionFactor(totalRaw, result.compBytes);
  result.savedPercent = totalRaw > 0 ? (1 - result.compBytes / totalRaw) * 100 : 0;
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
