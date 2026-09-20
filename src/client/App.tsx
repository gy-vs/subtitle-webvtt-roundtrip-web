import {useEffect,useMemo,useRef,useState} from 'react';
import {FlaskConical,Play,Save,Upload} from 'lucide-react';
import {
  isCue,
  parseVtt,
  patchCueDoc,
  serializeVtt,
  VttError,
  type CuePatch,
  type SettingName,
  type VttCue,
} from '../shared/vtt';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type Mode='visual'|'source';

const SETTING_FIELDS: {name:SettingName;label:string;placeholder:string}[]=[
  {name:'vertical',label:'vertical',placeholder:'rl | lr'},
  {name:'line',label:'line',placeholder:'e.g. 10 or -1,start'},
  {name:'position',label:'position',placeholder:'e.g. 25%'},
  {name:'size',label:'size',placeholder:'e.g. 50%'},
  {name:'align',label:'align',placeholder:'start | center | end | left | right'},
  {name:'region',label:'region',placeholder:'region id'},
];

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [mode,setMode]=useState<Mode>('visual');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [status,setStatus]=useState('Ready');
  const fileRef=useRef<HTMLInputElement|null>(null);

  useEffect(()=>{fetch('/api/tracks').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    setStatus('Loading');
    fetch('/api/tracks/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);setDraft(value.content);setStatus('Loaded');
    });
  },[selected]);

  // Parsed view of the draft. Visual edits mutate this doc through
  // patchCueDoc, which only touches the targeted cue/node.
  const doc=useMemo(()=>{
    try{return parseVtt(draft);}catch{return null;}
  },[draft]);

  function applyPatch(cueIndex:number,patch:CuePatch):boolean{
    if(!doc)return false;
    try{
      const next=patchCueDoc(structuredClone(doc),cueIndex,patch);
      setDraft(serializeVtt(next));
      setStatus(`Updated cue #${cueIndex+1}`);
      return true;
    }catch(err){
      setStatus(err instanceof VttError?`Invalid: ${err.message}`:'Invalid edit');
      return false;
    }
  }

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/tracks/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(!response.ok){setStatus('Revision conflict');return}
    setRow(value);setStatus('Saved');
  }

  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/tracks/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});
    setAnalysis(await response.json());setStatus('Ready');
  }

  function importFile(file:File){
    const reader=new FileReader();
    reader.onload=()=>{setDraft(String(reader.result??''));setStatus(`Imported ${file.name}`)};
    reader.readAsText(file);
  }

  let cueCounter=-1;

  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/><strong>Subtitle Timing Studio</strong><small>WebVTT round-trip</small>
    </header>
    <section className="workspace">
      <aside className="pane">
        <h2>Items</h2>
        <div className="list">
          {items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={analyze}><Play size={15}/>Analyze</button>
          <button onClick={()=>fileRef.current?.click()}><Upload size={15}/>Import .vtt</button>
          <input ref={fileRef} type="file" accept=".vtt,text/vtt" hidden onChange={e=>{const f=e.target.files?.[0];if(f)importFile(f);e.target.value='';}}/>
          <span className="mode-toggle">
            <button className={mode==='visual'?'active':''} onClick={()=>setMode('visual')}>Structured</button>
            <button className={mode==='source'?'active':''} onClick={()=>setMode('source')}>Source</button>
          </span>
          <span>{status}</span>
        </div>
        {mode==='source'||!doc?
          <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/>
        :
          <ol className="tokens">
            {doc.tokens.map((token,ti)=>{
              if(token.kind==='blank')return null;
              if(!isCue(token))return <li className={`block block-${token.kind}`} key={ti}>
                <span className="block-tag">{token.kind.toUpperCase()}</span>
                <pre>{token.raw}</pre>
              </li>;
              cueCounter+=1;
              const cueIndex=cueCounter;
              return <CueEditor key={ti} cue={token} cueIndex={cueIndex} onPatch={applyPatch}/>;
            })}
          </ol>}
      </section>
      <aside className="pane">
        <h2>Inspection</h2>
        <span className="pill">{selected}</span>
        <pre>{JSON.stringify(analysis??{tokens:doc?.tokens.length??0,cues:doc?.tokens.filter(isCue).length??0,bytes:draft.length},null,2)}</pre>
      </aside>
    </section>
  </main>;
}

function CueEditor({cue,cueIndex,onPatch}:{cue:VttCue;cueIndex:number;onPatch:(i:number,p:CuePatch)=>boolean}){
  return <li className="block block-cue">
    <span className="block-tag">CUE #{cueIndex+1}{cue.idLine!==null?` — ${cue.idLine}`:''}</span>
    <div className="cue-grid">
      <Field
        label="Start"
        initial={cue.start}
        commit={value=>onPatch(cueIndex,{start:value})}
      />
      <Field
        label="End"
        initial={cue.end}
        commit={value=>onPatch(cueIndex,{end:value})}
      />
      <Field
        label="Identifier"
        initial={cue.idLine??''}
        placeholder="(none)"
        className="cue-id"
        commit={value=>onPatch(cueIndex,{id:value})}
      />
    </div>
    <label className="text-label">Text (entities shown decoded; escaped once on export)
      <textarea
        value={cue.text}
        rows={Math.max(1,cue.text.split('\n').length)}
        onChange={e=>onPatch(cueIndex,{text:e.target.value})}
      />
    </label>
    <fieldset className="settings">
      <legend>Known settings</legend>
      {SETTING_FIELDS.map(field=>{
        const node=cue.settings.find(s=>s.kind==='known'&&s.name===field.name);
        return <Field
          key={field.name}
          label={field.label}
          initial={node&&node.kind==='known'?node.value:''}
          placeholder={field.placeholder}
          commit={value=>onPatch(cueIndex,{setting:{name:field.name,value}})}
        />;
      })}
    </fieldset>
    {cue.settings.some(s=>s.kind==='unknown')&&
      <div className="unknown-settings">
        <strong>Unknown settings (kept verbatim, in place):</strong>
        <ul>{cue.settings.filter(s=>s.kind==='unknown').map((s,i)=>
          <li key={i}><code>{s.kind==='unknown'?(s.key===''?s.value:s.key+':'+s.value):''}</code></li>)}
        </ul>
      </div>}
  </li>;
}

/**
 * Text input with a local editing buffer. Keystrokes update the buffer; the
 * patch is committed on blur/Enter, so an in-progress timestamp such as
 * "00:00:02." is not rejected field-by-field. A rejected commit resets the
 * buffer to the model value — the cue node itself is never rebuilt.
 */
function Field({label,initial,placeholder,className,commit}:{
  label:string;
  initial:string;
  placeholder?:string;
  className?:string;
  commit:(value:string)=>boolean;
}){
  const [value,setValue]=useState(initial);
  useEffect(()=>{setValue(initial)},[initial]);
  function submit(){
    if(value!==initial){
      if(!commit(value))setValue(initial); // rejected by model; reset buffer
    }
  }
  return <label className={className}>{label}
    <input
      value={value}
      placeholder={placeholder}
      onChange={e=>setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={e=>{if(e.key==='Enter')(e.target as HTMLInputElement).blur();}}
    />
  </label>;
}
