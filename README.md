# Subtitle Timing Studio

Local workbench for editing WebVTT with lossless round trips.

Run `npm install`, then `npm run dev`.

## Lossless WebVTT model (`src/shared/vtt.ts`)

A document parses into an **ordered token stream**: the header, blank lines,
`NOTE` / `STYLE` / `REGION` / unknown blocks (kept as raw fragments) and cues.
Cues additionally expose structured, known fields:

- timings (`start`, `end`), cue identifier
- known settings: `vertical`, `line`, `position`, `size`, `align`, `region`
- unknown settings preserved as in-place nodes
- `payload` (raw lines) plus `text` (entities decoded **once**)

Serialization stitches the same fragments back together. Properties:

- Parse → export only normalizes line terminators (CRLF/CR → LF); the
  semantic token sequence, block order, NOTE/STYLE/REGION, unknown blocks and
  unknown settings are byte-faithful.
- `patchCueDoc(doc, index, patch)` edits a single field of one cue:
  `start` / `end` / `id` / `text` / `setting`. Other tokens keep their
  identity and position, so a one-field diff cannot touch unrelated blocks.
- Edited text is escaped **once** (protecting existing markup tags); `>` is
  intentionally left literal so arrow text such as `-->` survives.
- Timing lines are only recognized at the first/second line of a block, so
  `-->` inside cue text can never be reparsed as a timing line.

## API

- `POST /api/vtt/parse` — `{content}` → `{doc, content}` (content normalized to LF)
- `POST /api/vtt/patch` — `{content, cueIndex, patch}` → `{content, doc}`;
  returns `400` for invalid timestamps or cue indices

## UI

The **Structured** view edits each cue node in place (timings, identifier,
decoded text, known settings); unknown settings and NOTE/STYLE/REGION blocks
are shown read-only and kept verbatim. **Source** view remains a raw textarea.
Both feed the same draft, saved through the revision-checked `PUT` endpoint.
