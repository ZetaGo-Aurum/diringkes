// src/tui/app.js
// Diringkes TUI — a GUI-style archive-manager interface built on Ink.
//
// It behaves like a desktop archive app, just rendered in the terminal:
//   • dual panes (filesystem | archive) on wide terminals, single pane on phones
//   • arrow-key / number "clicks", checkboxes for multi-select
//   • a button-styled action bar: Compress · Extract · Rename · Info · Pane · Quit
//   • inline rename (no manual path typing) for both files and archive entries
//   • live progress, responsive layout that reflows to the terminal width
//
// "Touch" maps to the on-screen keyboard: every action is a hotkey, and the
// layout stays usable at 40 columns.

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useInput, useStdout, useApp } from "ink";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  compressTargets,
  extractTargets,
  inspectArchive,
  renameInArchive,
} from "../core/engine.js";
import { humanizeBytes, elapsed } from "../util/humanize.js";

const h = React.createElement;
const C = {
  brand: "#89b4fa",
  accent: "#f5c2e7",
  green: "#a6e3a1",
  red: "#f38ba8",
  yellow: "#f9e2af",
  teal: "#94e2d5",
  sub: "#6c7086",
  dim: "#45475a",
  dir: "#f9e2af",
};
const MODES = ["ultra", "max", "fast", "store"];

// Compression-strength presets shown as target ratios (1x .. 10x). These map
// to a concrete codec mode (.drk) or a 0-9 level (zip/7z/rar). The *actual*
// ratio depends on the data — already-compressed files (photos, video, .gz)
// can't shrink further, that's information theory, not a bug.
const RATIOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FORMATS = [
  { id: "drk", label: ".drk  Diringkes ultra (dedupe + Brotli)" },
  { id: "zip", label: ".zip  standard (native, portable)" },
  { id: "7z", label: ".7z   7-Zip (needs `7z`)" },
  { id: "rar", label: ".rar  RAR (needs `rar`)" },
];
const FORMAT_EXT = { drk: ".drk", zip: ".zip", "7z": ".7z", rar: ".rar" };

function ratioToMode(r) {
  if (r <= 1) return "store";
  if (r <= 3) return "fast";
  if (r <= 6) return "max";
  return "ultra";
}

const MODE_DESC = {
  store: "no compression · instant",
  fast: "light effort · very fast",
  max: "strong effort · balanced",
  ultra: "maximum effort · slowest",
};

function KeyCap({ k, label, color = C.green, wide = true }) {
  return h(
    Box,
    { flexDirection: "row" },
    h(Text, { color: C.sub }, "["),
    h(Text, { color, bold: true }, k),
    h(Text, { color: C.sub }, "]"),
    wide ? h(Text, { color: C.sub }, label + "  ") : h(Text, { color: C.sub }, " ")
  );
}

function brandTitle(narrow) {
  return h(
    Box,
    { flexDirection: "column", marginBottom: narrow ? 0 : 1 },
    h(Text, { color: C.brand, bold: true }, narrow ? "◆ Diringkes" : "◆  D I R I N G K E S"),
    h(Text, { color: C.sub }, "  ultra compression · archive · dedupe · by ZetaGo-Aurum"),
    h(Text, { color: C.dim }, "  diringkes = diringkas (Jw.) · trakteer.id/Aleocrophic")
  );
}

function Bar({ pct, color = C.green, width = 26 }) {
  const filled = Math.max(0, Math.round((pct / 100) * width));
  return h(
    Text,
    null,
    "[",
    h(Text, { color }, "█".repeat(filled)),
    h(Text, { color: C.sub }, "░".repeat(Math.max(0, width - filled))),
    "]"
  );
}

async function readDir(dir) {
  const list = await fs.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of list) {
    if (e.name === "." || e.name === "..") continue;
    const p = path.join(dir, e.name);
    let st;
    try {
      st = await fs.stat(p);
    } catch {
      continue;
    }
    items.push({ name: e.name, isDir: st.isDirectory(), size: st.size });
  }
  items.sort((a, b) => (b.isDir === a.isDir ? (a.name < b.name ? -1 : 1) : b.isDir ? 1 : -1));
  return items;
}

export function App() {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const columns = stdout ? stdout.columns || 80 : 80;
  const wide = columns >= 88;
  const narrow = columns < 64;
  const pad = narrow ? 1 : 2;
  const rows = stdout ? stdout.rows || 24 : 24;
  // Safe content height for a pane: brand(3)+sep(1)+actionbar(1)+2 hints(2)=7,
  // minus pane border(2)+title(1)=3. `win` leaves 2 lines for ▲/▼ hints.
  const maxRows = Math.max(3, rows - 10);
  const win = Math.max(1, maxRows - 2);

  function clampScroll(cursor, scroll, len) {
    if (len <= win) return 0;
    let s = scroll;
    if (cursor < s) s = cursor;
    else if (cursor >= s + win) s = cursor - win + 1;
    return Math.max(0, Math.min(s, len - win));
  }

  const [screen, setScreen] = useState("browser");
  const [view, setView] = useState("fs"); // fs | archive
  const [paneFocus, setPaneFocus] = useState("fs");

  const [cwd, setCwd] = useState(process.cwd());
  const [fsEntries, setFsEntries] = useState([]);
  const [fsCursor, setFsCursor] = useState(0);
  const [fsScroll, setFsScroll] = useState(0);
  const [fsSel, setFsSel] = useState(() => new Set());

  const [arcPath, setArcPath] = useState(null);
  const [arcEntries, setArcEntries] = useState([]);
  const [arcCursor, setArcCursor] = useState(0);
  const [arcScroll, setArcScroll] = useState(0);
  const [arcSel, setArcSel] = useState(() => new Set());

  const [action, setAction] = useState(null); // {type, targets/output/mode/format/level | archive/dest/onlyFiles}
  const [rename, setRename] = useState(null); // {kind, old, buf, baseDir}
  const [ratioSel, setRatioSel] = useState(9); // index into RATIOS (10x)
  const [formatSel, setFormatSel] = useState(0); // index into FORMATS
  const [nameBuf, setNameBuf] = useState("");
  const [prog, setProg] = useState({ pct: 0, msg: "" });
  const [logs, setLogs] = useState([]);
  const logRef = useRef([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const actionRef = useRef(null);

  const finish = useCallback((code = 0) => setTimeout(() => exit(code), 30), [exit]);

  const loadFs = useCallback(async (dir) => {
    try {
      const items = await readDir(dir);
      setFsEntries(items);
      setFsCursor(0);
      setFsScroll(0);
    } catch (e) {
      setError("Cannot open: " + e.message);
      setScreen("error");
    }
  }, []);

  useEffect(() => {
    if (screen === "browser") loadFs(cwd);
  }, [cwd, screen, loadFs]);

  const openArchive = useCallback(async (p) => {
    try {
      const info = await inspectArchive(p);
      setArcEntries(info.files);
      setArcPath(p);
      setArcCursor(0);
      setArcScroll(0);
      setArcSel(new Set());
      setView("archive");
      setPaneFocus("archive");
    } catch (e) {
      setError(e.message);
      setScreen("error");
    }
  }, []);

  const active = wide ? paneFocus : view;
  const entries = active === "fs" ? fsEntries : arcEntries;
  const cursor = active === "fs" ? fsCursor : arcCursor;
  const sel = active === "fs" ? fsSel : arcSel;

  const move = (d) => {
    const n = Math.max(0, Math.min(entries.length - 1, cursor + d));
    if (active === "fs") {
      setFsCursor(n);
      setFsScroll((s) => clampScroll(n, s, fsEntries.length));
    } else {
      setArcCursor(n);
      setArcScroll((s) => clampScroll(n, s, arcEntries.length));
    }
  };

  const toggle = (key) => {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (active === "fs") setFsSel(next);
    else setArcSel(next);
  };

  const selectAll = () => {
    if (sel.size === entries.length) {
      if (active === "fs") setFsSel(new Set());
      else setArcSel(new Set());
    } else {
      if (active === "fs") setFsSel(new Set(entries.map((e) => e.name)));
      else setArcSel(new Set(entries.map((e) => e.relPath)));
    }
  };

  const goParent = () => {
    if (view === "archive") {
      setView("fs");
      setPaneFocus("fs");
      return;
    }
    const parent = path.dirname(cwd);
    if (parent !== cwd) {
      setCwd(parent);
      setFsSel(new Set());
    }
  };

  // ---- actions ----------------------------------------------------------
  const startCompress = () => {
    if (view === "archive") {
      setView("fs");
      setPaneFocus("fs");
    }
    let targets, outBase;
    if (fsSel.size > 0) {
      const names = [...fsSel];
      targets = names.map((n) => path.join(cwd, n));
      outBase = names[0];
    } else {
      targets = [cwd];
      outBase = path.basename(cwd);
    }
    // Remember the selection; the wizard (ratio → format → name) finalizes it.
    actionRef.current = { type: "compress", targets, outBase };
    setRatioSel(9);
    setFormatSel(0);
    setScreen("wizard_ratio");
  };

  const finalizeAndCompress = () => {
    const act = actionRef.current;
    if (!act) return;
    const fmt = FORMATS[formatSel].id;
    const clean = (nameBuf || act.outBase).replace(/\.(drk|zip|7z|rar)$/i, "");
    act.output = path.join(cwd, clean + FORMAT_EXT[fmt]);
    act.mode = ratioToMode(RATIOS[ratioSel]);
    act.format = fmt;
    act.level = RATIOS[ratioSel];
    setAction({ ...act });
    runAction();
  };

  const startExtract = () => {
    if (view !== "archive" || !arcPath) return;
    const only = arcSel.size > 0 ? [...arcSel] : null;
    const dest = path.join(
      cwd,
      path.basename(arcPath).replace(/\.drk$/i, "") + "_extracted"
    );
    const act = { type: "extract", archive: arcPath, dest, onlyFiles: only };
    actionRef.current = act;
    setAction(act);
    setScreen("progress");
    runAction();
  };

  const startRename = () => {
    if (active === "fs") {
      const e = fsEntries[fsCursor];
      if (!e || e.name === "..") return;
      setRename({ kind: "fs", old: e.name, buf: e.name, baseDir: cwd });
    } else {
      const e = arcEntries[arcCursor];
      if (!e) return;
      setRename({ kind: "archive", old: e.relPath, buf: path.basename(e.relPath), baseDir: path.dirname(e.relPath) });
    }
    setScreen("rename");
  };

  const startInfo = () => {
    if (active === "archive" && arcPath) {
      inspectArchive(arcPath).then((info) => {
        setResult({ kind: "inspect", path: arcPath, ...info });
        setScreen("result");
      });
      return;
    }
    const e = fsEntries[fsCursor];
    if (!e) return;
    const p = path.join(cwd, e.name);
    if (e.isDir) {
      setResult({ kind: "dir", name: e.name });
      setScreen("result");
    } else if (/\.drk$/i.test(e.name)) {
      inspectArchive(p).then((info) => {
        setResult({ kind: "inspect", path: p, ...info });
        setScreen("result");
      });
    } else {
      setResult({ kind: "file", name: e.name, size: e.size });
      setScreen("result");
    }
  };

  const runAction = useCallback(() => {
    const act = actionRef.current;
    if (!act) return;
    setScreen("progress");
    setProg({ pct: 0, msg: "" });
    logRef.current = [];
    setLogs([]);
    const ab = { aborted: false };
    abortRef.current = ab;
    let lastLogAt = 0;
    const pushLog = (msg, throttle) => {
      if (!msg) return;
      if (throttle && Date.now() - lastLogAt < 250) return;
      lastLogAt = Date.now();
      const arr = logRef.current;
      if (arr[arr.length - 1] === msg) return;
      arr.push(msg);
      if (arr.length > 6) arr.shift();
      setLogs([...arr]);
    };
    (async () => {
      try {
        if (act.type === "compress") {
          const t0 = Date.now();
          const res = await compressTargets({
            targets: act.targets,
            output: act.output,
            mode: act.mode,
            format: act.format,
            level: act.level,
            onProgress: ({ processed, total, phase, log }) => {
              if (ab.aborted) return;
              const label = phase === "scan" ? "scanning" : phase === "compress" ? "packing" : "working";
              setProg({ pct: total ? (processed / total) * 100 : 0, msg: `${label} ${humanizeBytes(processed)} / ${humanizeBytes(total)}` });
              if (log) pushLog(log);
              else pushLog(`${label} ${humanizeBytes(processed)} / ${humanizeBytes(total)}`, true);
            },
          });
          if (ab.aborted) return;
          setResult({ kind: "compress", ...res, mode: act.mode, format: act.format, ms: Date.now() - t0 });
          await loadFs(cwd).catch(() => {});
          setFsSel(new Set());
          setScreen("result");
        } else if (act.type === "extract") {
          const t0 = Date.now();
          const res = await extractTargets({ archive: act.archive, dest: act.dest, onlyFiles: act.onlyFiles });
          if (ab.aborted) return;
          setResult({ kind: "extract", ...res, ms: Date.now() - t0, dest: act.dest });
          await loadFs(cwd).catch(() => {});
          setScreen("result");
        }
      } catch (e) {
        if (ab.aborted) return;
        setError(e.message);
        setScreen("error");
      }
    })();
  }, [cwd, loadFs]);

  const commitRename = useCallback(async () => {
    const r = rename;
    if (!r) return;
    try {
      if (r.kind === "fs") {
        const newName = r.buf.trim();
        if (newName && newName !== r.old) {
          await fs.rename(path.join(r.baseDir, r.old), path.join(r.baseDir, newName));
          await loadFs(cwd).catch(() => {});
        }
      } else {
        const base = path.basename(r.buf.trim()) || path.basename(r.old);
        const newRel = path.join(r.baseDir, base).split(path.sep).join("/");
        if (newRel !== r.old) {
          await renameInArchive({ archive: arcPath, renames: new Map([[r.old, newRel]]) });
          const info = await inspectArchive(arcPath);
          setArcEntries(info.files);
          setArcCursor(0);
        }
      }
      setRename(null);
      setScreen("browser");
    } catch (e) {
      setError(e.message);
      setScreen("error");
    }
  }, [rename, arcPath, cwd, loadFs]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return finish(0);

    if (screen === "browser") {
      if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.leftArrow && wide) setPaneFocus((p) => (p === "fs" ? "archive" : "fs"));
      else if (key.rightArrow && wide) setPaneFocus((p) => (p === "fs" ? "archive" : "fs"));
      else if (key.tab) {
        if (wide) setPaneFocus((p) => (p === "fs" ? "archive" : "fs"));
        else setView((v) => (v === "fs" ? "archive" : "fs"));
      } else if (key.return) {
        if (active === "fs") {
          const e = fsEntries[fsCursor];
          if (!e) return;
          if (e.isDir) {
            setCwd(path.join(cwd, e.name));
            setFsSel(new Set());
          } else if (/\.drk$/i.test(e.name)) {
            openArchive(path.join(cwd, e.name));
          } else {
            toggle(e.name);
          }
        } else {
          const e = arcEntries[arcCursor];
          if (e) toggle(e.relPath);
        }
      } else if (key.backspace || key.delete) {
        goParent();
      } else if (input === " ") {
        const e = entries[cursor];
        if (e) toggle(active === "fs" ? e.name : e.relPath);
      } else if (input === "a") {
        selectAll();
      } else if (input === "c") {
        startCompress();
      } else if (input === "x") {
        if (active === "archive") startExtract();
        else {
          const e = fsEntries[fsCursor];
          if (e && /\.drk$/i.test(e.name)) openArchive(path.join(cwd, e.name));
        }
      } else if (input === "r") {
        startRename();
      } else if (input === "i") {
        startInfo();
      } else if (input === "q") {
        finish(0);
      }
    } else if (screen === "wizard_ratio") {
      if (key.escape) setScreen("browser");
      else if (key.upArrow) setRatioSel((r) => Math.max(0, r - 1));
      else if (key.downArrow) setRatioSel((r) => Math.min(RATIOS.length - 1, r + 1));
      else if (/^[0-9]$/.test(input)) setRatioSel(input === "0" ? RATIOS.length - 1 : Number(input) - 1);
      else if (key.return) setScreen("wizard_format");
    } else if (screen === "wizard_format") {
      if (key.escape) setScreen("wizard_ratio");
      else if (key.upArrow) setFormatSel((f) => Math.max(0, f - 1));
      else if (key.downArrow) setFormatSel((f) => Math.min(FORMATS.length - 1, f + 1));
      else if (/^[1-4]$/.test(input)) setFormatSel(Number(input) - 1);
      else if (key.return) {
        const base = actionRef.current?.outBase || "archive";
        setNameBuf(base.replace(/\.(drk|zip|7z|rar)$/i, ""));
        setScreen("wizard_name");
      }
    } else if (screen === "wizard_name") {
      if (key.escape) setScreen("wizard_format");
      else if (key.return) finalizeAndCompress();
      else if (key.backspace || key.delete) setNameBuf((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && input.length === 1) setNameBuf((s) => s + input);
    } else if (screen === "rename") {
      if (key.escape) setScreen("browser");
      else if (key.return) commitRename();
      else if (key.backspace || key.delete) setRename((r) => ({ ...r, buf: r.buf.slice(0, -1) }));
      else if (input && !key.ctrl && !key.meta && input.length === 1) setRename((r) => ({ ...r, buf: r.buf + input }));
    } else if (screen === "progress") {
      if (key.escape || input === "q") {
        if (abortRef.current) abortRef.current.aborted = true;
        setScreen("browser");
      }
    } else if (screen === "result" || screen === "error") {
      if (key.escape || key.return || input === "q" || input === " ") {
        setScreen("browser");
        setResult(null);
        setError("");
        setAction(null);
      }
    }
  });

  // ---- render panes -----------------------------------------------------
  const renderPane = (kind) => {
    const isFs = kind === "fs";
    const list = isFs ? fsEntries : arcEntries;
    const cur = isFs ? fsCursor : arcCursor;
    const isActive = (wide ? paneFocus : view) === kind;
    const title = isFs ? "FILES  " + (narrow ? "" : cwd) : "ARCHIVE  " + (arcPath ? path.basename(arcPath) : "(none)");
    const selSet = isFs ? fsSel : arcSel;
    const scroll = isFs ? fsScroll : arcScroll;
    const start = Math.max(0, Math.min(scroll, Math.max(0, list.length - win)));
    const end = Math.min(list.length, start + win);
    const visible = list.slice(start, end);

    const rowEls = [];
    if (start > 0) {
      rowEls.push(h(Text, { key: "up", color: C.dim }, `  ▲ ${start} more above`));
    }
    visible.forEach((e, i) => {
      const abs = start + i;
      const name = isFs ? e.name : e.relPath;
      const checked = selSet.has(name);
      const isCur = abs === cur && isActive;
      const isDir = isFs ? e.isDir : false;
      const sizeStr = isFs ? (isDir ? "<DIR>" : humanizeBytes(e.size)) : humanizeBytes(e.rawSize);
      rowEls.push(
        h(
          Box,
          { key: name + abs, flexDirection: "row" },
          h(Text, { color: isCur ? C.green : C.sub }, isCur ? " ▸ " : "   "),
          h(Text, { color: checked ? C.yellow : C.sub }, checked ? "[x] " : "[ ] "),
          h(Text, { color: isDir ? C.dir : isCur ? C.brand : C.sub, bold: isCur }, name.slice(0, narrow ? 26 : 40)),
          h(Text, { color: C.dim }, "  " + sizeStr)
        )
      );
    });
    if (end < list.length) {
      rowEls.push(h(Text, { key: "down", color: C.dim }, `  ▼ ${list.length - end} more below`));
    }
    if (list.length === 0) {
      rowEls.push(h(Text, { color: C.dim }, "  (empty)"));
    }
    return h(
      Box,
      { flexDirection: "column", flexGrow: 1, borderStyle: isActive ? "round" : "single", borderColor: isActive ? C.brand : C.dim, paddingX: 1 },
      h(Text, { color: isActive ? C.brand : C.dim, bold: true }, (isActive ? "▸ " : "  ") + title),
      ...rowEls
    );
  };

  let body;
  if (screen === "browser") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad, flexGrow: 1 },
      wide
        ? h(Box, { flexDirection: "row", gap: 1, flexGrow: 1 }, renderPane("fs"), renderPane("archive"))
        : renderPane(view),
      h(
        Box,
        { flexDirection: "row", flexWrap: "wrap", marginTop: 1 },
        KeyCap({ k: "C", label: "ompress", wide }),
        KeyCap({ k: "X", label: "tract/open", wide, color: C.teal }),
        KeyCap({ k: "R", label: "ename", wide, color: C.yellow }),
        KeyCap({ k: "I", label: "nfo", wide, color: C.accent }),
        KeyCap({ k: "A", label: "ll", wide, color: C.sub }),
        KeyCap({ k: "↵", label: wide ? "open/sel" : "open", wide, color: C.brand }),
        KeyCap({ k: "Q", label: "uit", wide, color: C.red })
      ),
      h(Text, { color: C.dim }, "  C compress selected · X extract (in archive) or open .drk · R rename · I info · A select all"),
      h(Text, { color: C.dim }, "  ↑↓ move · space select · enter open/check · tab/←→ pane · bsck parent")
    );
  } else if (screen === "wizard_ratio") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.accent, bold: true }, "① Compression strength (effort level)"),
      h(Text, { color: C.sub }, "   Higher = tries harder, not a guaranteed ratio."),
      h(Text, { color: C.dim }, "   text/logs shrink a lot; photos, video, .gz/.zip/.mp4 barely change (already compressed)."),
      ...RATIOS.map((r, i) => {
        const m = ratioToMode(r);
        const label = `${i + 1}. Level ${r} · ${m} — ${MODE_DESC[m]}`;
        return h(
          Box,
          { key: r, flexDirection: "row" },
          h(Text, { color: i === ratioSel ? C.green : C.sub, bold: i === ratioSel }, i === ratioSel ? " ▸ " : "   "),
          h(Text, { color: i === ratioSel ? C.brand : C.sub }, label)
        );
      }),
      h(Text, { color: C.sub, marginTop: 1 }, "↑↓ or 1-9,0 to choose · Enter next · Esc cancel")
    );
  } else if (screen === "wizard_format") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.accent, bold: true }, "② Output format"),
      ...FORMATS.map((f, i) =>
        h(
          Box,
          { key: f.id, flexDirection: "row" },
          h(Text, { color: i === formatSel ? C.green : C.sub, bold: i === formatSel }, i === formatSel ? " ▸ " : "   "),
          h(Text, { color: i === formatSel ? C.brand : C.sub }, `${i + 1}. ${f.label}`)
        )
      ),
      h(Text, { color: C.sub, marginTop: 1 }, "↑↓ or 1-4 to choose · Enter next · Esc back")
    );
  } else if (screen === "wizard_name") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.accent, bold: true }, "③ File name"),
      h(Text, { color: C.dim }, "   default (edit or keep), then Enter to start"),
      h(Box, { borderStyle: "round", borderColor: C.brand, paddingX: 1, marginTop: 1 }, h(Text, { color: nameBuf ? C.teal : C.dim }, nameBuf + FORMAT_EXT[FORMATS[formatSel].id])),
      h(Text, { color: C.sub, marginTop: 1 }, "type · Enter start · Esc back")
    );
  } else if (screen === "rename") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.yellow }, rename?.kind === "archive" ? "Rename archive entry" : "Rename file"),
      h(Text, { color: C.dim }, "old: " + (rename?.old || "")),
      h(Box, { borderStyle: "round", borderColor: C.brand, paddingX: 1, marginTop: 1 }, h(Text, { color: rename?.buf ? C.teal : C.dim }, rename?.buf || "…")),
      h(Text, { color: C.sub, marginTop: 1 }, "type · Enter confirm · Esc cancel")
    );
  } else if (screen === "progress") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.teal }, "Working…"),
      h(Box, { flexDirection: "row", marginTop: 1 }, h(Bar, { pct: prog.pct }), h(Text, { color: C.sub }, ` ${prog.pct.toFixed(0)}%`)),
      h(Text, { color: C.dim }, prog.msg),
      h(
        Box,
        { flexDirection: "column", marginTop: 1, borderStyle: "round", borderColor: C.dim, paddingX: 1 },
        h(Text, { color: C.sub, bold: true }, "log"),
        ...(logs.length ? logs : ["…"]).map((l, i) =>
          h(Text, { key: i, color: i === logs.length - 1 ? C.teal : C.dim, wrap: "truncate-end" }, "› " + l)
        )
      ),
      h(Text, { color: C.sub, marginTop: 1 }, "Esc/q to cancel")
    );
  } else if (screen === "result") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.green, bold: true }, "✔ Done"),
      ...renderResult(result, narrow),
      h(Text, { color: C.sub, marginTop: 1 }, "any key to continue")
    );
  } else if (screen === "error") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.red, bold: true }, "✖ Error"),
      h(Text, { color: C.red }, error),
      h(Text, { color: C.sub, marginTop: 1 }, "any key to continue")
    );
  }

  return h(
    Box,
    { flexDirection: "column", paddingY: 1, height: stdout ? stdout.rows || 24 : 24 },
    brandTitle(narrow),
    h(Text, { color: C.dim }, "  " + "─".repeat(Math.min(columns - 4, 60))),
    body
  );
}

function renderResult(r, narrow) {
  if (!r) return [];
  if (r.kind === "compress") {
    const rows = [
      line("output", r.output, C.teal),
      line("mode", r.mode + (r.format && r.format !== "drk" ? " · " + r.format : ""), C.accent),
      line("items", String(r.inputCount ?? 0), C.sub),
      line("chunks", String(r.chunkCount ?? 0), C.sub),
      line("raw", humanizeBytes(r.rawBytes ?? 0), C.sub),
      line("stored", humanizeBytes(r.compBytes ?? 0), C.green, true),
      line("ratio", (r.factor ?? 0).toFixed(2) + "x  (" + (r.savedPercent ?? 0).toFixed(1) + "% saved)", C.green, true),
      line("time", elapsed(r.ms), C.sub),
    ];
    if (r.note) {
      rows.push(
        h(
          Box,
          { marginTop: 1, paddingX: 1, borderStyle: "round", borderColor: C.yellow },
          h(Text, { color: C.sub, wrap: "wrap" }, "ℹ  " + r.note)
        )
      );
    }
    return rows;
  }
  if (r.kind === "extract") {
    return [
      line("dest", r.dest, C.teal),
      line("files", String(r.files), C.sub),
      line("restored", humanizeBytes(r.rawBytes ?? 0), C.green, true),
      line("time", elapsed(r.ms), C.sub),
    ];
  }
  if (r.kind === "inspect") {
    return [
      line("path", r.path, C.teal),
      line("mode", r.header?.mode ?? r.mode, C.accent),
      line("files", String(r.files?.length ?? r.files ?? 0), C.sub),
      line("chunks", String(r.header?.chunkCount ?? r.chunks ?? 0), C.sub),
      line("raw", humanizeBytes(r.totalRaw ?? r.raw ?? 0), C.sub),
      line("stored", humanizeBytes(r.totalComp ?? r.comp ?? 0), C.green, true),
      line("ratio", (r.factor ?? 0).toFixed(2) + "x  (" + (r.savedPercent ?? r.saved ?? 0).toFixed(1) + "% saved)", C.green, true),
    ];
  }
  if (r.kind === "file") {
    return [line("file", r.name, C.teal), line("size", humanizeBytes(r.size), C.sub)];
  }
  if (r.kind === "dir") {
    return [line("dir", r.name, C.dir)];
  }
  return [];
}

function line(label, value, color, strong) {
  return h(
    Box,
    { flexDirection: "row" },
    h(Text, { color: C.dim }, "  " + String(label).padEnd(10)),
    h(Text, { color, bold: strong }, String(value))
  );
}

export function runTui(initialArgs = []) {
  const { waitUntilExit } = render(h(App, {}));
  return new Promise((resolve) => {
    waitUntilExit().then(() => resolve(0));
  });
}
