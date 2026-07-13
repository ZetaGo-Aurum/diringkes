// src/core/chunker.js
// Content-Defined Chunking (CDC) engine.
//
// System-level note: this implements a FastCDC-style gear rolling hash.
// Unlike fixed-size blocks, boundaries are derived from the *content* itself,
// so identical regions of data always split at the same offset regardless of
// shifts. This is what makes cross-file / cross-version deduplication and the
// legendary "ultra" ratios possible.

import { readAt } from "../system/syscall.js";

const GEAR_SIZE = 256;

// Deterministic pseudo-random gear table (splitmix64 derived). Same table on
// every machine => deterministic chunking => reproducible archives.
function buildGearTable() {
  const table = new Uint32Array(GEAR_SIZE);
  let state = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < GEAR_SIZE; i++) {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    state = (state ^ (state >> 30n)) * 0xbf58476d1ce4e5b9n & 0xffffffffffffffffn;
    state = (state ^ (state >> 27n)) * 0x94d049bb133111ebn & 0xffffffffffffffffn;
    table[i] = Number((state ^ (state >> 31n)) & 0xffffffffn);
  }
  return table;
}

const GEAR = buildGearTable();

export class Chunker {
  /**
   * @param {object} opts
   * @param {number} opts.avg  target average chunk size in bytes
   * @param {number} opts.min  minimum chunk size in bytes
   * @param {number} opts.max  maximum chunk size in bytes
   */
  constructor({ avg = 64 * 1024, min = 8 * 1024, max = 256 * 1024 } = {}) {
    this.avg = avg;
    this.min = min;
    this.max = max;
    // mask selects ~1/avg boundaries
    const bits = Math.max(1, Math.round(Math.log2(avg)));
    this.mask = (1 << Math.min(bits, 23)) - 1;
    this.normalSize = avg;
  }

  /**
   * Yield chunk boundaries [start, end) for a single buffer.
   * For streaming large files, call with sliding windows maintained by caller.
   */
  *chunkBuffer(buf) {
    const n = buf.length;
    if (n === 0) return;
    const { min, max, mask } = this;
    let i = 0;
    let start = 0;
    let h = 0;
    while (i < n) {
      h = ((h << 1) | (h >>> 31)) + GEAR[buf[i]];
      h = h >>> 0;
      i++;
      const len = i - start;
      if (len >= max) {
        yield [start, i];
        start = i;
        h = 0;
      } else if (len >= min && (h & mask) === 0) {
        yield [start, i];
        start = i;
        h = 0;
      }
    }
    if (start < n) {
      yield [start, n];
    }
  }
}

/**
 * Streaming chunker over a file descriptor. Reads in blocks, keeps a look-back
 * window so boundaries are detected correctly across read boundaries.
 */
export async function* streamChunks(fd, fileSize, chunker, readSize = 1024 * 1024) {
  let offset = 0;
  let carry = Buffer.alloc(0);
  let absoluteStart = 0;
  let h = 0;
  const { min, max, mask } = chunker;

  while (offset < fileSize) {
    const toRead = Math.min(readSize, fileSize - offset);
    const block = Buffer.alloc(toRead);
    let got = 0;
    while (got < toRead) {
      const r = await readAt(fd, offset + got, block, got, toRead - got);
      if (r === 0) break;
      got += r;
    }
    offset += got;

    const buf = carry.length ? Buffer.concat([carry, block]) : block;
    let i = 0;
    let start = 0;
    while (i < buf.length) {
      h = ((h << 1) | (h >>> 31)) + GEAR[buf[i]];
      h = h >>> 0;
      i++;
      const len = i - start;
      if (len >= max) {
        const absStart = absoluteStart + start;
        const absEnd = absoluteStart + i;
        yield { start: absStart, end: absEnd };
        start = i;
        h = 0;
      } else if (len >= min && (h & mask) === 0) {
        const absStart = absoluteStart + start;
        const absEnd = absoluteStart + i;
        yield { start: absStart, end: absEnd };
        start = i;
        h = 0;
      }
    }
    // keep tail that could not yet be closed as carry
    const tail = buf.subarray(start);
    absoluteStart += start;
    carry = Buffer.from(tail);
  }

  if (carry.length) {
    yield { start: absoluteStart, end: absoluteStart + carry.length };
  }
}
