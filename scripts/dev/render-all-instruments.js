(async()=>{
const [{WebAudioEngine},{createEmptyProject,createTrack},{INSTRUMENTS}]=await Promise.all([import('/src/audio/WebAudioEngine.ts'),import('/src/core/project.ts'),import('/src/core/instruments.ts')]);
const ids=INSTRUMENTS.map(i=>i.id);const p=createEmptyProject();p.bpm=120;p.lengthBeats=ids.length*2;p.loop.enabled=false;
let beat=0;for(const id of ids){const def=INSTRUMENTS.find(i=>i.id===id);const t=createTrack('instrument',id);t.name=id;const pitch=def.isKit?38:id==='bass'?48:id==='daegeum'?74:id==='haegeum'?68:60;
t.clips.push({id:'c'+id,kind:'midi',name:id,startBeat:beat,lengthBeats:2,gain:1,notes:[{id:'n'+id,pitch,start:0,duration:1,velocity:.9}]});p.tracks.push(t);beat+=2}
const e=new WebAudioEngine(p);const t0=performance.now();
const sampled=INSTRUMENTS.filter(i=>i.set).map(i=>i.set);const status={};
for(const s of sampled){try{await e.preloadSamples(s);status[s]=e.sampleStatus(s)}catch(err){status[s]='ERR '+err}}
const tLoad=performance.now()-t0;
const blob=await e.exportWav(p);const buf=await blob.arrayBuffer();const ctx=new OfflineAudioContext(2,48000,48000);const a=await ctx.decodeAudioData(buf.slice(0));
const L=a.getChannelData(0),sr=a.sampleRate;const spb=60/120;const rows=[];
ids.forEach((id,i)=>{const s0=Math.floor(i*2*spb*sr),s1=Math.floor((i*2+1.5)*spb*sr);let pk=0,sum=0;for(let k=s0;k<s1;k++){const v=Math.abs(L[k]);pk=Math.max(pk,v);sum+=v*v}const rms=Math.sqrt(sum/(s1-s0));rows.push(id.padEnd(13)+' peak '+(20*Math.log10(pk||1e-9)).toFixed(1).padStart(6)+' dB  rms '+(20*Math.log10(rms||1e-9)).toFixed(1).padStart(6)+' dB')});
return 'load '+tLoad.toFixed(0)+'ms '+JSON.stringify(status)+'\nwav '+a.duration.toFixed(1)+'s ch'+a.numberOfChannels+'\n'+rows.join('\n')})()
