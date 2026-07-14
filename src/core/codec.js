// src/core/codec.js
// Compression codecs. Maps Diringkes "modes" to concrete algorithms.
//
//   ultra  -> Brotli q11, 16 MiB window (maximum ratio, slowest)
//   max    -> Brotli q9,  16 MiB window (near-ultra ratio, ~40x faster)
//   fast   -> Brotli q6,  16 MiB window (quick)
//   store  -> no compression (verbatim, for already-compressed media)
//
// Brotli with a 1GiB window + content-defined deduplication is what gives
// Diringkes its "impossible" ratios on redundant datasets.

import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

// Solid blocks are large (multi-MiB), so we always use the maximum Brotli
// window (LGWIN 24 = 16 MiB) to let the codec reference back across the whole
// block. Quality is tuned per mode for the ratio/speed sweet spot measured on
// real data: q10 gives the best ratio, q9 is nearly as good but ~40x faster.
const BROTLI_ULTRA_PARAMS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  },
};

const BROTLI_MAX_PARAMS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  },
};

const BROTLI_FAST_PARAMS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  },
};

const MODES = {
  ultra: { id: 0, name: "ultra", compress: brotliUltra, decompress: brotliDecompress },
  max: { id: 1, name: "max", compress: brotliMax, decompress: brotliDecompress },
  fast: { id: 2, name: "fast", compress: brotliFast, decompress: brotliDecompress },
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
  return brotliCompress(buf, sized(BROTLI_ULTRA_PARAMS, buf.length));
}
function brotliMax(buf) {
  return brotliCompress(buf, sized(BROTLI_MAX_PARAMS, buf.length));
}
function brotliFast(buf) {
  return brotliCompress(buf, sized(BROTLI_FAST_PARAMS, buf.length));
}

function sized(base, size) {
  return {
    params: {
      ...base.params,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  };
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
