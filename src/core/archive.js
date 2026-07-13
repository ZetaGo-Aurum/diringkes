// src/core/archive.js
// Diringkes archive engine + binary format (.drk).
//
// On-disk layout (all multi-byte integers big-endian):
//
//   [HEADER]   32 bytes
//     magic     "DRKS"           4
//     version   uint8           1
//     mode      uint8           codec mode id
//     flags     uint8           (bit0 = indexed)
//     reserved  uint8
//     fileCount uint32
//     chunkCount uint32
//     totalRaw  uint64
//     totalComp uint64
//   [FILE TABLE] fileCount * variable
//     pathLen   uint16
//     path      utf8
//     mode      uint32
//     mtimeMs   uint64
//     rawSize   uint64
//     chunkCount uint32
//   [FILE CHUNK MAPS]  fileCount * chunkCount * uint32  (dict indices)
//   [DATA SECTION]     concatenated compressed chunks
//   [CHUNK INDEX]  chunkCount * (rawSize uint32, compSize uint32, flags uint8, dataOffset uint64)
//                    flags bit0 = chunk stored verbatim (skip decompress)
//   [FOOTER] 12 bytes
//     magic     "KSRD"           4
//     indexOff  uint64           byte offset of CHUNK INDEX
//
// Format version 1. The CHUNK INDEX lives at the tail so a reader can seek
// straight to it and then randomly-access any chunk during single-file extract.

import { Chunker, streamChunks } from "./chunker.js";
import { DedupTable, hashChunk } from "./dedupe.js";
import { compress, decompress, modeId, modeFromId } from "./codec.js";
import os from "node:os";
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
const VERSION = 1;

const writeU16 = (b, v, o) => b.writeUInt16BE(v >>> 0, o);
const writeU32 = (b, v, o) => b.writeUInt32BE(v >>> 0, o);
const writeU64 = (b, v, o) => {
  v = BigInt(v);
  b.writeUInt32BE(Number(v >> 32n), o);
  b.writeUInt32BE(Number(v & 0xffffffffn), o + 4);
};

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
  maxChunk = 256 * 1024,
  concurrency = 8,
  onProgress = () => {},
  tmpDir,
} = {}) {
  const chunker = new Chunker({ avg: avgChunk, min: minChunk, max: maxChunk });
  const dict = new DedupTable();
  const occurrences = []; // per file: array of dict indices
  const files = []; // metadata

  // Spool file holds compressed chunks in dict-index order.
  const spoolPath = npath.join(
    tmpDir || (await fs.mkdtemp(os.tmpdir() + "/drk-")),
    "spool.bin"
  );
  const spoolFd = await openForRW(spoolPath);
  let spoolOffset = 0;

  // Atomic, serialized write chain so concurrent chunk commits never overlap
  // on the spool file (offset is reserved synchronously before any await).
  let writeChain = Promise.resolve();
  let pendingCount = 0;
  let compressError = null;

  function commitWrite(comp, hash, rawSize, stored) {
    const myOffset = spoolOffset;
    spoolOffset += comp.length;
    const task = writeChain.then(() => writeAll(spoolFd, comp, myOffset));
    writeChain = task.then(() => {}, () => {});
    return task.then(() =>
      dict.commit(hash, {
        rawSize,
        compSize: comp.length,
        offset: myOffset,
        stored: !!stored,
      })
    );
  }

  function schedule(buf, hash, fileOcc) {
    let idx;
    if (dict.has(hash)) {
      idx = dict.get(hash).index; // reserved or committed already
    } else {
      idx = dict.reserve(hash); // atomic index assignment at schedule time
      pendingCount++;
      const storeMode = mode === "store";
      const compressDone = storeMode
        ? Promise.resolve(buf)
        : compress(mode, buf);
      compressDone
        .then((comp) => {
          // Store incompressible chunks verbatim so the archive never
          // bloats past the raw size (Brotli can't shrink random/already-
          // compressed data, so storing raw is strictly better). Flag it
          // in the chunk index so extract knows not to decompress.
          const stored = storeMode || comp.length >= buf.length;
          commitWrite(stored ? buf : comp, hash, buf.length, stored);
        })
        .catch((e) => {
          compressError = e;
        })
        .finally(() => {
          pendingCount--;
        });
    }
    fileOcc.push(idx);
  }

  let processedBytes = 0;
  let totalBytes = inputs.reduce((a, f) => a + f.size, 0);

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
      schedule(buf, hash, occ);
      processedBytes += len;
      onProgress({ processed: processedBytes, total: totalBytes, files: files.length });
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

  // Wait for all in-flight compressions to commit.
  while (pendingCount > 0 || compressError) {
    if (compressError) throw compressError;
    await new Promise((r) => setTimeout(r, 1));
  }
  await writeChain;

  // Build file -> chunk-index maps (occurrences already hold indices).
  const fileMaps = occurrences;

  // Finalize archive.
  const outFd = await openForWrite(output);
  await allocate(outFd, headerSize() + spoolOffset + 1024 * 1024);
  const totalRaw = totalBytes;
  const totalComp = spoolOffset;

  // HEADER
  const header = Buffer.alloc(headerSize());
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = modeId(mode);
  header[6] = 1; // indexed
  header[7] = 0;
  writeU32(header, files.length, 8);
  writeU32(header, dict.size, 12);
  writeU64(header, totalRaw, 16);
  writeU64(header, totalComp, 24);
  await writeAll(outFd, header, 0);

  // FILE TABLE
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

  // FILE CHUNK MAPS
  for (const map of fileMaps) {
    if (map.length === 0) continue;
    const buf = Buffer.alloc(map.length * 4);
    for (let i = 0; i < map.length; i++) writeU32(buf, map[i], i * 4);
    await writeAll(outFd, buf, off);
    off += buf.length;
  }

  const dataStart = off;

  // DATA SECTION: stream spool -> output
  {
    const st = await sizeOf(spoolFd);
    let pos = 0;
    const block = Buffer.alloc(1024 * 1024);
    while (pos < st) {
      const to = Math.min(block.length, st - pos);
      await readAt(spoolFd, pos, block, 0, to);
      await writeAll(outFd, block.subarray(0, to), dataStart + pos);
      pos += to;
    }
  }
  await spoolFd.close();
  await fs.unlink(spoolPath).catch(() => {});

  // CHUNK INDEX
  const indexOff = dataStart + spoolOffset;
  const dictEntries = dict.entries();
  const indexBuf = Buffer.alloc(dictEntries.length * (4 + 4 + 1 + 8));
  for (let i = 0; i < dictEntries.length; i++) {
    const e = dictEntries[i];
    const base = i * 17;
    writeU32(indexBuf, e.rawSize, base);
    writeU32(indexBuf, e.compSize, base + 4);
    indexBuf[base + 8] = e.stored ? 1 : 0; // flags (bit0 = stored verbatim)
    writeU64(indexBuf, dataStart + e.offset, base + 9);
  }
  await writeAll(outFd, indexBuf, indexOff);

  // FOOTER
  const footer = Buffer.alloc(12);
  MAGIC_FOOTER.copy(footer, 0);
  writeU64(footer, indexOff, 4);
  await writeAll(outFd, footer, indexOff + indexBuf.length);

  // Drop any preallocated slack so the file ends exactly at the footer.
  await outFd.truncate(indexOff + indexBuf.length + 12).catch(() => {});

  await outFd.close();

  onProgress({ processed: totalBytes, total: totalBytes, files: files.length, done: true });

  return {
    output,
    fileCount: files.length,
    chunkCount: dict.size,
    rawBytes: totalRaw,
    compBytes: indexOff + indexBuf.length + 12,
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
  const mode = modeFromId(buf[5]);
  const fileCount = buf.readUInt32BE(8);
  const chunkCount = buf.readUInt32BE(12);
  const totalRaw = Number(buf.readUInt32BE(16)) * 2 ** 32 + buf.readUInt32BE(20);
  const totalComp = Number(buf.readUInt32BE(24)) * 2 ** 32 + buf.readUInt32BE(28);
  return { version, mode, fileCount, chunkCount, totalRaw, totalComp };
}

async function readFooter(fd, fileSize) {
  const buf = Buffer.alloc(12);
  await readAt(fd, fileSize - 12, buf, 0, 12);
  if (!buf.subarray(0, 4).equals(MAGIC_FOOTER)) {
    throw new Error("Corrupt archive (bad footer)");
  }
  const indexOff = Number(buf.readUInt32BE(4)) * 2 ** 32 + buf.readUInt32BE(8);
  return { indexOff };
}

async function readChunkIndex(fd, indexOff, chunkCount) {
  const buf = Buffer.alloc(chunkCount * 17);
  await readAt(fd, indexOff, buf, 0, chunkCount * 17);
  const out = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const base = i * 17;
    out[i] = {
      rawSize: buf.readUInt32BE(base),
      compSize: buf.readUInt32BE(base + 4),
      stored: (buf[base + 8] & 1) === 1,
      dataOffset: Number(buf.readUInt32BE(base + 9)) * 2 ** 32 + buf.readUInt32BE(base + 13),
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
      mtimeMs: Number(meta.readUInt32BE(4)) * 2 ** 32 + meta.readUInt32BE(8),
      rawSize: Number(meta.readUInt32BE(12)) * 2 ** 32 + meta.readUInt32BE(16),
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

export async function extractArchive({
  archive,
  dest,
  onProgress = () => {},
  onlyFiles = null,
} = {}) {
  const fd = await openForRead(archive);
  const fileSize = await sizeOf(fd);
  const header = await readArchiveHeader(fd);
  const { indexOff } = await readFooter(fd, fileSize);
  const chunkIndex = await readChunkIndex(fd, indexOff, header.chunkCount);
  const { files, mapsStart } = await readFileTable(fd, header.fileCount);
  await readFileMaps(fd, mapsStart, files);

  const filter = onlyFiles
    ? new Set(onlyFiles.map((p) => npath.normalize(p)))
    : null;

  let totalRaw = 0;
  let written = 0;
  for (const f of files) {
    if (filter && !filter.has(npath.normalize(f.relPath))) continue;
    const outPath = npath.join(dest, f.relPath);
    if (f.rawSize === 0) {
      await fs.mkdir(npath.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, Buffer.alloc(0));
      continue;
    }
    await fs.mkdir(npath.dirname(outPath), { recursive: true });
    const outFd = await openForWrite(outPath);
    for (const ci of f.map) {
      const c = chunkIndex[ci];
      const comp = Buffer.alloc(c.compSize);
      await readAt(fd, c.dataOffset, comp, 0, c.compSize);
      const raw = c.stored ? comp : await decompress(header.mode, comp);
      await writeAll(outFd, raw, 0, true);
    }
    await outFd.close();
    try {
      await fs.utimes(outPath, f.mtimeMs / 1000, f.mtimeMs / 1000);
    } catch {}
    totalRaw += f.rawSize;
    written += f.rawSize;
    onProgress({ written, total: totalRaw });
  }
  await fd.close();
  return { files: files.length, rawBytes: totalRaw, mode: header.mode };
}

export async function listArchive(archive) {
  const fd = await openForRead(archive);
  const fileSize = await sizeOf(fd);
  const header = await readArchiveHeader(fd);
  const { indexOff } = await readFooter(fd, fileSize);
  const { files } = await readFileTable(fd, header.fileCount);
  await fd.close();
  return { header, files };
}

/**
 * Rename entries inside an existing archive. Implemented as a clean repack:
 * the file table is rebuilt with new names while the (immutable) chunk data
 * section is copied verbatim, so offsets shift by a constant delta. The new
 * archive is written to a temp file and atomically swapped in.
 *
 * @param {object} o
 * @param {string} o.archive
 * @param {Map<string,string>} o.renames  oldPath -> newPath
 */
export async function renameInArchive({ archive, renames }) {
  const fd = await openForRead(archive);
  const fileSize = await sizeOf(fd);
  const header = await readArchiveHeader(fd);
  const { indexOff } = await readFooter(fd, fileSize);
  const { files, mapsStart } = await readFileTable(fd, header.fileCount);
  const dataStart = await readFileMaps(fd, mapsStart, files);
  const dataLen = indexOff - dataStart;
  const chunkIndex = await readChunkIndex(fd, indexOff, header.chunkCount);

  // Apply renames.
  for (const f of files) {
    const np = renames.get(f.relPath);
    if (np) f.relPath = String(np).split(npath.sep).join("/");
  }

  // Sizes.
  const oldFtSize = mapsStart - headerSize();
  let newFtSize = 0;
  for (const f of files) {
    const p = Buffer.from(f.relPath, "utf8");
    newFtSize += 2 + p.length + 4 + 8 + 8 + 4;
  }
  const mapsSize = dataStart - mapsStart;
  const newDataStart = headerSize() + newFtSize + mapsSize;
  const delta = newDataStart - dataStart;

  // New file table bytes.
  const ftBuf = Buffer.alloc(newFtSize);
  let o = 0;
  for (const f of files) {
    const p = Buffer.from(f.relPath, "utf8");
    writeU16(ftBuf, p.length, o); o += 2;
    p.copy(ftBuf, o); o += p.length;
    writeU32(ftBuf, f.mode, o); o += 4;
    writeU64(ftBuf, Math.round(f.mtimeMs), o); o += 8;
    writeU64(ftBuf, f.rawSize, o); o += 8;
    writeU32(ftBuf, f.chunkCount, o); o += 4;
  }

  // Maps bytes.
  const mapsBuf = Buffer.alloc(mapsSize);
  o = 0;
  for (const f of files) {
    for (let i = 0; i < f.map.length; i++) {
      writeU32(mapsBuf, f.map[i], o); o += 4;
    }
  }

  const tmp = archive + ".rename.tmp";
  const outFd = await openForWrite(tmp);
  const headBuf = Buffer.alloc(headerSize());
  MAGIC.copy(headBuf, 0);
  headBuf[4] = header.version;
  headBuf[5] = modeId(header.mode);
  headBuf[6] = 1;
  headBuf[7] = 0;
  writeU32(headBuf, files.length, 8);
  writeU32(headBuf, chunkIndex.length, 12);
  writeU64(headBuf, header.totalRaw, 16);
  writeU64(headBuf, header.totalComp, 24);
  await writeAll(outFd, headBuf, 0);
  let pos = headerSize();
  await writeAll(outFd, ftBuf, pos); pos += ftBuf.length;
  await writeAll(outFd, mapsBuf, pos); pos += mapsBuf.length;
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
  const newIndexOff = newDataStart + dataLen;
  const indexBuf = Buffer.alloc(chunkIndex.length * 17);
  for (let i = 0; i < chunkIndex.length; i++) {
    const c = chunkIndex[i];
    const base = i * 17;
    writeU32(indexBuf, c.rawSize, base);
    writeU32(indexBuf, c.compSize, base + 4);
    indexBuf[base + 8] = c.stored ? 1 : 0;
    writeU64(indexBuf, c.dataOffset + delta, base + 9);
  }
  await writeAll(outFd, indexBuf, newIndexOff);
  const footer = Buffer.alloc(12);
  MAGIC_FOOTER.copy(footer, 0);
  writeU64(footer, newIndexOff, 4);
  await writeAll(outFd, footer, newIndexOff + indexBuf.length);
  await outFd.truncate(newIndexOff + indexBuf.length + 12).catch(() => {});
  await outFd.close();
  await fd.close();

  // Atomic swap.
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

async function allocate(fh, bytes) {
  try {
    await fh.truncate(bytes).catch(() => {});
  } catch {}
}
