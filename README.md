# Subtitle Timing Studio

Local workbench for timed WebVTT cues with fidelity-preserving parsing.

Run `npm install`, then `npm run dev`.

## WebVTT fidelity model (`src/shared/vtt.ts`)

Every parsed block carries both structured fields and its **verbatim raw fragment**:

- `cue` — decoded `text`, structured timestamps and ordered setting nodes
  (`vertical`, `line`, `position`, `size`, `align`, `region` plus any unknown
  tokens), alongside `timingRaw` / `payloadRaw`.
- `region` — ordered region setting nodes plus the raw block.
- `note` / `style` / `unknown` — raw lines only, kept in place.

Serialization rules:

- An untouched block is emitted from its raw fragment; editing one cue never
  rewrites NOTE/STYLE/REGION/unknown blocks or untouched lines of the same cue.
- Timing line and cue payload have independent dirty flags, so a text edit
  leaves the timing line byte-identical and vice versa.
- Entities are decoded **once** at parse time and encoded **once** when text
  was edited (no double escaping, no cascaded decoding); tags (`<v>`, `<c>`,
  timestamp tags, …) always pass through.
- CRLF / CR input is accepted; export normalizes line endings to LF while the
  semantic token sequence (`semanticTokens`) stays identical.
- Empty cue text and `-->` characters inside payloads round-trip correctly.

## HTTP API

- `POST /api/vtt/parse` — `{content}` → structured document (raw fragments included).
- `POST /api/vtt/patch` — `{content, ops}` → patched VTT text. Ops are
  node-scoped: `cue-time`, `cue-text`, `cue-setting`, `region-setting`.
- `POST /api/vtt/serialize` — structured document → VTT text.

The client renders a form per cue/region; editing a known setting mutates only
that setting node (`setCueSetting` / `setRegionSetting`), it never rebuilds the
cue. The raw textarea stays bi-directional with the structured model.

## Tests

`npm test` — covers CRLF, NOTE (marker and inline), STYLE, REGION, unknown
blocks/settings, named/decimal/hex entities (incl. no cascade, single
re-escape), empty text, `-->` inside text, semantic-token stability across
import/export, and per-chunk diff isolation for single-field edits.
