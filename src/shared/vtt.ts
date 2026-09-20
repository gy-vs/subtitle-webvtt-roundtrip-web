/**
 * Lossy-less WebVTT document model.
 *
 * Every block keeps the *verbatim raw lines* it was parsed from, while known
 * fields (timestamps, cue settings, region settings, decoded cue text) are
 * exposed as structured overlays. A block is serialized from its raw fragment
 * until the corresponding structured field is actually edited, so touching one
 * cue never rewrites NOTE/STYLE/REGION/unknown blocks or even untouched parts
 * of the same cue.
 *
 * Cue text entities are decoded exactly once (at parse time) and encoded
 * exactly once (when a cue's text was edited); the serialized form of an
 * untouched cue is its original payload.
 */

// ---------- entities ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  quot: '"',
  apos: "'",
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Decode WebVTT character references in a single forward scan (no cascade). */
function decodeEntities(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; ) {
  const ch = input[i]!;
  if (ch !== '&') {
    out += ch;
    i += 1;
    continue;
  }
  const semi = input.indexOf(';', i + 1);
  if (semi > i && semi - i <= 32) {
    const body = input.slice(i + 1, semi);
    let replacement: string | undefined;
    if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (Number.isFinite(code) && code >= 0) {
      try {
      replacement = String.fromCodePoint(code);
      } catch {
      replacement = undefined;
      }
    }
    } else {
    replacement = NAMED_ENTITIES[body.toLowerCase()];
    }
    if (replacement !== undefined) {
    out += replacement;
    i = semi + 1;
    continue;
    }
  }
  out += '&';
  i += 1;
  }
  return out;
}

/** Encode the minimal required WebVTT escapes in a single forward scan. */
function encodeEntities(input: string): string {
  let out = '';
  for (const ch of input) {
  if (ch === '&') out += '&amp;';
  else if (ch === '<') out += '&lt;';
  else if (ch === '>') out += '&gt;';
  else if (ch === ' ') out += '&nbsp;';
  else out += ch;
  }
  return out;
}

/** Cue text tags (<c>, <v>, <i>, timestamp tags, ...) pass through verbatim. */
function splitTags(line: string): Array<{ tag: boolean; value: string }> {
  const parts: Array<{ tag: boolean; value: string }> = [];
  let rest = line;
  const re = /<[^>]*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
  if (m.index > last) parts.push({ tag: false, value: rest.slice(last, m.index) });
  parts.push({ tag: true, value: m[0] });
  last = m.index + m[0].length;
  }
  if (last < rest.length) parts.push({ tag: false, value: rest.slice(last) });
  return parts;
}

/** Decode one payload line; tags are preserved, entities decoded once. */
export function decodeCueLine(line: string): string {
  return splitTags(line)
  .map((part) => (part.tag ? part.value : decodeEntities(part.value)))
  .join('');
}

/** Encode one payload line; tags are preserved, text escaped once. */
export function encodeCueLine(line: string): string {
  return splitTags(line)
  .map((part) => (part.tag ? part.value : encodeEntities(part.value)))
  .join('');
}

function decodePayload(rawLines: string[]): string {
  return rawLines.map(decodeCueLine).join('\n');
}

function encodeText(text: string): string[] {
  if (text === '') return [];
  return text.split('\n').map(encodeCueLine);
}

// ---------- timestamps ----------

const TIMESTAMP_RE = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.:](\d{3})$/;

/** Parse a WebVTT timestamp to milliseconds; returns null when malformed. */
export function parseTimestamp(value: string): number | null {
  const m = TIMESTAMP_RE.exec(value.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4]);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;
}

/** Format milliseconds canonically as hh:mm:ss.mmm. */
export function formatTimestamp(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

// ---------- model ----------

export interface SettingNode {
  /** Lower-cased key ('' for a malformed token without a colon). */
  key: string;
  /** Structured value. */
  value: string;
  /** Verbatim "key:value" fragment; untouched nodes are emitted as-is. */
  raw: string;
}

export const CUE_SETTING_KEYS = ['vertical', 'line', 'position', 'size', 'align', 'region'] as const;
export const REGION_SETTING_KEYS = [
  'id',
  'width',
  'lines',
  'regionanchor',
  'viewportanchor',
  'scroll',
] as const;

export interface HeaderBlock {
  kind: 'header';
  /** Verbatim header line ("WEBVTT" plus optional descriptive text). */
  raw: string;
  /** Structured descriptive text after WEBVTT. */
  text: string;
}

export interface NoteBlock {
  kind: 'note';
  /** All raw lines, including the NOTE marker line. */
  rawLines: string[];
}

export interface StyleBlock {
  kind: 'style';
  /** All raw lines, including the STYLE marker line. */
  rawLines: string[];
}

export interface RegionBlock {
  kind: 'region';
  /** All raw lines, including the REGION marker line. */
  rawLines: string[];
  /** Ordered region settings (known and unknown). */
  settings: SettingNode[];
  /** Set once any structured setting node changes. */
  dirty: boolean;
}

export interface CueBlock {
  kind: 'cue';
  /** Verbatim cue identifier line, or null when absent. */
  idRaw: string | null;
  /** Verbatim timing line; emitted verbatim until the timing is edited. */
  timingRaw: string;
  /** Verbatim start timestamp text. */
  startRaw: string;
  /** Verbatim end timestamp text. */
  endRaw: string;
  /** Ordered cue setting nodes (known and unknown), each with a raw fragment. */
  settings: SettingNode[];
  /** Verbatim payload lines (entity-escaped source text). */
  payloadRaw: string[];
  /** Decoded cue text; computed exactly once during parsing. */
  text: string;
  /** Set when the timing line (time or settings) must be rebuilt. */
  timingDirty: boolean;
  /** Set when the payload must be re-encoded from `text`. */
  textDirty: boolean;
}

export interface UnknownBlock {
  kind: 'unknown';
  /** Unrecognized extension block; kept verbatim and in place. */
  rawLines: string[];
}

export type Block = NoteBlock | StyleBlock | RegionBlock | CueBlock | UnknownBlock;

export interface VttDocument {
  header: HeaderBlock | null;
  blocks: Block[];
}

// ---------- parsing ----------

function parseSettingNodes(rest: string): SettingNode[] {
  if (rest.trim() === '') return [];
  return rest.split(/[ \t]+/).filter(Boolean).map((token) => {
  const colon = token.indexOf(':');
  if (colon <= 0) return { key: '', value: '', raw: token };
  return {
    key: token.slice(0, colon).toLowerCase(),
    value: token.slice(colon + 1),
    raw: token,
  };
  });
}

function parseCueBlock(lines: string[]): CueBlock | UnknownBlock {
  const arrowIndex = lines.findIndex((line) => line.includes('-->'));
  let idRaw: string | null = null;
  let timingLine: string;
  let payloadStart: number;
  if (arrowIndex === 0) {
  timingLine = lines[0]!;
  payloadStart = 1;
  } else if (arrowIndex === 1) {
  idRaw = lines[0]!;
  timingLine = lines[1]!;
  payloadStart = 2;
  } else {
  return { kind: 'unknown', rawLines: lines };
  }

  const m = /^[ \t]*(\S.*?)[ \t]+-->[ \t]+(\S+)[ \t]*(.*?)$/.exec(timingLine);
  if (!m) return { kind: 'unknown', rawLines: lines };
  const startRaw = m[1]!;
  const endRaw = m[2]!;
  if (parseTimestamp(startRaw) === null || parseTimestamp(endRaw) === null) {
  return { kind: 'unknown', rawLines: lines };
  }

  const payloadRaw = lines.slice(payloadStart);
  return {
  kind: 'cue',
  idRaw,
  timingRaw: timingLine,
  startRaw,
  endRaw,
  settings: parseSettingNodes(m[3] ?? ''),
  payloadRaw,
  text: decodePayload(payloadRaw),
  timingDirty: false,
  textDirty: false,
  };
}

function parseRegionBlock(lines: string[]): RegionBlock {
  return {
  kind: 'region',
  rawLines: lines,
  settings: lines.slice(1).map((line) => {
    const colon = line.indexOf(':');
    if (colon <= 0) return { key: '', value: '', raw: line };
    return {
    key: line.slice(0, colon).toLowerCase(),
    value: line.slice(colon + 1),
    raw: line,
    };
  }),
  dirty: false,
  };
}

function isNoteStart(line: string): boolean {
  return line === 'NOTE' || line.startsWith('NOTE ') || line.startsWith('NOTE\t');
}

function parseBlock(lines: string[]): Block {
  const first = lines[0]!;
  if (isNoteStart(first)) return { kind: 'note', rawLines: lines };
  if (first === 'STYLE') return { kind: 'style', rawLines: lines };
  if (first === 'REGION') return parseRegionBlock(lines);
  return parseCueBlock(lines);
}

/** Parse WebVTT text (LF, CRLF or CR line endings all accepted). */
export function parseVtt(input: string): VttDocument {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\r|\n/);

  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor += 1;

  let header: HeaderBlock | null = null;
  const headerLine = lines[cursor];
  if (headerLine !== undefined && (headerLine === 'WEBVTT' || headerLine.startsWith('WEBVTT '))) {
  header = {
    kind: 'header',
    raw: headerLine,
    text: headerLine.slice(6).replace(/^[ \t]+/, ''),
  };
  cursor += 1;
  }

  const blocks: Block[] = [];
  let current: string[] = [];
  const flush = () => {
  if (current.length) {
    blocks.push(parseBlock(current));
    current = [];
  }
  };
  for (; cursor < lines.length; cursor += 1) {
  const line = lines[cursor]!;
  if (line.trim() === '') {
    flush();
  } else {
    current.push(line);
  }
  }
  flush();

  return { header, blocks };
}

// ---------- serialization ----------

function serializeCue(cue: CueBlock): string {
  const out: string[] = [];
  if (cue.idRaw !== null) out.push(cue.idRaw);
  // An untouched timing line is emitted verbatim (spacing fidelity).
  out.push(cue.timingDirty ? cueTimingLine(cue) : cue.timingRaw);
  const payload = cue.textDirty ? encodeText(cue.text) : cue.payloadRaw;
  for (const line of payload) out.push(line);
  return out.join('\n');
}

/** Rebuild the timing line from structured nodes (canonical single spacing). */
function cueTimingLine(cue: CueBlock): string {
  let timing = `${cue.startRaw} --> ${cue.endRaw}`;
  if (cue.settings.length) timing += ` ${cue.settings.map((node) => node.raw).join(' ')}`;
  return timing;
}

/** Serialize a document. Line endings are normalized to LF + blank-line gaps. */
export function serializeVtt(doc: VttDocument): string {
  const chunks: string[] = [];
  if (doc.header) chunks.push(doc.header.raw);

  for (const block of doc.blocks) {
  switch (block.kind) {
    case 'note':
    case 'style':
    case 'unknown':
    chunks.push(block.rawLines.join('\n'));
    break;
    case 'region':
    if (block.dirty) {
      chunks.push(['REGION', ...block.settings.map((node) => node.raw)].join('\n'));
    } else {
      chunks.push(block.rawLines.join('\n'));
    }
    break;
    case 'cue':
    chunks.push(serializeCue(block));
    break;
  }
  }
  return chunks.join('\n\n') + '\n';
}

// ---------- structured edits (node level, never block rebuilds) ----------

export function getCueSetting(cue: CueBlock, key: string): string | undefined {
  return cue.settings.find((node) => node.key === key)?.value;
}

export function setCueSetting(cue: CueBlock, key: string, value: string | null): void {
  const index = cue.settings.findIndex((node) => node.key === key);
  if (value === null || value === '') {
  if (index >= 0) cue.settings.splice(index, 1);
  } else if (index >= 0) {
  const node = cue.settings[index]!;
  node.value = value;
  node.raw = `${key}:${value}`;
  } else {
  cue.settings.push({ key, value, raw: `${key}:${value}` });
  }
  cue.timingDirty = true;
}

export function setCueTime(cue: CueBlock, change: { start?: string; end?: string }): void {
  if (change.start !== undefined) {
  const start = change.start.trim();
  if (parseTimestamp(start) === null) throw new Error(`invalid timestamp: ${start}`);
  cue.startRaw = start;
  }
  if (change.end !== undefined) {
  const end = change.end.trim();
  if (parseTimestamp(end) === null) throw new Error(`invalid timestamp: ${end}`);
  cue.endRaw = end;
  }
  cue.timingDirty = true;
}

export function setCueText(cue: CueBlock, text: string): void {
  // `text` is already decoded user input; it is encoded once at serialization.
  cue.text = text;
  cue.textDirty = true;
}

export function setRegionSetting(region: RegionBlock, key: string, value: string | null): void {
  const index = region.settings.findIndex((node) => node.key === key);
  if (value === null || value === '') {
  if (index >= 0) region.settings.splice(index, 1);
  } else if (index >= 0) {
  const node = region.settings[index]!;
  node.value = value;
  node.raw = `${key}:${value}`;
  } else {
  region.settings.push({ key, value, raw: `${key}:${value}` });
  }
  region.dirty = true;
}

export type Op =
  | { block: number; type: 'cue-time'; start?: string; end?: string }
  | { block: number; type: 'cue-text'; text: string }
  | { block: number; type: 'cue-setting'; key: string; value: string | null }
  | { block: number; type: 'region-setting'; key: string; value: string | null };

/** Apply a batch of node-scoped edits to a parsed document. */
export function applyOps(doc: VttDocument, ops: Op[]): VttDocument {
  for (const op of ops) {
  const block = doc.blocks[op.block];
  if (!block) throw new Error(`no block at index ${op.block}`);
  switch (op.type) {
    case 'cue-time':
    if (block.kind !== 'cue') throw new Error(`block ${op.block} is not a cue`);
    setCueTime(block, op);
    break;
    case 'cue-text':
    if (block.kind !== 'cue') throw new Error(`block ${op.block} is not a cue`);
    setCueText(block, op.text);
    break;
    case 'cue-setting':
    if (block.kind !== 'cue') throw new Error(`block ${op.block} is not a cue`);
    setCueSetting(block, op.key, op.value);
    break;
    case 'region-setting':
    if (block.kind !== 'region') throw new Error(`block ${op.block} is not a region`);
    setRegionSetting(block, op.key, op.value);
    break;
  }
  }
  return doc;
}

/** Parse + edit + serialize helper: untouched fragments survive verbatim. */
export function patchVtt(content: string, ops: Op[]): string {
  return serializeVtt(applyOps(parseVtt(content), ops));
}

// ---------- semantic token stream (order-sensitive comparison) ----------

/**
 * The semantic token sequence of a document. Direct import -> export must keep
 * this sequence identical even though line endings and whitespace may be
 * canonicalized.
 */
export function semanticTokens(doc: VttDocument): unknown[] {
  const tokens: unknown[] = [];
  tokens.push(doc.header ? ['header', doc.header.text] : ['no-header']);
  for (const block of doc.blocks) {
  switch (block.kind) {
    case 'note':
    tokens.push(['note', ...block.rawLines]);
    break;
    case 'style':
    tokens.push(['style', ...block.rawLines]);
    break;
    case 'unknown':
    tokens.push(['unknown', ...block.rawLines]);
    break;
    case 'region':
    tokens.push(['region', ...block.settings.map((node): [string, string] => [node.key, node.value])]);
    break;
    case 'cue':
    tokens.push([
    'cue',
    block.idRaw,
    block.startRaw,
    block.endRaw,
    block.settings.map((node): [string, string] => [node.key, node.value]),
    block.text,
    ]);
    break;
  }
  }
  return tokens;
}
