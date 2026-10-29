import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const timing={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/songDirector.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:timing});
const source=ts.transpileModule(fs.readFileSync('src/songAudioBridge.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

async function setup({lead=0,send,phase,parts,forbidAudioContext=false}={}) {
  let tick;const calls=[],failures=[];const delay={delayTime:{value:0},connect:()=>{},disconnect:()=>{}};
  const context={createMediaElementSource:()=>({connect:()=>{},disconnect:()=>{}}),createDelay:()=>delay,destination:{},resume:async()=>{},close:async()=>calls.push('closed')};
  const api={};vm.runInNewContext(source,{exports:api,require:name=>{assert.equal(name,'./songDirector');return timing;},AudioContext:class{constructor(){if(forbidAudioContext)throw Error('Web Audio unavailable');calls.push('contextCreated');return context;}},setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout,clearTimeout,Int16Array});
  const segments=parts||[{index:0,start_ms:100,end_ms:205,sample_count:2520,pcm_path:'a.pcm'},{index:1,start_ms:300,end_ms:400,sample_count:2400,pcm_path:'b.pcm'}];
  const audio={paused:true,currentTime:0};const sent=[],phases=[],sentCues=[];
  const bridge=await api.createSongAudioBridge(audio,segments,async path=>{const part=segments.find(p=>p.pcm_path===path);return new Int16Array(part.sample_count).fill(path==='a.pcm'?100:200).buffer;},lead,async(samples,sequence)=>{sent.push({samples,sequence});await send?.();},error=>failures.push(error),async(active,sequence)=>{phases.push({active,sequence});await phase?.(active,sequence);},(index,sentAt)=>sentCues.push({index,sentAt}));
  const at=async ms=>{audio.currentTime=ms/1000;tick();await flush();};
  return {audio,bridge,sent,phases,sentCues,failures,delay,calls,at};
}

test('lyric cue notices wait for the first PCM write, include overlapping cues once and reject late cancelled writes',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const p=await setup({send:()=>gate,parts:[{index:0,start_ms:100,end_ms:200,sample_count:2400,pcm_path:'a.pcm'},{index:1,start_ms:110,end_ms:200,sample_count:2160,pcm_path:'b.pcm'}]});
  try{
    p.audio.paused=false;await p.bridge.resume();await p.at(100);assert.equal(p.sentCues.length,0);
    const before=Date.now();release();await flush();
    assert.deepEqual(p.sentCues.map(c=>c.index),[0,1]);assert.ok(p.sentCues.every(c=>c.sentAt>=before));
    for(let ms=120;ms<=200;ms+=20)await p.at(ms);assert.equal(p.sentCues.length,2);
  }finally{release();p.bridge.dispose();}
  let unblock;const wait=new Promise(resolve=>{unblock=resolve;});const q=await setup({send:()=>wait});
  q.audio.paused=false;await q.bridge.resume();await q.at(100);q.bridge.dispose();unblock();await flush();assert.equal(q.sentCues.length,0);
});

test('prepared PCM sends only lyric frames and releases the channel across the interlude',async()=>{
  const p=await setup();try {
    p.audio.paused=false;await p.bridge.resume();await flush();assert.equal(p.sent.length,0);
    for(let ms=20;ms<=400;ms+=20)await p.at(ms);
    const all=p.sent.flatMap(x=>x.samples);
    assert.ok(all.slice(0,2520).every(x=>x===100));
    assert.ok(all.slice(2520,2880).every(x=>x===0));
    assert.ok(all.slice(2880).every(x=>x===200));assert.equal(all.length,5280);
    assert.deepEqual(p.phases.map(x=>x.active),[false,true,false,true,false]);
    assert.deepEqual(p.phases.map(x=>x.sequence),[0,0,6,6,11]);
    assert.equal(p.sent[0].samples.length,480);assert.deepEqual(p.sent.map(x=>x.sequence),p.sent.map((_,i)=>i));assert.deepEqual(p.failures,[]);
  } finally {p.bridge.dispose();}
});

test('zero lead leaves original-song audio on native media playback and needs no Web Audio context',async()=>{
  const p=await setup({forbidAudioContext:true});try {
    p.audio.paused=false;await p.bridge.resume();await p.at(100);
    assert.ok(p.sent.length>0);assert.equal(p.audio.paused,false);assert.equal(p.calls.includes('contextCreated'),false);
    assert.deepEqual(p.failures,[]);
  } finally {p.bridge.dispose();}
});

test('PCM lead 500ms sends at 0.5 seconds for a 1-second lyric without changing local playback',async()=>{
  const p=await setup({lead:500,forbidAudioContext:true,parts:[{index:0,start_ms:1000,end_ms:1100,sample_count:2400,pcm_path:'a.pcm'}]});
  try {
    p.audio.paused=false;await p.bridge.resume();await p.at(499);assert.equal(p.sent.length,0);
    await p.at(500);assert.ok(p.sent[0].samples.every(x=>x===100));assert.equal(p.audio.currentTime,.5);assert.equal(p.audio.paused,false);
    for(let ms=520;ms<=600;ms+=20)await p.at(ms);
    assert.equal(p.sent.flatMap(x=>x.samples).filter(x=>x===100).length,2400);
    assert.equal(p.calls.includes('contextCreated'),false);
    p.audio.currentTime=1.1;p.audio.paused=true;let drained=false;void p.bridge.drain().then(()=>{drained=true;});await flush();assert.equal(drained,true);
  } finally {p.bridge.dispose();}
});

test('early clamped lyric pieces stay complete and ordered while the local song starts normally',async()=>{
  const p=await setup({lead:500,forbidAudioContext:true});try{
    p.audio.paused=false;await p.bridge.resume();await flush();
    for(let ms=20;ms<=220;ms+=20)await p.at(ms);
    const all=p.sent.flatMap(x=>x.samples);
    assert.ok(all.slice(0,2520).every(x=>x===100));assert.ok(all.slice(2520,4920).every(x=>x===200));
    assert.equal(all.filter(x=>x===100).length,2520);assert.equal(all.filter(x=>x===200).length,2400);
    assert.equal(p.audio.currentTime,.22);assert.equal(p.calls.includes('contextCreated'),false);assert.deepEqual(p.failures,[]);
  }finally{p.bridge.dispose();}
});

test('sending vocals early reserves the song channel until the corresponding accompaniment phrase ends',async()=>{
  const p=await setup({lead:500,parts:[{index:0,start_ms:1000,end_ms:1100,sample_count:2400,pcm_path:'a.pcm'}]});
  try{
    p.audio.paused=false;await p.bridge.resume();
    for(let ms=20;ms<=600;ms+=20)await p.at(ms);
    assert.equal(p.sent.length,6);assert.equal(p.phases.at(-1).active,true);
    for(let ms=620;ms<=1080;ms+=20)await p.at(ms);
    assert.equal(p.sent.length,30);assert.equal(p.phases.at(-1).active,true);
    assert.ok(p.sent.slice(5).every(frame=>frame.samples.every(sample=>sample===0)));
    assert.deepEqual(p.sentCues.map(cue=>cue.index),[0]);
    await p.at(1100);assert.equal(p.phases.at(-1).active,false);
  }finally{p.bridge.dispose();}
});

test('reserved short gaps stream silence for phrase tails, then a released interlude stops frames',async()=>{
  const p=await setup({lead:500,parts:[
    {index:0,start_ms:1000,end_ms:1100,sample_count:2400,pcm_path:'a.pcm'},
    {index:1,start_ms:1400,end_ms:1500,sample_count:2400,pcm_path:'b.pcm'},
    {index:2,start_ms:2500,end_ms:2600,sample_count:2400,pcm_path:'c.pcm'},
  ]});
  try{
    p.audio.paused=false;await p.bridge.resume();
    for(let ms=20;ms<=1500;ms+=20)await p.at(ms);
    assert.equal(p.sent.length,50);
    assert.ok(p.sent.slice(5,20).every(frame=>frame.samples.every(sample=>sample===0)));
    assert.deepEqual(p.sentCues.map(cue=>cue.index),[0,1]);
    assert.equal(p.phases.at(-1).active,false);
    for(let ms=1520;ms<=1980;ms+=20)await p.at(ms);
    assert.equal(p.sent.length,50);
    await p.at(2000);assert.equal(p.sent.length,51);
    assert.deepEqual(p.sentCues.map(cue=>cue.index),[0,1,2]);
    assert.deepEqual(p.failures,[]);
  }finally{p.bridge.dispose();}
});

test('pause and disposal stop PCM, and a slow sender cannot accumulate more than half a second',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const p=await setup({send:()=>pending,parts:[{index:0,start_ms:0,end_ms:2000,sample_count:48000,pcm_path:'a.pcm'}]});
  try {
    p.audio.paused=false;await p.bridge.resume();
    p.audio.paused=true;await p.at(200);assert.equal(p.sent.length,1);
    p.audio.paused=false;
    for(let ms=20;ms<=600;ms+=20)await p.at(ms);
    assert.match(p.failures[0],/500毫秒/);const count=p.sent.length;release();await flush();await p.at(1000);assert.equal(p.sent.length,count);
  } finally {release();p.bridge.dispose();}
});

test('first lyric frame waits for native priority switching, and disposal rejects late continuation',async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const p=await setup({phase:active=>active?wait:Promise.resolve()});
  try{
    p.audio.paused=false;await p.bridge.resume();await p.at(100);
    assert.equal(p.phases.at(-1).active,true);assert.equal(p.sent.length,0);
    release();await flush();assert.equal(p.sent.length,1);assert.ok(p.sent[0].samples.every(s=>s===100));
  }finally{release();p.bridge.dispose();}
  let unblock;const blocked=new Promise(resolve=>{unblock=resolve;});
  const q=await setup({phase:active=>active?blocked:Promise.resolve()});
  q.audio.paused=false;await q.bridge.resume();await q.at(100);q.bridge.dispose();unblock();await flush();assert.equal(q.sent.length,0);
});
