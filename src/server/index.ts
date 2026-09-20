import express from 'express';
import {fileURLToPath} from 'node:url';
import {parseVtt, patchCue, serializeVtt, VttError} from '../shared/vtt';

const SAMPLE_VTT =
  'WEBVTT - Studio\r\n' +
  '\r\n' +
  'NOTE This file mixes CRLF and LF on purpose\r\n' +
  '\r\n' +
  'REGION\r\n' +
  'id:top\r\n' +
  'width:40%\r\n' +
  'lines:3\r\n' +
  '\r\n' +
  'STYLE\r\n' +
  '::cue {\r\n' +
  '  color: white;\r\n' +
  '}\r\n' +
  '\n' +
  'intro\n' +
  '00:00:01.000 --> 00:00:04.000 vertical:rl line:10 position:25% region:top experimental:on\r\n' +
  'Tom &amp; Jerry &lt;laugh&gt; &nbsp; hi\r\n' +
  '\n' +
  '00:00:05.000 --> 00:00:08.500\r\n' +
  'Arrow text: --> and <c.t>tags &amp; co</c>\r\n' +
  '\n' +
  'empty-cue\r\n' +
  '00:00:09.000 --> 00:00:10.000 vertical:lr\r\n';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary timed cues',revision:3,content:SAMPLE_VTT,updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary timed cues',revision:5,content:'WEBVTT\r\n\r\nNOTE review draft\r\n\r\n00:00:00.000 --> 00:00:02.000\r\nBeta &amp; draft',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"subtitle-timing",count:rows.length}));
  app.get('/api/tracks',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/tracks/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/tracks/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/tracks/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));const content=String(req.body.content??row.content);const doc=parseVtt(content);res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,cueCount:doc.tokens.filter(t=>t.kind==='cue').length,diagnostics:[]})});

  // Stateless WebVTT model endpoints.
  app.post('/api/vtt/parse',(_req,res)=>{
    const content=String(_req.body?.content??'');
    res.json({doc:parseVtt(content),content:serializeVtt(parseVtt(content))});
  });
  app.post('/api/vtt/patch',(req,res)=>{
    try{
      const content=String(req.body?.content??'');
      const cueIndex=Number(req.body?.cueIndex);
      if(!Number.isInteger(cueIndex)||cueIndex<0)return res.status(400).json({error:'invalid_cue_index'});
      const patch=req.body?.patch;
      if(typeof patch!=='object'||patch===null)return res.status(400).json({error:'invalid_patch'});
      const next=patchCue(content,cueIndex,patch);
      res.json({content:next,doc:parseVtt(next)});
    }catch(err){
      if(err instanceof VttError)return res.status(400).json({error:err.code,message:err.message});
      throw err;
    }
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
