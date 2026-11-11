# PDF View for Obsidian

**Annotate PDFs in Obsidian without giving up the native viewer, the PDF file, or plain Markdown.**

Highlights, notes and AI reading assistance are stored as **ordinary Markdown links** — no sidecar
JSON, no database, no binary patching. Uninstall the plugin and your notes still render, still link,
still make sense.

> 中文说明见 [README.zh-CN.md](./README.zh-CN.md)。

---

## Why another PDF plugin?

Most PDF plugins pick one of two dead ends: they take over the viewer (so you lose Obsidian's own
PDF handling and get a second-class reading experience), or they keep annotations in a private
sidecar file (so your highlights die with the plugin).

PDF View for Obsidian takes a third path:

```
PDF file        ← never modified
Obsidian note   ← the database
Plugin          ← a viewer that reads the database
```

A highlight is a link. A note is a callout. A backlink is a query. That's the whole data model.

---

## Features

### Works with CJK PDFs that other viewers blank out
Chinese journal PDFs (CNKI, Wanfang) typically use `GBK-EUC-H` / `UniGB-UCS2-H` double-byte
encodings **with non-embedded fonts**. pdf.js cannot map those codes to glyphs without a CMap
table, and it fails silently — digits and punctuation render, every Chinese character vanishes:

| | text items | CJK chars |
|---|---|---|
| without CMap | 238 | 0 |
| with CMap | 429 | 1422 |

The usual fix is a `cMapUrl` for pdf.js to `fetch`. That doesn't work under Obsidian's `app://`
protocol, and a community plugin ships as three files. So all 168 `.bcmap` files are base64-inlined
into `main.js` (1.6 MB → 3.2 MB) and served by `EmbeddedCMapReaderFactory`. Regenerate with
`node scripts/gen-cmaps.mjs`.

### Blank page + `0 / 0` in Obsidian's own viewer

First identify whose viewer it is: a single toolbar row with a magnifier is **Obsidian's native
viewer**; a "PDF 批注" title plus a full row of drawing tools is this plugin. Most blank pages are
the former, and no plugin can reach it.

One confirmed cause is a **dirty trailer**: CNKI's downloader appends a `WebFastLoad` XML blob
(DOI, file name) *after* the last `%%EOF`. Parsers that scan backwards from EOF for `startxref`
find that junk instead and give up.

```
%%EOF
WebFastLoad<FileProperty><Doi>10.16149/…</Doi>…   ← these 177 bytes break it
```

The **“诊断 PDF 尾部垃圾并生成修复版”** command reads the selected PDF, counts non-blank bytes
after the last `%%EOF`, and writes a `…（修复版）.pdf` copy. It never modifies the original.

### Annotate without replacing the viewer
- Opt-in "annotator view" (command, ribbon icon, or a link click) — `registerExtensions` is
  **not** called by default, so double-clicking a PDF still opens Obsidian's native viewer.
  There is a single opt-in setting to take over `.pdf` for the rare file the native viewer can't open.
- Highlight, underline, rectangle, arrow, pencil, marker, sticky note — all drawn on a per-page SVG
  layer whose `viewBox` is the page's pt size, so annotations stay pixel-exact at any zoom with zero
  recomputation.
- Pressure-aware ink (Pointer Events), speed modulation for the pencil, Chaikin smoothing, and a
  variable-width ribbon for the pen so it doesn't stair-step.

### Storage: Markdown links that outlive the plugin
```markdown
[[论文.pdf#page=3&selection=8,0,10,45&color=yellow]]
[[论文.pdf#page=7&rect=72,600,300,640&color=red]]
```
`page`, `selection`, `rect`, `color` — the same four parameters PDF++ uses. A `selection` is
**character indices** (start line, start char, end line, end char), *not* x/y coordinates: indices
survive DPI changes, re-cropping and mobile sync; coordinates don't.

### Backlink highlights (the PDF side of the loop)
Open a PDF and the plugin scans the vault for links pointing at it, resolves each `selection=`/`rect=`
against the page's text layer, and paints them as read-only highlights *under* your own annotations.
Multi-colour overlaps darken naturally (`mix-blend-mode: multiply`).

### Bidirectional jump
- Click a link in a note → the PDF scrolls to that page and selection (captured before Obsidian's own
  handler, so the native viewer doesn't steal it).
- Double-click a backlink highlight (or press Ctrl/⌘ and click) → jump back to the exact line in the
  source note.
- A side panel lists every reference, grouped by source note, with a "this page only" filter and
  two-way hover highlighting.

### AI companion (OpenAI-compatible + Ollama)
Select text → ✨ → **Translate**, **Explain**, or **Summarize**. The result lands in a modal and can
be inserted into your note together with the PDF link and the quoted source, giving you a
`quote + interpretation` block that is still plain Markdown.

- One request path for every provider: OpenAI, DeepSeek, SiliconFlow, OneAPI, vLLM, LM Studio and
  Ollama all speak `/v1/chat/completions`. Ollama defaults to `http://localhost:11434/v1` — **no
  second code path**.
- Non-streaming requests go through Obsidian's `requestUrl` (main-process proxy → no CORS).
- Optional streaming uses `fetch` + `ReadableStream` for a typewriter effect, and silently falls back
  to `requestUrl` when CORS blocks it.

### Rich sticky notes
The note popover is a mini Markdown editor: `<textarea>` for source, live `MarkdownRenderer` preview
(300 ms debounce), and paste-to-attach images (`vault.createBinary` +
`getAvailablePathForAttachment`). The content is stored in a **companion note** as a callout with a
block anchor — not inside the link:

```markdown
> [!PDF-note|yellow] [[论文.pdf#page=3&rect=72,600,90,620|论文, p.3]]
> 这里是 **Markdown** 正文
>
> ![[attachments/pasted-20261109-003217.png]]

^pdfa-note-a1b2c3
```

The pin on the PDF page points at `^pdfa-note-a1b2c3`; the callout's first line points back at the
PDF. Two symmetric, ordinary links — nothing proprietary.

### Visible annotation cards

A highlight is easy to forget about. Highlight, underline or box some text first, then **click the
mark itself** — a popover opens in place with **添加评论** (add comment); or use **annotate**
(`message-square` in the selection toolbar) for the full rich-text note. Either way the mark turns
into a note with a card in the page margin, joined to the text by a dashed leader line:

```
┌────────────────────┐
│ ● 批注 · p.2   ✎ ✕ │
│ use this in the lit│   ← card sits in the margin, never over the text
└────────────────────┘
        ╲
         ╲ dashed leader
   ████████████  ← the highlighted line
```

**Click-to-comment** works like WPS / Zotero: click a mark you already drew and the bubble offers
*add comment*; type and press `Ctrl/⌘ + Enter`. The click is only treated as a click when the pointer
moved less than 4px and nothing is selected — dragging to select text (or triple-click) never opens
the bubble by accident, and the bubble anchors to the line you clicked rather than following the
cursor. Arrows and freehand ink deliberately have no comment entry: they have no text block to anchor
to, so persisting them would degrade to a bounding box on reload; the bubble says so and points at
the rectangle tool instead.

Cards live in an overlay attached to the **scroll container**, not the page: `.pdfa-page` uses
`overflow: hidden` + `contain: paint`, which would clip anything drawn outside the page box.

**Card width follows the margin (fixed in 0.8.1).** 0.8.0 hard-coded 236px and decided "fits /
does not fit" against that number. On a 1536px window at 125% zoom each margin is only ~200px, so
every card was judged "does not fit" and fell back **on top of the body text** — exactly the thing
margin cards exist to avoid. Now the wider margin is measured and the card is sized to
`min(236, margin − 12 − 6)`:

| Available margin | Card width | Result |
|---|---|---|
| ≥ 254px | 236px (cap) | in the margin, dashed leader to the highlight |
| 128 – 254px | shrinks with the margin, switches to the compact layout | in the margin, leader drawn |
| < 128px | falls back inside the page | covers a slice of text, no leader |

The last row is a physical limit — at that size the page already fills the pane. Note the scrollbar
eats ~15px; `clientWidth` already excludes it, so the measurement is what you actually see.

The leader always leaves from the **page edge, at the height of the annotated line** — not from the
end of the highlight, which would cut across the remaining words on that line.

Under the hood it is still a single `NoteAnnotation` with an optional `rects` field: with `rects` it
renders a highlight + card, without it you get the classic pin. Storage is unchanged, so no existing
note needs migrating, and converting a highlight reuses the same id — one undo step, no orphan pin.
Its `mark` field ("highlight" / "underline" / "box") remembers what the annotation looked like
before it gained a comment, so an underline does not silently become a filled block.

### Works on tablets
A pointer adapter normalises mouse / pen / touch into one sample type and adds what touch screens
lack: long-press → context menu, double-tap → backlink jump, multi-finger → abort the gesture (so
pinch-zoom doesn't draw a stray line).

### Fixed single-row toolbar
One row pinned to the top of the view: page navigation (`‹ [n] / total ›`, jump on Enter, clamped at
both ends), zoom (out / 100% / in / fit-width / fit-page), the annotation tool set with its colour
swatch, undo / redo, the backlink panel toggle with its count badge, and the AI menu. The row scrolls
horizontally instead of wrapping when the pane is narrow, and the file name is the first thing to go.
Page jumps are applied via `scrollTop`, not `scrollIntoView`, so the toolbar can never be scrolled
out of the viewport.

---

### Never hijacks a sidebar (fixed in 0.8.1)

The "open .pdf with this plugin" fallback used to call `setViewState` on `workspace.activeLeaf`
whenever `file-open` fired. Sounds harmless, but the active leaf is often a **sidebar** leaf — that
is where focus sits right after you click a file in the explorer. The PDF then opened inside the
sidebar: your file explorer got pushed to a background tab ("why did my folder icon move up there")
and the sidebar kept a PDF tab you could not close (its × is usually hidden under the window
buttons).

Now: only a main-area leaf showing that exact file is converted (`findPdfLeafFor`), otherwise a new
main-area tab is opened; `openPdf()` rejects sidebar leaves; on startup duplicated sidebar tabs of
an already-open PDF are closed; and the command **`关掉侧栏里误开的 PDF 标签`** cleans up manually.
"Sidebar or not" is decided by comparing `leaf.getRoot()` against `workspace.leftSplit` /
`rightSplit` — sidebars and the main area are separate split trees, so reference equality is exact.

## Comparison

| | **PDF View for Obsidian** | **PDF++** | **Annotator** |
|---|---|---|---|
| Annotation storage | Plain Markdown links, no sidecar | Plain Markdown links | Sidecar data file next to the PDF |
| Link syntax | PDF++-compatible (`page` / `selection` / `rect` / `color`) | Its own, same four parameters | Plugin-private |
| Native Obsidian viewer | **Preserved** (opt-in second view) | Replaces it with a custom PDF view | Separate annotator UI |
| Backlink highlights inside the PDF | Yes, read-only projection | Yes (this is where the idea comes from) | No |
| Note → PDF jump | Yes | Yes | Partial |
| PDF → note jump | Double-click highlight, or the backlinks panel | Yes | Via the annotation list |
| **AI companion** (translate / explain / summarize) | **Yes — OpenAI-compatible + Ollama, insert as quote + answer** | No | No |
| **Rich notes** (Markdown + images) | **Yes — callout + block anchor in a companion note** | Callout blocks | Plain text |
| Uninstall-safe | Yes — notes remain readable and clickable | Yes | No — highlights vanish with the sidecar |
| Mobile / touch | Pointer adapter (long-press, double-tap) | Desktop-focused | Desktop |

> Cells for other plugins reflect their public documentation at the time of writing. Check the
> current state of [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) and
> [Annotator](https://github.com/Annotator-Obsidian/obsidian-annotator) before quoting this table.

---

## Install

### From a release
Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/moonecho39-bit/just-try/releases/latest) into
`<vault>/.obsidian/plugins/pdf-annotator/`, then enable **PDF View for Obsidian** in
*Settings → Community plugins*.

### Via BRAT (auto-updating)
Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then run
**BRAT → Add beta plugin** with `moonecho39-bit/just-try`.

> `main.js` is intentionally git-ignored — it is built by CI and attached to each release.
> A plain `git clone` will **not** give you a working plugin; run `npm run build` or use a release.

### From source
```bash
npm install --registry=https://registry.npmmirror.com
npm run build          # typecheck + production bundle
```

---

## Usage

1. Open a PDF with the command **“Open current PDF in annotator view”** (or the ribbon icon).
2. Drag-select text → the floating toolbar appears:
   `highlight · underline · rect · arrow · note · pencil · marker · ✨ AI · link`
3. **“Highlight & copy link”** puts `[[file.pdf#page=…&selection=…]]` on your clipboard — paste it
   anywhere. Hold **Alt** and drag a highlight onto a Markdown editor to do the same with the mouse.
4. Click that link later and the PDF reopens at the exact selection. Double-click the resulting
   backlink highlight to jump back to the note.

| Command | Default hotkey |
|---|---|
| Copy PDF link for selection | `Mod+Shift+C` |
| Copy selection as PDF callout | — |
| Toggle backlinks panel | — |
| AI translate / explain / summarize | — (bind your own) |
| Clear draft annotations (page / all) | — |

---

## AI setup

*Settings → PDF View for Obsidian → AI companion*

| Provider | Base URL | Model example | API key |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | required |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` | leave empty |
| Custom (vLLM / LM Studio / gateway) | `http://localhost:8000/v1` | whatever you serve | usually empty |

Use **Test connection** to validate URL + key + model in one click, and **Fetch models** to pick from
`/v1/models`.

### About streaming (important)

Streaming gives you the typewriter effect, but it is not a free upgrade:

1. `requestUrl` **cannot stream** — it buffers the whole response. Streaming therefore switches to
   `fetch`, which is subject to CORS.
2. For Ollama you must allow Obsidian's origin:
   ```bash
   # Windows (PowerShell, then restart the Ollama service)
   setx OLLAMA_ORIGINS "app://obsidian.md"
   # macOS / Linux
   OLLAMA_ORIGINS=app://obsidian.md ollama serve
   ```
   Without it the browser layer reports `Failed to fetch` before the request ever leaves.
3. `localhost` on a phone means *the phone*. Streaming to a desktop Ollama from mobile will not work;
   use an HTTPS endpoint or turn streaming off.
4. When streaming fails, the plugin automatically retries through `requestUrl` — you still get the
   answer, just without the animation.

---

## Link syntax reference

| Parameter | Meaning |
|---|---|
| `page=N` | 1-based page number |
| `selection=l1,c1,l2,c2` | Text range: start line, start char, end line, end char (**indices, not coordinates**) |
| `rect=l,b,r,t` | Rectangle in PDF user space (y up, pt) — for images, tables, blank areas |
| `color=NAME` | Optional; one of `yellow orange red pink purple blue cyan green gray`, or a bare hex value |
| `offset=l,t,zoom` | Obsidian's own scroll position; preserved but never generated |
| `annotation=ID` | Native PDF annotation id (PDF++'s other mode); parsed and ignored |

Callout form (optional wrapper):

```markdown
> [!PDF|yellow] [[论文.pdf#page=3&selection=8,0,10,45|论文, p.3]]
> > quoted source text
```

Nine colour names are treated as a **stable public API** — they can be added to, never renamed,
because renaming would recolour every existing note.

---

## Development

```bash
npm run dev      # watch
npm run build    # typecheck + production bundle
npm test         # jsdom smoke tests: 248 assertions across [A]–[M]

# visual check without Obsidian (real components, fake DOM)
npx esbuild demo/entry.ts --bundle --format=iife \
  --alias:obsidian=./demo/obsidian-stub.ts --outfile=demo/demo.js
# then open demo/index.html
```

Layout:

```
src/
├── main.ts            plugin entry: view registration, commands, capture-phase link interception
├── view.ts            ItemView: layering, lazy rendering, zoom, selection, backlinks, AI, notes
├── renderer.ts        pdf.js wrapper (canvas + text layer); getPageText() without bitmaps
├── coords.ts          four coordinate spaces and their conversions
├── link/              format.ts (syntax) · textIndex.ts (char ⇄ rect) · scan.ts · navigate.ts
├── note/              noteFormat.ts (pure) · noteStore.ts (vault IO) · attachments.ts
├── ai/                protocol.ts (pure) · client.ts (transport) · prompt.ts · settings.ts
├── annot/             types · toolState · annotationStore · pageLayer · ink · geometry
└── ui/                toolbar · colorPopover · noteEditor · aiModal · backlinkPanel · pointer …
```

Design notes worth knowing before changing things:

- **Four coordinate spaces.** NORM (0–1) is the only persisted form; stroke widths are in pt so they
  scale with the page while pins stay visually constant.
- **`selectionToRects()` and `rectsToSelection()` share one `TextPageIndex`.** If they ever disagree
  about line breaking, "write a link, reopen the PDF, land somewhere else" becomes normal.
- **Annotations vs. backlinks are different types.** `Annotation` is editable and undoable;
  `BacklinkMark` is a read-only projection of someone else's note, so `Ctrl+Z` can never delete a note
  from disk.
- **Capture-phase click interception** is the only place the plugin touches native behaviour, and only
  for PDF links that carry `page=`.

---

## License

MIT
