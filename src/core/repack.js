// src/core/repack.js
// Alternative output containers for the non-.drk formats.
//
//   .zip  -> written natively with zlib deflate (no external deps)
//   .7z   -> shelled out to `7z`  (p7zip) when available
//   .rar  -> shelled out to `rar`  when available
//
// The native .drk path (with dedupe + Brotli) lives in archive.js. These
// adapters are plain single-pass compressors: great for everyday files, but
// they do not get Diringkes' cross-file deduplication superpower.

import zlib from "node:zlib";
import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Best-effort check for a binary. Treats "command not found" as missing;
// any other error means the binary exists (it just rejected the arg).
async function commandExists(tool) {
  try {
    await execFileP(tool, ["-h"], { timeout: 8000 });
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    return true;
  }
}

// Try to install p7zip via whatever package manager is available. Best-effort:
// if it fails (no network / no permission) we simply re-check and fall back.
async function tryInstall7z() {
  const installers = [
    ["pkg", ["install", "-y", "p7zip"]], // Termux
    ["sudo", ["apt-get", "install", "-y", "p7zip-full"]], // Debian/Ubuntu
    ["apt-get", ["install", "-y", "p7zip-full"]],
    ["brew", ["install", "p7zip"]], // macOS
    ["apk", ["add", "p7zip"]], // Alpine
  ];
  for (const [bin, args] of installers) {
    if (await commandExists(bin)) {
      try {
        await execFileP(bin, args, { timeout: 180000 });
      } catch {}
      break;
    }
  }
}

// --- CRC32 (zip needs it) --------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (b, v, o) => b.writeUInt16LE(v >>> 0, o);
const u32 = (b, v, o) => b.writeUInt32LE(v >>> 0, o);

// ---------------------------------------------------------------------------
// ZIP (native, deflate)
// ---------------------------------------------------------------------------
export async function repackZip({ inputs, output, level = 9, onProgress = () => {} }) {
  const parts = [];
  const central = [];
  let offset = 0;
  let totalRaw = 0;
  let byteDone = 0;
  const totalFiles = inputs.length;

  for (const f of inputs) {
    const data = await fs.readFile(f.path);
    const lvl = Math.max(0, Math.min(9, level)); // zlib allows 0..9
    const comp = lvl > 0 ? zlib.deflateRawSync(data, { level: lvl }) : data;
    const method = lvl > 0 ? 8 : 0;
    const crc = crc32(data);
    const name = Buffer.from(f.relPath, "utf8");

    const lh = Buffer.alloc(30);
    u32(lh, 0x04034b50, 0);
    u16(lh, 20, 4);
    u16(lh, 0x0800, 6); // UTF-8 filename flag
    u16(lh, method, 8);
    u16(lh, 0, 10);
    u16(lh, 0, 12);
    u32(lh, crc, 14);
    u32(lh, comp.length, 18);
    u32(lh, data.length, 22);
    u16(lh, name.length, 26);
    u16(lh, 0, 28);

    parts.push(lh, name, comp);

    const cd = Buffer.alloc(46);
    u32(cd, 0x02014b50, 0);
    u16(cd, 20, 4);
    u16(cd, 20, 6);
    u16(cd, 0x0800, 8);
    u16(cd, method, 10);
    u16(cd, 0, 12);
    u16(cd, 0, 14);
    u32(cd, crc, 16);
    u32(cd, comp.length, 20);
    u32(cd, data.length, 24);
    u16(cd, name.length, 28);
    u16(cd, 0, 30);
    u16(cd, 0, 32);
    u16(cd, 0, 34);
    u16(cd, 0, 36);
    u32(cd, 0, 38);
    u32(cd, offset, 42);
    central.push(cd, name);

    offset += lh.length + name.length + comp.length;
    totalRaw += data.length;
    byteDone += data.length;
    onProgress({ processed: byteDone, total: totalRaw });
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  u32(eocd, 0x06054b50, 0);
  u16(eocd, totalFiles, 8);
  u16(eocd, totalFiles, 10);
  u32(eocd, cdBuf.length, 12);
  u32(eocd, offset, 16);

  await fs.writeFile(output, Buffer.concat([...parts, cdBuf, eocd]));

  return {
    output,
    fileCount: totalFiles,
    chunkCount: totalFiles,
    rawBytes: totalRaw,
    compBytes: offset + cdBuf.length + eocd.length,
    inputCount: totalFiles,
  };
}

// ---------------------------------------------------------------------------
// 7z / rar (external tools)
// ---------------------------------------------------------------------------
export async function repackExternal({ inputs, output, tool, level = 9, onProgress = () => {} }) {
  const bin = tool === "rar" ? "rar" : "7z";
  if (!(await commandExists(bin))) {
    if (tool === "7z") await tryInstall7z();
    if (!(await commandExists(bin))) {
      const hint =
        tool === "rar"
          ? "Install `rar` (rarlab) or pick .drk / .zip / .7z."
          : "Install `p7zip` (provides `7z`) or pick .drk / .zip.";
      throw new Error(`${bin} not found. ${hint}`);
    }
  }
  const totalRaw = inputs.reduce((a, f) => a + f.size, 0);
  const mx = Math.min(9, Math.max(0, level));
  // `-bsp1` makes 7z stream progress percentages to stdout so the UI shows a
  // moving bar instead of appearing stuck at 0%.
  const args =
    tool === "rar"
      ? ["a", "-y", `-m${mx > 5 ? 5 : mx}`, output, ...inputs.map((f) => f.path)]
      : ["a", "-y", "-bsp1", `-mx=${mx}`, output, ...inputs.map((f) => f.path)];

  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let errbuf = "";
    let lastPct = -1;
    let lastFile = "";
    let sawReal = false;
    let pollTimer = null;

    // Primary: parse REAL progress. Both 7z and rar stream lines like
    // " 42% + name" but separate updates with backspaces (\b) rather than
    // newlines, so we scan the whole chunk for the LAST "<n>%" occurrence and
    // the current file name.
    const onData = (d) => {
      const s = d.toString();
      let m;
      const re = /(\d{1,3})%(?:\s*[+\-]?\s*([^\b\r\n]+?)\s*(?=[\b\r\n]|$))?/g;
      let last = null;
      while ((m = re.exec(s)) !== null) last = m;
      if (last) {
        const pct = Math.min(100, Number(last[1]));
        const file = (last[2] || lastFile).trim();
        if (file) lastFile = file;
        if (pct !== lastPct) {
          sawReal = true;
          lastPct = pct;
          onProgress({
            phase: "compress",
            processed: (pct / 100) * totalRaw,
            total: totalRaw,
            log: `${bin}: ${pct}%${lastFile ? " · " + lastFile : ""}`,
          });
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => {
      errbuf += d.toString();
      onData(d);
    });

    // Fallback (real, not fake): if the tool emits no percentage, poll the
    // growing output file so the user still sees genuine bytes-written motion.
    pollTimer = setInterval(async () => {
      if (sawReal) return;
      try {
        const st = await fs.stat(output);
        onProgress({
          phase: "compress",
          processed: st.size,
          total: totalRaw,
          log: `${bin}: written ${(st.size / 1048576).toFixed(1)} MB`,
        });
      } catch {}
    }, 300);

    child.on("error", (e) => {
      clearInterval(pollTimer);
      reject(e);
    });
    child.on("close", (code) => {
      clearInterval(pollTimer);
      if (code === 0) resolve();
      else {
        const hint =
          tool === "rar"
            ? "Install `rar` (rarlab) or pick .drk / .zip / .7z."
            : "Install `p7zip` (provides `7z`) or pick .drk / .zip.";
        reject(new Error(`${bin} exited ${code}: ${errbuf.trim().slice(-200)}. ${hint}`));
      }
    });
  });

  onProgress({ phase: "compress", processed: totalRaw, total: totalRaw });
  const { size } = await fs.stat(output);
  return {
    output,
    fileCount: inputs.length,
    chunkCount: inputs.length,
    rawBytes: totalRaw,
    compBytes: size,
    inputCount: inputs.length,
  };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
export async function repack({ inputs, output, format = "drk", level = 9, onProgress = () => {} }) {
  if (format === "zip") return repackZip({ inputs, output, level, onProgress });
  if (format === "7z") return repackExternal({ inputs, output, tool: "7z", level, onProgress });
  if (format === "rar") return repackExternal({ inputs, output, tool: "rar", level, onProgress });
  throw new Error("Unsupported format: " + format);
}

// Map a Diringkes compression mode to a 0-9 level used by zip/7z/rar.
export function modeToLevel(mode) {
  return { store: 0, fast: 6, max: 9, ultra: 9 }[mode] ?? 9;
}
