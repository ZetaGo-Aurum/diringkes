// src/core/dedupe.js
// Global chunk deduplication table. Maps a strong content hash (SHA-256) to a
// slot in the chunk dictionary. Because chunking is content-defined, two
// identical regions anywhere in the dataset (even in different files) collide
// here and are stored only once — this is the heart of "ultra" compression.

import crypto from "node:crypto";

export function hashChunk(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export class DedupTable {
  constructor() {
    // hex hash -> { index, rawSize, compSize, offset }
    this.map = new Map();
    this.count = 0;
  }

  has(h) {
    return this.map.has(h);
  }

  get(h) {
    return this.map.get(h);
  }

  /**
   * Synchronously reserve a dictionary slot for a chunk. Returns the index so
   * callers can reference it immediately (before compression even finishes).
   * This keeps index assignment atomic with scheduling and prevents gaps.
   */
  reserve(h) {
    const index = this.count++;
    this.map.set(h, { index, rawSize: 0, compSize: 0, offset: 0 });
    return index;
  }

  /**
   * Fill a previously reserved slot with its compressed metadata. Safe to call
   * out of order because the index is already fixed.
   */
  commit(h, meta) {
    const e = this.map.get(h);
    if (e) Object.assign(e, meta, { index: e.index });
  }

  get size() {
    return this.count;
  }

  entries() {
    // Return slots ordered by index (reserve guarantees no gaps).
    const arr = new Array(this.count);
    for (const v of this.map.values()) arr[v.index] = v;
    return arr;
  }
}
