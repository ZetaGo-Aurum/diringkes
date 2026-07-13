// src/cli.js
// Diringkes CLI — concise, color-rich command line interface.

import chalk from "chalk";
import { theme, banner, progressBar } from "./ui/theme.js";
import { compressTargets, extractTargets, inspectArchive } from "./core/engine.js";
import { humanizeBytes, elapsed } from "./util/humanize.js";

const COMMANDS = {
  compress: "c",
  extract: "x",
  list: "l",
  info: "i",
  tui: "t",
  about: "a",
  help: "h",
  version: "v",
};

function normalizeCommand(c) {
  if (!c) return null;
  const map = {
    compress: "compress", c: "compress",
    extract: "extract", x: "extract",
    list: "list", ls: "list", l: "list",
    info: "info", i: "info", stat: "info",
    tui: "tui", t: "tui",
    about: "about", a: "about",
    help: "help", h: "help", "?": "help",
    version: "version", v: "version", "--version": "version", "-v": "version",
  };
  return map[c] || null;
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--output") flags.output = args[++i];
    else if (a === "-m" || a === "--mode") flags.mode = args[++i];
    else if (a === "-b" || a === "--base") flags.base = args[++i];
    else if (a === "-q" || a === "--quiet") flags.quiet = true;
    else if (a === "-y" || a === "--yes") flags.yes = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "--ultra") flags.mode = "ultra";
    else if (a === "--max") flags.mode = "max";
    else if (a === "--fast") flags.mode = "fast";
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else flags._.push(a);
  }
  return flags;
}

const HELP = `
${theme.brand("Diringkes")} — ultra compression & archive toolkit
${theme.sub("Maintainer:")} ${theme.accent("ZetaGo-Aurum")}

${theme.bold("USAGE")}
  diringkes <command> [targets...] [options]
  drks      <command> [targets...] [options]      ${theme.sub("# short alias")}

${theme.bold("COMMANDS")}
  ${theme.green("c")}  compress <files/dirs>   ${theme.sub("Pack & ultra-compress")}
  ${theme.green("x")}  extract  <archive.drk>  ${theme.sub("Restore files")}
  ${theme.green("l")}  list     <archive.drk>  ${theme.sub("Show archive contents")}
  ${theme.green("i")}  info     <archive.drk>  ${theme.sub("Show compression stats")}
  ${theme.green("t")}  tui                   ${theme.sub("Launch interactive TUI")}
  ${theme.green("a")}  about                  ${theme.sub("Story & fun fact")}
  ${theme.green("h")}  help                   ${theme.sub("Show this help")}
  ${theme.green("v")}  version                ${theme.sub("Show version")}

${theme.bold("OPTIONS")}
  ${theme.yellow("-o, --output <file>")}   ${theme.sub("Output path (.drk)")}
  ${theme.yellow("-m, --mode <mode>")}     ${theme.sub("ultra | max | fast | store  (default: ultra)")}
  ${theme.yellow("-b, --base <dir>")}      ${theme.sub("Base dir for stored paths")}
  ${theme.yellow("-q, --quiet")}           ${theme.sub("Minimal output")}
  ${theme.yellow("-y, --yes")}            ${theme.sub("Skip confirmations")}

${theme.bold("EXAMPLES")}
  ${theme.accent("diringkes c ./Videos -o out.drk")}
  ${theme.accent("drks c bigfile.iso --ultra -o tiny.drk")}
  ${theme.accent("diringkes x out.drk -o ./restored")}
  ${theme.accent("diringkes i out.drk")}
  ${theme.accent("drks t")}   ${theme.sub("# open the TUI")}
`;

function clearLine() {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}

export async function runCli(argv) {
  const rawCmd = argv[0];
  if (rawCmd === undefined) {
    // No command -> drop into the TUI (touch/key friendly).
    const { runTui } = await import("./tui/app.js");
    return runTui([]);
  }
  if (rawCmd === "-h" || rawCmd === "--help") {
    console.log(banner());
    console.log(HELP);
    return 0;
  }
  if (rawCmd === "-v" || rawCmd === "--version" || rawCmd === "version") {
    console.log("diringkes 1.0.0  ·  ZetaGo-Aurum");
    return 0;
  }

  const cmd = normalizeCommand(rawCmd);
  const rest = argv.slice(1);
  const flags = parseFlags(rest);

  if (cmd === "help") {
    console.log(banner());
    console.log(HELP);
    return 0;
  }
  if (cmd === "tui") {
    const { runTui } = await import("./tui/app.js");
    return runTui([]);
  }

  try {
    if (cmd === "compress") return await doCompress(flags);
    if (cmd === "extract") return await doExtract(flags);
    if (cmd === "list") return await doList(flags);
    if (cmd === "info") return await doInfo(flags);
    if (cmd === "about") return doAbout();
  } catch (e) {
    clearLine();
    console.error(theme.red(`\n✖ ${e.message}`));
    return 1;
  }

  console.log(HELP);
  return 1;
}

async function doCompress(flags) {
  const targets = flags._;
  if (!targets.length) {
    throw new Error("Specify at least one file or directory to compress.");
  }
  const output = flags.output || defaultName(targets[0]);
  const mode = flags.mode || "ultra";

  if (!flags.quiet) {
    console.log(banner());
    console.log(
      `  ${theme.green("▶")} ${theme.bold("Compressing")} ${theme.sub(targets.join(", "))}`
    );
    console.log(
      `  ${theme.sub("mode")} ${theme.accent(mode)}  ${theme.sub("→")} ${theme.accent(output)}\n`
    );
  }

  const t0 = Date.now();
  let last = 0;
  const res = await compressTargets({
    targets,
    output,
    mode,
    base: flags.base,
    onProgress: ({ processed, total, done }) => {
      if (flags.quiet) return;
      const pct = total ? (processed / total) * 100 : 0;
      const now = Date.now();
      if (done || now - last > 60) {
        last = now;
        clearLine();
        const bps = processed / ((now - t0) / 1000 || 1);
        process.stdout.write(
          `  ${progressBar(pct)}  ${theme.sub(
            humanizeBytes(processed) + " / " + humanizeBytes(total)
          )}  ${theme.dim(humanizeBytes(bps) + "/s")}\r`
        );
      }
    },
  });

  clearLine();
  const dt = Date.now() - t0;
  console.log(
    `  ${theme.green("✔")} ${theme.bold("Done")}  ${theme.sub(res.inputCount + " items · " + res.chunkCount + " chunks")}`
  );
  console.log(
    `  ${theme.sub("raw")} ${theme.accent(humanizeBytes(res.rawBytes))}  ${theme.sub(
      "→"
    )}  ${theme.green(humanizeBytes(res.compBytes))}`
  );
  console.log(
    `  ${theme.sub("ratio")} ${theme.green(res.factor.toFixed(2) + "x")}  ${theme.sub(
      "saved"
    )} ${theme.green(res.savedPercent.toFixed(1) + "%")}  ${theme.dim("in " + elapsed(dt))}`
  );
  return 0;
}

async function doExtract(flags) {
  const archive = flags._[0];
  if (!archive) throw new Error("Specify an archive to extract.");
  const dest = flags.output || ".";
  if (!flags.quiet) {
    console.log(banner());
    console.log(`  ${theme.green("▶")} ${theme.bold("Extracting")} ${theme.accent(archive)} ${theme.sub("→")} ${theme.accent(dest)}\n`);
  }
  const t0 = Date.now();
  const res = await extractTargets({
    archive,
    dest,
    onProgress: () => {},
  });
  if (!flags.quiet) {
    console.log(
      `  ${theme.green("✔")} ${theme.bold("Extracted")} ${theme.sub(
        res.files + " files · " + humanizeBytes(res.rawBytes)
      )}  ${theme.dim("in " + elapsed(Date.now() - t0))}`
    );
  }
  return 0;
}

async function doList(flags) {
  const archive = flags._[0];
  if (!archive) throw new Error("Specify an archive to list.");
  const { files } = await inspectArchive(archive);
  console.log(banner());
  console.log(`  ${theme.bold(archive)}  ${theme.sub("(" + files.length + " entries)")}\n`);
  for (const f of files) {
    console.log(
      `  ${theme.green("•")} ${f.relPath}  ${theme.sub(humanizeBytes(f.rawSize))}`
    );
  }
  return 0;
}

async function doInfo(flags) {
  const archive = flags._[0];
  if (!archive) throw new Error("Specify an archive to inspect.");
  const info = await inspectArchive(archive);
  console.log(banner());
  console.log(`  ${theme.bold(archive)}\n`);
  console.log(`  ${theme.sub("mode")}        ${theme.accent(info.header.mode)}`);
  console.log(`  ${theme.sub("files")}       ${theme.accent(info.files.length)}`);
  console.log(`  ${theme.sub("chunks")}      ${theme.accent(info.header.chunkCount)}`);
  console.log(`  ${theme.sub("raw size")}    ${theme.accent(humanizeBytes(info.totalRaw))}`);
  console.log(`  ${theme.sub("stored size")} ${theme.green(humanizeBytes(info.totalComp))}`);
  console.log(`  ${theme.sub("ratio")}       ${theme.green(info.factor.toFixed(2) + "x")}`);
  console.log(`  ${theme.sub("saved")}       ${theme.green(info.savedPercent.toFixed(1) + "%")}`);
  return 0;
}

function defaultName(target) {
  const base = target.replace(/[/\\]$/, "").split(/[/\\]/).pop() || "archive";
  return `${base}.drk`;
}

function doAbout() {
  console.log(banner());
  const fy = theme.accent;
  console.log(`  ${theme.bold("Diringkes")} — ${theme.sub("nama & asal-usul")}\n`);
  console.log(`  ${theme.sub("Kata")} ${fy('"diringkes"')} ${theme.sub("terinspirasi dari bahasa Jawa,")}`);
  console.log(`  ${theme.sub("yang bermakna")} ${fy('"diringkas"')} ${theme.sub("— yaitu")} ${fy('"dibuat ringkas / diringkas"')}${theme.sub(".")}`);
  console.log(`  ${theme.sub("Filosofinya: bawa yang berat jadi ringan, yang panjang jadi pendek.")}\n`);
  console.log(`  ${theme.sub("Dibuat & dirawat oleh")} ${fy("ZetaGo-Aurum")}${theme.sub(".")}`);
  console.log(`  ${theme.sub("Lisensi MIT · v1.0.0")}\n`);
  console.log(`  ${theme.bold("Support & Community")}`);
  console.log(`  ${theme.sub("Trakteer  ")} ${theme.teal("https://trakteer.id/Aleocrophic/tip")}`);
  console.log(`  ${theme.sub("Community")} ${theme.teal("https://chat.whatsapp.com/KwTSsF7t5868ERksMPamyQ")}\n`);
  return 0;
}
