/** Isolated comparison harness. No library implementation is copied or bundled into the app. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, version as esbuildVersion } from 'esbuild';
import { fixtures } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const EPSILON = 1e-12;
const nodeFsIsUnused = { name: 'omit-unused-node-fs-import', setup(b) { b.onResolve({ filter: /^(node:)?fs$/ }, ({ path }) => ({ path, external: true, sideEffects: false })); } };
const scribbleEntry = "import {clip} from 'scribbletune'; export {clip};";
const strudelEntry = "import {mini} from '@strudel/mini'; import {useRNG} from '@strudel/core'; useRNG('precise'); export {mini};";
const sort = (events) => events.sort((a,b)=>a.start-b.start || a.pitch-b.pitch || a.duration-b.duration || a.velocity-b.velocity);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function scientificPitch(text) {
  const m = /^([a-g])([#b]?)(-?\d+)$/i.exec(String(text));
  if (!m) throw new Error(`Unsupported pitch ${text}`);
  const pitch = (Number(m[3])+1)*12 + {c:0,d:2,e:4,f:5,g:7,a:9,b:11}[m[1].toLowerCase()] + (m[2]==='#'?1:m[2]==='b'?-1:0);
  if (!Number.isInteger(pitch) || pitch<0 || pitch>127) throw new Error(`Out-of-range pitch ${text}`);
  return pitch;
}
const dawPitchName = midi => `${['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi%12]}${Math.floor(midi/12)-2}`;
function crop(events, window) {
  if (!window) return sort(events);
  const [a,b]=window;
  return sort(events.flatMap(e=>{const start=Math.max(e.start,a),end=Math.min(e.start+e.duration,b);return end>start+EPSILON?[{...e,start,duration:end-start}]:[]}));
}
function normalizeScribble(raw, window) {
  let cursor=0;const events=[];
  for(const entry of raw){
    const duration=entry.length/128;
    if (!Number.isFinite(duration) || duration<=0) throw new Error('Invalid duration');
    for(const name of entry.note??[]) events.push({pitch:scientificPitch(name),start:cursor,duration,velocity:entry.level/127});
    cursor+=duration;
  }
  return {events:crop(events,window),length:window?window[1]-window[0]:cursor};
}
function normalizeStrudel(pattern, start, end, window) {
  const raw=pattern.queryArc(start/4,end/4), events=[];
  for(const entry of raw){
    if(!entry.whole) throw new Error('Continuous event outside the discrete POC profile');
    // queryArc can split one long note into cycle fragments. Keep its onset, or
    // its first carry-in fragment when the query begins inside the note.
    if (!entry.hasOnset() && Math.abs(Number(entry.part.begin)*4-start)>EPSILON) continue;
    const begin=Number(entry.whole.begin)*4, finish=Number(entry.whole.end)*4;
    events.push({pitch:scientificPitch(entry.value.note),start:begin,duration:finish-begin,velocity:entry.value.velocity});
  }
  return {events:crop(events,window),length:window?window[1]-window[0]:end-start};
}
function compare(actual, fixture){
  const expected=sort(fixture.expected.map(e=>({...e}))), got=actual.events;
  const length=fixture.window?fixture.window[1]-fixture.window[0]:fixture.length;
  let maxTimeError=Math.abs(actual.length-length),maxVelocityError=0,pitchMatches=got.length===expected.length;
  const differences=[];
  for(let i=0;i<Math.min(got.length,expected.length);i++){
    const a=got[i],b=expected[i];
    const timeError=Math.max(Math.abs(a.start-b.start),Math.abs(a.duration-b.duration));
    maxTimeError=Math.max(maxTimeError,timeError);maxVelocityError=Math.max(maxVelocityError,Math.abs(a.velocity-b.velocity));
    pitchMatches&&=a.pitch===b.pitch;
    if(timeError>EPSILON || a.pitch!==b.pitch || Math.abs(a.velocity-b.velocity)>EPSILON) differences.push({index:i,expected:b,actual:a});
  }
  return {pass:pitchMatches&&maxTimeError<=EPSILON&&maxVelocityError<=EPSILON,eventCount:got.length,expectedCount:expected.length,lengthBeats:actual.length,expectedLengthBeats:length,maxTimeErrorBeats:maxTimeError,maxVelocityError,differences:differences.slice(0,4)};
}
function workerLikeContext(){
  const calls={audioConstructors:0,timers:0,network:0};const messages=[];
  function forbiddenAudio(){calls.audioConstructors++;throw new Error('Unexpected audio engine construction');}
  function forbiddenTimer(){calls.timers++;throw new Error('Unexpected scheduled timer');}
  const context=vm.createContext({console:{log:(...x)=>messages.push(x.join(' ')),warn:(...x)=>messages.push(x.join(' ')),error:(...x)=>messages.push(x.join(' '))},performance:{now:()=>0},AudioContext:forbiddenAudio,webkitAudioContext:forbiddenAudio,AudioWorkletNode:forbiddenAudio,setTimeout:forbiddenTimer,setInterval:forbiddenTimer,requestAnimationFrame:forbiddenTimer,clearTimeout(){},clearInterval(){},fetch(){calls.network++;throw new Error('Unexpected network request');}});
  return {context,calls,messages};
}
async function browserBundle(name, contents, {external=[],plugins=[]}={}){
  try {
    const r=await build({stdin:{contents,resolveDir:here,sourcefile:name+'.mjs'},bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'PocCandidate',write:false,metafile:true,minify:true,external,plugins,logLevel:'silent'});
    const output=Object.values(r.metafile.outputs)[0];
    const retained=Object.entries(output.inputs).filter(([,v])=>v.bytesInOutput>0);
    const evidence={build:true,bytes:r.outputFiles[0].contents.length,imports:output.imports,kabelsalatBytes:retained.filter(([p])=>p.includes('@kabelsalat')).reduce((sum,[,v])=>sum+v.bytesInOutput,0),tonePackageBytes:retained.filter(([p])=>/\/tone\//.test(p)).reduce((sum,[,v])=>sum+v.bytesInOutput,0)};
    if(output.imports.length) return {evidence:{...evidence,workerLikeExecution:'not-run-external-imports'}};
    const runtime=workerLikeContext();
    try { vm.runInContext(r.outputFiles[0].text,runtime.context,{timeout:2000,filename:name+'.js'});return {evidence:{...evidence,workerLikeExecution:'pass',startupCalls:{...runtime.calls},startupMessages:runtime.messages},runtime,api:runtime.context.PocCandidate}; }
    catch(error){return {evidence:{...evidence,workerLikeExecution:'fail',error:error.message}};}
  }catch(error){return {evidence:{build:false,errors:error.errors?.map(e=>e.text)??[error.message]}};}
}
const baselineScribble=await browserBundle('scribble-default',scribbleEntry);
const externalScribble=await browserBundle('scribble-external-fs',scribbleEntry,{external:['fs','node:fs']});
const browserScribble=await browserBundle('scribble-browser',"import {clip} from 'scribbletune/browser'; export {clip};",{plugins:[nodeFsIsUnused]});
if(browserScribble.api){try{browserScribble.api.clip({notes:'C4',pattern:'x'});browserScribble.evidence.clipCall='pass';}catch(e){browserScribble.evidence.clipCall='fail';browserScribble.evidence.clipError=e.message;}}
const scribble=await browserBundle('scribble-pure-core',scribbleEntry,{plugins:[nodeFsIsUnused]});
const strudel=await browserBundle('strudel-core-mini',strudelEntry);
assert(scribble.api&&strudel.api,'Pattern compiler bundle did not execute');
const results=[];
for(const fixture of fixtures){
  const params={...fixture.scribble,amp:fixture.amp??100,pattern:fixture.scribble.pattern.repeat(fixture.repeats??1)};
  const s=normalizeScribble(scribble.api.clip(params),fixture.window);
  const p=strudel.api.mini(fixture.strudel).note().velocity((fixture.amp??100)/127);
  const [start,end]=fixture.window??[0,fixture.length];
  const t=normalizeStrudel(p,start,end,fixture.window);
  results.push({id:fixture.id,category:fixture.category,source:{scribble:params,strudel:fixture.strudel},scribble:compare(s,fixture),strudel:compare(t,fixture)});
}
for(const baseId of ['triplet','nested-triplet']){
const tripletBase=fixtures.find(f=>f.id===baseId);
for(const bars of [8,16,32]){
  const fixture={...tripletBase,id:`${baseId}-${bars}-bars`,category:'long triplet arrangement',length:4*bars,repeats:bars,expected:Array.from({length:bars},(_,i)=>tripletBase.expected.map(e=>({...e,start:e.start+4*i}))).flat()};
  const s=normalizeScribble(scribble.api.clip({...fixture.scribble,amp:100,pattern:fixture.scribble.pattern.repeat(bars)}));
  const t=normalizeStrudel(strudel.api.mini(fixture.strudel).note().velocity(100/127),0,fixture.length);
  results.push({id:fixture.id,category:fixture.category,source:{scribble:{...fixture.scribble,repeat:bars},strudel:fixture.strudel},scribble:compare(s,fixture),strudel:compare(t,fixture)});
}
}
// Math.random is replaced only inside this isolated test VM to prove that an unknown seed argument does not control the output.
const randomParams={notes:'C4',pattern:'RRRR',randomNotes:['C4','G4'],subdiv:'4n',seed:42};
vm.runInContext('Math.random=()=>0.1',scribble.runtime.context);
const randomA=normalizeScribble(scribble.api.clip(randomParams));
vm.runInContext('Math.random=()=>0.9',scribble.runtime.context);
const randomB=normalizeScribble(scribble.api.clip(randomParams));
const randomPattern=(seed)=>strudel.api.mini('[c4|d4|e4|g4]*8').note().velocity(100/127).seed(seed);
const randomFull=normalizeStrudel(randomPattern(42),0,128);
const randomRepeat=normalizeStrudel(randomPattern(42),0,128);
const randomOther=normalizeStrudel(randomPattern(43),0,128);
const randomWindow=normalizeStrudel(randomPattern(42),32,64,[32,64]);
const randomExpectedWindow={events:crop(randomFull.events,[32,64]),length:32};
const randomness={scribble:{nativeSeed:'unsupported',sameSeedDependsOnMathRandom:digest(randomA)!==digest(randomB),firstSequence:randomA.events.map(e=>e.pitch),secondSequence:randomB.events.map(e=>e.pitch)},strudel:{rng:'precise',seed:42,repeatSameSeed:digest(randomFull)===digest(randomRepeat),differentSeedChangesResult:digest(randomFull)!==digest(randomOther),finiteWindowMatchesFull:digest(randomWindow)===digest(randomExpectedWindow),events:randomFull.events.length,hash:digest(randomFull)}};
const nativeNodeProbe=spawnSync(process.execPath,['--input-type=module','-e',"import {mini} from '@strudel/mini'; console.log(mini('c4').queryArc(0,1).length)"],{cwd:here,encoding:'utf8'});
const nodeEntry={strudel:{pass:nativeNodeProbe.status===0,error:nativeNodeProbe.status?nativeNodeProbe.stderr.split('\n').find(line=>line.includes('SyntaxError:'))??nativeNodeProbe.stderr.slice(0,300):null}};
const packageJson=async name=>JSON.parse(await readFile(require.resolve(name+'/package.json'),'utf8'));
const versions={node:process.version,esbuild:esbuildVersion,scribbletune:JSON.parse(await readFile(join(dirname(require.resolve('scribbletune')),'../package.json'),'utf8')).version,strudelCore:(await packageJson('@strudel/core')).version,strudelMini:(await packageJson('@strudel/mini')).version};
const failed=lib=>results.filter(r=>!r[lib].pass).map(r=>r.id);
// These are observation checks, not assertions that both libraries satisfy every adoption gate.
assert.deepEqual(failed('scribble'),['triplet','nested-triplet','native-one-measure','triplet-8-bars','triplet-16-bars','triplet-32-bars','nested-triplet-8-bars','nested-triplet-16-bars','nested-triplet-32-bars']);
assert.deepEqual(failed('strudel'),[]);
assert(randomness.scribble.sameSeedDependsOnMathRandom);
assert(randomness.strudel.repeatSameSeed&&randomness.strudel.differentSeedChangesResult&&randomness.strudel.finiteWindowMatchesFull);
assert.equal(scientificPitch('C4'),60);assert.equal(dawPitchName(60),'C3');
assert.equal(scribble.runtime.calls.audioConstructors+strudel.runtime.calls.audioConstructors,0);
assert.equal(scribble.runtime.calls.timers+strudel.runtime.calls.timers,0);
assert.equal(scribble.runtime.calls.network+strudel.runtime.calls.network,0);
const report={schemaVersion:1,generatedAt:new Date().toISOString(),versions,method:{meter:'4/4',cycleBeats:4,quarterLengthInScribble:128,pitch:'scientific C4=60; DAW display C3=60',velocity:'Scribble amp/127; Strudel velocity assigned the same normalized value',windowPolicy:'Intersect whole note intervals with [startBeat,endBeat), keep absolute beat positions; this is an adapter policy, not a claim of identical native window APIs.',epsilon:EPSILON,runtime:'esbuild browser IIFE in a worker-like node:vm context; not a real browser, audio playback, or security sandbox validation',randomTest:'Scribble unknown seed property is tested with controlled Math.random in the isolated VM; this override is not a proposed production design.'},summary:{fixtures:results.length,scribbleExactPass:results.filter(r=>r.scribble.pass).length,strudelExactPass:results.filter(r=>r.strudel.pass).length,scribbleFailed:failed('scribble'),strudelFailed:failed('strudel')},bundles:{scribbleDefault:baselineScribble.evidence,scribbleExternalFs:externalScribble.evidence,scribbleBrowser:browserScribble.evidence,scribblePureCore:scribble.evidence,strudelCoreMini:strudel.evidence},runtimeCalls:{scribble:scribble.runtime.calls,strudel:strudel.runtime.calls},nodeEntry,pitchBoundary:{source:'C4',midi:60,daw:'C3'},randomness,results};
await writeFile(join(here,'results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary:report.summary,bundles:report.bundles,randomness,nodeEntry},null,2));
