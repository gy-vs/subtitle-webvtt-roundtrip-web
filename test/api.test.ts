import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {
  parseVtt,
  serializeVtt,
  patchCue,
  decodeVttText,
  encodeVttLine,
  isCue,
  type VttDoc,
  type VttToken,
} from '../src/shared/vtt';

/** Position-independent semantic snapshot of a document's token sequence. */
function semantic(doc: VttDoc): unknown[] {
  return doc.tokens.map((token) => {
    if (token.kind === 'blank') return {kind: 'blank'};
    if (token.kind === 'cue') {
      return {
        kind: 'cue',
        idLine: token.idLine,
        start: token.start,
        end: token.end,
        settings: token.settings.map((s) =>
          s.kind === 'known'
            ? {kind: 'known', name: s.name, value: s.value}
            : {kind: 'unknown', key: s.key, value: s.value},
        ),
        payload: [...token.payload],
        text: token.text,
      };
    }
    return {kind: token.kind, raw: token.raw};
  });
}

function tokensOfKinds(doc: VttDoc): string[] {
  return doc.tokens
    .filter((t) => t.kind !== 'blank')
    .map((t: VttToken) => (t.kind === 'cue' ? `cue:${t.start}` : t.kind));
}

/** Physical-line indices that differ between two exports. */
function diffLines(a: string, b: string): number[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  const changed: number[] = [];
  for (let i = 0; i < n; i += 1) if (la[i] !== lb[i]) changed.push(i);
  return changed;
}

function cues(doc: VttDoc) {
  return doc.tokens.filter(isCue);
}

const CRLF_DOC =
  'WEBVTT - Studio\r\n' +
  '\r\n' +
  'NOTE keep me\r\n' +
  '\r\n' +
  'REGION\r\n' +
  'id:top\r\n' +
  'width:40%\r\n' +
  '\r\n' +
  'STYLE\r\n' +
  '::cue {\r\n' +
  '  color: white;\r\n' +
  '}\r\n' +
  '\n' + // mixed LF right here
  'intro\n' +
  '00:00:01.000 --> 00:00:04.000 vertical:rl line:10 position:25% region:top experimental:on\r\n' +
  'Tom &amp; Jerry &lt;laugh&gt; &nbsp; hi\r\n' +
  '\n' +
  '00:00:05.000 --> 00:00:08.500\r\n' +
  'Arrow: --> stays text &amp; <v.kate>hi</v>\r\n' +
  '\n' +
  'empty-cue\r\n' +
  '00:00:09.000 --> 00:00:10.000 vertical:lr\r\n';

const LF_DOC = CRLF_DOC.replace(/\r\n/g, '\n');

describe('parse + serialize round trip', () => {
  it('normalizes CRLF/CR but preserves the semantic token sequence', () => {
    const fromCrlf = parseVtt(CRLF_DOC);
    const fromLf = parseVtt(LF_DOC);
    expect(semantic(fromCrlf)).toEqual(semantic(fromLf));

    const exported = serializeVtt(fromCrlf);
    expect(exported).not.toMatch(/\r/); // line terminators normalized to LF
    expect(exported).toBe(LF_DOC); // nothing else moved/rewritten
    expect(semantic(parseVtt(exported))).toEqual(semantic(fromCrlf));
  });

  it('keeps NOTE, STYLE, REGION and unknown blocks in original order', () => {
    expect(tokensOfKinds(parseVtt(CRLF_DOC))).toEqual([
      'header',
      'note',
      'region',
      'style',
      'cue:00:00:01.000',
      'cue:00:00:05.000',
      'cue:00:00:09.000',
    ]);
  });

  it('recognizes the BOM-prefixed header', () => {
    const doc = parseVtt('﻿WEBVTT\r\n\r\n00:00:00.000 --> 00:00:01.000\r\nx\r\n');
    expect(doc.tokens[0].kind).toBe('header');
    expect(serializeVtt(doc)).toBe('﻿WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nx\n');
  });
});

describe('settings fidelity', () => {
  it('exposes known fields structurally and keeps unknown settings verbatim in place', () => {
    const cue = cues(parseVtt(CRLF_DOC))[0];
    const known = cue.settings.filter((s) => s.kind === 'known');
    expect(known.map((s) => (s.kind === 'known' ? `${s.name}=${s.value}` : ''))).toEqual([
      'vertical=rl',
      'line=10',
      'position=25%',
      'region=top',
    ]);
    const unknown = cue.settings.filter((s) => s.kind === 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({key: 'experimental', value: 'on'});
  });

  it('changing one cue time does not touch vertical/line/region or any other block', () => {
    const baseline = serializeVtt(parseVtt(CRLF_DOC));
    const next = patchCue(CRLF_DOC, 0, {start: '00:00:02.500'});
    const changed = diffLines(baseline, next);
    expect(changed).toEqual([14]); // only the first cue's timing line
    expect(next.split('\n')[14]).toBe(
      '00:00:02.500 --> 00:00:04.000 vertical:rl line:10 position:25% region:top experimental:on',
    );
    const doc = parseVtt(next);
    const [c1, c2, c3] = cues(doc);
    expect(c1.settings).toEqual(cues(parseVtt(CRLF_DOC))[0].settings);
    expect(c2.start).toBe('00:00:05.000');
    expect(c3.settings.find((s) => s.kind === 'known' && s.name === 'vertical')).toMatchObject({
      value: 'lr',
    });
    expect(
      tokensOfKinds(doc).map((t) => t.split(':')[0]),
    ).toEqual(tokensOfKinds(parseVtt(CRLF_DOC)).map((t) => t.split(':')[0]));
  });

  it('updating a known setting edits only that node, preserving unknown order', () => {
    const next = patchCue(CRLF_DOC, 0, {setting: {name: 'line', value: '0'}});
    const line = next.split('\n')[14];
    expect(line).toBe(
      '00:00:01.000 --> 00:00:04.000 vertical:rl line:0 position:25% region:top experimental:on',
    );
    // Only one physical line changed.
    expect(diffLines(serializeVtt(parseVtt(CRLF_DOC)), next)).toEqual([14]);

    const removed = patchCue(CRLF_DOC, 0, {setting: {name: 'vertical', value: ''}});
    expect(removed.split('\n')[14]).toBe(
      '00:00:01.000 --> 00:00:04.000 line:10 position:25% region:top experimental:on',
    );
  });
});

describe('entities are decoded/escaped exactly once', () => {
  it('decodes named and numeric entities once at parse time', () => {
    expect(decodeVttText('a &amp; b &lt;c&gt; &nbsp; &#65; &#x42;')).toBe('a & b <c>   A B');
    expect(decodeVttText('a &amp;amp; b')).toBe('a &amp; b'); // exactly one pass
    expect(decodeVttText('&notanentity;')).toBe('&notanentity;'); // unknown stays literal
  });

  it('round-trips entity payload verbatim (no double escape)', () => {
    const next = patchCue(CRLF_DOC, 1, {end: '00:00:09.000'}); // time edit only
    expect(next).toContain('Tom &amp; Jerry &lt;laugh&gt; &nbsp; hi');
    expect(next).toContain('Arrow: --> stays text &amp; <v.kate>hi</v>');
    expect(next).not.toContain('&amp;amp;');
  });

  it('escapes edited text exactly once, leaving markup intact', () => {
    expect(encodeVttLine('a & b <c>x</c> > \u00a0')).toBe('a &amp; b <c>x</c> > &nbsp;');
    const next = patchCue(CRLF_DOC, 0, {text: 'new & <bold>keep</bold>'});
    expect(next).toContain('new &amp; <bold>keep</bold>');
    // Settings and neighbors survive a text edit.
    expect(next).toContain('vertical:rl line:10 position:25% region:top experimental:on');
    expect(next).toContain('Arrow: --> stays text &amp; <v.kate>hi</v>');
    expect(diffLines(serializeVtt(parseVtt(CRLF_DOC)), next)).toEqual([15]);
  });
});

describe('empty text and arrow characters', () => {
  it('preserves cues with empty payloads', () => {
    const next = patchCue(CRLF_DOC, 2, {start: '00:00:09.500'});
    const exported = next.split('\n');
    expect(exported[exported.length - 2]).toBe(
      '00:00:09.500 --> 00:00:10.000 vertical:lr',
    );
    expect(exported[exported.length - 1]).toBe('');
  });

  it('never parses --> inside payload as a timing line', () => {
    const doc = parseVtt(CRLF_DOC);
    const [, c2] = cues(doc);
    expect(c2.payload).toEqual(['Arrow: --> stays text &amp; <v.kate>hi</v>']);
    expect(c2.text).toBe('Arrow: --> stays text & <v.kate>hi</v>');
    const next = patchCue(CRLF_DOC, 1, {text: 'edited: --> still text'});
    expect(parseVtt(next).tokens.filter(isCue)).toHaveLength(3);
    expect(next).toContain('edited: --> still text');
  });

  it('supports clearing and replacing cue text', () => {
    const cleared = patchCue(CRLF_DOC, 0, {text: ''});
    expect(parseVtt(cleared).tokens.filter(isCue)[0].payload).toEqual([]);
    const multiline = patchCue(cleared, 0, {text: 'line one\nline two'});
    expect(parseVtt(multiline).tokens.filter(isCue)[0].payload).toEqual([
      'line one',
      'line two',
    ]);
  });

  it('accepts CR-only line endings with the same semantic result', () => {
    const crDoc = LF_DOC.replace(/\n/g, '\r');
    expect(semantic(parseVtt(crDoc))).toEqual(semantic(parseVtt(CRLF_DOC)));
    expect(serializeVtt(parseVtt(crDoc))).toBe(LF_DOC);
  });
});

describe('unknown blocks and extensions', () => {
  const DOC =
    'WEBVTT\n' +
    '\n' +
    'NOTE first comment\n' +
    '\n' +
    'WEIRD-EXTENSION some raw payload line\n' +
    'second raw line\n' +
    '\n' +
    'REGION\n' +
    'id:r1\n' +
    '\n' +
    'NOTE trailing note\n' +
    '\n' +
    '00:00:01.000 --> 00:00:02.000\n' +
    'cue text\n';

  it('keeps unknown blocks raw and in order through a round trip', () => {
    expect(tokensOfKinds(parseVtt(DOC))).toEqual([
      'header',
      'note',
      'unknown',
      'region',
      'note',
      'cue:00:00:01.000',
    ]);
    expect(serializeVtt(parseVtt(DOC))).toBe(DOC);
  });

  it('a single-field edit cannot move comments, regions or unknown blocks', () => {
    const baseline = serializeVtt(parseVtt(DOC));
    const next = patchCue(DOC, 0, {end: '00:00:03.000'});
    const changed = diffLines(baseline, next);
    expect(changed).toEqual([12]); // only the cue timing line
    expect(next.split('\n').slice(0, 12)).toEqual(baseline.split('\n').slice(0, 12));
    const unknown = parseVtt(next).tokens.find((t) => t.kind === 'unknown');
    expect(unknown && unknown.kind === 'unknown' ? unknown.raw : '').toBe(
      'WEIRD-EXTENSION some raw payload line\nsecond raw line',
    );
  });

  it('adds a missing known setting onto the existing cue node', () => {
    const doc = parseVtt(DOC);
    const cue = cues(doc)[0];
    expect(cue.settings).toEqual([]);
    // A known setting added through the form lands on the existing cue node.
    const next = patchCue(DOC, 0, {setting: {name: 'align', value: 'center'}});
    expect(next.split('\n')[12]).toBe(
      '00:00:01.000 --> 00:00:02.000 align:center',
    );
  });
});

describe('HTTP API', () => {
  it('still conditionally updates records', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    await request(app)
      .put('/api/tracks/alpha')
      .send({content: 'updated', revision: before.body.revision})
      .expect(200);
    await request(app)
      .put('/api/tracks/alpha')
      .send({content: 'stale', revision: before.body.revision})
      .expect(409);
  });

  it('parses and patches vtt without disturbing unrelated blocks', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/vtt/patch')
      .send({content: CRLF_DOC, cueIndex: 0, patch: {start: '00:00:03.000'}})
      .expect(200);
    expect(res.body.content).toContain('00:00:03.000 --> 00:00:04.000 vertical:rl');
    expect(res.body.doc.tokens.some((t: {kind: string}) => t.kind === 'note')).toBe(true);
    expect(res.body.content).not.toContain('\r');

    await request(app)
      .post('/api/vtt/patch')
      .send({content: CRLF_DOC, cueIndex: 9, patch: {start: '00:00:03.000'}})
      .expect(400);
    await request(app)
      .post('/api/vtt/patch')
      .send({content: CRLF_DOC, cueIndex: 0, patch: {start: 'nope'}})
      .expect(400);
  });
});
