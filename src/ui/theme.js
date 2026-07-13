// src/ui/theme.js
// Shared visual identity for CLI + TUI. Catppuccin-inspired modern palette.

import chalk from "chalk";

export const theme = {
  brand: (s) => chalk.hex("#89b4fa").bold(s),
  accent: (s) => chalk.hex("#f5c2e7")(s),
  green: (s) => chalk.hex("#a6e3a1")(s),
  red: (s) => chalk.hex("#f38ba8")(s),
  yellow: (s) => chalk.hex("#f9e2af")(s),
  teal: (s) => chalk.hex("#94e2d5")(s),
  sub: (s) => chalk.hex("#6c7086")(s),
  dim: (s) => chalk.dim(s),
  bold: (s) => chalk.bold(s),
  ul: (s) => chalk.underline(s),
};

export function banner(version = "1.0.0") {
  const line = theme.sub("─".repeat(54));
  const title = theme.brand("◆ Diringkes");
  const tag = theme.sub("ultra compression · archive · dedupe");
  return [
    "",
    `  ${title}  ${tag}`,
    `  ${theme.sub("by")} ${theme.accent("ZetaGo-Aurum")}  ${theme.sub("· v" + version)}`,
    line,
    "",
  ].join("\n");
}

export function progressBar(pct, width = 28) {
  const filled = Math.round((pct / 100) * width);
  const bar = theme.green("█".repeat(Math.max(0, filled))) + theme.sub("░".repeat(Math.max(0, width - filled)));
  return `[${bar}] ${pct.toFixed(0).padStart(3)}%`;
}
