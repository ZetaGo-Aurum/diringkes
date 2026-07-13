// src/util/humanize.js
// Human friendly byte / number formatting used across CLI + TUI.

export function humanizeBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  const fixed = value >= 100 || i === 0 ? Math.round(value) : value.toFixed(2);
  return `${fixed} ${units[i]}`;
}

export function humanizeRate(bytesPerSec) {
  return `${humanizeBytes(bytesPerSec)}/s`;
}

export function ratio(saved, total) {
  if (total <= 0) return 0;
  return (saved / total) * 100;
}

export function compressionFactor(input, output) {
  if (output <= 0) return Infinity;
  return input / output;
}

export function elapsed(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}
