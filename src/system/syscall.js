// src/system/syscall.js
// Low-level I/O helpers. These wrap Node's fs in a way that mimics positional,
// zero-copy-friendly system reads so the compression engine can treat huge
// files as a linear address space without buffering the whole thing in RAM.

import { promises as fs, open, fstat, constants, read, write } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Positional read into `target` at absolute file offset. Returns bytes read.
 * Uses an explicit position so we never rely on a shared file cursor
 * (thread/async safe for the parallel compression pipeline).
 */
export async function readAt(fh, position, target, offset = 0, length = target.length - offset) {
  const { bytesRead } = await fh.read(target, offset, length, position);
  return bytesRead;
}

/**
 * Open a file for positional streaming reads (no shared cursor).
 */
export async function openForRead(p) {
  return fs.open(p, constants.O_RDONLY);
}

export async function openForWrite(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  return fs.open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644);
}

export async function openForRW(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  return fs.open(p, constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC, 0o644);
}

export async function sizeOf(fd) {
  const st = await fd.stat();
  return st.size;
}

/**
 * Best-effort pre-allocation hint so the archive is laid out contiguously
 * (reduces fragmentation on spinning disks). Ignores unsupported platforms.
 */
export async function preallocate(fh, bytes) {
  try {
    if (process.platform === "linux") {
      await fh.truncate(bytes).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

export const sys = {
  isWindows: process.platform === "win32",
  cpus: () => Math.max(1, os.cpus().length),
};

export { fs, path, fileURLToPath, read, write, open, fstat };
