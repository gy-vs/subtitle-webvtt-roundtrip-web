import {useEffect,useMemo,useState} from 'react';
import {FlaskConical,Play,Save,Tags} from 'lucide-react';
import {
  CUE_SETTING_KEYS,
  REGION_SETTING_KEYS,
  getCueSetting,
  parseTimestamp,
  parseVtt,
  serializeVtt,
  setCueSetting,
  setCueText,
  setCueTime,
  setRegionSetting,
  type Block,
  type CueBlock,
  type RegionBlock,
  type VttDocument,
} from '../shared/vtt';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

const KNOWN_CUE = new Set<string>(CUE_SETTING_KEYS);
const KNOWN_REGION = new Set<string>(REGION_SETTING_KEYS);

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [status,setStatus]=useState('Ready');
  const [doc,setDoc]=useState<VttDocument|null>(null);

  useEffect(()=>{fetch('/api/tracks').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    setStatus('Loading');
    fetch('/api/tracks/'+selected)
      .then(r=>r.json())
      .then((value:Row)=>{
        setRow(value);
        setDraft(value.content);
        setDoc(parseVtt(value.content));
        setStatus('Loaded');
      });
  },[selected]);

  /** Re-serialize the structured document into the raw draft (single encode pass). */
  function syncFromDoc(next:VttDocument){
    setDoc(next);
    setDraft(serializeVtt(next));
  }

  function onRawChange(value:string){
    setDraft(value);
    setDoc(parseVtt(value));
  }

  function patchBlock(index:number,fn:(block:Block)=>void){
    if(!doc)return;
    // Clone the structured model, mutate only the targeted node, then
    // serialize once. Untouched blocks keep their raw fragments.
    const next=structuredClone(doc) as VttDocument;
    fn(next.blocks[index]!);
    syncFromDoc(next);
  }

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/tracks/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(!response.ok){setStatus('Revision conflict');return}
    setRow(value);
    setStatus('Saved');
  }

  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/tracks/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});
    setAnalysis(await response.json());
    setStatus('Ready');
  }

  const cueCount=useMemo(()=>doc?.blocks.filter(b=>b.kind==='cue').length??0,[doc]);

  return (
    <main className="shell">
      <header className="topbar"><Tags size={20}/><strong>Subtitle Timing Studio</strong><small>WebVTT fidelity editing</small></header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">{items.map(item=>
            <button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>
              {item.name}<br/><small>Revision {item.revision}</small>
            </button>)}
          </div>
        </aside>
        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}><Save size={15}/>Save</button>
            <button onClick={analyze}><Play size={15}/>Analyze</button>
            <span>{status}</span>
          </div>
          {doc && <div className="meta">{cueCount} cue(s) parsed · NOTE / STYLE / unknown blocks preserved</div>}
          <textarea aria-label="Content" value={draft} onChange={event=>onRawChange(event.target.value)}/>
          {doc && <div className="forms">
            {doc.blocks.map((block,index)=>
              <BlockForm key={index} index={index} block={block} patchBlock={patchBlock}/>
            )}
          </div>}
        </section>
        <aside className="pane">
          <h2>Inspection</h2>
          <span className="pill">{selected}</span>
          <pre>{JSON.stringify(analysis??doc,null,2)}</pre>
        </aside>
      </section>
    </main>
  );
}

function BlockForm({index,block,patchBlock}:{
  index:number;
  block:Block;
  patchBlock:(index:number,fn:(block:Block)=>void)=>void;
}){
  if(block.kind==='cue'){
    return <CueForm index={index} cue={block} patchBlock={patchBlock}/>;
  }
  if(block.kind==='region'){
    return <RegionForm index={index} region={block} patchBlock={patchBlock}/>;
  }
  return (
    <section className={`block block-${block.kind}`}>
      <header><span className="badge">{block.kind}</span><small>block #{index} · preserved verbatim</small></header>
      <pre className="raw">{block.rawLines.join('\n')}</pre>
    </section>
  );
}

function CueForm({index,cue,patchBlock}:{
  index:number;
  cue:CueBlock;
  patchBlock:(index:number,fn:(block:Block)=>void)=>void;
}){
  const validStart=parseTimestamp(cue.startRaw)!==null;
  const validEnd=parseTimestamp(cue.endRaw)!==null;
  return (
    <section className="block block-cue">
      <header>
        <span className="badge">cue #{index}</span>
        {cue.idRaw && <small>id: {cue.idRaw}</small>}
      </header>
      <div className="grid">
        <label>start
          <input
            value={cue.startRaw}
            className={validStart?'':'invalid'}
            onChange={e=>{const v=e.target.value;if(parseTimestamp(v)!==null)patchBlock(index,b=>setCueTime(b as CueBlock,{start:v}))}}
          />
        </label>
        <label>end
          <input
            value={cue.endRaw}
            className={validEnd?'':'invalid'}
            onChange={e=>{const v=e.target.value;if(parseTimestamp(v)!==null)patchBlock(index,b=>setCueTime(b as CueBlock,{end:v}))}}
          />
        </label>
      </div>
      <div className="grid settings">
        {CUE_SETTING_KEYS.map(key=>
          <label key={key}>{key}
            <input
              value={getCueSetting(cue,key)??''}
              placeholder="—"
              onChange={e=>patchBlock(index,b=>setCueSetting(b as CueBlock,key,e.target.value||null))}
            />
          </label>
        )}
      </div>
      {cue.settings.filter(n=>!KNOWN_CUE.has(n.key)).length>0 &&
        <div className="unknown">unknown settings: {cue.settings.filter(n=>!KNOWN_CUE.has(n.key)).map(n=>n.raw).join(' · ')}</div>}
      <label className="text">cue text (decoded once)
        <textarea
          rows={Math.max(1,cue.text.split('\n').length)}
          value={cue.text}
          onChange={e=>patchBlock(index,b=>setCueText(b as CueBlock,e.target.value))}
        />
      </label>
    </section>
  );
}

function RegionForm({index,region,patchBlock}:{
  index:number;
  region:RegionBlock;
  patchBlock:(index:number,fn:(block:Block)=>void)=>void;
}){
  return (
    <section className="block block-region">
      <header><span className="badge">region #{index}</span></header>
      <div className="grid settings">
        {REGION_SETTING_KEYS.map(key=>{
          const node=region.settings.find(n=>n.key===key);
          return <label key={key}>{key}
            <input
              value={node?.value??''}
              placeholder="—"
              onChange={e=>patchBlock(index,b=>setRegionSetting(b as RegionBlock,key,e.target.value||null))}
            />
          </label>;
        })}
      </div>
      {region.settings.filter(n=>!KNOWN_REGION.has(n.key)).length>0 &&
        <div className="unknown">unknown settings: {region.settings.filter(n=>!KNOWN_REGION.has(n.key)).map(n=>n.raw).join(' · ')}</div>}
    </section>
  );
}
