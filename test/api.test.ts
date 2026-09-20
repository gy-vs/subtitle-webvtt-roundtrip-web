import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const VTT = [
  'WEBVTT',
  '',
  'REGION',
  'id:top',
  '',
  'NOTE keep me',
  '',
  'STYLE',
  '::cue { color: lime; }',
  '',
  'X-WEIRD',
  'foo:bar',
  '',
  'cue-1',
  '00:00:01.000 --> 00:00:04.000 vertical:rl line:10 region:top',
  'Tom &amp; Jerry',
  '',
  '00:00:05.000 --> 00:00:06.000',
  'a --> b',
  '',
  '00:00:09.000 --> 00:00:10.000',
  '',
].join('\r\n');

describe('service', () => {
  it('loads and conditionally updates a record', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    await request(app).put('/api/tracks/alpha').send({content: 'updated', revision: before.body.revision}).expect(200);
    await request(app).put('/api/tracks/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });
});

describe('/api/vtt/parse', () => {
  it('returns structured blocks plus raw fragments for CRLF input', async () => {
    const app = createApp();
    const res = await request(app).post('/api/vtt/parse').send({content: VTT}).expect(200);
    const doc = res.body.document;
    expect(doc.header.raw).toBe('WEBVTT');
    const kinds = doc.blocks.map((b: {kind: string}) => b.kind);
    expect(kinds).toEqual(['region', 'note', 'style', 'unknown', 'cue', 'cue', 'cue']);
    const cue = doc.blocks[4];
    expect(cue.idRaw).toBe('cue-1');
    expect(cue.startRaw).toBe('00:00:01.000');
    expect(cue.text).toBe('Tom & Jerry');
    expect(cue.settings.find((n: {key: string}) => n.key === 'vertical').value).toBe('rl');
    // unknown block kept raw
    expect(doc.blocks[3]).toEqual({kind: 'unknown', rawLines: ['X-WEIRD', 'foo:bar']});
  });
});

describe('/api/vtt/patch', () => {
  it('changes one timestamp and leaves other chunks byte-identical', async () => {
    const app = createApp();
    const res = await request(app)
    .post('/api/vtt/patch')
    .send({content: VTT, ops: [{block: 4, type: 'cue-time', start: '00:00:02.000'}]})
    .expect(200);
    const out: string = res.body.content;
    expect(out).not.toMatch(/\r/);
    expect(out).toContain('00:00:02.000 --> 00:00:04.000 vertical:rl line:10 region:top');
    // everything else preserved
    expect(out).toContain('NOTE keep me');
    expect(out).toContain('STYLE\n::cue { color: lime; }');
    expect(out).toContain('X-WEIRD\nfoo:bar');
    expect(out).toContain('Tom &amp; Jerry');
    expect(out).toContain('a --> b');
    expect(out).toMatch(/00:00:09\.000 --> 00:00:10\.000\n$/);
  });

  it('updates a known cue setting without rebuilding the cue text', async () => {
    const app = createApp();
    const res = await request(app)
    .post('/api/vtt/patch')
    .send({content: VTT, ops: [{block: 4, type: 'cue-setting', key: 'line', value: null}]})
    .expect(200);
    expect(res.body.content).toContain('vertical:rl region:top');
    expect(res.body.content).toContain('Tom &amp; Jerry');
    expect(res.body.content).not.toContain('line:');
  });

  it('edits text with a single decode/encode round trip', async () => {
    const app = createApp();
    const res = await request(app)
    .post('/api/vtt/patch')
    .send({content: VTT, ops: [{block: 4, type: 'cue-text', text: 'Tom & Jerry & co'}]})
    .expect(200);
    expect(res.body.content).toContain('Tom &amp; Jerry &amp; co');
    // feeding the export back and editing again must not double-escape
    const again = await request(app)
    .post('/api/vtt/patch')
    .send({content: res.body.content, ops: [{block: 4, type: 'cue-text', text: 'Tom & Jerry & co'}]})
    .expect(200);
    expect(again.body.content).toContain('Tom &amp; Jerry &amp; co');
  });

  it('edits a region setting and keeps cues verbatim', async () => {
    const app = createApp();
    const res = await request(app)
    .post('/api/vtt/patch')
    .send({content: VTT, ops: [{block: 0, type: 'region-setting', key: 'width', value: '90%'}]})
    .expect(200);
    expect(res.body.content).toContain('REGION\nid:top\nwidth:90%');
    expect(res.body.content).toContain('Tom &amp; Jerry');
  });

  it('rejects a bad timestamp and bad block index', async () => {
    const app = createApp();
    await request(app)
    .post('/api/vtt/patch')
    .send({content: VTT, ops: [{block: 4, type: 'cue-time', start: 'nope'}]})
    .expect(400);
    await request(app)
    .post('/api/vtt/patch')
    .send({content: VTT, ops: [{block: 99, type: 'cue-text', text: 'x'}]})
    .expect(400);
  });
});
