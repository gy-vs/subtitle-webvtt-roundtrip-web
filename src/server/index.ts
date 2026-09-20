import express from 'express';
import {fileURLToPath} from 'node:url';
import {parseVtt, patchVtt, serializeVtt, type Op, type VttDocument} from '../shared/vtt';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};

const ALPHA_VTT = [
  'WEBVTT - Main track',
  '',
  'REGION',
  'id:top',
  'width:40%',
  'lines:3',
  '',
  'NOTE this is a production note',
  'spanning two lines',
  '',
  'STYLE',
  '::cue(.red) { color: red; }',
  '',
  'unknown-block',
  'foo:bar',
  '',
  'cue-1',
  '00:00:01.000 --> 00:00:04.000 vertical:rl line:10 region:top xweird:42',
  'Tom &amp; Jerry &rarr; home',
  '',
  '00:00:05.000 --> 00:00:06.500',
  'second cue with arrow --> inside text',
  '',
  '00:00:10.000 --> 00:00:11.000',
  '',
].join('\r\n');

const rows: RecordRow[] = [
  {id:'alpha',name:'Primary timed cues',revision:3,content:ALPHA_VTT,updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary timed cues',revision:5,content:'timed cues: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"subtitle-timing",count:rows.length}));
  app.get('/api/tracks',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/tracks/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/tracks/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/tracks/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // Parse arbitrary VTT content into the fidelity-preserving model.
  app.post('/api/vtt/parse',(req,res)=>{
    const content=String(req.body?.content??'');
    res.json({document:parseVtt(content)});
  });

  // Apply node-scoped edits server-side. Raw fragments of untouched blocks
  // (and untouched parts of edited blocks) survive byte-for-byte except for
  // line-ending normalization.
  app.post('/api/vtt/patch',(req,res)=>{
    const content=String(req.body?.content??'');
    const ops=Array.isArray(req.body?.ops)?(req.body.ops as Op[]):[];
    try{
      res.json({content:patchVtt(content,ops)});
    }catch(err){
      res.status(400).json({error:'invalid_patch',message:(err as Error).message});
    }
  });

  // Serialize a structured document back to VTT.
  app.post('/api/vtt/serialize',(req,res)=>{
    try{
      res.json({content:serializeVtt(req.body?.document as VttDocument)});
    }catch(err){
      res.status(400).json({error:'invalid_document',message:(err as Error).message});
    }
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
