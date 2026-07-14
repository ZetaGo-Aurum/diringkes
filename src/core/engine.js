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

// Extensions whose contents are *already* compressed. No compressor (Diringkes,
// 7-Zip, WinRAR, gzip…) can meaningfully shrink these — it's information theory,
// not a bug. We use this only to explain results to the user, never to skip work.
const PRECOMPRESSED = new Set([
  // video
  "mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "mpg", "mpeg", "3gp", "ts",
  // image
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif",
  // audio
  "mp3", "aac", "ogg", "opus", "m4a", "flac", "wma",
  // archives / already-packed containers
  "zip", "7z", "rar", "gz", "tgz", "bz2", "tbz", "xz", "zst", "br", "lz4", "lzma", "cab",
  // documents / packages that embed compression
  "pdf", "docx", "xlsx", "pptx", "apk", "jar", "epub", "crx", "whl",
]);

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : "";
}

// Produce a human-friendly explanation when a compression run barely shrinks
// (or even grows) the data, so the UI can reassure the user instead of looking
// broken.
function compressNote(inputs, savedPercent) {
  let precompBytes = 0;
  let total = 0;
  for (const f of inputs) {
    total += f.size;
    if (PRECOMPRESSED.has(extOf(f.path))) precompBytes += f.size;
  }
  const precompShare = total > 0 ? precompBytes / total : 0;
  if (savedPercent >= 3) return null;
  if (precompShare >= 0.5) {
    return "These files are already compressed (media/archives), so they can't shrink further — that's physics, not a bug. Diringkes stored them as-is without bloating.";
  }
  if (savedPercent <= 0.5) {
    return "This data is already near maximum density (looks random/encrypted or pre-compressed), so it can't be reduced further.";
  }
  return "Low compressibility: little redundant data to remove here.";
}

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
  result.rawBytes = totalRaw;
  result.factor = compressionFactor(totalRaw, result.compBytes);
  result.savedPercent = totalRaw > 0 ? (1 - result.compBytes / totalRaw) * 100 : 0;
  result.format = format;
  result.note = compressNote(filtered, result.savedPercent);
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
