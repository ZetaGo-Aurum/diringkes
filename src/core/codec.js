// src/core/codec.js
// Compression codecs. Maps Diringkes "modes" to concrete algorithms.
//
//   ultra  -> Brotli q11 with large window (maximum ratio, slower)
//   max    -> Brotli q11 (high ratio)
//   fast   -> Deflate (zlib) level 6 (speed)
//   store  -> no compression (verbatim, for already-compressed media)
//
// Brotli with a 1GiB window + content-defined deduplication is what gives
// Diringkes its "impossible" ratios on redundant datasets.

import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

const BROTLI_ULTRA_PARAMS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 1024 * 1024 * 1024,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24, // 16MiB window
  },
};

const BROTLI_MAX_PARAMS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
  },
};

const MODES = {
  ultra: { id: 0, name: "ultra", compress: brotliUltra, decompress: brotliDecompress },
  max: { id: 1, name: "max", compress: brotliMax, decompress: brotliDecompress },
  fast: { id: 2, name: "fast", compress: deflateFast, decompress: inflate },
  store: { id: 3, name: "store", compress: (b) => b, decompress: (b) => b },
};

export function modeId(mode) {
  return (MODES[mode] || MODES.ultra).id;
}

export function modeFromId(id) {
  for (const m of Object.values(MODES)) if (m.id === id) return m.name;
  return "ultra";
}

function brotliUltra(buf) {
  return brotliCompress(buf, BROTLI_ULTRA_PARAMS);
}
function brotliMax(buf) {
  return brotliCompress(buf, BROTLI_MAX_PARAMS);
}
function deflateFast(buf) {
  return deflate(buf, { level: 6 });
}

export async function compress(mode, buf) {
  const fn = (MODES[mode] || MODES.ultra).compress;
  return fn(buf);
}

export async function decompress(mode, buf) {
  const fn = (MODES[mode] || MODES.ultra).decompress;
  return fn(buf);
}

export const MODE_NAMES = Object.keys(MODES);
