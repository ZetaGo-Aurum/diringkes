// src/core/archive.js
// Diringkes archive engine + binary format (.drk), format version 2.
//
// v2 uses SOLID-BLOCK compression: identical chunks are deduplicated (content-
// defined chunking + SHA-256), then the *unique* chunks are concatenated and
// compressed together in large solid blocks. Compressing many chunks as one
// Brotli stream lets the codec share a dictionary across them, which is what
// gives whole-stream ratios (comparable to xz/7z) instead of the much weaker
// per-chunk compression used in v1.
//
// On-disk layout (all multi-byte integers big-endian):
//
//   [HEADER]   32 bytes
//     magic     "DRKS"           4
//     version   uint8            1  (=2)
//     mode      uint8            codec mode id
//     flags     uint8            bit0 = solid
//     reserved  uint8
//     fileCount uint32
//     chunkCount uint32
//     totalRaw  uint64
//     totalComp uint64
//   [FILE TABLE] fileCount * variable
//     pathLen uint16, path utf8, mode uint32, mtimeMs uint64,
//     rawSize uint64, chunkCount uint32
//   [FILE CHUNK MAPS]  fileCount * chunkCount * uint32  (chunk indices)
//   [DATA SECTION]     concatenated solid blocks (each a Brotli stream)
//   [CHUNK INDEX]  chunkCount * (blockId uint32, offInBlock uint32, rawSize uint32)   = 12 B
//   [BLOCK INDEX]  blockCount * (dataOffset uint64, compSize uint32, rawSize uint32, flags uint8) = 17 B
//                    flags bit0 = block stored verbatim (skip decompress)
//   [FOOTER] 28 bytes
//     magic     "KSRD"           4
//     chunkIndexOff uint64
//     blockIndexOff uint64
//     blockCount    uint32

import { Chunker, streamChunks } from "./chunker.js";
import { DedupTable, hashChunk } from "./dedupe.js";
import { compress, decompress, modeId, modeFromId } from "./codec.js";
import os from "node:os";
import zlib from "node:zlib";

// Cheap incompressibility probe: already-compressed data (video, photos, audio,
// archives, encrypted) has near-maximum entropy, so a fast deflate on a small
// sample barely shrinks it. When so, skip the expensive Brotli pass entirely and
// store the block verbatim — this makes packing media near-instant instead of
// grinding q11 for nothing.
function looksIncompressible(raw) {
  if (raw.length < 4096) return false;
  const sampleSize = Math.min(raw.length, 256 * 1024);
  let sample;
  if (raw.length <= sampleSize) {
    sample = raw;
  } else {
    // Sample from three regions so headers alone don't skew the estimate.
    const part = Math.floor(sampleSize / 3);
    const mid = Math.floor(raw.length / 2) - Math.floor(part / 2);
    const end = raw.length - part;
    sample = Buffer.concat([
      raw.subarray(0, part),
      raw.subarray(mid, mid + part),
      raw.subarray(end, end + part),
    ]);
  }
  const probe = zlib.deflateRawSync(sample, { level: 1 });
  return probe.length >= sample.length * 0.97;
}
import {
  openForRead,
  openForWrite,
  openForRW,
  sizeOf,
  readAt,
  fs,
  path as npath,
} from "../system/syscall.js";

const MAGIC = Buffer.from("DRKS");
const MAGIC_FOOTER = Buffer.from("KSRD");
const VERSION = 2;
const DEFAULT_BLOCK = 8 * 1024 * 1024; // 8 MiB solid blocks

const writeU16 = (b, v, o) => b.writeUInt16BE(v >>> 0, o);
const writeU32 = (b, v, o) => b.writeUInt32BE(v >>> 0, o);
const writeU64 = (b, v, o) => {
  v = BigInt(v);
  b.writeUInt32BE(Number(v >> 32n), o);
  b.writeUInt32BE(Number(v & 0xffffffffn), o + 4);
};
const readU64 = (b, o) => Number(b.readUInt32BE(o)) * 2 ** 32 + b.readUInt32BE(o + 4);

function cpuCount() {
  try {
    return Math.max(2, Math.min(8, os.cpus().length));
  } catch {
    return 4;
  }
}

function headerSize() {
  return 32;
}

// ---------------------------------------------------------------------------
// ENCODE
// ---------------------------------------------------------------------------

export async function createArchive({
  inputs,
  output,
  mode = "ultra",
  avgChunk = 64 * 1024,
  minChunk = 8 * 1024,
  maxChunk = 1024 * 1024,
  blockSize = DEFAULT_BLOCK,
  onProgress = () => {},
  tmpDir,
} = {}) {
  const chunker = new Chunker({ avg: avgChunk, min: minChunk, max: maxChunk });
  const dict = new DedupTable();
  const occurrences = []; // per file: array of dict indices
  const files = []; // metadata

  // Spool holds the RAW bytes of each unique chunk, in dict-index order.
  const spoolDir = tmpDir || (await fs.mkdtemp(os.tmpdir() + "/drk-"));
  const spoolPath = npath.join(spoolDir, "spool.bin");
  const spoolFd = await openForRW(spoolPath);
  let spoolOffset = 0;
  const uniques = []; // index -> { rawSize, spoolOffset }

  const totalBytes = inputs.reduce((a, f) => a + f.size, 0);
  let scanned = 0;

  // ---- PASS 1: chunk + dedup, spool unique raw chunks --------------------
  for (const f of inputs) {
    const occ = [];
    occurrences.push(occ);
    const fd = await openForRead(f.path);
    const size = f.size;
    for await (const ch of streamChunks(fd, size, chunker)) {
      const len = ch.end - ch.start;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const r = await readAt(fd, ch.start + got, buf, got, len - got);
        if (r === 0) break;
        got += r;
      }
      const hash = hashChunk(buf);
      let idx;
      if (dict.has(hash)) {
        idx = dict.get(hash).index;
      } else {
        idx = dict.reserve(hash);
        await writeAll(spoolFd, buf, spoolOffset);
        uniques[idx] = { rawSize: len, spoolOffset };
        spoolOffset += len;
      }
      occ.push(idx);
      scanned += len;
      onProgress({ phase: "scan", processed: scanned, total: totalBytes, files: files.length });
    }
    await fd.close();
    files.push({
      relPath: f.relPath,
      mode: f.mode,
      mtimeMs: f.mtimeMs,
      rawSize: size,
      chunkCount: occ.length,
    });
  }

  const chunkCount = dict.size;
  const uniqueRaw = spoolOffset;

  // ---- Compute layout offsets -------------------------------------------
  let fileTableSize = 0;
  for (const f of files) {
    fileTableSize += 2 + Buffer.byteLength(f.relPath, "utf8") + 4 + 8 + 8 + 4;
  }
  let mapsSize = 0;
  for (const occ of occurrences) mapsSize += occ.length * 4;
  const dataStart = headerSize() + fileTableSize + mapsSize;

  // ---- Write header + file table + maps ---------------------------------
  const outFd = await openForWrite(output);

  const header = Buffer.alloc(headerSize());
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = modeId(mode);
  header[6] = 1; // solid
  header[7] = 0;
  writeU32(header, files.length, 8);
  writeU32(header, chunkCount, 12);
  writeU64(header, totalBytes, 16);
  writeU64(header, 0, 24); // totalComp patched at the end
  await writeAll(outFd, header, 0);

  let off = headerSize();
  for (const f of files) {
    const p = Buffer.from(f.relPath, "utf8");
    const rec = Buffer.alloc(2 + p.length + 4 + 8 + 8 + 4);
    writeU16(rec, p.length, 0);
    p.copy(rec, 2);
    let o = 2 + p.length;
    writeU32(rec, f.mode, o); o += 4;
    writeU64(rec, Math.round(f.mtimeMs), o); o += 8;
    writeU64(rec, f.rawSize, o); o += 8;
    writeU32(rec, f.chunkCount, o);
    await writeAll(outFd, rec, off);
    off += rec.length;
  }
  for (const occ of occurrences) {
    if (occ.length === 0) continue;
    const buf = Buffer.alloc(occ.length * 4);
    for (let i = 0; i < occ.length; i++) writeU32(buf, occ[i], i * 4);
    await writeAll(outFd, buf, off);
    off += buf.length;
  }

  // ---- Group unique chunks into solid blocks ----------------------------
  const groups = []; // each = { idx: [chunkIndex...], raw: bytes }
  {
    let curIdx = [];
    let curRaw = 0;
    for (let idx = 0; idx < chunkCount; idx++) {
      curIdx.push(idx);
      curRaw += uniques[idx].rawSize;
      if (curRaw >= blockSize) {
        groups.push({ idx: curIdx, raw: curRaw });
        curIdx = [];
        curRaw = 0;
      }
    }
    if (curIdx.length) groups.push({ idx: curIdx, raw: curRaw });
  }

  // ---- PASS 2: compress blocks concurrently -----------------------------
  // Blocks are independent, so we compress several at once on the libuv thread
  // pool. Results are collected then written in block order, keeping offsets
  // deterministic while hiding the latency of slow Brotli passes.
  const chunkMeta = new Array(chunkCount); // { blockId, offInBlock, rawSize }
  const results = new Array(groups.length); // { payload, rawSize, stored }
  let compressedRaw = 0;
  const concurrency = Math.max(1, Math.min(groups.length, cpuCount()));

  async function compressGroup(blockId) {
    const g = groups[blockId];
    const raw = Buffer.alloc(g.raw);
    let o = 0;
    for (const idx of g.idx) {
      const u = uniques[idx];
      let got = 0;
      while (got < u.rawSize) {
        const r = await readAt(spoolFd, u.spoolOffset + got, raw, o + got, u.rawSize - got);
        if (r === 0) break;
        got += r;
      }
      chunkMeta[idx] = { blockId, offInBlock: o, rawSize: u.rawSize };
      o += u.rawSize;
    }
    let payload;
    let stored;
    if (mode === "store" || looksIncompressible(raw)) {
      payload = raw;
      stored = true;
    } else {
      const comp = await compress(mode, raw);
      stored = comp.length >= raw.length;
      payload = stored ? raw : comp;
    }
    results[blockId] = { payload, rawSize: raw.length, stored };
    compressedRaw += g.raw;
    onProgress({ phase: "compress", processed: compressedRaw, total: uniqueRaw, files: files.length });
  }

  {
    let next = 0;
    const workers = [];
    const runNext = async () => {
      while (next < groups.length) {
        const id = next++;
        await compressGroup(id);
      }
    };
    for (let w = 0; w < concurrency; w++) workers.push(runNext());
    await Promise.all(workers);
  }

  // ---- Write blocks in order --------------------------------------------
  const blocks = []; // { dataOffset, compSize, rawSize, stored }
  let dataPos = dataStart;
  for (let blockId = 0; blockId < results.length; blockId++) {
    const r = results[blockId];
    await writeAll(outFd, r.payload, dataPos);
    blocks.push({ dataOffset: dataPos, compSize: r.payload.length, rawSize: r.rawSize, stored: r.stored });
    dataPos += r.payload.length;
  }

  await spoolFd.close();
  await fs.unlink(spoolPath).catch(() => {});

  // ---- CHUNK INDEX ------------------------------------------------------
  const chunkIndexOff = dataPos;
  const chunkIndexBuf = Buffer.alloc(chunkCount * 12);
  for (let i = 0; i < chunkCount; i++) {
    const m = chunkMeta[i];
    const base = i * 12;
    writeU32(chunkIndexBuf, m.blockId, base);
    writeU32(chunkIndexBuf, m.offInBlock, base + 4);
    writeU32(chunkIndexBuf, m.rawSize, base + 8);
  }
  await writeAll(outFd, chunkIndexBuf, chunkIndexOff);

  // ---- BLOCK INDEX ------------------------------------------------------
  const blockIndexOff = chunkIndexOff + chunkIndexBuf.length;
  const blockIndexBuf = Buffer.alloc(blocks.length * 17);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const base = i * 17;
    writeU64(blockIndexBuf, b.dataOffset, base);
    writeU32(blockIndexBuf, b.compSize, base + 8);
    writeU32(blockIndexBuf, b.rawSize, base + 12);
    blockIndexBuf[base + 16] = b.stored ? 1 : 0;
  }
  await writeAll(outFd, blockIndexBuf, blockIndexOff);

  // ---- FOOTER -----------------------------------------------------------
  const footerOff = blockIndexOff + blockIndexBuf.length;
  const footer = Buffer.alloc(28);
  MAGIC_FOOTER.copy(footer, 0);
  writeU64(footer, chunkIndexOff, 4);
  writeU64(footer, blockIndexOff, 12);
  writeU32(footer, blocks.length, 20);
  await writeAll(outFd, footer, footerOff);

  const totalComp = footerOff + footer.length;

  // Patch totalComp into the header.
  const patch = Buffer.alloc(8);
  writeU64(patch, totalComp, 0);
  await writeAll(outFd, patch, 24);

  await outFd.truncate(totalComp).catch(() => {});
  await outFd.close();

  onProgress({ phase: "done", processed: totalBytes, total: totalBytes, files: files.length, done: true });

  return {
    output,
    fileCount: files.length,
    chunkCount,
    blockCount: blocks.length,
    rawBytes: totalBytes,
    compBytes: totalComp,
    mode,
  };
}

// ---------------------------------------------------------------------------
// DECODE / EXTRACT
// ---------------------------------------------------------------------------

export async function readArchiveHeader(fd) {
  const buf = Buffer.alloc(headerSize());
  await readAt(fd, 0, buf, 0, headerSize());
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error("Not a Diringkes archive (bad magic)");
  }
  const version = buf[4];
  if (version !== VERSION) {
    throw new Error(
      `Unsupported .drk format v${version} (this build reads v${VERSION}). ` +
        `Re-create the archive with the current Diringkes version.`
    );
  }
  return {
    version,
    mode: modeFromId(buf[5]),
    flags: buf[6],
    fileCount: buf.readUInt32BE(8),
    chunkCount: buf.readUInt32BE(12),
    totalRaw: readU64(buf, 16),
    totalComp: readU64(buf, 24),
  };
}

async function readFooter(fd, fileSize) {
  const buf = Buffer.alloc(28);
  await readAt(fd, fileSize - 28, buf, 0, 28);
  if (!buf.subarray(0, 4).equals(MAGIC_FOOTER)) {
    throw new Error("Corrupt archive (bad footer)");
  }
  return {
    chunkIndexOff: readU64(buf, 4),
    blockIndexOff: readU64(buf, 12),
    blockCount: buf.readUInt32BE(20),
  };
}

async function readChunkIndex(fd, off, chunkCount) {
  const buf = Buffer.alloc(chunkCount * 12);
  await readAt(fd, off, buf, 0, buf.length);
  const out = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const base = i * 12;
    out[i] = {
      blockId: buf.readUInt32BE(base),
      offInBlock: buf.readUInt32BE(base + 4),
      rawSize: buf.readUInt32BE(base + 8),
    };
  }
  return out;
}

async function readBlockIndex(fd, off, blockCount) {
  const buf = Buffer.alloc(blockCount * 17);
  await readAt(fd, off, buf, 0, buf.length);
  const out = new Array(blockCount);
  for (let i = 0; i < blockCount; i++) {
    const base = i * 17;
    out[i] = {
      dataOffset: readU64(buf, base),
      compSize: buf.readUInt32BE(base + 8),
      rawSize: buf.readUInt32BE(base + 12),
      stored: (buf[base + 16] & 1) === 1,
    };
  }
  return out;
}

async function readFileTable(fd, fileCount) {
  let off = headerSize();
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const head = Buffer.alloc(2);
    await readAt(fd, off, head, 0, 2);
    const len = head.readUInt16BE(0);
    off += 2;
    const p = Buffer.alloc(len);
    await readAt(fd, off, p, 0, len);
    off += len;
    const meta = Buffer.alloc(4 + 8 + 8 + 4);
    await readAt(fd, off, meta, 0, meta.length);
    off += meta.length;
    files.push({
      relPath: p.toString("utf8"),
      mode: meta.readUInt32BE(0),
      mtimeMs: readU64(meta, 4),
      rawSize: readU64(meta, 12),
      chunkCount: meta.readUInt32BE(20),
    });
  }
  return { files, mapsStart: off };
}

async function readFileMaps(fd, mapsStart, files) {
  let off = mapsStart;
  for (const f of files) {
    if (f.chunkCount === 0) {
      f.map = [];
      continue;
    }
    const buf = Buffer.alloc(f.chunkCount * 4);
    await readAt(fd, off, buf, 0, buf.length);
    off += buf.length;
    const map = new Array(f.chunkCount);
    for (let i = 0; i < f.chunkCount; i++) map[i] = buf.readUInt32BE(i * 4);
    f.map = map;
  }
  return off; // dataStart
}

// Small LRU cache of decompressed blocks, so consecutive chunks that live in
// the same solid block only trigger one decompress.
class BlockCache {
  constructor(fd, mode, blockIndex, max = 3) {
    this.fd = fd;
    this.mode = mode;
    this.blockIndex = blockIndex;
    this.max = max;
    this.map = new Map();
  }
  async get(blockId) {
    if (this.map.has(blockId)) {
      const v = this.map.get(blockId);
      this.map.delete(blockId);
      this.map.set(blockId, v);
      return v;
    }
    const b = this.blockIndex[blockId];
    const comp = Buffer.alloc(b.compSize);
    let got = 0;
    while (got < b.compSize) {
      const r = await readAt(this.fd, b.dataOffset + got, comp, got, b.compSize - got);
      if (r === 0) break;
      got += r;
    }
    const raw = b.stored ? comp : await decompress(this.mode, comp);
    this.map.set(blockId, raw);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return raw;
  }
}

export async function extractArchive({
  archive,
  dest,
  onProgress = () => {},
  onlyFiles = null,
} = {}) {
  const fd = await openForRead(archive);
  const fileSize = await sizeOf(fd);
  const header = await readArchiveHeader(fd);
  const { chunkIndexOff, blockIndexOff, blockCount } = await readFooter(fd, fileSize);
  const chunkIndex = await readChunkIndex(fd, chunkIndexOff, header.chunkCount);
  const blockIndex = await readBlockIndex(fd, blockIndexOff, blockCount);
  const { files, mapsStart } = await readFileTable(fd, header.fileCount);
  await readFileMaps(fd, mapsStart, files);

  const cache = new BlockCache(fd, header.mode, blockIndex);
  const filter = onlyFiles ? new Set(onlyFiles.map((p) => npath.normalize(p))) : null;

  let written = 0;
  const totalRaw = files.reduce((a, f) => a + f.rawSize, 0);
  for (const f of files) {
    if (filter && !filter.has(npath.normalize(f.relPath))) continue;
    const outPath = npath.join(dest, f.relPath);
    await fs.mkdir(npath.dirname(outPath), { recursive: true });
    if (f.rawSize === 0) {
      await fs.writeFile(outPath, Buffer.alloc(0));
      continue;
    }
    const outFd = await openForWrite(outPath);
    for (const ci of f.map) {
      const c = chunkIndex[ci];
      const blockRaw = await cache.get(c.blockId);
      const slice = blockRaw.subarray(c.offInBlock, c.offInBlock + c.rawSize);
      await writeAll(outFd, slice, 0, true);
      written += c.rawSize;
      onProgress({ written, total: totalRaw });
    }
    await outFd.close();
    try {
      await fs.utimes(outPath, f.mtimeMs / 1000, f.mtimeMs / 1000);
    } catch {}
  }
  await fd.close();
  return { files: files.length, rawBytes: totalRaw, mode: header.mode };
}

export async function listArchive(archive) {
  const fd = await openForRead(archive);
  const fileSize = await sizeOf(fd);
  const header = await readArchiveHeader(fd);
  await readFooter(fd, fileSize);
  const { files } = await readFileTable(fd, header.fileCount);
  await fd.close();
  return { header, files };
}

/**
 * Rename entries inside an existing archive. Implemented as a clean repack:
 * the file table is rebuilt with new names while the data section, chunk index
 * and block index are copied verbatim (only absolute block offsets shift by a
 * constant delta). Written to a temp file and atomically swapped in.
 */
export async function renameInArchive({ archive, renames }) {
  const fd = await openForRead(archive);
  const fileSize = await sizeOf(fd);
  const header = await readArchiveHeader(fd);
  const { chunkIndexOff, blockIndexOff, blockCount } = await readFooter(fd, fileSize);
  const { files, mapsStart } = await readFileTable(fd, header.fileCount);
  const dataStart = await readFileMaps(fd, mapsStart, files);
  const dataLen = chunkIndexOff - dataStart;
  const chunkIndex = await readChunkIndex(fd, chunkIndexOff, header.chunkCount);
  const blockIndex = await readBlockIndex(fd, blockIndexOff, blockCount);

  for (const f of files) {
    const np = renames.get(f.relPath);
    if (np) f.relPath = String(np).split(npath.sep).join("/");
  }

  let newFtSize = 0;
  for (const f of files) {
    newFtSize += 2 + Buffer.byteLength(f.relPath, "utf8") + 4 + 8 + 8 + 4;
  }
  const mapsSize = dataStart - mapsStart;
  const newDataStart = headerSize() + newFtSize + mapsSize;
  const delta = newDataStart - dataStart;

  const tmp = archive + ".rename.tmp";
  const outFd = await openForWrite(tmp);

  const headBuf = Buffer.alloc(headerSize());
  MAGIC.copy(headBuf, 0);
  headBuf[4] = VERSION;
  headBuf[5] = modeId(header.mode);
  headBuf[6] = header.flags;
  headBuf[7] = 0;
  writeU32(headBuf, files.length, 8);
  writeU32(headBuf, header.chunkCount, 12);
  writeU64(headBuf, header.totalRaw, 16);
  writeU64(headBuf, header.totalComp + delta, 24);
  await writeAll(outFd, headBuf, 0);

  let pos = headerSize();
  for (const f of files) {
    const p = Buffer.from(f.relPath, "utf8");
    const rec = Buffer.alloc(2 + p.length + 4 + 8 + 8 + 4);
    writeU16(rec, p.length, 0);
    p.copy(rec, 2);
    let o = 2 + p.length;
    writeU32(rec, f.mode, o); o += 4;
    writeU64(rec, Math.round(f.mtimeMs), o); o += 8;
    writeU64(rec, f.rawSize, o); o += 8;
    writeU32(rec, f.chunkCount, o);
    await writeAll(outFd, rec, pos);
    pos += rec.length;
  }
  for (const f of files) {
    if (!f.map.length) continue;
    const buf = Buffer.alloc(f.map.length * 4);
    for (let i = 0; i < f.map.length; i++) writeU32(buf, f.map[i], i * 4);
    await writeAll(outFd, buf, pos);
    pos += buf.length;
  }

  // Copy data section verbatim.
  {
    let copied = 0;
    const block = Buffer.alloc(1024 * 1024);
    while (copied < dataLen) {
      const to = Math.min(block.length, dataLen - copied);
      await readAt(fd, dataStart + copied, block, 0, to);
      await writeAll(outFd, block.subarray(0, to), newDataStart + copied);
      copied += to;
    }
  }

  const newChunkIndexOff = newDataStart + dataLen;
  const chunkIndexBuf = Buffer.alloc(header.chunkCount * 12);
  for (let i = 0; i < header.chunkCount; i++) {
    const m = chunkIndex[i];
    const base = i * 12;
    writeU32(chunkIndexBuf, m.blockId, base);
    writeU32(chunkIndexBuf, m.offInBlock, base + 4);
    writeU32(chunkIndexBuf, m.rawSize, base + 8);
  }
  await writeAll(outFd, chunkIndexBuf, newChunkIndexOff);

  const newBlockIndexOff = newChunkIndexOff + chunkIndexBuf.length;
  const blockIndexBuf = Buffer.alloc(blockIndex.length * 17);
  for (let i = 0; i < blockIndex.length; i++) {
    const b = blockIndex[i];
    const base = i * 17;
    writeU64(blockIndexBuf, b.dataOffset + delta, base);
    writeU32(blockIndexBuf, b.compSize, base + 8);
    writeU32(blockIndexBuf, b.rawSize, base + 12);
    blockIndexBuf[base + 16] = b.stored ? 1 : 0;
  }
  await writeAll(outFd, blockIndexBuf, newBlockIndexOff);

  const footerOff = newBlockIndexOff + blockIndexBuf.length;
  const footer = Buffer.alloc(28);
  MAGIC_FOOTER.copy(footer, 0);
  writeU64(footer, newChunkIndexOff, 4);
  writeU64(footer, newBlockIndexOff, 12);
  writeU32(footer, blockIndex.length, 20);
  await writeAll(outFd, footer, footerOff);

  await outFd.truncate(footerOff + footer.length).catch(() => {});
  await outFd.close();
  await fd.close();

  const backup = archive + ".bak";
  await fs.rename(archive, backup).catch(() => {});
  await fs.rename(tmp, archive);
  await fs.unlink(backup).catch(() => {});

  return { renamed: renames.size, files: files.length };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function writeAll(fh, buf, position, append = false) {
  let written = 0;
  while (written < buf.length) {
    const { bytesWritten } = await fh.write(
      buf,
      written,
      buf.length - written,
      append ? null : position + written
    );
    written += bytesWritten;
  }
}
