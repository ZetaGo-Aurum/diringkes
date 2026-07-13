# ◆ Diringkes

> **Ultra compression & archive toolkit** with a modern CLI and a mobile-friendly TUI.
> Maintained by **ZetaGo-Aurum** · MIT License · v1.0.0

```
  ◆  D I R I N G K E S
  ultra compression · archive · dedupe
  by ZetaGo-Aurum
```

---

## ✦ Fun fact (asal-usul nama)

The word **`diringkes`** is inspired by **Javanese**, where it means
**`"diringkas"`** — *"to be made concise / condensed"*. The whole philosophy
of this tool: *bawa yang berat jadi ringan, yang panjang jadi pendek*
(take what is heavy and make it light, take what is long and make it short).

So yes — *Diringkes* is basically "compress" with a Javanese soul. 🌿

---

## ✦ What it is

`Diringkes` feels like a **file manager / archiver**, but its headline feature
is compression that goes *far beyond* ordinary tools. It combines three
techniques:

1. **Content-Defined Chunking (CDC)** — files are split on *content* boundaries
   (FastCDC-style gear rolling hash), not fixed blocks. Shift a file by one byte
   and the chunks stay stable.
2. **Global Deduplication** — every unique chunk is stored **once**, no matter
   how many times (or in how many files) it appears. Identical regions anywhere
   in the dataset collapse into a single reference.
3. **Strong codecs** — `ultra` mode uses **Brotli q11** with a large window;
   `max` uses Brotli q11; `fast` uses Deflate; `store` keeps data verbatim.

Archives use the bespoke **`.drk`** format: a seekable, indexed, streaming
binary container that can scale to terabytes while staying random-access.

> **Honest note on the "10 GB → 10 MB" legend.** No tool can magically shrink
> *arbitrary* data — entropy is entropy. But when data is redundant (backups,
> VM images, duplicated media, versioned datasets), Diringkes' dedup + CDC
> pipeline reaches ratios that *look* impossible. Real demo below: **2 GB of
> duplicated files → 10.12 MB (≈ 197×, 99.5% saved).** Scale the redundancy
> and 10 GB → 10 MB is genuinely reachable.

---

## ✦ Install

### Requirements
- **Node.js ≥ 18** (LTS recommended). Check with `node -v`.
- A terminal that supports ANSI colors (every modern terminal does).
- ~30 MB free disk for the install; temporary space during compression
  scales with the dataset (uses `os.tmpdir()`).

### 1) Global install via npm (recommended)

```bash
npm install -g diringkes
```

This installs **two** commands globally:

| Command      | Alias for            |
|--------------|----------------------|
| `diringkes` | the full primary command |
| `drks`      | short alias (same thing) |

Both accept identical flags and sub-commands, e.g. `diringkes -h` ≡ `drks -h`.

Verify the install:

```bash
drks -h        # prints the help banner
drks v         # prints "diringkes 1.0.0 · ZetaGo-Aurum"
```

### 2) Install from source (for development / latest)

```bash
git clone https://github.com/ZetaGo-Aurum/diringkes.git
cd diringkes
npm install
npm link        # symlinks `diringkes` + `drks` into your PATH
```

Run directly without installing:

```bash
node bin/diringkes.js c ./Photos -o photos.drk
node bin/drks.js i photos.drk
```

### 3) Local (per-project) install

```bash
npm install diringkes          # adds it to ./node_modules/.bin
npx diringkes c ./data -o data.drk
```

### 4) Termux (Android) — see the Termux section below.

### Uninstall

```bash
npm uninstall -g diringkes
```

### Upgrade

```bash
npm update -g diringkes
```

---

## ✦ Two modes

### 1. CLI mode (concise commands)

```bash
diringkes c  ./Videos          -o videos.drk          # compress
drks       c  big.iso --ultra -o tiny.drk            # short alias + ultra
diringkes x  videos.drk        -o ./restored         # extract
diringkes l  videos.drk                               # list contents
diringkes i  videos.drk                               # stats / ratio
diringkes a                                            # about & fun fact
diringkes t                                            # launch TUI
```

Command shortcuts: `c` compress · `x` extract · `l` list · `i` info ·
`t` tui · `a` about · `h` help · `v` version.

Flags: `-o/--output`, `-m/--mode <ultra|max|fast|store>`, `-b/--base`,
`-q/--quiet`, `-y/--yes`, plus `--ultra/--max/--fast`.

### 2. TUI mode (touch / key friendly)

```bash
diringkes        # no args -> opens the TUI
drks t           # or explicitly
```

Built on **Ink**, the TUI is:

- **Responsive** — layout reflows to the terminal width, so it stays clean on
  narrow phone-SSH clients (try it on a 40-column terminal).
- **Touch/key friendly** — every action is reachable by **arrow keys *and*
  number hotkeys** (1-4), behaving like large tap targets on small screens.
- **Live progress** with a streaming bar; compress / extract / inspect flows
  are fully guided.

---

## ✦ Example output

```text
  ◆ Diringkes  ultra compression · archive · dedupe
  by ZetaGo-Aurum  · v1.0.0
  ──────────────────────────────────────────────────────

  ▶ Compressing /tmp/drkbig/big
  mode ultra  → /tmp/drkbig/big.drk

  [████████████████████████████] 100%  1.95 GB / 1.95 GB
  ✔ Done  200 items · 10 chunks
  raw 1.95 GB  →  10.12 MB
  ratio 197.63x  saved 99.5%  in 36.2s
```

---

## ✦ How the `.drk` format works

```
[HEADER]  magic "DRKS", version, mode, fileCount, chunkCount, sizes
[FILE TABLE]  per-file path / mode / mtime / size / chunkCount
[FILE CHUNK MAPS]  per-file array of dict indices  (dedup lives here)
[DATA SECTION]  concatenated, individually-compressed chunks
[CHUNK INDEX]  rawSize, compSize, dataOffset  (seekable)
[FOOTER]  magic "KSRD" + offset to CHUNK INDEX
```

Because the chunk index sits at the tail, extraction of a *single* file seeks
straight to its chunks — no need to read the whole archive.

---

## ✦ Project layout

```
diringkes/
├── bin/            diringkes.js · drks.js          (entry points / aliases)
├── src/
│   ├── cli.js      concise CLI parser + renderer
│   ├── index.js    dispatcher
│   ├── tui/app.js  Ink-based responsive TUI
│   ├── core/       engine · chunker · dedupe · codec · archive · walk
│   ├── system/     syscall.js (positional I/O, prealloc, workers)
│   └── ui/         theme.js (Catppuccin-style palette + banner)
├── test/           integrity tests
├── package.json · README.md · LICENSE
```

---

## ✦ Termux (Android) support

`Diringkes` is fully **Termux-friendly**:

- **Zero native builds.** Every dependency (`ink`, `react`, `chalk`,
  `cli-spinners`) is pure JavaScript, so `npm install -g diringkes` works on
  ARM Android without a toolchain.
- **No `/tmp` assumption.** Temp/spool files use `os.tmpdir()`, which on
  Termux resolves to `…/com.termux/files/usr/tmp`.
- **Touch-screen friendly TUI.** Termux on a phone has no terminal mouse, but
  every TUI action is reachable by **number hotkeys (1-4)** and arrow keys,
  so the on-screen keyboard acts like large tap targets. The layout also
  reflows for narrow phone widths.
- Needs **Node.js ≥ 18** (`pkg install nodejs` on Termux).

```bash
pkg install nodejs
npm install -g diringkes
drks t        # open the TUI right from your pocket
```

---

## ✦ Support & Community

If Diringkes helps you, a tip keeps the late-night builds alive — and the
community is the best place to ask, share datasets, and request features.

<a href="https://trakteer.id/Aleocrophic/tip" target="_blank"><img src="buttons/trakteer_button.svg" alt="Trakteer Tip" width="250"></a>
<a href="https://chat.whatsapp.com/KwTSsF7t5868ERksMPamyQ" target="_blank"><img src="buttons/community_button.svg" alt="Join Community" width="250"></a>

- 💙 **Trakteer** — support the work: https://trakteer.id/Aleocrophic/tip
- 💬 **Join Community** — chat & updates: https://chat.whatsapp.com/KwTSsF7t5868ERksMPamyQ

---

## ✦ License

MIT © **ZetaGo-Aurum**
