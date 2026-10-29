import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(fs.readFileSync('src/songAudioBridge.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

async function setup({lead=0,send,parts,forbidAudioContext=false}={}) {
  let tick;const calls=[],failures=[];const delay={delayTime:{value:0},connect:()=>{},disconnect:()=>{}};
  const context={createMediaElementSource:()=>({connect:()=>{},disconnect:()=>{}}),createDelay:()=>delay,destination:{},resume:async()=>{},close:async()=>calls.push('closed')};
  const api={};vm.runInNewContext(source,{exports:api,AudioContext:class{constructor(){if(forbidAudioContext)throw Error('Web Audio unavailable');calls.push('contextCreated');return context;}},setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout,clearTimeout,Int16Array});
  const segments=parts||[{index:0,start_ms:100,end_ms:205,sample_count:2520,pcm_path:'a.pcm'},{index:1,start_ms:300,end_ms:400,sample_count:2400,pcm_path:'b.pcm'}];
  const audio={paused:true,currentTime:0};const sent=[];
  const bridge=await api.createSongAudioBridge(audio,segments,async path=>{const part=segments.find(p=>p.pcm_path===path);return new Int16Array(part.sample_count).fill(path==='a.pcm'?100:200).buffer;},lead,async(samples,sequence)=>{sent.push({samples,sequence});await send?.();},error=>failures.push(error));
  const at=async ms=>{audio.currentTime=ms/1000;tick();await flush();};
  return {audio,bridge,sent,failures,delay,calls,at};
}

test('prepared PCM uses exact lyric boundaries and sends silence across the interlude',async()=>{
  const p=await setup();try {
    p.audio.paused=false;await p.bridge.resume();
    for(let ms=20;ms<=400;ms+=20)await p.at(ms);
    const all=p.sent.flatMap(x=>x.samples);
    assert.ok(all.slice(0,2400).every(x=>x===0));
    assert.ok(all.slice(2400,4920).every(x=>x===100));
    assert.ok(all.slice(4920,7200).every(x=>x===0));
    assert.ok(all.slice(7200,9600).every(x=>x===200));
    assert.ok(all.slice(9600).every(x=>x===0));
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

test('PCM lead 500ms delays local sound and drains its tail without dropping the first lyric samples',async()=>{
  const p=await setup({lead:500,parts:[{index:0,start_ms:0,end_ms:100,sample_count:2400,pcm_path:'a.pcm'}]});
  try {
    assert.equal(p.delay.delayTime.value,.5);p.audio.paused=false;await p.bridge.resume();await flush();
    assert.ok(p.sent[0].samples.every(x=>x===100));
    for(let ms=20;ms<=80;ms+=20)await p.at(ms);
    p.audio.currentTime=.1;p.audio.paused=true;
    let drained=false;const end=p.bridge.drain().then(()=>{drained=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(drained,false);
    await end;assert.equal(drained,true);assert.equal(p.sent.flatMap(x=>x.samples).filter(x=>x===100).length,2400);
  } finally {p.bridge.dispose();}
});

test('pause and disposal stop PCM, and a slow sender cannot accumulate more than half a second',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const p=await setup({send:()=>pending});
  try {
    p.audio.paused=false;await p.bridge.resume();
    p.audio.paused=true;await p.at(200);assert.equal(p.sent.length,1);
    p.audio.paused=false;
    for(let ms=20;ms<=600;ms+=20)await p.at(ms);
    assert.match(p.failures[0],/500毫秒/);const count=p.sent.length;release();await flush();await p.at(1000);assert.equal(p.sent.length,count);
  } finally {release();p.bridge.dispose();}
});
