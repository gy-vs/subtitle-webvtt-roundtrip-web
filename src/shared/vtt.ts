/**
 * Lossless WebVTT model.
 *
 * The document is parsed into an ordered token stream (header, blank lines,
 * NOTE / STYLE / REGION / unknown blocks and cues). Every token keeps the raw
 * fragment it was parsed from, while cues additionally expose structured,
 * known fields. Serialization stitches the fragments back together, so a
 * parse -> serialize round trip only normalizes line terminators (CRLF/CR ->
 * LF); nothing else is reordered, dropped or re-escaped.
 *
 * Text entities are decoded exactly once (at parse time) and escaped exactly
 * once (only when a cue text is edited through `patchCue`).
 */

export type SettingName =
  | 'vertical'
  | 'line'
  | 'position'
  | 'size'
  | 'align'
  | 'region';

const KNOWN_SETTINGS: ReadonlySet<string> = new Set<SettingName>([
  'vertical',
  'line',
  'position',
  'size',
  'align',
  'region',
]);

/** One cue setting. `lead` is the exact whitespace fragment preceding it. */
export type VttSetting =
  | {kind: 'known'; name: SettingName; value: string; lead: string}
  | {kind: 'unknown'; key: string; value: string; lead: string};

export type VttCue = {
  kind: 'cue';
  /** Raw identifier line, or null when the cue has no id line. */
  idLine: string | null;
  start: string;
  end: string;
  /** Whitespace between the start timestamp and `-->`. */
  arrowLead: string;
  /** Whitespace between `-->` and the end timestamp. */
  arrowMiddle: string;
  /** Whitespace between the end timestamp and the settings. */
  arrowTrail: string;
  /** Original raw settings fragment (verifiable against `settings`). */
  settingsSource: string;
  /** Trailing whitespace after the last setting (kept verbatim). */
  settingsTail: string;
  settings: VttSetting[];
  /** Raw payload lines (never entity-decoded; used verbatim on export). */
  payload: string[];
  /** Payload decoded once: entities resolved, markup left untouched. */
  text: string;
};

export type VttRawBlock = {
  kind: 'header' | 'note' | 'style' | 'region' | 'unknown';
  raw: string;
};

export type VttBlank = {kind: 'blank'};

export type VttToken = VttCue | VttRawBlock | VttBlank;

export type VttDoc = {tokens: VttToken[]};

export class VttError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VttError';
    this.code = code;
  }
}

const TIMESTAMP_RE = /^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/;
const TIMING_RE =
  /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([ \t]+)-->([ \t]+)((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([ \t]*?)(.*?)([ \t]*)$/;
const HEADER_RE = /^﻿?WEBVTT(?:[ \t].*)?$/;
const NOTE_RE = /^NOTE(?:[ \t]|$)/;

export function isCue(token: VttToken): token is VttCue {
  return token.kind === 'cue';
}

/** Decode WebVTT character references exactly once. Unknown refs stay literal. */
export function decodeVttText(input: string): string {
  return input.replace(
    /&(?:(amp|lt|gt|nbsp)|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
      if (named) {
        if (named === 'amp') return '&';
        if (named === 'lt') return '<';
        if (named === 'gt') return '>';
        return ' '; // nbsp
      }
      const codePoint = dec !== undefined
        ? Number.parseInt(dec, 10)
        : Number.parseInt(hex as string, 16);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    },
  );
}

function escapePlainText(input: string): string {
  // '&' and '<' are the mandatory WebVTT text escapes; '>' is left as-is so
  // arrow characters in cue text survive an edit round trip.
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/ /g, '&nbsp;');
}

/**
 * Encode a single payload line once. Markup spans (`<...>`, including inline
 * timestamp tags) are protected and emitted as-is; only text nodes are
 * escaped, so existing references in raw payload are never re-escaped.
 */
export function encodeVttLine(line: string): string {
  let out = '';
  const tagRe = /<[^>]*>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(line)) !== null) {
    out += escapePlainText(line.slice(last, match.index));
    out += match[0];
    last = tagRe.lastIndex;
  }
  out += escapePlainText(line.slice(last));
  return out;
}

function parseSettings(source: string): {settings: VttSetting[]; tail: string} {
  const settings: VttSetting[] = [];
  const tokenRe = /([A-Za-z][A-Za-z0-9-]*):([^ \t]*)/y;
  let i = 0;
  while (i < source.length) {
    const leadMatch = /[ \t]*/y.exec(source.slice(i)) as RegExpExecArray;
    const lead = leadMatch[0];
    const j = i + lead.length;
    if (j === source.length) {
      // Pure trailing whitespace: keep as tail fragment.
      return {settings, tail: lead};
    }
    tokenRe.lastIndex = j;
    const m = tokenRe.exec(source);
    if (m && m.index === j) {
      const key = m[1];
      const value = m[2];
      if (KNOWN_SETTINGS.has(key.toLowerCase()) && key === key.toLowerCase()) {
        settings.push({kind: 'known', name: key as SettingName, value, lead});
      } else {
        settings.push({kind: 'unknown', key, value, lead});
      }
      i = j + m[0].length;
      continue;
    }
    // Malformed fragment: retain it verbatim as an unknown node.
    let k = j;
    while (k < source.length && source[k] !== ' ' && source[k] !== '\t') k++;
    settings.push({kind: 'unknown', key: '', value: source.slice(j, k), lead});
    i = k;
  }
  return {settings, tail: ''};
}

function buildSettingsSource(settings: VttSetting[], tail: string): string {
  return (
    settings
      .map((node) => {
        const body = node.kind === 'unknown' && node.key === ''
          ? node.value
          : `${node.kind === 'known' ? node.name : node.key}:${node.value}`;
        return `${node.lead}${body}`;
      })
      .join('') + tail
  );
}

function classifyBlock(lines: string[], isFirstBlock: boolean): VttToken {
  const first = lines[0];
  if (isFirstBlock && lines.length === 1 && HEADER_RE.test(first)) {
    return {kind: 'header', raw: lines.join('\n')};
  }
  if (NOTE_RE.test(first)) {
    return {kind: 'note', raw: lines.join('\n')};
  }
  if (first === 'STYLE') {
    return {kind: 'style', raw: lines.join('\n')};
  }
  if (first === 'REGION') {
    return {kind: 'region', raw: lines.join('\n')};
  }
  // A cue has a timing line as its first or second line. The payload is never
  // inspected for `-->`, so arrow characters in text cannot hijack parsing.
  let timingIndex = -1;
  if (TIMING_RE.test(lines[0])) timingIndex = 0;
  else if (lines.length > 1 && TIMING_RE.test(lines[1])) timingIndex = 1;
  if (timingIndex >= 0) {
    const idLine = timingIndex === 1 ? lines[0] : null;
    const timingLine = lines[timingIndex];
    const m = TIMING_RE.exec(timingLine) as RegExpExecArray;
    const payload = lines.slice(timingIndex + 1);
    const settingsSource = m[6] + m[7];
    const {settings, tail} = parseSettings(settingsSource);
    return {
      kind: 'cue',
      idLine,
      start: m[1],
      end: m[4],
      arrowLead: m[2],
      arrowMiddle: m[3],
      arrowTrail: m[5],
      settingsSource,
      settingsTail: tail,
      settings,
      payload,
      text: payload.map(decodeVttText).join('\n'),
    };
  }
  return {kind: 'unknown', raw: lines.join('\n')};
}

/** Parse WebVTT text into an ordered, lossless token stream. */
export function parseVtt(content: string): VttDoc {
  // Physical lines; this is the only normalization performed on input.
  const lines = content.split(/\r\n|\r|\n/);
  const tokens: VttToken[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i] === '') {
      tokens.push({kind: 'blank'});
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i] !== '') i += 1;
    const sawBlockAlready = tokens.some((t) => t.kind !== 'blank');
    tokens.push(classifyBlock(lines.slice(start, i), !sawBlockAlready));
  }
  return {tokens};
}

function serializeTiming(cue: VttCue): string {
  return (
    cue.start +
    cue.arrowLead +
    '-->' +
    cue.arrowMiddle +
    cue.end +
    cue.arrowTrail +
    cue.settingsSource
  );
}

function serializeCue(cue: VttCue): string {
  const head: string[] = [];
  if (cue.idLine !== null) head.push(cue.idLine);
  head.push(serializeTiming(cue));
  for (const line of cue.payload) head.push(line);
  return head.join('\n');
}

/** Serialize a token stream back to WebVTT (LF line terminators). */
export function serializeVtt(doc: VttDoc): string {
  return doc.tokens
    .map((token) => {
      switch (token.kind) {
        case 'blank':
          return '';
        case 'cue':
          return serializeCue(token);
        default:
          return token.raw;
      }
    })
    .join('\n');
}

export type SettingPatch = {name: SettingName; value: string};

export type CuePatch = {
  start?: string;
  end?: string;
  /** Identifier line; null/'' removes it. */
  id?: string | null;
  /** New decoded text; newlines split payload lines; '' is an empty cue. */
  text?: string;
  setting?: SettingPatch;
};

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) {
    throw new VttError('invalid_timestamp', `invalid ${field} timestamp`);
  }
}

function applySetting(cue: VttCue, change: SettingPatch): void {
  const index = cue.settings.findIndex(
    (node) => node.kind === 'known' && node.name === change.name,
  );
  if (change.value === '') {
    // Remove the node and consume its separating whitespace. When it was the
    // first setting, its lead transfers to the new first node so the fragment
    // still reads `...end<sep>next:...` instead of producing a double space.
    if (index < 0) return;
    const removed = cue.settings[index];
    if (index === 0 && cue.settings.length > 1) {
      // The separator after the end timestamp is owned by `arrowTrail` plus
      // the first node's lead. Adopt the removed first node's lead so exactly
      // one separator remains (e.g. `end vertical:x line:y` -> `end line:y`).
      cue.settings[1].lead = removed.lead;
    }
    cue.settings = cue.settings.filter((_, i) => i !== index);
  } else if (index >= 0) {
    // Update the single node in place; order and unknown nodes are untouched.
    const node = cue.settings[index];
    if (node.kind === 'known') node.value = change.value;
  } else {
    cue.settings.push({kind: 'known', name: change.name, value: change.value, lead: ' '});
  }
  cue.settingsSource = buildSettingsSource(cue.settings, cue.settingsTail);
}

/**
 * Apply one field-level change to the nth cue (cues counted in document
 * order) on a parsed document. Only the touched fragment / node changes:
 * settings, comments, unknown blocks and raw payload lines of other cues
 * keep their identity and position. Returns the same mutated document.
 */
export function patchCueDoc(doc: VttDoc, cueIndex: number, patch: CuePatch): VttDoc {
  let remaining = cueIndex;
  const cue = doc.tokens.find((token): token is VttCue => {
    if (token.kind !== 'cue') return false;
    if (remaining === 0) return true;
    remaining -= 1;
    return false;
  });
  if (!cue) throw new VttError('cue_not_found', `cue index ${cueIndex} does not exist`);

  if (patch.start !== undefined) {
    assertTimestamp(patch.start, 'start');
    cue.start = patch.start;
  }
  if (patch.end !== undefined) {
    assertTimestamp(patch.end, 'end');
    cue.end = patch.end;
  }
  if (patch.id !== undefined) {
    const id = patch.id === null ? '' : patch.id;
    if (id.includes('\n')) throw new VttError('invalid_id', 'cue id must be one line');
    if (id.includes('-->')) throw new VttError('invalid_id', 'cue id cannot contain -->');
    cue.idLine = id === '' ? null : id;
  }
  if (patch.text !== undefined) {
    const text = patch.text.replace(/\r\n|\r/g, '\n');
    // Encode once; untouched cues keep exporting their raw payload.
    cue.payload = text === '' ? [] : text.split('\n').map(encodeVttLine);
    cue.text = text;
  }
  if (patch.setting) applySetting(cue, patch.setting);

  return doc;
}

/** Parse, patch a single cue field, and serialize. Unrelated blocks stay raw. */
export function patchCue(content: string, cueIndex: number, patch: CuePatch): string {
  return serializeVtt(patchCueDoc(parseVtt(content), cueIndex, patch));
}
