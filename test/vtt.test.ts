import {describe,expect,it} from 'vitest';
import {
  decodeCueLine,
  encodeCueLine,
  formatTimestamp,
  getCueSetting,
  parseTimestamp,
  parseVtt,
  patchVtt,
  semanticTokens,
  serializeVtt,
  setCueSetting,
  setCueText,
  setCueTime,
  setRegionSetting,
  type CueBlock,
  type VttDocument,
} from '../src/shared/vtt';

const SAMPLE_LF = [
  'WEBVTT - Main track',
  '',
  'REGION',
  'id:top',
  'width:40%',
  'lines:3',
  '',
  'NOTE this is a note',
  'second note line',
  '',
  'STYLE',
  '::cue(.red) { color: red; }',
  '',
  'X-UNKNOWN',
  'weird:42',
  '',
  'cue-1',
  '00:00:01.000 --> 00:00:04.000 vertical:rl line:10 region:top',
  'Tom &amp; Jerry &rarr; home',
  '',
  '00:00:05.000 --> 00:00:06.500 position:50%',
  'arrow --> inside text',
  '',
  '00:00:10.000 --> 00:00:11.000',
  '',
].join('\n');

const SAMPLE_CRLF = SAMPLE_LF.replace(/\n/g, '\r\n');

function roundTrip(input: string): {doc: VttDocument; out: string} {
  const doc = parseVtt(input);
  return {doc, out: serializeVtt(doc)};
}

describe('line endings', () => {
  it('parses CRLF and normalizes to LF on export', () => {
    const {doc, out} = roundTrip(SAMPLE_CRLF);
    expect(out).not.toMatch(/\r/);
    expect(doc.blocks).toHaveLength(7);
    expect(out.split('\n\n')).toHaveLength(8); // header + 7 blocks
  });

  it('parses bare CR the same as LF', () => {
    const cr = parseVtt(SAMPLE_LF.replace(/\n/g, '\r'));
    expect(semanticTokens(cr)).toEqual(semanticTokens(parseVtt(SAMPLE_LF)));
  });

  it('strips a leading BOM', () => {
    const doc = parseVtt(`${String.fromCharCode(0xfeff)}WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello`);
    expect(doc.header?.raw).toBe('WEBVTT');
  });
});

describe('direct import -> export semantic stability', () => {
  it('keeps the semantic token sequence identical for CRLF input', () => {
    const before = semanticTokens(parseVtt(SAMPLE_CRLF));
    const after = semanticTokens(parseVtt(serializeVtt(parseVtt(SAMPLE_CRLF))));
    expect(after).toEqual(before);
  });

  it('keeps raw fragments byte-identical (modulo CRLF) on round trip', () => {
    const out = roundTrip(SAMPLE_CRLF).out;
    const lfInput = SAMPLE_LF;
    // trailing newline is added; every block chunk must be unchanged
    expect(out.trimEnd()).toBe(lfInput.trimEnd());
  });
});

describe('NOTE / STYLE / REGION / unknown ordering', () => {
  it('preserves NOTE lines and order verbatim', () => {
    const doc = parseVtt(SAMPLE_LF);
    const note = doc.blocks[1]!;
    expect(note.kind).toBe('note');
    expect(note).toMatchObject({rawLines: ['NOTE this is a note', 'second note line']});
  });

  it('handles an inline NOTE (text on the marker line)', () => {
    const doc = parseVtt('WEBVTT\n\nNOTE one short note\n\n00:00:01.000 --> 00:00:02.000\nx');
    expect(doc.blocks[0]).toMatchObject({kind: 'note', rawLines: ['NOTE one short note']});
  });

  it('keeps STYLE blocks verbatim', () => {
    const doc = parseVtt(SAMPLE_LF);
    const style = doc.blocks[2]!;
    expect(style.kind).toBe('style');
    expect(serializeVtt(doc)).toContain('STYLE\n::cue(.red) { color: red; }');
  });

  it('keeps unknown extension blocks verbatim and in place', () => {
    const doc = parseVtt(SAMPLE_LF);
    const unknown = doc.blocks[3]!;
    expect(unknown).toMatchObject({kind: 'unknown', rawLines: ['X-UNKNOWN', 'weird:42']});
    expect(semanticTokens(doc)[4]).toEqual(['unknown', 'X-UNKNOWN', 'weird:42']);
  });

  it('parses REGION structured fields while retaining the raw block', () => {
    const doc = parseVtt(SAMPLE_LF);
    const region = doc.blocks[0]!;
    expect(region.kind).toBe('region');
    if (region.kind !== 'region') throw new Error('guard');
    expect(region.settings.map((n) => [n.key, n.value])).toEqual([
      ['id', 'top'],
      ['width', '40%'],
      ['lines', '3'],
    ]);
    expect(region.dirty).toBe(false);
    expect(region.rawLines).toEqual(['REGION', 'id:top', 'width:40%', 'lines:3']);
  });

  it('keeps unknown REGION setting rows verbatim', () => {
    const doc = parseVtt('WEBVTT\n\nREGION\nid:r\nfrobnicate:yes\n');
    const region = doc.blocks[0]!;
    expect(region.kind).toBe('region');
    if (region.kind !== 'region') throw new Error('guard');
    setRegionSetting(region, 'width', '80%');
    const out = serializeVtt(doc);
    expect(out).toContain('frobnicate:yes');
    expect(out).toContain('width:80%');
  });
});

describe('unknown cue settings are preserved', () => {
  it('retains unknown settings and adds/removes known ones in place', () => {
    const doc = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 xweird:42 align:start\nx',
    );
    const cue = doc.blocks[0] as CueBlock;
    expect(cue.settings.map((n) => n.raw)).toEqual(['xweird:42', 'align:start']);
    setCueSetting(cue, 'vertical', 'rl');
    setCueSetting(cue, 'align', null);
    expect(cue.settings.map((n) => n.raw)).toEqual(['xweird:42', 'vertical:rl']);
    expect(serializeVtt(doc)).toContain('00:00:01.000 --> 00:00:02.000 xweird:42 vertical:rl');
  });
});

describe('entity decode/encode happens exactly once', () => {
  it('decodes named, decimal and hex entities once', () => {
    expect(decodeCueLine('a &amp; b &#65; &#x42; &copy;')).toBe('a & b A B ©');
  });

  it('does not cascade decoded entities', () => {
    expect(decodeCueLine('&amp;amp;')).toBe('&amp;');
    expect(decodeCueLine('&amp;#65;')).toBe('&#65;');
  });

  it('leaves tags intact while decoding text between them', () => {
    expect(decodeCueLine('<v.hot Tom>Hi &amp; bye</v>')).toBe('<v.hot Tom>Hi & bye</v>');
    expect(decodeCueLine('<c.red>1 &lt; 2</c> <00:00:01.000>')).toBe('<c.red>1 < 2</c> <00:00:01.000>');
  });

  it('encodes edited text once and survives re-export', () => {
    const encoded = encodeCueLine('<v>Tom & Jerry ></v>');
    expect(encoded).toBe('<v>Tom &amp; Jerry &gt;</v>');
    expect(decodeCueLine(encoded)).toBe('<v>Tom & Jerry ></v>');
    // editing text from the decoded form must not double-escape
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry');
    const cue = doc.blocks[0] as CueBlock;
    setCueText(cue, cue.text + ' & co');
    const once = serializeVtt(doc);
    expect(once).toContain('Tom &amp; Jerry &amp; co');
    const twice = serializeVtt(parseVtt(once));
    expect(twice).toContain('Tom &amp; Jerry &amp; co');
  });

  it('never re-escapes untouched payloads', () => {
    const out = patchVtt(SAMPLE_CRLF, []);
    expect(out).toContain('Tom &amp; Jerry &rarr; home');
  });
});

describe('arrow characters inside text', () => {
  it('does not treat --> inside payload as a timing line', () => {
    const doc = parseVtt(SAMPLE_LF);
    const cue = doc.blocks[5] as CueBlock;
    expect(cue.kind).toBe('cue');
    expect(cue.text).toBe('arrow --> inside text');
    expect(roundTrip(SAMPLE_LF).out).toContain('arrow --> inside text');
  });
});

describe('empty cue text', () => {
  it('parses and re-serializes empty cues', () => {
    const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:11.000\n';
    const doc = parseVtt(vtt);
    const cue = doc.blocks[0] as CueBlock;
    expect(cue.text).toBe('');
    expect(serializeVtt(doc)).toBe('WEBVTT\n\n00:00:10.000 --> 00:00:11.000\n');
  });

  it('can set cue text empty after edit without breaking structure', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\nworld');
    const cue = doc.blocks[0] as CueBlock;
    setCueText(cue, '');
    const out = serializeVtt(doc);
    expect(out).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n');
    expect(semanticTokens(parseVtt(out))).toEqual(semanticTokens(doc));
  });
});

describe('single-field edits do not touch unrelated blocks', () => {
  it('changing one cue start time only rewrites that cue chunk', () => {
    const beforeChunks = SAMPLE_LF.trimEnd().split('\n\n');
    const out = patchVtt(SAMPLE_CRLF, [{block: 4, type: 'cue-time', start: '00:00:02.500'}]);
    const afterChunks = out.trimEnd().split('\n\n');
    expect(afterChunks).toHaveLength(beforeChunks.length);
    afterChunks.forEach((chunk, i) => {
    if (i === 5) return; // edited cue was chunk index 5 (after header/region/note/style/unknown)
    expect(chunk).toBe(beforeChunks[i]);
    });
    expect(afterChunks[5]).toContain('00:00:02.500 --> 00:00:04.000 vertical:rl line:10 region:top');
  });

  it('keeps vertical/line/region of the edited cue when only the end time changes', () => {
    const out = patchVtt(SAMPLE_CRLF, [{block: 4, type: 'cue-time', end: '00:00:09.000'}]);
    const cue = parseVtt(out).blocks[4] as CueBlock;
    expect(getCueSetting(cue, 'vertical')).toBe('rl');
    expect(getCueSetting(cue, 'line')).toBe('10');
    expect(getCueSetting(cue, 'region')).toBe('top');
  });

  it('changing text only rewrites that cue payload; timing line stays raw', () => {
    const out = patchVtt(SAMPLE_CRLF, [{block: 4, type: 'cue-text', text: 'new text'}]);
    const chunks = out.trimEnd().split('\n\n');
    // timing line untouched
    expect(chunks[5]).toBe('cue-1\n00:00:01.000 --> 00:00:04.000 vertical:rl line:10 region:top\nnew text');
    // all other chunks identical
    const beforeChunks = SAMPLE_LF.trimEnd().split('\n\n');
    chunks.forEach((chunk, i) => {
    if (i === 5) return;
    expect(chunk).toBe(beforeChunks[i]);
    });
  });

  it('changing a setting preserves the cue text and all other blocks', () => {
    const out = patchVtt(SAMPLE_CRLF, [{block: 4, type: 'cue-setting', key: 'line', value: '20'}]);
    expect(out).toContain('vertical:rl line:20 region:top');
    expect(out).toContain('Tom &amp; Jerry &rarr; home');
    expect(out).toContain('NOTE this is a note');
    expect(out).toContain('X-UNKNOWN\nweird:42');
  });

  it('a region setting edit does not rewrite any cue', () => {
    const beforeChunks = SAMPLE_LF.trimEnd().split('\n\n');
    const out = patchVtt(SAMPLE_CRLF, [{block: 0, type: 'region-setting', key: 'width', value: '70%'}]);
    const afterChunks = out.trimEnd().split('\n\n');
    afterChunks.forEach((chunk, i) => {
    if (i === 1) return; // the REGION chunk
    expect(chunk).toBe(beforeChunks[i]);
    });
    expect(afterChunks[1]).toBe('REGION\nid:top\nwidth:70%\nlines:3');
  });
});

describe('timestamps', () => {
  it('parses and formats timestamps', () => {
    expect(parseTimestamp('00:01:02.500')).toBe(62500);
    expect(parseTimestamp('01:02.500')).toBe(62500);
    expect(parseTimestamp('60:01.000')).toBeNull();
    expect(formatTimestamp(62500)).toBe('00:01:02.500');
  });

  it('rejects invalid timestamps on edit', () => {
    expect(() =>
    patchVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx', [
    {block: 0, type: 'cue-time', start: 'not-a-time'},
    ]),
    ).toThrow(/invalid timestamp/);
  });
});

describe('files without header / extra blank lines', () => {
  it('survives a file without WEBVTT header', () => {
    const input = '\n\n00:00:01.000 --> 00:00:02.000\nx\n';
    const doc = parseVtt(input);
    expect(doc.header).toBeNull();
    const tokens = semanticTokens(doc);
    const reparsed = semanticTokens(parseVtt(serializeVtt(doc)));
    expect(reparsed).toEqual(tokens);
  });

  it('collapses multiple blank lines sementially (token sequence unchanged)', () => {
    const input = 'WEBVTT\n\n\n00:00:01.000 --> 00:00:02.000\na\n\n\n\n00:00:03.000 --> 00:00:04.000\nb';
    const doc = parseVtt(input);
    expect(doc.blocks).toHaveLength(2);
    const out = serializeVtt(doc);
    expect(out).not.toMatch(/\n\n\n/);
    expect(semanticTokens(parseVtt(out))).toEqual(semanticTokens(doc));
  });
});

describe('cue with id and id-like text', () => {
  it('uses the line before timing as cue identifier', () => {
    const doc = parseVtt('WEBVTT\n\nchapter one\n00:00:01.000 --> 00:00:02.000\nx');
    const cue = doc.blocks[0] as CueBlock;
    expect(cue.idRaw).toBe('chapter one');
    expect(roundTrip('WEBVTT\n\nchapter one\n00:00:01.000 --> 00:00:02.000\nx').out).toContain(
    'chapter one\n00:00:01.000 --> 00:00:02.000',
    );
  });

  it('keeps id when time changes', () => {
    const out = patchVtt('WEBVTT\n\nchapter one\n00:00:01.000 --> 00:00:02.000\nx', [
    {block: 0, type: 'cue-time', end: '00:00:05.000'},
    ]);
    expect(out).toContain('chapter one\n00:00:01.000 --> 00:00:05.000');
  });
});
