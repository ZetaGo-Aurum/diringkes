// src/tui/app.js
// Diringkes TUI — a modern, responsive, touch/key friendly interface built on
// Ink. Layout adapts to the terminal width (works on narrow phone SSH clients),
// and every action is reachable by both arrow keys and number hotkeys so it
// behaves like large tap targets on small screens.

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useInput, useStdout, useApp } from "ink";
import { compressTargets, extractTargets, inspectArchive } from "../core/engine.js";
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
};

const MODES = ["ultra", "max", "fast", "store"];

const FLOWS = {
  compress: {
    steps: [
      { field: "target", label: "Files / directory to compress" },
      { field: "output", label: "Output archive (.drk)", def: (f) => (f.target || "archive").replace(/[/\\]$/, "").split(/[/\\]/).pop() + ".drk" },
    ],
    needMode: true,
  },
  extract: {
    steps: [
      { field: "archive", label: "Archive to extract (.drk)" },
      { field: "output", label: "Extract destination", def: () => "." },
    ],
    needMode: false,
  },
  inspect: {
    steps: [{ field: "archive", label: "Archive to inspect (.drk)" }],
    needMode: false,
  },
};

function brandTitle(narrow) {
  return h(
    Box,
    { flexDirection: "column", marginBottom: narrow ? 0 : 1 },
    h(Text, { color: C.brand, bold: true }, narrow ? "◆ Diringkes" : "◆  D I R I N G K E S"),
    h(Text, { color: C.sub }, "  ultra compression · archive · dedupe"),
    h(Text, { color: C.accent }, "  by ZetaGo-Aurum"),
    h(Text, { color: C.dim }, "  diringkes = diringkas (Jw.)")
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

export function App() {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const columns = stdout ? stdout.columns || 80 : 80;
  const narrow = columns < 64;
  const pad = narrow ? 1 : 3;

  const [screen, setScreen] = useState("home");
  const [menu, setMenu] = useState(0);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [flow, setFlow] = useState(null); // {name, steps, idx}
  const [modeSel, setModeSel] = useState(0);
  const [prog, setProg] = useState({ pct: 0, msg: "" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({});
  const abortRef = useRef(null);

  const finish = useCallback((code = 0) => setTimeout(() => exit(code), 30), [exit]);

  const startFlow = useCallback((name) => {
    setForm({});
    setFlow({ name, steps: FLOWS[name].steps, idx: 0 });
    const first = FLOWS[name].steps[0];
    setLabel(first.label);
    setText("");
    setScreen("input");
  }, []);

  const advanceInput = useCallback(() => {
    const steps = flow.steps;
    const cur = steps[flow.idx];
    const next = { ...form, [cur.field]: text };
    setForm(next);
    const ni = flow.idx + 1;
    if (ni < steps.length) {
      const ns = steps[ni];
      setFlow({ ...flow, idx: ni });
      setLabel(ns.label);
      setText(ns.def ? ns.def(next) : "");
    } else if (FLOWS[flow.name].needMode) {
      setScreen("mode");
    } else {
      runFlow(next);
    }
  }, [flow, text, form]);

  const runFlow = useCallback((f) => {
    setScreen("progress");
    setProg({ pct: 0, msg: "" });
    abortRef.current = { aborted: false };
    const ab = abortRef.current;
    (async () => {
      try {
        if (flow?.name === "compress" || f.target) {
          const mode = MODES[modeSel];
          const t0 = Date.now();
          const res = await compressTargets({
            targets: [f.target],
            output: f.output,
            mode,
            onProgress: ({ processed, total }) => {
              if (ab.aborted) return;
              const pct = total ? (processed / total) * 100 : 0;
              setProg({ pct, msg: `compressing · ${humanizeBytes(processed)}/${humanizeBytes(total)}` });
            },
          });
          if (ab.aborted) return;
          setResult({ kind: "compress", ...res, mode, ms: Date.now() - t0 });
          setScreen("result");
        } else if (f.archive && f.output !== undefined && !("target" in f)) {
          const t0 = Date.now();
          const res = await extractTargets({ archive: f.archive, dest: f.output });
          if (ab.aborted) return;
          setResult({ kind: "extract", ...res, ms: Date.now() - t0 });
          setScreen("result");
        } else if (f.archive) {
          const info = await inspectArchive(f.archive);
          if (ab.aborted) return;
          setResult({ kind: "inspect", path: f.archive, ...info, ms: 0 });
          setScreen("result");
        }
      } catch (e) {
        if (ab.aborted) return;
        setError(e.message);
        setScreen("error");
      }
    })();
  }, [flow, modeSel]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return finish(0);

    if (screen === "home") {
      const items = ["compress", "extract", "inspect", "quit"];
      if (key.upArrow) setMenu((m) => (m + items.length - 1) % items.length);
      else if (key.downArrow) setMenu((m) => (m + 1) % items.length);
      else if (/^[1-4]$/.test(input)) setMenu(Number(input) - 1);
      else if (key.return) choose(items[menu]);
      else if (input === "c") choose("compress");
      else if (input === "x") choose("extract");
      else if (input === "i") choose("inspect");
      else if (input === "q") finish(0);
    } else if (screen === "input") {
      if (key.escape) home();
      else if (key.return) advanceInput();
      else if (key.backspace || key.delete) setText((t) => t.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) setText((t) => t + input);
    } else if (screen === "mode") {
      if (key.escape) home();
      else if (key.upArrow) setModeSel((m) => (m + MODES.length - 1) % MODES.length);
      else if (key.downArrow) setModeSel((m) => (m + 1) % MODES.length);
      else if (/^[1-4]$/.test(input)) setModeSel(Number(input) - 1);
      else if (key.return) runFlow({ ...form, target: form.target, output: form.output });
    } else if (screen === "progress") {
      if (key.escape || input === "q") {
        if (abortRef.current) abortRef.current.aborted = true;
        home();
      }
    } else if (screen === "result" || screen === "error") {
      if (key.escape || key.return || input === "q" || input === " ") {
        home();
      }
    }
  });

  function choose(choice) {
    if (choice === "quit") return finish(0);
    startFlow(choice);
  }
  function home() {
    setScreen("home");
    setFlow(null);
    setForm({});
    setResult(null);
    setError("");
    setText("");
  }

  // ---- render ----
  let body;
  if (screen === "home") {
    const items = [
      { k: "1", t: "Compress", d: "Pack & ultra-compress files/dirs" },
      { k: "2", t: "Extract", d: "Restore from a .drk archive" },
      { k: "3", t: "Inspect", d: "Show archive stats" },
      { k: "4", t: "Quit", d: "Exit Diringkes" },
    ];
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.sub, dimColor: true }, "  choose an action (↑/↓ or 1-4):"),
      ...items.map((it, i) =>
        h(
          Box,
          { key: it.t, flexDirection: "row" },
          h(Text, { color: i === menu ? C.green : C.sub, bold: i === menu }, i === menu ? " ▶ " : "   "),
          h(Text, { color: i === menu ? C.brand : C.sub, bold: i === menu }, `${it.k}. ${it.t}`),
          h(Text, { color: C.dim }, `   ${narrow ? "" : it.d}`)
        )
      ),
      h(
        Text,
        { color: C.sub, marginTop: 1 },
        narrow
          ? "trakteer.id/Aleocrophic · wa.me/KwTSsF7t5868ERksMPamyQ"
          : "support: trakteer.id/Aleocrophic · community: chat.whatsapp.com/KwTSsF7t5868ERksMPamyQ"
      )
    );
  } else if (screen === "input") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.accent }, label),
      h(Box, { borderStyle: "round", borderColor: C.brand, paddingX: 1, marginTop: 1 }, h(Text, { color: text ? C.teal : C.dim }, text || "…")),
      h(Text, { color: C.sub, marginTop: 1 }, "type then Enter · Esc to cancel")
    );
  } else if (screen === "mode") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.accent }, "Select compression mode (↑/↓ or 1-4):"),
      ...MODES.map((m, i) =>
        h(
          Box,
          { key: m, flexDirection: "row" },
          h(Text, { color: i === modeSel ? C.green : C.sub, bold: i === modeSel }, i === modeSel ? " ▶ " : "   "),
          h(Text, { color: i === modeSel ? C.brand : C.sub }, `${i + 1}. ${m}`)
        )
      ),
      h(Text, { color: C.sub, marginTop: 1 }, "Enter to start · Esc to cancel")
    );
  } else if (screen === "progress") {
    body = h(
      Box,
      { flexDirection: "column", paddingLeft: pad },
      h(Text, { color: C.teal }, "Working…"),
      h(Box, { flexDirection: "row", marginTop: 1 }, h(Bar, { pct: prog.pct }), h(Text, { color: C.sub }, ` ${prog.pct.toFixed(0)}%`)),
      h(Text, { color: C.dim }, prog.msg),
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
    { flexDirection: "column", paddingY: 1 },
    brandTitle(narrow),
    h(Text, { color: C.dim }, "  " + "─".repeat(Math.min(columns - 4, 52))),
    body,
    h(Text, { color: C.dim }, "")
  );
}

function renderResult(r, narrow) {
  if (!r) return [];
  if (r.kind === "compress") {
    return [
      line("output", r.output, C.teal),
      line("mode", r.mode, C.accent),
      line("items", String(r.inputCount ?? r.items ?? 0), C.sub),
      line("chunks", String(r.chunkCount ?? r.chunks ?? 0), C.sub),
      line("raw", humanizeBytes(r.rawBytes ?? r.raw ?? 0), C.sub),
      line("stored", humanizeBytes(r.compBytes ?? r.comp ?? 0), C.green, true),
      line("ratio", (r.factor ?? 0).toFixed(2) + "x  (" + (r.savedPercent ?? r.saved ?? 0).toFixed(1) + "% saved)", C.green, true),
      line("time", elapsed(r.ms), C.sub),
    ];
  }
  if (r.kind === "extract") {
    return [
      line("files", String(r.files), C.teal),
      line("restored", humanizeBytes(r.rawBytes ?? r.raw ?? 0), C.green, true),
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
