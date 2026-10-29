import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const nodes=tree=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(nodes):[tree,...nodes(tree.props?.children)];
const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):String(node??'');
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function mount(queued=false,separated=true){
  const values=[],refs=[],effects=[],callbacks=[],calls=[];let cursor=0,ref=0,effect=0,callback=0,pending=[];
  let song={id:'song',title:'测试原唱',created_at:1,duration_ms:2000,status:'ready',available:true,stems_ready:separated,vocals_path:'vocals.wav',accompaniment_path:'accompaniment.wav',audio_path:'audio.mp3',raw_segments:[],cues:[{start_ms:100,end_ms:1000,text:'第一句',lead_ms:200}],pcm_lead_ms:0,pcm_ready:queued,pcm_segments:queued?[{}]:[]};
  const director={};vm.runInNewContext(compile('src/songDirector.ts'),{exports:director});
  const modules={
    react:{
      useState(initial){const i=cursor++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return[values[i],next=>{values[i]=typeof next==='function'?next(values[i]):next;}];},
      useRef(initial){return refs[ref++]??={current:initial};},
      useCallback(fn,deps){const i=callback++;if(!callbacks[i]||deps.some((x,j)=>!Object.is(x,callbacks[i].deps[j])))callbacks[i]={fn,deps};return callbacks[i].fn;},
      useEffect(fn,deps){const i=effect++;if(!effects[i]||deps.some((x,j)=>!Object.is(x,effects[i][j])))pending.push(()=>{effects[i]=deps;fn();});},
    },
    'react/jsx-runtime':{jsx:(tag,props)=>({tag,props}),jsxs:(tag,props)=>({tag,props})},
    'lucide-react':{},'../songDirector':director,'../modelConfig':{},'../ttsConfig':{},
    '@tauri-apps/api/core':{isTauri:()=>true,convertFileSrc:p=>p,invoke:async(name,args)=>{
      calls.push({name,args});
      if(name==='director_save'){song={...song,cues:args.cues,pcm_lead_ms:args.pcmLeadMs,pcm_ready:true,pcm_segments:[{}]};}
      if(name==='director_save_timing')song={...song,pcm_lead_ms:args.pcmLeadMs,...(args.textLeadMs!==null?{lyric_display_delay_ms:args.textLeadMs}:{})};
      if(name==='director_prepare_pcm')song={...song,pcm_ready:true,pcm_segments:[{}]};
      if(name==='director_separate')song={...song,stems_ready:true,pcm_ready:true,pcm_segments:[{}]};
      if(name==='director_save_lyric_delay')song={...song,lyric_display_delay_ms:args.delayMs};
      return name==='director_list'?{songs:[song],directory:'songs'}:song;
    }},
  };
  const api={};vm.runInNewContext(compile('src/ui/SingingModule.tsx'),{exports:api,require:n=>modules[n],structuredClone,localStorage:{getItem:()=>null},window:{confirm:()=>true}});
  const render=()=>{cursor=ref=effect=callback=0;pending=[];const tree=api.SingingModule({active:true,onConfigureModel:()=>{},onEnqueue:async()=>{},queuedSongIds:queued?['song']:[],queueAvailable:true});pending.forEach(fn=>fn());return tree;};
  const button=label=>nodes(render()).find(n=>n.tag==='button'&&text(n)===label);
  const pcmInput=()=>nodes(nodes(render()).find(n=>n.tag==='label'&&text(n).startsWith('PCM提前量'))).find(n=>n.tag==='input');
  const textInput=()=>nodes(nodes(render()).find(n=>n.tag==='label'&&text(n).startsWith('歌词文字提前量'))).find(n=>n.tag==='input');
  return{render,calls,button,pcmInput,textInput};
}

test('legacy mixed songs require separation before enqueue and expose separate stem previews',async()=>{
  const p=mount(false,false);p.render();await flush();
  assert.equal(p.button('加入播放歌曲槽位').props.disabled,true);
  assert.equal(p.button('截取歌词PCM').props.disabled,true);
  p.button('分离人声与伴奏').props.onClick();await flush();
  assert.ok(p.calls.some(c=>c.name==='director_separate'));
  assert.equal(p.button('加入播放歌曲槽位').props.disabled,false);
  p.button('编辑').props.onClick();
  const previews=nodes(p.render()).filter(n=>n.tag==='audio').map(n=>n.props.src);
  assert.ok(previews.includes('accompaniment.wav'));assert.ok(previews.includes('vocals.wav'));
  assert.match(text(p.render()),/伴奏不延迟、不变速/);
});

test('one signed lyric control previews before PCM, persists negative and zero, and replaces the old delay control',async()=>{
  const p=mount(true);p.render();await flush();p.button('编辑').props.onClick();
  assert.equal(p.textInput().props.value,'1500');assert.equal(p.textInput().props.disabled,false);
  assert.equal(p.button('保存歌词显示延迟'),undefined);
  assert.equal(nodes(p.render()).some(n=>n.tag==='label'&&text(n).startsWith('PCM发送后显示歌词')),false);
  p.pcmInput().props.onChange({target:{value:'50'}});p.textInput().props.onChange({target:{value:'2000'}});
  assert.equal(text(nodes(p.render()).find(n=>n.props?.['aria-label']==='第1段OBS显示时刻')),'0:02.050');
  p.textInput().props.onChange({target:{value:'-1500'}});p.button('保存提前量').props.onClick();await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls.find(c=>c.name==='director_save_timing').args)),{id:'song',pcmLeadMs:50,textLeadMs:-1500});
  p.button('收起详情').props.onClick();p.button('编辑').props.onClick();assert.equal(p.textInput().props.value,'-1500');
  assert.equal(text(nodes(p.render()).find(n=>n.props?.['aria-label']==='第1段OBS显示时刻')),'0:00.000');
  assert.equal(p.calls.filter(c=>['director_save_lyric_delay','director_prepare_pcm','director_save'].includes(c.name)).length,0);
  p.textInput().props.onChange({target:{value:'0'}});p.button('保存提前量').props.onClick();await flush();
  p.button('收起详情').props.onClick();p.button('编辑').props.onClick();
  assert.equal(p.textInput().props.value,'0');assert.equal(p.pcmInput().props.value,'50');
  for(const value of ['', '-10001','10001','1.5']){p.textInput().props.onChange({target:{value}});p.button('保存提前量').props.onClick();await flush();}
  assert.equal(p.calls.filter(c=>c.name==='director_save_timing').length,2);
});

test('singing editor exposes and saves independent PCM lead and prepares before enqueue',async()=>{
  const p=mount();p.render();await flush();assert.equal(p.button('加入播放歌曲槽位').props.disabled,true);
  p.button('编辑').props.onClick();assert.equal(p.pcmInput().props.value,'0');
  p.pcmInput().props.onChange({target:{value:'500'}});p.button('保存时间轴').props.onClick();await flush();
  const save=p.calls.find(c=>c.name==='director_save');assert.equal(save.args.pcmLeadMs,500);assert.equal(save.args.cues[0].lead_ms,200);
  assert.equal(p.button('加入播放歌曲槽位').props.disabled,false);
  p.button('收起详情').props.onClick();p.button('编辑').props.onClick();assert.equal(p.pcmInput().props.value,'500');
});

test('queued songs allow saving both leads while active crop/timeline edits remain locked',async()=>{
  const p=mount(true);p.render();await flush();p.button('编辑').props.onClick();
  assert.equal(p.pcmInput().props.disabled,false);assert.equal(p.textInput().props.disabled,false);
  assert.equal(p.button('截取歌词PCM').props.disabled,true);assert.equal(p.button('保存时间轴').props.disabled,true);
  p.pcmInput().props.onChange({target:{value:'500'}});p.textInput().props.onChange({target:{value:'750'}});
  p.button('保存提前量').props.onClick();await flush();
  const save=p.calls.find(c=>c.name==='director_save_timing');assert.equal(save.args.pcmLeadMs,500);assert.equal(save.args.textLeadMs,750);
  assert.equal(p.calls.filter(c=>['director_save','director_prepare_pcm'].includes(c.name)).length,0);
  assert.match(text(p.render()),/正在播放的本轮不变，下次播放生效/);
  p.button('收起详情').props.onClick();p.button('编辑').props.onClick();assert.equal(p.pcmInput().props.value,'500');assert.equal(p.textInput().props.value,'750');
});

test('invalid leads never invoke timing save or change queued audio data',async()=>{
  const p=mount(true);p.render();await flush();p.button('编辑').props.onClick();
  p.textInput().props.onChange({target:{value:'10001'}});p.button('保存提前量').props.onClick();await flush();
  assert.equal(p.calls.filter(c=>c.name==='director_save_timing').length,0);assert.match(text(p.render()),/-10000–10000/);
});

test('timeline previews PCM and OBS display intervals without transcription columns',async()=>{
  const p=mount(true);p.render();await flush();p.button('编辑').props.onClick();
  const cell=label=>nodes(p.render()).find(n=>n.tag==='td'&&n.props['aria-label']===label);
  assert.equal(text(cell('第1段PCM发送时刻')),'0:00.100');
  assert.equal(text(cell('第1段OBS显示时刻')),'0:01.600');assert.equal(text(cell('第1段OBS结束时刻')),'0:02.500');
  assert.equal(cell('第1段文字发送时刻'),undefined);
  assert.equal(nodes(p.render()).some(n=>n.tag==='th'&&['文字提前量','文字发送时刻'].includes(text(n))),false);
  p.pcmInput().props.onChange({target:{value:'50'}});
  assert.equal(text(cell('第1段PCM发送时刻')),'0:00.050');assert.equal(text(cell('第1段OBS结束时刻')),'0:02.450');
  p.textInput().props.onChange({target:{value:'0'}});
  assert.equal(text(cell('第1段PCM发送时刻')),'0:00.050');assert.equal(text(cell('第1段OBS结束时刻')),'0:00.950');
});
