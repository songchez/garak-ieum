#include "garak/engine.hpp"
#include "garak/dsp.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <iomanip>
#include <limits>
#include <new>
#include <optional>
#include <stdexcept>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#if defined(_WIN32)
#include <malloc.h>
#define GARAK_NOINLINE __declspec(noinline)
#else
#define GARAK_NOINLINE __attribute__((noinline))
#endif

namespace {
thread_local bool watchAllocations=false;
thread_local std::size_t allocations=0,deallocations=0;
// Engine worker threads watch themselves for their whole loop (onWorkerThread).
thread_local bool watchWorker=false;
std::atomic<std::size_t> workerHeapOperations{0};
void countWorker()noexcept{if(watchWorker)workerHeapOperations.fetch_add(1,std::memory_order_relaxed);}
void check(bool condition,const char*message){if(!condition)throw std::runtime_error(message);}
void near(double a,double b,double tolerance,const char*message){if(!std::isfinite(a)||!std::isfinite(b)||std::abs(a-b)>tolerance){std::ostringstream detail;detail<<message<<" (actual "<<std::setprecision(17)<<a<<", expected "<<b<<", tolerance "<<tolerance<<")";throw std::runtime_error(detail.str());}}
template<class F>void rejects(F&&fn,const char*message){try{fn();}catch(const std::exception&){return;}throw std::runtime_error(message);}
}
// Cover nothrow and over-aligned forms as well: SPSC queues themselves are
// cache-line aligned, and std::stable_sort uses the nothrow allocation form.
GARAK_NOINLINE void*operator new(std::size_t size){if(watchAllocations)++allocations;countWorker();if(void*p=std::malloc(size?size:1))return p;throw std::bad_alloc();}
GARAK_NOINLINE void*operator new[](std::size_t size){return ::operator new(size);}
GARAK_NOINLINE void*operator new(std::size_t size,const std::nothrow_t&)noexcept{try{return ::operator new(size);}catch(...){return nullptr;}}
GARAK_NOINLINE void*operator new[](std::size_t size,const std::nothrow_t&n)noexcept{return ::operator new(size,n);}
GARAK_NOINLINE void operator delete(void*p)noexcept{if(watchAllocations&&p)++deallocations;if(p)countWorker();std::free(p);}
GARAK_NOINLINE void operator delete[](void*p)noexcept{::operator delete(p);}
GARAK_NOINLINE void operator delete(void*p,std::size_t)noexcept{::operator delete(p);}
GARAK_NOINLINE void operator delete[](void*p,std::size_t)noexcept{::operator delete(p);}
GARAK_NOINLINE void operator delete(void*p,const std::nothrow_t&)noexcept{::operator delete(p);}
GARAK_NOINLINE void operator delete[](void*p,const std::nothrow_t&)noexcept{::operator delete(p);}
GARAK_NOINLINE void*operator new(std::size_t size,std::align_val_t alignment){
  if(watchAllocations)++allocations;
  countWorker();
  const auto a=static_cast<std::size_t>(alignment);
  if(size>std::numeric_limits<std::size_t>::max()-a)throw std::bad_alloc();
#if defined(_WIN32)
  void*p=_aligned_malloc(size?size:1,a);
#else
  void*p=std::aligned_alloc(a,((size?size:1)+a-1)/a*a);
#endif
  if(!p)throw std::bad_alloc();
  return p;
}
GARAK_NOINLINE void*operator new[](std::size_t size,std::align_val_t a){return ::operator new(size,a);}
GARAK_NOINLINE void*operator new(std::size_t size,std::align_val_t a,const std::nothrow_t&)noexcept{try{return ::operator new(size,a);}catch(...){return nullptr;}}
GARAK_NOINLINE void*operator new[](std::size_t size,std::align_val_t a,const std::nothrow_t&n)noexcept{return ::operator new(size,a,n);}
GARAK_NOINLINE void operator delete(void*p,std::align_val_t)noexcept{
  if(watchAllocations&&p)++deallocations;
  if(p)countWorker();
#if defined(_WIN32)
  _aligned_free(p);
#else
  std::free(p);
#endif
}
GARAK_NOINLINE void operator delete[](void*p,std::align_val_t a)noexcept{::operator delete(p,a);}
GARAK_NOINLINE void operator delete(void*p,std::size_t,std::align_val_t a)noexcept{::operator delete(p,a);}
GARAK_NOINLINE void operator delete[](void*p,std::size_t,std::align_val_t a)noexcept{::operator delete(p,a);}
GARAK_NOINLINE void operator delete(void*p,std::align_val_t a,const std::nothrow_t&)noexcept{::operator delete(p,a);}
GARAK_NOINLINE void operator delete[](void*p,std::align_val_t a,const std::nothrow_t&)noexcept{::operator delete(p,a);}

namespace {
using namespace garak;
ProjectTimeline project(std::uint32_t rate=48000,std::int64_t frames=48000){ProjectTimeline p;p.projectId="test";p.sampleRate=rate;p.lengthFrames=frames;return p;}
TrackTimeline synthTrack(const std::string&id="keys"){TrackTimeline t;t.id="track";t.source.kind=TrackSource::Kind::BuiltinSynth;t.source.instrumentId=id;t.source.isKit=id=="drums";return t;}
std::shared_ptr<const PcmAsset> asset(std::string id,std::uint32_t rate,std::vector<float> samples,std::uint32_t channels=1){auto a=std::make_shared<PcmAsset>();a->id=std::move(id);a->sampleRate=rate;a->channels=channels;a->samples=std::move(samples);return a;}
void rt(RenderEngine&e,float*out,const float*in,std::uint32_t frames,std::uint32_t channels=2){allocations=deallocations=0;watchAllocations=true;e.render(out,in,frames,channels);watchAllocations=false;check(!allocations&&!deallocations,"Audio callback allocated or destroyed heap storage");}
std::vector<float> render(RenderEngine&e,std::uint32_t frames,std::uint32_t block=128){std::vector<float>out(static_cast<std::size_t>(frames)*2);for(std::uint32_t at=0;at<frames;at+=block)rt(e,out.data()+at*2,nullptr,std::min(block,frames-at));return out;}
double energy(const std::vector<float>&data){double result=0;for(auto v:data){check(std::isfinite(v),"Non-finite rendered PCM");result+=v*v;}return result;}
void checkSame(const std::vector<float>&a,const std::vector<float>&b,double tolerance,const char*message){check(a.size()==b.size(),"Different rendered lengths");for(std::size_t i=0;i<a.size();++i)near(a[i],b[i],tolerance,message);}

void synthsAndBlockIndependence(){
  for(const auto*id:{"keys","bass","pad","pluck","rhodes","drums"}){
    auto p=project();auto t=synthTrack(id);t.source.params["level"]=.25;t.notes.push_back({1,37,4000,48000,id==std::string("drums")?38:60,.8f});p.tracks.push_back(t);
    RenderEngine a(48000,512),b(48000,512);a.submit(a.prepare(p,{}));b.submit(b.prepare(p,{}));check(a.play()&&b.play(),"Play queue failed");
    const auto x=render(a,12000,31),y=render(b,12000,257);check(energy(x)>.01,"A built-in instrument rendered silence");checkSame(x,y,1e-6,"Synthesis changes with callback block size");
    for(int i=0;i<37*2;++i)near(x[i],0,0,"A timeline note played before its exact onset");
    check(a.snapshot().voiceOverflows==0,"Unexpected voice exhaustion");
  }
}

void audioWindowsAndLoop(){
  auto p=project(48000,1000);TrackTimeline t;t.id="audio";
  t.audio.push_back({1,"ramp",11,411,100,24000,0,400,.4f,0,0});p.tracks.push_back(t);
  std::vector<float>pcm(1000);for(std::size_t i=0;i<pcm.size();++i)pcm[i]=static_cast<float>(i)/10000;
  AssetStore assets{{"ramp",asset("ramp",24000,std::move(pcm))}};
  RenderEngine engine(48000,127);engine.submit(engine.prepare(p,assets));check(engine.play(),"Play failed");const auto out=render(engine,600,77);
  for(std::size_t i=0;i<22;++i)near(out[i],0,0,"Audio started early");
  // 200 frames into this region is outside the four-ms click ramp. Source rate
  // is half the project rate, so this samples source frame 200 exactly.
  near(out[(11+200)*2],.02*.4/std::sqrt(2.0),1e-7,"Trimmed/resampled source frame is incorrect");
  for(std::size_t i=411*2;i<out.size();++i)near(out[i],0,0,"Audio window leaked after its exclusive endpoint");

  auto loop=project(48000,1000);auto keys=synthTrack();keys.source.params["level"]=.1;keys.notes.push_back({1,30,80,100,60,1});loop.tracks.push_back(keys);loop.cycle=std::array<std::int64_t,2>{20,100};
  RenderEngine cycle(48000,64);cycle.submit(cycle.prepare(loop,{}));check(cycle.play(),"Play failed");(void)render(cycle,100,64);check(cycle.snapshot().frame==20,"Exact loop boundary was not normalized");
  (void)render(cycle,80,64);check(cycle.snapshot().frame==20,"Loop length drifted across callback boundaries");
  check(cycle.seek(100),"Seek failed");std::array<float,2>frame{};rt(cycle,frame.data(),nullptr,0);check(cycle.snapshot().frame==20,"Seek at loop end did not honor cycle");
  RenderEngine offline(48000,64);offline.setOffline(true);offline.submit(offline.prepare(loop,{}));check(offline.play(),"Play failed");(void)render(offline,180);check(offline.snapshot().frame==180,"Offline rendering incorrectly followed audition cycle");
}

void regionGainFadesAndCrossfade(){
  // Region gain (+24 dB range), curved fades and an overlap crossfade, mirroring src/core/clipEnvelope.ts.
  near(fadeShape(0,.25),.25,1e-12,"Linear fade shape");near(fadeShape(1,.5),std::sin(3.14159265358979323846/4),1e-12,"Equal-power fade shape");
  near(fadeShape(2,.25),(1-std::cos(3.14159265358979323846/4))/2,1e-12,"S-curve fade shape");near(fadeShape(3,.5),.25,1e-12,"Exponential fade shape");near(fadeShape(4,.5),.75,1e-12,"Logarithmic fade shape");
  near(fadeShape(1,-1),0,0,"Fade shape below range");near(fadeShape(2,2),1,0,"Fade shape above range");
  const double center=1/std::sqrt(2.0),pi=3.14159265358979323846;
  auto p=project(48000,48000);TrackTimeline t;t.id="audio";
  AudioWindow w{1,"dc",0,48000,0,48000,0,48000,4.f,4800,9600};w.fadeInCurve=1;w.fadeOutCurve=2;t.audio.push_back(w);p.tracks.push_back(t);
  AssetStore assets{{"dc",asset("dc",48000,std::vector<float>(48000,.125f))}};
  RenderEngine engine(48000,256);engine.submit(engine.prepare(p,assets));check(engine.play(),"Play failed");const auto out=render(engine,48000,113);
  near(out[2400*2],.125*4*std::sin(pi/4)*center,1e-6,"Equal-power fade-in midpoint");
  near(out[24000*2],.125*4*center,1e-6,"Region gain above unity (+12 dB)");
  near(out[(48000-2400)*2],.125*4*(1-std::cos(pi/4))/2*center,1e-6,"S-curve fade-out quarter point");
  auto bad=p;bad.tracks[0].audio[0].fadeInCurve=7;bool rejected=false;try{(void)engine.prepare(bad,assets);}catch(const std::exception&){rejected=true;}check(rejected,"An unknown fade curve was accepted");

  auto x=project(48000,48000);TrackTimeline c;c.id="xfade";
  AudioWindow a{1,"dc",0,30000,0,48000,0,30000,1.f,0,6000};a.fadeOutCurve=1;AudioWindow b{2,"dc",24000,48000,0,48000,0,24000,1.f,6000,0};b.fadeInCurve=1;
  c.audio={a,b};x.tracks.push_back(c);
  RenderEngine cross(48000,256);cross.submit(cross.prepare(x,assets));check(cross.play(),"Play failed");const auto mix=render(cross,48000,128);
  for(std::int64_t f:{24600,27000,29400}){const double k=(f-24000)/6000.0;near(mix[f*2],.125*(std::sin((1-k)*pi/2)+std::sin(k*pi/2))*center,1e-6,"Equal-power crossfade sum");}
  near(mix[20000*2],.125*center,1e-6,"Before the crossfade only the first region plays");near(mix[40000*2],.125*center,1e-6,"After the crossfade only the second region plays");
}

void sampledZonesAndMissingAssets(){
  AssetStore assets{{"quiet",asset("quiet",48000,std::vector<float>(20000,.04f))},{"loud",asset("loud",48000,std::vector<float>(20000,.12f))}};
  SampleSet set;set.id="set";set.isKit=true;set.zones={{"quiet",36,36,36,0,.5,0,0,{},1},{"loud",36,36,36,.5,1,0,0,{},1}};
  auto p=project();TrackTimeline t;t.id="samples";t.source.kind=TrackSource::Kind::BuiltinSampled;t.source.instrumentId="kit-test";t.source.sampleSetId="set";t.source.isKit=true;t.notes={{1,0,10,48000,36,.25f}};p.tracks.push_back(t);
  RenderEngine quiet;quiet.submit(quiet.prepare(p,assets,{{"set",set}}));check(quiet.play(),"Play failed");auto q=render(quiet,2000);
  p.tracks[0].notes[0].velocity=.75f;RenderEngine loud;loud.submit(loud.prepare(p,assets,{{"set",set}}));check(loud.play(),"Play failed");auto l=render(loud,2000);
  check(energy(l)>energy(q)*5,"Sample velocity layer selection is incorrect");check(std::abs(q[1500*2])>.001,"One-shot kit was incorrectly cut by MIDI note duration");
  rejects([&]{RenderEngine e;(void)e.prepare(p,assets,{});},"Missing sample set silently fell back to a synth");
  rejects([&]{RenderEngine e;(void)e.prepare(p,{},{{"set",set}});},"Missing sample PCM silently succeeded");

  SampleSet pitched;pitched.id="looped";pitched.zones={{"quiet",60,0,127,0,1,0,0,std::array<double,2>{.02,.04},-1}};
  auto instrument=project();t.source.isKit=false;t.source.sampleSetId="looped";t.source.instrumentId="test-piano";t.notes={{1,0,48000,48000,60,.7f}};instrument.tracks.push_back(t);
  RenderEngine held;held.submit(held.prepare(instrument,assets,{{"looped",pitched}}));check(held.play(),"Play failed");auto h=render(held,30000,129);
  check(std::abs(h[29000*2])>.001,"A looped sample ended at the original PCM length");
}

void pianoReleaseNoise(){
  near(dsp::releaseNoiseGain(1,0,5,1,false),1,1e-12,"Release noise ignored velocity 1");
  near(dsp::releaseNoiseGain(.5,2,5,.5,false),.25*std::exp(-1.0),1e-12,"Release noise did not follow velocity, amount and hold time");
  check(dsp::releaseNoiseGain(1,.5,5,0,false)==0,"Release noise amount 0 did not turn it off");
  check(dsp::releaseNoiseGain(1,.5,5,1,true)==0,"Cut-off note played a release noise");
  check(dsp::releaseNoiseGain(.01,.5,5,1,false)==0,"Very soft note played a release noise");
  check(dsp::releaseNoiseGain(1,5,5,1,false)==0,"Rang-out note played a release noise");
  AssetStore assets{{"tone",asset("tone",48000,std::vector<float>(20000))},{"short",asset("short",48000,std::vector<float>(2000))},{"release",asset("release",48000,std::vector<float>(100,.01f))}};
  SampleSet set;set.id="piano";set.zones={{"tone",60,0,127,0,1,0,0,{},-1}};set.releaseZones={{"release",60,0,127,0,1,0,0,{},-1}};
  SampleSet shortSet=set;shortSet.id="short";shortSet.zones[0].assetId="short";
  const auto run=[&](NotePair note,double amount,const char*setId){
    auto p=project(48000,8000);TrackTimeline t;t.id="piano";t.source.kind=TrackSource::Kind::BuiltinSampled;t.source.instrumentId="grand";t.source.sampleSetId=setId;
    t.source.params={{"releaseNoise",amount}};t.notes={note};p.tracks.push_back(t);
    RenderEngine e;e.submit(e.prepare(p,assets,{{"piano",set},{"short",shortSet}}));check(e.play(),"Play failed");return render(e,6000);
  };
  const auto released=run({1,0,1000,4000,60,.8f},.5,"piano");
  near(released[1000*2],dsp::dbToGain(-6)*.01*.5*.8*std::exp(-1000.0/48000/2)/std::sqrt(2.0),1e-8,"Release noise missed the note-off or its level");
  check(energy(run({1,0,4000,4000,60,.8f},.5,"piano"))==0,"A note cut off at its clip end played a release noise");
  check(energy(run({1,0,1000,4000,60,.8f},0,"piano"))==0,"Release noise amount 0 still played");
  check(energy(run({1,0,3000,4000,60,.8f},.5,"short"))==0,"A note held past its sample length played a release noise");
}

void liveMidiAndPanning(){
  auto p=project();TrackTimeline t;t.id="live";t.source.kind=TrackSource::Kind::BuiltinSampled;t.source.instrumentId="piano";t.source.sampleSetId="live";t.source.params={{"attack",.2},{"release",.1}};p.tracks.push_back(t);
  SampleSet set;set.id="live";set.gainDb=6;set.zones={{"tone",60,0,127,0,1,0,0,{},-1}};
  AssetStore assets{{"tone",asset("tone",48000,std::vector<float>(20000,.02f))}};
  RenderEngine live;live.submit(live.prepare(p,assets,{{"live",set}}));check(live.noteOn(0,60,.8f,1),"Live note on failed");(void)render(live,200);
  check(live.noteOff(0,60,1),"Live note off failed");const auto tail=render(live,10000);
  const auto releaseLevel=.02*(.25+.75*.8)*(200.0/48000/.2)/std::sqrt(2.0);
  near(tail[0],releaseLevel,1e-8,"Quick live note-off jumped from attack to full sustain");
  for(std::size_t i=9000*2;i<tail.size();++i)near(tail[i],0,0,"Live note-off did not retire its voice");

  assets["tone"]=asset("tone",48000,std::vector<float>(20000));assets["release"]=asset("release",48000,std::vector<float>(100,.01f));
  set.releaseZones={{"release",60,0,127,0,1,0,0,{},-1}};
  RenderEngine released;released.submit(released.prepare(p,assets,{{"live",set}}));check(released.noteOn(0,60,.8f,7),"Live note on failed");(void)render(released,200);check(released.noteOff(0,60,7),"Live note off failed");const auto r=render(released,150);
  near(r[0],.01*.5*.8*std::exp(-200.0/48000/2)/std::sqrt(2.0),1e-8,"Live sample release zone missed its exact note-off");
  near(r[99*2],r[0],1e-8,"Sample release zone was truncated");near(r[100*2],0,0,"Sample release zone extended past its PCM");

  auto audio=project(48000,1000);TrackTimeline a;a.id="mono";a.pan=-1;a.audio={{1,"pan",0,1000,0,48000,0,1000,1,0,0}};audio.tracks.push_back(a);
  assets["pan"]=asset("pan",48000,std::vector<float>(1000,.02f));RenderEngine pan;pan.submit(pan.prepare(audio,assets));check(pan.play(),"Play failed");const auto left=render(pan,500);
  near(left[300*2],.02,1e-8,"Mono full-pan gained six dB from duplicated scratch channels");near(left[300*2+1],0,1e-8,"Mono full-left pan leaked into the right channel");
}

void monitoringAndRecording(){
  auto p=project(48000,10000);TrackTimeline t;t.id="input";p.tracks.push_back(t);
  RenderEngine e(48000,8,16);e.submit(e.prepare(p,{}));const std::array<std::uint32_t,1>ids{0};check(e.setMonitoring(ids),"Monitor command failed");check(e.setInputChannels(0,-1),"Input selection failed");
  std::array<float,16>out{};std::array<float,8>in{.01f,.02f,.03f,.04f,.05f,.06f,.07f,.08f};rt(e,out.data(),in.data(),8,1);
  for(std::size_t i=0;i<in.size();++i){near(out[2*i],in[i]/std::sqrt(2.0),1e-7,"Native mono monitor did not use equal-power panning");near(out[2*i+1],out[2*i],1e-7,"Mono input was not routed to both channels");}
  check(e.seek(123),"Seek failed");check(e.startRecording(),"Record start failed");check(e.play(),"Play failed");rt(e,out.data(),in.data(),8,1);
  check(e.snapshot().recordingStartFrame==123,"Recording start used a UI/wall clock instead of project frames");check(e.snapshot().recordedFrames==8,"Incorrect capture frame count");
  const auto stop=e.stopRecording();rt(e,out.data(),in.data(),8,1);check(e.snapshot().lastAppliedCommand>=stop&&!e.snapshot().recording,"Record stop was not acknowledged");
  std::array<float,32>recorded{};check(e.drainRecording(recorded.data(),16)==8,"Recording retained samples after acknowledged stop");
  for(std::size_t i=0;i<8;++i){near(recorded[2*i],in[i],0,"Recording PCM was not lossless");near(recorded[2*i+1],in[i],0,"Recording channel mapping mismatch");}
  check(e.startRecording(),"Second take failed");rt(e,out.data(),in.data(),8,1);rt(e,out.data(),in.data(),8,1);rt(e,out.data(),in.data(),8,1);
  check(!e.snapshot().recording&&e.snapshot().recordingDroppedFrames==8,"Capture ring overflow was not exposed and stopped");
  check(e.drainRecording(recorded.data(),16)==16,"Capture ring lost already-buffered PCM on overflow");
}

// Device opens physical inputs 4, 7 and 9, interleaved as indices 0, 1, 2.
ProjectTimeline inputProject(){
  auto p=project(48000,10000);
  const auto audio=[](const char*id,std::optional<TrackInput>input){TrackTimeline t;t.id=id;t.input=input;return t;};
  p.tracks={audio("mono9",TrackInput{{9,-1}}),audio("pair47",TrackInput{{4,7}}),audio("absent5",TrackInput{{5,-1}}),audio("default",std::nullopt)};
  return p;
}
void perTrackInputRouting(){
  const std::array<std::uint8_t,3>layout{4,7,9};
  const auto mono=routeInput(TrackInput{{9,-1}},layout,3,0,1),pair=routeInput(TrackInput{{4,7}},layout,3,0,1),absent=routeInput(TrackInput{{5,-1}},layout,3,0,1);
  check(mono.left==2&&mono.right==-1&&mono.channels==1&&!mono.missing,"Physical mono input did not map to its interleaved index");
  check(pair.left==0&&pair.right==1&&pair.channels==2,"Physical stereo input did not map to its interleaved pair");
  check(absent.missing&&absent.left==-1&&absent.channels==1,"An unopened input was not reported missing");
  check(routeInput(TrackInput{{4,5}},layout,3,0,1).missing,"A half-open stereo pair recorded only one side");
  check(routeInput(TrackInput{{9,-1}},layout,2,0,1).missing,"A layout channel beyond the delivered count was treated as open");
  const auto fallback=routeInput(std::nullopt,layout,1,0,1);check(fallback.left==0&&fallback.right==-1&&fallback.channels==1,"Default input on a mono device is not its first channel");
  check(routeInput(std::nullopt,layout,0,0,1).missing,"Default input without any device input is not missing");

  auto p=inputProject();RenderEngine e(48000,8,64);e.submit(e.prepare(p,{}));
  const std::array<std::uint32_t,3>physical{4,7,9};check(e.setInputLayout(physical),"Input layout command failed");
  std::array<float,24>in{};for(std::size_t i=0;i<8;++i){in[i*3]=.1f;in[i*3+1]=.2f;in[i*3+2]=.3f;}
  std::array<float,16>out{};
  const auto monitorOnly=[&](std::uint32_t index){const std::array<std::uint32_t,1>ids{index};check(e.setMonitoring(ids),"Monitor command failed");rt(e,out.data(),in.data(),8,3);};
  monitorOnly(0);for(std::size_t i=0;i<8;++i){near(out[2*i],.3/std::sqrt(2.0),1e-6,"Mono track did not monitor its own physical input");near(out[2*i+1],out[2*i],1e-7,"Mono track input was not centered");}
  monitorOnly(1);for(std::size_t i=0;i<8;++i){near(out[2*i],.1,1e-6,"Stereo track left is not its first physical channel");near(out[2*i+1],.2,1e-6,"Stereo track right is not its second physical channel");}
  monitorOnly(2);for(const auto v:out)near(v,0,0,"A track with an unopened input heard another channel");
  monitorOnly(3);near(out[0],.1,1e-6,"Default input is not the first enabled pair");near(out[1],.2,1e-6,"Default input is not the first enabled pair");
  // Reconfigured device: the same tracks follow their physical channels to new indices.
  const std::array<std::uint32_t,2>swapped{9,4};check(e.setInputLayout(swapped),"Input layout swap failed");
  std::array<float,16>two{};for(std::size_t i=0;i<8;++i){two[i*2]=.5f;two[i*2+1]=.6f;}
  {const std::array<std::uint32_t,1>ids{0};check(e.setMonitoring(ids),"Monitor command failed");rt(e,out.data(),two.data(),8,2);}
  near(out[0],.5/std::sqrt(2.0),1e-6,"Input layout swap did not remap the physical channel");
  {const std::array<std::uint32_t,1>ids{1};check(e.setMonitoring(ids),"Monitor command failed");rt(e,out.data(),two.data(),8,2);}
  for(const auto v:out)near(v,0,0,"A stereo input whose pair closed still produced sound");
  rejects([&]{const std::array<std::uint32_t,2>dup{3,3};(void)e.setInputLayout(dup);},"Duplicate physical input channels were accepted");
  rejects([&]{const std::array<std::uint32_t,1>big{256};(void)e.setInputLayout(big);},"Out-of-range physical input channel was accepted");
}

void simultaneousTakes(){
  auto p=inputProject();RenderEngine e(48000,8,64);e.submit(e.prepare(p,{}));
  const std::array<std::uint32_t,3>physical{4,7,9};check(e.setInputLayout(physical),"Input layout command failed");
  const std::array<std::uint32_t,4>tracks{0,1,2,3};const auto plan=e.planRecording(tracks);
  check(plan.size()==4&&plan[0].route.channels==1&&plan[1].route.channels==2&&plan[2].route.missing&&plan[3].route.channels==2,"Take plan does not follow each track input");
  rejects([&]{const std::array<std::uint32_t,2>dup{1,1};(void)e.planRecording(dup);},"A track was planned to record twice");
  rejects([&]{const std::array<std::uint32_t,1>bad{9};(void)e.planRecording(bad);},"An unknown track was planned");
  rejects([&]{std::vector<std::uint32_t>many(65);for(std::uint32_t i=0;i<65;++i)many[i]=i;(void)e.planRecording(many);},"More than 64 takes were planned");
  check(e.seek(40),"Seek failed");check(e.startRecording(plan),"Multi-take start failed");check(e.play(),"Play failed");
  check(e.recordingChannels()==6,"Capture frame does not hold every take's channels");
  rejects([&]{(void)e.startRecording(plan);},"A second capture replaced one the callback still owns");
  std::array<float,24>in{};std::array<float,16>out{};
  for(int block=0;block<2;++block){for(std::size_t i=0;i<8;++i)for(std::size_t c=0;c<3;++c)in[i*3+c]=static_cast<float>(block*8+i)+static_cast<float>(c)/10;rt(e,out.data(),in.data(),8,3);}
  check(e.snapshot().recordingStartFrame==40&&e.snapshot().recordedFrames==16,"Takes did not start on one shared transport frame");
  const auto stop=e.stopRecording();rt(e,out.data(),in.data(),8,3);check(e.snapshot().lastAppliedCommand>=stop,"Multi-take stop was not acknowledged");
  std::vector<float>frames(16*6);check(e.drainRecording(frames.data(),16)==16,"Multi-take capture lost frames");
  for(std::size_t f=0;f<16;++f){
    const float*x=frames.data()+f*6;const auto base=static_cast<float>(f);
    near(x[0],base+.2f,0,"Mono take did not record physical channel 9");
    near(x[1],base,0,"Stereo take left is not physical channel 4");near(x[2],base+.1f,0,"Stereo take right is not physical channel 7");
    near(x[3],0,0,"A take with an unopened input recorded another channel");
    near(x[4],base,0,"Default take left is not the first pair");near(x[5],base+.1f,0,"Default take right is not the first pair");
  }
  // The released ring can be replaced by the next recording.
  const std::array<std::uint32_t,1>one{0};check(e.startRecording(e.planRecording(one)),"Next take after a drained stop failed");check(e.recordingChannels()==1,"Next take kept the previous capture layout");
}

void latencyDetection(){
  const auto pulse=latencyPulse(48000);check(pulse.size()==192,"Latency pulse is not 4 ms");
  std::vector<std::int64_t>emitted;for(int k=0;k<5;++k)emitted.push_back(k*20000);
  std::uint32_t seed=12345;const auto noise=[&]{seed=seed*1664525u+1013904223u;return (static_cast<float>(seed>>8)/16777216.f-.5f);};
  const auto loop=[&](std::int64_t delay,float gain,float noiseLevel,int skip){
    std::vector<float>x(100000);for(auto&v:x)v=noise()*noiseLevel+.01f; // DC offset from a cheap converter.
    for(std::size_t k=0;k<emitted.size();++k)if(static_cast<int>(k)!=skip)for(std::size_t i=0;i<pulse.size();++i)x[static_cast<std::size_t>(emitted[k]+delay)+i]+=gain*pulse[i];
    return x;
  };
  auto found=detectLatency(loop(777,-.3f,.02f,-1),pulse,emitted,16800);
  check(found.roundTripFrames&&*found.roundTripFrames==777,"Inverted, quiet loopback was not found at the exact frame");
  check(found.attempts==5&&found.detected==5&&found.confidence>.8,"Clean loopback reported low confidence");
  auto partial=detectLatency(loop(4096,.8f,.05f,2),pulse,emitted,16800);
  check(partial.roundTripFrames&&*partial.roundTripFrames==4096&&partial.detected==4,"A missed pulse changed the measured latency");
  check(partial.confidence<found.confidence&&partial.confidence>.5,"A missed pulse did not reduce confidence");
  auto silent=detectLatency(loop(500,0,.05f,-1),pulse,emitted,16800);
  check(!silent.roundTripFrames&&silent.confidence==0&&silent.attempts==5,"Noise without a loopback reported a latency");
  auto late=detectLatency(loop(17000,.5f,.01f,-1),pulse,emitted,16800);
  check(!late.roundTripFrames||late.confidence<.5,"A return beyond the search window was reported as certain");
}

void overloadCounting(){
  LoadMeter meter;meter.record(.0005,.001);check(meter.overloads()==0,"Half a buffer of work was counted as an overload");near(meter.lastLoad(),.5,1e-6,"Callback load is not processing/buffer time");
  meter.record(.00091,.001);meter.record(.002,.001);check(meter.overloads()==2,"Callbacks above 90% of the buffer were not counted");near(meter.lastLoad(),2,1e-6,"A late callback load was clamped");
  meter.record(.001,0);check(meter.overloads()==2,"A zero-length buffer was counted");
  meter.reset();check(meter.overloads()==0&&meter.lastLoad()==0,"Load meter reset failed");
}

void builtinEffectsAndGuitar(){
  // The old BiquadFilterNode low/high-pass Q is measured in dB. Check against
  // its documented gain at cutoff, independently from the native coefficients.
  for(auto type:{dsp::Filter::Lowpass,dsp::Filter::Highpass}){
    dsp::Biquad filter;filter.configure(type,48000,1000,.7);double real=0,imaginary=0;
    for(unsigned i=0;i<4096;++i){const auto h=filter.sample(i==0?1.f:0.f);const auto phase=2*dsp::pi*1000*i/48000;real+=h*std::cos(phase);imaginary-=h*std::sin(phase);}
    near(std::hypot(real,imaginary),std::pow(10,.7/20),2e-6,"Persisted low/high-pass resonance changed units during migration");
  }
  std::vector<float>input(12000*2);for(std::size_t i=0;i<input.size()/2;++i)input[2*i]=input[2*i+1]=static_cast<float>(.08*std::sin(2*dsp::pi*440*i/48000));
  for(const auto*name:{"eq","filter","compressor","drive","delay","reverb","guitar-rig","chorus","phaser","flanger","tremolo","limiter","gate","tape","bitcrusher","utility"}){
    auto effect=dsp::makeEffect(name,{},48000,120);auto output=input;allocations=deallocations=0;watchAllocations=true;
    for(std::size_t at=0;at<12000;at+=127)effect->process(output.data()+2*at,static_cast<std::uint32_t>(std::min<std::size_t>(127,12000-at)));
    watchAllocations=false;check(!allocations&&!deallocations,"Native insert allocated in its callback");check(energy(output)>.001,"Native effect unexpectedly silenced input");
  }
  Parameters bypass{{"compEnabled",0},{"driveEnabled",0},{"ampEnabled",0},{"cabinetEnabled",0},{"chorusEnabled",0},{"delayEnabled",0}};
  auto rig=dsp::makeEffect("guitar-rig",bypass,48000,120);auto output=input;rig->process(output.data(),12000);checkSame(input,output,0,"All-bypass guitar rig is not transparent");check(rig->latencyFrames()==0,"All-bypass guitar rig reported unnecessary delay");
  auto a=dsp::makeEffect("guitar-rig",{{"micPosition",0},{"micType",0}},48000,120),b=dsp::makeEffect("guitar-rig",{{"micPosition",1},{"micType",1}},48000,120);
  auto x=input,y=input;a->process(x.data(),12000);b->process(y.data(),12000);double difference=0;for(std::size_t i=0;i<x.size();++i)difference+=std::abs(x[i]-y[i]);check(difference>.1,"Native microphone controls did not affect the audio");
  // User-arranged rack: an empty rack is transparent, and moving the drive after the amp changes the tone.
  Parameters emptyRack;for(int slot=0;slot<10;++slot)emptyRack["rackSlot"+std::to_string(slot)]=0;
  auto none=dsp::makeEffect("guitar-rig",emptyRack,48000,120);auto bare=input;none->process(bare.data(),12000);checkSame(input,bare,0,"Empty guitar rack is not transparent");check(none->latencyFrames()==0&&none->tailSeconds()==0,"Empty guitar rack reported latency or tail");
  Parameters reordered{{"driveEnabled",1},{"rackSlot0",3},{"rackSlot1",2},{"rackSlot2",4},{"rackSlot3",0},{"rackSlot4",0},{"rackSlot5",0}},usual{{"driveEnabled",1},{"rackSlot0",2},{"rackSlot1",3},{"rackSlot2",4},{"rackSlot3",0},{"rackSlot4",0},{"rackSlot5",0}};
  auto ra=dsp::makeEffect("guitar-rig",reordered,48000,120),rb=dsp::makeEffect("guitar-rig",usual,48000,120);auto ox=input,oy=input;ra->process(ox.data(),12000);rb->process(oy.data(),12000);
  double moved=0;for(std::size_t i=0;i<ox.size();++i)moved+=std::abs(ox[i]-oy[i]);check(moved>.1,"Guitar rack order did not change the processing order");
  rejects([]{(void)dsp::makeEffect("unimplemented",{},48000,120);},"Unknown effect was silently skipped");
  rejects([]{(void)dsp::makeEffect("eq",{{"wrongParameter",1}},48000,120);},"Unknown parameter was silently ignored");
  rejects([]{(void)dsp::makeEffect("delay",{{"feedback",1}},48000,120);},"Unstable feedback was accepted");
}

// 시김새 (docs/SIGIMSAE.md): limiter ceiling, gate closing, utility sums, modulation stability, bypass.
void sigimsaeEffects(){
  std::vector<float>tone(24000*2);for(std::size_t i=0;i<tone.size()/2;++i)tone[2*i]=tone[2*i+1]=static_cast<float>(.08*std::sin(2*dsp::pi*440*i/48000));
  for(const auto*name:{"chorus","phaser","flanger","tremolo","limiter","gate","tape","bitcrusher","utility"}){
    auto effect=dsp::makeEffect(name,{},48000,120);auto output=tone;allocations=deallocations=0;watchAllocations=true;
    for(std::size_t at=0;at<24000;at+=127)effect->process(output.data()+2*at,static_cast<std::uint32_t>(std::min<std::size_t>(127,24000-at)));
    watchAllocations=false;check(!allocations&&!deallocations,"Sigimsae effect allocated in its callback");check(energy(output)>.001,"Sigimsae effect unexpectedly silenced input");
    auto replacement=dsp::makeEffect(name,{},48000,120);allocations=deallocations=0;watchAllocations=true;replacement->takeStateFrom(*effect);watchAllocations=false;check(!allocations&&!deallocations,"Sigimsae state transfer allocated");
  }
  // Limiter: a +6 dBFS sine driven another 12 dB never passes a -3 dB ceiling.
  std::vector<float>loud(24000*2);for(std::size_t i=0;i<loud.size()/2;++i){loud[2*i]=static_cast<float>(2*std::sin(2*dsp::pi*97*i/48000));loud[2*i+1]=static_cast<float>(1.5*std::sin(2*dsp::pi*211*i/48000));}
  auto limiter=dsp::makeEffect("limiter",{{"gain",12},{"ceiling",-3},{"release",50}},48000,120);auto limited=loud;limiter->process(limited.data(),24000);
  double peak=0;for(auto v:limited)peak=std::max(peak,static_cast<double>(std::abs(v)));check(peak<=dsp::dbToGain(-3)+1e-6,"Limiter exceeded its ceiling");check(peak>dsp::dbToGain(-3)*.9,"Limiter output collapsed");
  // Gate: opens on the tone, closes to exact silence once the input stops; never opens below threshold.
  std::vector<float>burst(48000*2,0.f);for(std::size_t i=0;i<12000;++i)burst[2*i]=burst[2*i+1]=tone[2*i];for(std::size_t i=24000;i<48000;++i)burst[2*i]=burst[2*i+1]=static_cast<float>(1e-4*std::sin(i*.3));
  auto gate=dsp::makeEffect("gate",{{"threshold",-40},{"hold",20},{"release",40}},48000,120);auto gated=burst;gate->process(gated.data(),48000);
  double opened=0;for(std::size_t i=4000;i<12000;++i)opened+=std::abs(gated[2*i]);check(opened>100,"Gate did not open on a loud tone");
  for(std::size_t i=24000;i<48000;++i)check(gated[2*i]==0&&gated[2*i+1]==0,"Gate leaked noise below its threshold after closing");
  // Utility: mono is the exact L/R average; polarity on both sides negates; neutral is transparent.
  std::vector<float>split(4000*2);for(std::size_t i=0;i<4000;++i){split[2*i]=static_cast<float>(std::sin(i*.05));split[2*i+1]=static_cast<float>(.3*std::cos(i*.11));}
  auto mono=dsp::makeEffect("utility",{{"mono",1}},48000,120);auto summed=split;mono->process(summed.data(),4000);
  for(std::size_t i=0;i<4000;++i){near(summed[2*i],.5*(split[2*i]+split[2*i+1]),1e-6,"Utility mono is not the L/R average");check(summed[2*i]==summed[2*i+1],"Utility mono left/right differ");}
  auto invert=dsp::makeEffect("utility",{{"phase",3}},48000,120);auto inverted=split;invert->process(inverted.data(),4000);for(std::size_t i=0;i<inverted.size();++i)near(inverted[i],-split[i],1e-6,"Utility polarity invert is wrong");
  auto neutral=dsp::makeEffect("utility",{},48000,120);auto same=split;neutral->process(same.data(),4000);checkSame(split,same,1e-6,"Neutral utility is not transparent");
  // Modulation and feedback at their most extreme stay finite and bounded on full-scale noise.
  std::vector<float>noise(96000*2);std::uint32_t seed=7;for(auto&v:noise){seed=seed*1664525u+1013904223u;v=static_cast<float>(static_cast<double>(seed)/4294967295.0*2-1);}
  const std::pair<const char*,Parameters>extreme[]={{"chorus",{{"rate",5},{"depth",1},{"mix",1}}},{"phaser",{{"rate",5},{"depth",1},{"feedback",.9},{"mix",1}}},
    {"flanger",{{"rate",5},{"depth",1},{"feedback",.95},{"mix",1}}},{"tremolo",{{"rate",20},{"depth",1},{"shape",1},{"pan",1}}},{"tremolo",{{"sync",1.0/6},{"depth",1}}},
    {"delay",{{"amount",1},{"feedback",.95},{"age",1},{"mode",1},{"lowcut",2000},{"time",1.0/6}}},{"tape",{{"drive",24},{"warmth",1}}},{"bitcrusher",{{"bits",1},{"downsample",32}}}};
  for(const auto&[name,params]:extreme){auto effect=dsp::makeEffect(name,params,48000,120);auto out=noise;effect->process(out.data(),96000);for(auto v:out)check(std::isfinite(v)&&std::abs(v)<40,"Extreme sigimsae settings diverged");}
  // Studio delay: ping-pong starts on the left, the right answers one delay later; time follows tempo.
  std::vector<float>click(48000*2,0.f);click[0]=click[1]=1;
  auto pong=dsp::makeEffect("delay",{{"mode",1},{"amount",1},{"feedback",.5},{"time",.5},{"tone",16000}},48000,120);auto bounced=click;pong->process(bounced.data(),48000);
  auto peakAt=[&](unsigned c,std::size_t from,std::size_t to){std::size_t best=from;for(std::size_t i=from;i<to;++i)if(std::abs(bounced[2*i+c])>std::abs(bounced[2*best+c]))best=i;return best;};
  const auto firstLeft=peakAt(0,100,20000),firstRight=peakAt(1,100,30000);check(firstLeft>11900&&firstLeft<12100,"Ping-pong first repeat is not one 1/8 at 120 BPM on the left");check(firstRight>23900&&firstRight<24100,"Ping-pong right repeat is not one delay later");
  rejects([]{(void)dsp::makeEffect("delay",{{"time",.1}},48000,120);},"Delay accepted a time outside its range");
  rejects([]{(void)dsp::makeEffect("limiter",{{"ceiling",1}},48000,120);},"Limiter accepted a ceiling above 0 dB");
  // Reverb spaces: each type has its own impulse; pre-delay holds the wet signal back.
  std::vector<double>energyBy;for(int type=0;type<4;++type){auto verb=dsp::makeEffect("reverb",{{"amount",1},{"type",static_cast<double>(type)},{"predelay",100}},48000,120);auto out=click;verb->process(out.data(),48000);
    double early=0;for(std::size_t i=1;i<4700;++i)early+=std::abs(out[2*i]);check(early==0,"Reverb pre-delay leaked early output");energyBy.push_back(energy(out));}
  check(energyBy[0]!=energyBy[1]&&energyBy[1]!=energyBy[2]&&energyBy[2]!=energyBy[3],"Reverb space types sound identical");
  // Bypass is bit-exact at the engine: a disabled insert renders exactly like no insert.
  for(const auto*name:{"chorus","phaser","flanger","tremolo","limiter","gate","tape","bitcrusher","utility","delay"}){
    auto p=project(48000,12000);auto t=synthTrack();t.source.params["level"]=.2;t.notes={{1,0,6000,12000,60,1}};auto plain=p;plain.tracks.push_back(t);
    t.inserts={{"fx",name,false,{},{}}};p.tracks.push_back(t);
    RenderEngine a(48000,256),b(48000,256);a.submit(a.prepare(plain,{}));b.submit(b.prepare(p,{}));check(a.play()&&b.play(),"Play failed");checkSame(render(a,12000),render(b,12000),0,"Bypassed sigimsae effect is not bit-exact");
  }
}

void reverbPartitionAccuracy(){
  constexpr unsigned sr=8000,frames=17000;const double size=.37;
  auto effect=dsp::makeEffect("reverb",{{"amount",1},{"size",size},{"tone",3000}},sr,120);
  std::vector<float>output(frames*2);output[0]=output[1]=.1f;
  for(unsigned at=0;at<frames;at+=73)effect->process(output.data()+2*at,std::min(73u,frames-at));
  auto impulse=[](double seconds,std::uint32_t seed){const auto length=static_cast<std::size_t>(std::ceil(sr*seconds));std::array<std::vector<float>,2>ir{std::vector<float>(length),std::vector<float>(length)};double power=0;
    for(auto&channel:ir)for(std::size_t i=0;i<length;++i){seed=seed*1664525u+1013904223u;channel[i]=static_cast<float>((static_cast<double>(seed)/4294967295.0*2-1)*std::pow(1-static_cast<double>(i)/length,3.6));power+=channel[i]*channel[i];}
    const float scale=static_cast<float>(.00125/std::max(.000125,std::sqrt(power/(length*2)))*44100/sr);for(auto&channel:ir)for(auto&v:channel)v*=scale;return ir;};
  const auto small=impulse(1.7,9183),large=impulse(4.2,61427);dsp::Biquad tone;tone.configure(dsp::Filter::Lowpass,sr,3000,1);
  for(unsigned frame=0;frame<frames;++frame)for(unsigned c=0;c<2;++c){const double kernel=large[c][frame]*size+(frame<small[c].size()?small[c][frame]*(1-size):0);const float expected=static_cast<float>((frame==0?.1:0)+.5*tone.sample(static_cast<float>(.1*kernel),c));near(output[frame*2+c],expected,2e-6,"Partitioned reverb differs from its causal impulse response");}
  effect->reset();std::fill(output.begin(),output.end(),0.f);effect->process(output.data(),frames);near(energy(output),0,0,"Reverb reset leaked old generations");
}

class TestPlugin final:public PluginProcessor {
 public:
  explicit TestPlugin(unsigned latency=0):latency_(latency),ring_((latency+1)*2){}
  void process(float*stereo,std::uint32_t frames,std::span<const PluginEvent>events,const ProcessContext&context)noexcept override {
    last=context;if(reset_){reset_=false;playing_=false;}
    for(std::size_t i=0;i<events.size()&&eventCount<received.size();++i)received[eventCount++]=events[i];
    for(unsigned i=0;i<frames;++i){for(const auto&e:events)if(e.offset==i){if(e.type==PluginEvent::Type::NoteOn)playing_=true;else if(e.type==PluginEvent::Type::NoteOff||e.type==PluginEvent::Type::AllNotesOff)playing_=false;}
      for(unsigned c=0;c<2;++c){float x=instrument?(playing_?.02f:0):stereo[2*i+c];if(latency_){const auto next=(write_+1)%(latency_+1);const float y=ring_[next*2+c];ring_[write_*2+c]=x;x=y;}stereo[2*i+c]=x;}
      if(latency_)write_=(write_+1)%(latency_+1);
    }
  }
  std::uint32_t latencyFrames()const noexcept override{return latency_;}
  void requestReset()noexcept override{reset_=true;++resets;}
  bool instrument=false;unsigned resets=0;std::array<PluginEvent,1024>received{};std::size_t eventCount=0;ProcessContext last;
 private:
  unsigned latency_,write_=0;std::vector<float>ring_;bool reset_=false,playing_=false;
};

void pluginTimingAndCompensation(){
  auto plugin=std::make_shared<TestPlugin>();plugin->instrument=true;auto p=project(48000,1000);TrackTimeline track;track.id="vst";track.source.kind=TrackSource::Kind::Vst3;track.source.plugin.instanceId="synth";track.source.plugin.isInstrument=true;track.notes={{1,7,23,1000,60,.7f},{2,23,41,1000,67,.8f}};p.tracks.push_back(track);
  RenderEngine e(48000,64);e.submit(e.prepare(p,{}, {},[&](const PluginSpec&,double,unsigned){return plugin;}));check(e.play(),"Play failed");auto out=render(e,64,64);
  check(plugin->eventCount==4,"VST note events were lost");check(plugin->received[0].offset==7&&plugin->received[1].offset==23&&plugin->received[1].type==PluginEvent::Type::NoteOff&&plugin->received[2].type==PluginEvent::Type::NoteOn,"VST block offsets or off-before-on order incorrect");
  for(unsigned i=0;i<64;++i)near(out[2*i],i>=7&&i<41?.02:0,1e-7,"VST event timing was not sample accurate");
  check(plugin->last.bpm==120&&plugin->last.sampleRate==48000,"VST transport context missing");

  auto pdc=project(48000,5000);TrackTimeline dry;dry.id="dry";dry.audio={{1,"a",0,1000,0,48000,0,1000,.2f,0,0}};auto delayed=dry;delayed.id="delayed";BuiltinInsert insert;insert.id="vstfx";insert.type="vst3";insert.plugin.instanceId="effect";delayed.inserts.push_back(insert);pdc.tracks={dry,delayed};
  AssetStore assets{{"a",asset("a",48000,std::vector<float>(2000,.1f),2)}};
  RenderEngine combined(48000,64),reference(48000,64);auto fx=std::make_shared<TestPlugin>(23);
  combined.submit(combined.prepare(pdc,assets,{},[&](const PluginSpec&,double,unsigned){return fx;}));auto onlyDry=pdc;onlyDry.tracks.resize(1);reference.submit(reference.prepare(onlyDry,assets));check(combined.play()&&reference.play(),"Play failed");auto a=render(combined,1300),b=render(reference,1300);
  check(combined.snapshot().latencyFrames==23,"Graph latency not reported");for(unsigned i=23;i<1200;++i)near(a[2*i],2*b[2*(i-23)],2e-6,"Parallel track delay compensation is not aligned");

  auto disabled=pdc;disabled.tracks[1].enabled=false;unsigned resolves=0;
  auto inactive=combined.prepare(disabled,assets,{},[&](const PluginSpec&,double,unsigned){++resolves;return fx;});
  check(!resolves&&inactive->latencyFrames()==0,"Disabled VST track loaded a plugin or added compensation delay");
  auto duplicate=pdc;duplicate.tracks[0].inserts.push_back(insert);
  rejects([&]{(void)combined.prepare(duplicate,assets,{},[&](const PluginSpec&,double,unsigned){return fx;});},"Duplicate plugin instances were processed twice");

  plugin->eventCount=0;check(e.seek(12),"Seek failed");(void)render(e,40,11);
  check(std::count_if(plugin->received.begin(),plugin->received.begin()+static_cast<std::ptrdiff_t>(plugin->eventCount),[](const PluginEvent&e){return e.type==PluginEvent::Type::NoteOff&&e.noteId==1;})==1,"Chased VST note received duplicate note-offs");
  check(e.pause(),"Pause failed");(void)render(e,1);plugin->eventCount=0;check(e.noteOn(0,60,1,90)&&e.noteOff(0,60,90),"Live note queue failed");(void)render(e,64);
  check(plugin->eventCount==0,"A note-on cancelled before its callback left a VST voice stuck");

  auto held=p;held.tracks[0].notes={{1,0,999,1000,60,.8f}};auto heldPlugin=std::make_shared<TestPlugin>();heldPlugin->instrument=true;
  const PluginResolver factory=[&](const PluginSpec&,double,unsigned){return heldPlugin;};RenderEngine holding(48000,64);holding.submit(holding.prepare(held,{}, {},factory));check(holding.play(),"Play failed");(void)render(holding,64);const auto resetCount=heldPlugin->resets;
  held.revision=1;held.tracks[0].source.plugin.parameters[17]=.6;holding.submit(holding.prepare(held,{}, {},factory));const auto continuing=render(holding,64);
  check(heldPlugin->resets==resetCount,"VST knob update reset its sustained voices");near(continuing[0],.02,1e-8,"VST knob update interrupted the playing voice");
}

void editsPreserveVoicesAndTails(){
  auto p=project(48000,48000);auto t=synthTrack();t.source.params["level"]=.1;t.notes={{1,0,24000,48000,60,1}};t.inserts={{"delay","delay",true,{{"amount",.7},{"time",.25},{"feedback",.3}}, {}}};p.tracks.push_back(t);
  RenderEngine edited(48000,256),reference(48000,256);edited.submit(edited.prepare(p,{}));reference.submit(reference.prepare(p,{}));check(edited.play()&&reference.play(),"Play failed");(void)render(edited,7000);(void)render(reference,7000);
  p.revision=1;edited.submit(edited.prepare(p,{}));check(edited.play(),"Repeated play queue failed");auto x=render(edited,10000,67),y=render(reference,10000,67);checkSame(x,y,2e-6,"No-op graph update/repeated play restarted voices or delay history");
  p.tracks[0].source.params["bell"]=.5;p.tracks[0].source.params["release"]=1.1;edited.submit(edited.prepare(p,{}));x=render(edited,1000,67);y=render(reference,1000,67);checkSame(x,y,2e-6,"Instrument knob edit restarted or retuned an existing voice");
  p.revision=2;p.tracks[0].gain=.4f;p.tracks[0].inserts[0].params["feedback"] = .4;edited.submit(edited.prepare(p,{}));const auto before=edited.snapshot().frame;(void)render(edited,64);check(edited.snapshot().frame==before+64,"Mix edit moved transport");check(edited.snapshot().revision==2,"Mix revision not applied");edited.collectRetired();

  auto reverb=dsp::makeEffect("reverb",{{"amount",.8}},8000,120), replacement=dsp::makeEffect("reverb",{{"amount",.8}},8000,120), unchanged=dsp::makeEffect("reverb",{{"amount",.8}},8000,120);
  std::vector<float>first(1000*2);first[0]=first[1]=.2f;auto original=first;reverb->process(first.data(),1000);unchanged->process(original.data(),1000);
  allocations=deallocations=0;watchAllocations=true;replacement->takeStateFrom(*reverb);watchAllocations=false;check(!allocations&&!deallocations,"Reverb history transfer allocated or destroyed storage");
  std::vector<float>a(9000*2),b(9000*2);replacement->process(a.data(),9000);unchanged->process(b.data(),9000);checkSame(a,b,2e-6,"Reverb tail was lost at parameter graph transition");
}

void offlineConsistencyAndValidation(){
  auto p=project(48000,4000);auto t=synthTrack("pluck");t.source.params["level"]=.15;t.notes={{1,0,3000,4000,64,.8f}};t.inserts={{"eq","eq",true,{{"mid",-4}},{}},{"delay","delay",true,{{"amount",.2},{"time",.25}}, {}}};p.tracks.push_back(t);
  RenderEngine live(48000,512),offline(48000,512);offline.setOffline(true);live.submit(live.prepare(p,{}));offline.submit(offline.prepare(p,{}));check(live.play()&&offline.play(),"Play failed");auto a=render(live,20000,127),b=render(offline,20000,311);checkSame(a,b,2e-6,"Realtime and offline DSP rendering diverged");
  auto bad=p;bad.tracks[0].source.instrumentId="missing";rejects([&]{(void)live.prepare(bad,{});},"Unknown instrument silently fell back");
  bad=p;bad.sampleRate=44100;rejects([&]{(void)live.prepare(bad,{});},"Mismatched device/project clocks accepted");
  RenderEngine queue;for(int i=0;i<1023;++i)check(queue.stop(),"Bounded command queue filled early");check(queue.stop()==0&&queue.snapshot().commandOverflows==1,"Command queue overflow was not reported");
}

void concurrentControlAndRender(){
  auto p=project();auto t=synthTrack();t.source.params["level"]=.1;t.notes={{1,0,48000,48000,60,.5f}};p.tracks.push_back(t);RenderEngine e(48000,64);e.submit(e.prepare(p,{}));check(e.play(),"Play failed");
  std::atomic<bool>done{false},bad{false};
  std::thread audio([&]{std::array<float,128>out{};while(!done.load()){allocations=deallocations=0;watchAllocations=true;e.render(out.data(),nullptr,64);watchAllocations=false;if(allocations||deallocations)bad.store(true);for(auto v:out)if(!std::isfinite(v))bad.store(true);}});
  for(unsigned i=0;i<50;++i){p.revision=i+1;p.tracks[0].gain=(i%10)/10.f;e.submit(e.prepare(p,{}));(void)e.snapshot();e.collectRetired();}
  done.store(true);audio.join();e.collectRetired();check(!bad.load(),"Concurrent graph replacement broke callback safety");
}

// ---- Multi-core processing and render-ahead ----
ProcessingOptions processing(std::uint32_t threads,RenderAhead ahead=RenderAhead::Off,std::uint32_t block=128){
  ProcessingOptions o;o.threads=threads;o.renderAhead=ahead;o.deviceBlockFrames=block;
  // Workers watch their own heap use from start to exit.
  o.onWorkerThread=[](bool started){watchWorker=started;};
  return o;
}
void bitIdentical(const std::vector<float>&a,const std::vector<float>&b,const char*message,std::size_t fromFrame=0,std::size_t toFrame=std::numeric_limits<std::size_t>::max()/4){
  check(a.size()==b.size(),"Different rendered lengths");
  for(std::size_t i=fromFrame*2;i<std::min(toFrame*2,a.size());++i)if(std::memcmp(&a[i],&b[i],sizeof(float))!=0) {
    std::ostringstream detail;detail<<message<<" (frame "<<i/2<<", channel "<<i%2<<": "<<std::setprecision(9)<<a[i]<<" vs "<<b[i]<<")";
    throw std::runtime_error(detail.str());
  }
}
double maxDifference(const std::vector<float>&a,const std::vector<float>&b){double d=0;for(std::size_t i=0;i<a.size();++i){check(std::isfinite(a[i])&&std::isfinite(b[i]),"Non-finite rendered PCM");d=std::max(d,std::abs(double(a[i])-b[i]));}return d;}
struct Busy { ProjectTimeline project; AssetStore assets; SampleSetStore sets; };
// Synths with delay/compressor/drive/filter/reverb inserts, drums, a sampled
// kit, audio regions and optionally a plug-in instrument, inside a cycle.
Busy busyProject(std::size_t tracks,std::uint32_t seed,bool plugin){
  Busy b;b.project=project(48000,96000);b.project.cycle=std::array<std::int64_t,2>{12000,60000};
  std::vector<float>loop(48000*2);for(std::size_t i=0;i<loop.size();++i)loop[i]=static_cast<float>(.2*std::sin(.013*static_cast<double>(i))*std::cos(.0007*static_cast<double>(i)));
  b.assets["loop"]=asset("loop",48000,std::move(loop),2);b.assets["hit"]=asset("hit",48000,std::vector<float>(3000,.05f));
  SampleSet kit;kit.id="kit";kit.isKit=true;kit.zones={{"hit",36,36,36,0,1,0,0,{},-1},{"hit",38,38,38,0,1,-3,0,{},1}};b.sets["kit"]=kit;
  std::uint32_t rng=seed;const auto next=[&]{rng=rng*1664525u+1013904223u;return rng>>8;};
  const char*synths[]={"keys","drums","pad","bass","pluck"};
  for(std::size_t i=0;i<tracks;++i) {
    TrackTimeline t;t.id="t"+std::to_string(i);t.gain=.25f;t.pan=static_cast<float>(static_cast<int>(i%5)-2)/2.f;
    const auto kind=i%7;
    if(kind==6){t.audio={{static_cast<std::int32_t>(i+1),"loop",static_cast<std::int64_t>(next()%20000),static_cast<std::int64_t>(50000+next()%40000),0,48000,0,90000,.6f,200,200}};t.inserts={{"eq"+t.id,"eq",true,{},{}}};}
    else if(kind==5){t.source.kind=TrackSource::Kind::BuiltinSampled;t.source.instrumentId="kit-test";t.source.sampleSetId="kit";t.source.isKit=true;}
    else {t.source.kind=TrackSource::Kind::BuiltinSynth;t.source.instrumentId=synths[kind];t.source.isKit=kind==1;}
    if(kind==0)t.inserts={{"d"+t.id,"delay",true,{{"amount",.3},{"time",.25},{"feedback",.3}},{}}};
    if(kind==2)t.inserts={{"c"+t.id,"compressor",true,{},{}},{"x"+t.id,"drive",true,{},{}}};
    if(kind==3)t.inserts={{"f"+t.id,"filter",true,{},{}}};
    if(kind==4&&i%3==0)t.inserts={{"r"+t.id,"reverb",true,{},{}}};
    if(kind!=6)for(std::int32_t n=0;n<14;++n) {
      const auto on=static_cast<std::int64_t>(next()%92000),off=std::min<std::int64_t>(96000,on+1000+static_cast<std::int64_t>(next()%15000));
      const int pitch=kind==1||kind==5?(n%2?38:36):48+static_cast<int>(next()%24);
      t.notes.push_back({n+1,on,off,off,pitch,.4f+static_cast<float>(next()%60)/100.f});
    }
    b.project.tracks.push_back(std::move(t));
  }
  if(plugin){TrackTimeline t;t.id="plugin";t.gain=.3f;t.source.kind=TrackSource::Kind::Vst3;t.source.plugin.instanceId="plugin";t.source.plugin.isInstrument=true;t.notes={{1,1000,30000,30000,60,.8f},{2,40000,58000,58000,64,.8f}};b.project.tracks.push_back(std::move(t));}
  return b;
}
// Track-input routing (docs/TRACK_INPUT_ROUTING.md): destinations listed before their source, so the
// engine must order the source first. Source: a VST instrument (.02 while its note plays, frames
// 100..900) into a 7-frame-latency effect, fader .5. Graph latency is therefore 7.
ProjectTimeline routedProject(){
  auto p=project(48000,4000);
  const auto audio=[](const char*id,std::optional<TrackRoute>route){TrackTimeline t;t.id=id;t.route=std::move(route);return t;};
  const auto from=[](TrackRoute::Tap tap){TrackRoute r;r.kind=TrackRoute::Kind::Track;r.trackId="synth";r.tap=tap;return r;};
  TrackRoute master;master.kind=TrackRoute::Kind::Master;
  TrackTimeline synth;synth.id="synth";synth.gain=.5f;synth.source.kind=TrackSource::Kind::Vst3;synth.source.plugin.instanceId="inst";synth.source.plugin.isInstrument=true;
  synth.notes={{1,100,900,4000,60,.8f}};BuiltinInsert fx;fx.id="fx";fx.type="vst3";fx.plugin.instanceId="delay7";synth.inserts.push_back(fx);
  p.tracks={audio("pre",from(TrackRoute::Tap::PreFx)),audio("post",from(TrackRoute::Tap::PostFx)),audio("fader",from(TrackRoute::Tap::PostFader)),audio("resample",master),synth};
  return p;
}
PluginResolver routedPlugins(){return [](const PluginSpec&spec,double,std::uint32_t)->std::shared_ptr<PluginProcessor>{
  if(spec.instanceId=="inst"){auto p=std::make_shared<TestPlugin>();p->instrument=true;return p;}
  return std::make_shared<TestPlugin>(7);};}
void trackInputRoutes(){
  for(const std::uint32_t threads:{0u,2u}) {
    auto p=routedProject();RenderEngine e(48000,64,8192);e.setProcessing(processing(threads));e.submit(e.prepare(p,{},{},routedPlugins()));
    const std::array<std::uint32_t,4>takes{0,1,2,3};const auto plan=e.planRecording(takes);
    check(plan.size()==4&&std::all_of(plan.begin(),plan.end(),[](const RecordingTake&t){return t.routed&&t.route.channels==2&&!t.route.missing;}),"Routed takes were not planned as internal stereo inputs");
    check(!plan[0].routeDelayed&&plan[1].routeDelayed&&plan[2].routeDelayed&&plan[3].routeDelayed,"Only post-insert taps carry the graph's plug-in delay");
    // The resampling track is monitored: its own output reaches the master but never its own input.
    const std::array<std::uint32_t,1>monitored{3};check(e.setMonitoring(monitored),"Monitor failed");
    check(e.startRecording(plan),"Routed recording failed to start");check(e.play(),"Play failed");
    (void)render(e,1200,64);
    check(e.snapshot().latencyFrames==7&&e.snapshot().recordingStartFrame==0,"Unexpected graph latency or take start");
    const auto stop=e.stopRecording();(void)render(e,64,64);check(e.snapshot().lastAppliedCommand>=stop,"Routed stop was not acknowledged");
    std::vector<float>frames(1300*8);const auto got=e.drainRecording(frames.data(),1300);check(got==1200,"Routed takes lost frames");
    for(std::size_t f=0;f<got;++f){
      const float*x=frames.data()+f*8;const bool on=f>=100&&f<900,late=f>=107&&f<907;
      for(int c=0;c<2;++c){
        near(x[c],on?.02:0,1e-7,"Pre-FX take is not the instrument output on its exact timeline frames");
        near(x[2+c],late?.02:0,1e-7,"Post-FX take is not the insert output delayed by exactly the graph latency");
        near(x[4+c],late?.01:0,1e-7,"Post-fader take did not apply the source fader");
        near(x[6+c],late?.01:0,1e-7,"Master resampling take heard itself or missed the source");
      }
    }
  }
  // Monitoring a post-FX route: the source is muted, the destination plays its input in place.
  {
    auto p=routedProject();p.tracks[4].audible=false;RenderEngine e(48000,64);e.submit(e.prepare(p,{},{},routedPlugins()));
    const std::array<std::uint32_t,1>monitored{1};check(e.setMonitoring(monitored)&&e.play(),"Monitor or play failed");
    const auto out=render(e,1000,64);
    for(std::size_t f=0;f<1000;++f)near(out[2*f],f>=107&&f<907?.02:0,1e-7,"A monitored track route was not heard on the source's frames");
  }
  // Loops (a<->b, c->c) and a deleted source turn into silent inputs; nothing hangs or throws.
  {
    auto p=project(48000,2000);
    const auto routed=[](const char*id,const char*source){TrackTimeline t;t.id=id;TrackRoute r;r.kind=TrackRoute::Kind::Track;r.trackId=source;r.tap=TrackRoute::Tap::PostFader;t.route=r;
      t.audio={{1,"a",0,2000,0,48000,0,2000,1.f,0,0}};return t;};
    p.tracks={routed("a","b"),routed("b","a"),routed("c","c"),routed("orphan","gone")};
    AssetStore assets{{"a",asset("a",48000,std::vector<float>(4000,.1f),2)}};
    RenderEngine e(48000,64,4096);e.setProcessing(processing(2));e.submit(e.prepare(p,assets));
    const std::array<std::uint32_t,4>all{0,1,2,3};check(e.setMonitoring(all),"Monitor failed");
    const auto plan=e.planRecording(all);check(e.startRecording(plan)&&e.play(),"Loop recording failed to start");
    const auto out=render(e,512,64);for(const auto v:out)check(std::isfinite(v)&&std::abs(v)<1,"A routing loop fed back");
    const auto stop=e.stopRecording();(void)render(e,64,64);check(e.snapshot().lastAppliedCommand>=stop,"Stop was not acknowledged");
    std::vector<float>frames(600*8);const auto got=e.drainRecording(frames.data(),600);check(got==512,"Loop takes lost frames");
    // a's route was broken (silence); b hears a's region output; c (self) and the orphan record silence.
    for(std::size_t f=200;f<got;++f){const float*x=frames.data()+f*8;
      near(x[0],0,0,"A loop member kept its input");check(std::abs(x[2])>.01,"The surviving route of a broken loop went silent");
      near(x[4],0,0,"A self route recorded audio");near(x[6],0,0,"A route to a deleted track recorded audio");}
  }
}


// Send/return (docs/SENDS_RETURNS.md). Stereo audio regions keep the pan law out of the arithmetic.
class CountingPlugin final:public PluginProcessor {
 public:
  void process(float*,std::uint32_t frames,std::span<const PluginEvent>,const ProcessContext&)noexcept override{processed+=frames;}
  std::uint32_t latencyFrames()const noexcept override{return 0;}
  void requestReset()noexcept override{}
  std::uint64_t processed=0;
};
TrackTimeline regionTrack(const char*id,const char*assetId,float gain,std::int64_t frames){TrackTimeline t;t.id=id;t.gain=gain;t.audio={{1,assetId,0,frames,0,48000,0,frames,1.f,0,0}};return t;}
TrackTimeline returnTrack(const char*id){TrackTimeline t;t.id=id;t.isReturn=true;return t;}
void sendReturns(){
  const std::int64_t length=4000;
  AssetStore assets{{"dc",asset("dc",48000,std::vector<float>(static_cast<std::size_t>(length)*2,.1f),2)}};
  {
    // Exact send gains: post-fader follows the fader, pre-fader does not; both stop when the sender is muted.
    // Two senders feed one return whose counting insert must see every frame exactly once.
    for(const std::uint32_t threads:{0u,2u})for(const bool pre:{false,true})for(const bool muted:{false,true}) {
      auto p=project(48000,length);auto a=regionTrack("a","dc",.5f,length),b=regionTrack("b","dc",.2f,length);
      a.sends={{"ret",.25f,pre}};b.sends={{"ret",.5f,false}};a.audible=!muted;
      auto ret=returnTrack("ret");BuiltinInsert count;count.id="count";count.type="vst3";count.plugin.instanceId="count";ret.inserts.push_back(count);
      p.tracks={ret,a,b}; // The return is listed first: the engine must still render its senders before it.
      auto counter=std::make_shared<CountingPlugin>();
      RenderEngine e(48000,64);e.setProcessing(processing(threads));e.submit(e.prepare(p,assets,{},[&](const PluginSpec&,double,unsigned){return counter;}));check(e.play(),"Play failed");
      const auto out=render(e,1000,64);
      check(counter->processed==1000,"A return chain was not processed exactly once per frame");
      const double dryA=muted?0:.05,dryB=.02,sendA=muted?0:pre?.1*.25:.05*.25,sendB=.02*.5;
      for(std::size_t f=400;f<1000;++f)for(int c=0;c<2;++c)near(out[2*f+c],dryA+dryB+sendA+sendB,1e-6,"Send gain, pre/post tap or mute gating is not exact");
      check(e.snapshot().latencyFrames==0&&e.snapshot().senderLatencyFrames==0,"A send without plug-in latency reported delay");
    }
    // A fader at 0 silences only the post-fader send.
    auto p=project(48000,length);auto a=regionTrack("a","dc",0.f,length);a.sends={{"pre",1.f,true},{"post",1.f,false}};p.tracks={a,returnTrack("pre"),returnTrack("post")};
    RenderEngine e(48000,64);e.submit(e.prepare(p,assets));check(e.play(),"Play failed");const auto out=render(e,800,64);
    for(std::size_t f=400;f<800;++f)near(out[2*f],.1,1e-6,"Pre-fader send followed the fader");
  }
  {
    // PDC across a latent return path: senders align to the largest sender latency (5), the return adds 13,
    // and every dry path waits 13 more, so the master hears each impulse once, dry and wet together, at +18.
    std::vector<float> impulses(static_cast<std::size_t>(length)*2,0.f);impulses[500*2]=impulses[500*2+1]=.4f;
    std::vector<float> later(static_cast<std::size_t>(length)*2,0.f);later[700*2]=later[700*2+1]=.4f;
    AssetStore pulses{{"i",asset("i",48000,impulses,2)},{"j",asset("j",48000,later,2)}};
    auto p=project(48000,length);
    auto a=regionTrack("a","i",.5f,length),b=regionTrack("b","j",.5f,length);
    BuiltinInsert five;five.id="five";five.type="vst3";five.plugin.instanceId="five";b.inserts.push_back(five);
    a.sends={{"ret",1.f,false}};b.sends={{"ret",.5f,true}};
    auto ret=returnTrack("ret");BuiltinInsert slow;slow.id="slow";slow.type="vst3";slow.plugin.instanceId="slow";ret.inserts.push_back(slow);ret.gain=.5f;
    TrackTimeline rec;rec.id="rec";TrackRoute route;route.kind=TrackRoute::Kind::Track;route.trackId="a";route.tap=TrackRoute::Tap::PostFader;rec.route=route;rec.audible=false;
    TrackTimeline loop=returnTrack("bad");loop.sends={{"bad",1.f,false}};
    p.tracks={rec,ret,a,b};
    const PluginResolver plugins=[](const PluginSpec&spec,double,unsigned){return std::make_shared<TestPlugin>(spec.instanceId=="slow"?13:5);};
    std::vector<float> reference;
    for(const std::uint32_t threads:{0u,2u}) {
      RenderEngine e(48000,64,8192);e.setProcessing(processing(threads));auto prepared=e.prepare(p,pulses,{},plugins);
      check(prepared->latencyFrames()==18&&prepared->senderLatencyFrames()==5,"Return-path latency was not added after the sender alignment");
      e.submit(std::move(prepared));
      const std::array<std::uint32_t,1>takes{0};const auto plan=e.planRecording(takes);
      check(plan.size()==1&&plan[0].routed&&plan[0].routeDelayed&&!plan[0].routeMasterFeed,"A post-fader route was not planned as a delayed track tap");
      check(e.startRecording(plan)&&e.play(),"Recording or play failed");
      const auto out=render(e,1200,64);
      check(e.snapshot().latencyFrames==18&&e.snapshot().senderLatencyFrames==5,"Snapshot latencies differ from the prepared graph");
      for(std::size_t f=0;f<1200;++f){
        // a: dry .2 + return (.2 * 1 send) * .5 return fader = .3 at 518. b (pre send): dry .2 + (.4 * .5) * .5 = .3 at 718.
        const double expected=f==518||f==718?.3:0;
        near(out[2*f],expected,1e-6,"Dry and return paths are not aligned by delay compensation");
      }
      if(threads)bitIdentical(reference,out,"Worker threads changed a send/return mix");else reference=out;
      const auto stop=e.stopRecording();(void)render(e,64,64);check(e.snapshot().lastAppliedCommand>=stop,"Stop was not acknowledged");
      std::vector<float> frames(1400*2);const auto got=e.drainRecording(frames.data(),1400);check(got>=1200,"Routed take lost frames");
      for(std::size_t f=0;f<1200;++f)near(frames[2*f],f==505?.2:0,1e-6,"A post-fader route tap did not carry exactly the sender alignment");
    }
    auto invalid=p;invalid.tracks.push_back(loop);
    rejects([&]{RenderEngine e(48000,64);(void)e.prepare(invalid,pulses,{},plugins);},"A return track with sends (a possible loop) was accepted");
    // A route naming a return records silence (returns are never route sources), and a send to a missing return is silent.
    auto orphan=project(48000,length);auto s=regionTrack("s","dc",.5f,length);s.sends={{"gone",1.f,false}};
    TrackTimeline r2;r2.id="r2";TrackRoute toReturn;toReturn.kind=TrackRoute::Kind::Track;toReturn.trackId="ret";toReturn.tap=TrackRoute::Tap::PostFader;r2.route=toReturn;
    orphan.tracks={s,returnTrack("ret"),r2};
    RenderEngine e(48000,64,4096);e.submit(e.prepare(orphan,assets));const std::array<std::uint32_t,1>monitored{2};check(e.setMonitoring(monitored)&&e.play(),"Play failed");
    const auto out=render(e,800,64);for(std::size_t f=400;f<800;++f)near(out[2*f],.05,1e-6,"A missing return or a route to a return produced sound");
  }
  {
    // Tails: a 100% wet echo return keeps sounding after its sender stopped, and an offline export lasts that long.
    auto p=project(48000,48000);p.bpm=120;
    std::vector<float> burst(9600*2,.1f);AssetStore shortAssets{{"b",asset("b",48000,burst,2)}};
    auto a=regionTrack("a","b",1.f,4800);a.sends={{"echo",1.f,false}};
    auto echo=returnTrack("echo");echo.inserts.push_back({"delay","delay",true,{{"amount",1},{"dry",0},{"time",.25},{"feedback",0},{"sync",1},{"tone",16000}},{}});
    p.tracks={a,echo};
    RenderEngine e(48000,256);auto prepared=e.prepare(p,shortAssets);check(prepared->tailSeconds()>.85+.125,"The return's echo tail was not part of the render tail");
    e.submit(std::move(prepared));check(e.play(),"Play failed");const auto out=render(e,16000,256);
    double during=0,after=0;for(std::size_t f=1000;f<4000;++f)during=std::max(during,double(std::abs(out[2*f])));
    for(std::size_t f=7000;f<10000;++f)after=std::max(after,double(std::abs(out[2*f])));
    near(during,.1,1e-4,"A 100% wet return passed its dry input (dry = 0)");
    check(after>.02,"The return's echo did not continue after the sender stopped");
  }
}

PluginResolver testInstruments(){return [](const PluginSpec&,double,std::uint32_t){auto p=std::make_shared<TestPlugin>();p->instrument=true;return p;};}
std::unique_ptr<RenderEngine> busyEngine(const Busy&b,const ProcessingOptions&options,bool offline=false,std::uint32_t maxBlock=512){
  auto e=std::make_unique<RenderEngine>(48000,maxBlock);if(offline)e->setOffline(true);e->setProcessing(options);
  e->submit(e->prepare(b.project,b.assets,b.sets,testInstruments()));return e;
}
// The same callbacks and commands on every engine, block by block.
template<class Sizes,class Commands>
std::vector<std::vector<float>> drive(const std::vector<RenderEngine*>&engines,std::size_t blocks,Sizes&&sizes,Commands&&commands,const float*input=nullptr){
  std::vector<std::vector<float>>outs(engines.size());std::vector<float>buffer;
  for(std::size_t k=0;k<blocks;++k) {
    const std::uint32_t frames=sizes(k);
    for(std::size_t i=0;i<engines.size();++i) {
      commands(*engines[i],k);buffer.assign(static_cast<std::size_t>(frames)*2,0.f);
      rt(*engines[i],buffer.data(),input,frames,2);outs[i].insert(outs[i].end(),buffer.begin(),buffer.end());
    }
  }
  return outs;
}

void multicoreBitIdentical(){
  workerHeapOperations=0;
  const auto b=busyProject(20,11,true);
  const auto automatic=std::max(1u,autoProcessingThreads());
  std::vector<float>input(1024*2);for(std::size_t i=0;i<input.size();++i)input[i]=static_cast<float>(.05*std::sin(.01*static_cast<double>(i)));
  for(const bool offline:{false,true}) {
    auto single=busyEngine(b,processing(0),offline),two=busyEngine(b,processing(2),offline),many=busyEngine(b,processing(automatic),offline);
    check(single->snapshot().workerThreads==0&&two->snapshot().workerThreads==2&&many->snapshot().workerThreads==automatic,"Worker thread count was not reported");
    std::uint32_t rng=99;
    const auto sizes=[&](std::size_t k)->std::uint32_t{if(k%3)return 128;rng=rng*1664525u+1013904223u;return 1+(rng>>8)%1024;};
    const auto commands=[&](RenderEngine&e,std::size_t k) {
      if(k==0)check(e.play(),"Play failed");
      if(k==30){const std::array<std::uint32_t,2>ids{2,9};check(e.setMonitoring(ids),"Monitor failed");check(e.noteOn(0,67,.9f,500),"Live note failed");}
      if(k==60)check(e.noteOff(0,67,500),"Live note off failed");
      if(k==90)check(e.seek(30000),"Seek failed");
      if(k==140)check(e.setMonitoring({}),"Monitor clear failed");
    };
    const auto outs=drive({single.get(),two.get(),many.get()},420,sizes,commands,input.data());
    check(energy(outs[0])>1,"The busy project rendered silence");
    bitIdentical(outs[0],outs[1],offline?"Two worker threads changed the offline mix":"Two worker threads changed the mix");
    bitIdentical(outs[0],outs[2],offline?"Automatic worker threads changed the offline mix":"Automatic worker threads changed the mix");
    const auto a=single->snapshot(),c=two->snapshot(),d=many->snapshot();
    check(a.voiceOverflows==c.voiceOverflows&&a.voiceOverflows==d.voiceOverflows&&a.invalidSamples==c.invalidSamples&&a.invalidSamples==d.invalidSamples,"Per-track counters were not summed after the join");
    check(std::equal(a.trackPeaks.begin(),a.trackPeaks.end(),c.trackPeaks.begin())&&std::equal(a.trackPeaks.begin(),a.trackPeaks.end(),d.trackPeaks.begin()),"Track meters differ between thread counts");
  }
  check(workerHeapOperations.load()==0,"An engine worker allocated or freed heap storage");
  RenderEngine late;late.submit(late.prepare(project(),{}));
  rejects([&]{late.setProcessing(processing(2));},"Processing changed after a project was submitted");
  rejects([&]{RenderEngine e;e.setProcessing(processing(maxProcessingThreads+1));},"More than 16 processing threads were accepted");
}

void renderAheadMatchesCallback(){
  workerHeapOperations=0;
  constexpr std::uint32_t block=128;
  const auto b=busyProject(12,23,true);
  auto reference=busyEngine(b,processing(0)),normal=busyEngine(b,processing(2,RenderAhead::Normal,block)),high=busyEngine(b,processing(0,RenderAhead::High,block));
  check(high->snapshot().workerThreads==1,"Render-ahead without processing threads has no worker");
  auto edited=b.project;edited.revision=5;edited.tracks[4].notes.pop_back(); // Structural: every engine resets every track.
  auto other=b.project;other.projectId="other";
  std::uint32_t mostAhead=0;
  const auto commands=[&](RenderEngine&e,std::size_t k) {
    switch(k) {
      case 0:check(e.play(),"Play failed");break;
      case 150:check(e.seek(20000),"Seek failed");break;
      case 300:{const std::array<std::uint32_t,1>ids{2};check(e.setMonitoring(ids),"Monitor failed");break;}
      case 400:check(e.setMonitoring({}),"Monitor clear failed");break;
      case 500:e.submit(e.prepare(edited,b.assets,b.sets,testInstruments()));break;
      case 700:check(e.pause(),"Pause failed");break;
      case 705:check(e.play(),"Play failed");break;
      case 706:check(e.seek(15000),"Seek failed");break;
      case 800:e.submit(e.prepare(other,b.assets,b.sets,testInstruments()));break;
      case 801:check(e.play(),"Play failed");break;
      default:break;
    }
    if(k%50==0)e.collectRetired();
    if(&e!=reference.get())mostAhead=std::max(mostAhead,e.snapshot().renderAheadTracks);
  };
  // 1100 buffers cross several cycle wraps (every 375 buffers), before and after each edit.
  const auto outs=drive({reference.get(),normal.get(),high.get()},1100,[](std::size_t){return block;},commands);
  check(mostAhead>=10,"Non-live tracks did not render ahead");
  for(std::size_t i=1;i<3;++i) {
    // A newly monitored track joins the callback after its ring drains (<= 1 + 4 buffers);
    // a pause cuts the tails ahead tracks had already rendered until the next seek.
    bitIdentical(outs[0],outs[i],"Render-ahead differs from callback rendering",0,300*block);
    bitIdentical(outs[0],outs[i],"Render-ahead differs after a track became monitored",306*block,700*block);
    bitIdentical(outs[0],outs[i],"Render-ahead differs after pause and seek",706*block);
  }
  check(normal->snapshot().renderAheadResyncs==0&&high->snapshot().renderAheadResyncs==0,"A render-ahead ring lost sync");
  check(workerHeapOperations.load()==0,"A render-ahead worker allocated or freed heap storage");

  // A mix edit keeps voices and rings: it is heard up to the ahead window late, then converges.
  auto mix=b.project;mix.revision=9;mix.tracks[0].gain=.6f;mix.tracks[3].pan=.5f;
  auto plain=busyEngine(b,processing(0)),ahead=busyEngine(b,processing(2,RenderAhead::High,block));
  const auto edits=drive({plain.get(),ahead.get()},600,[](std::size_t){return block;},[&](RenderEngine&e,std::size_t k) {
    if(k==0)check(e.play(),"Play failed");
    if(k==200)e.submit(e.prepare(mix,b.assets,b.sets,testInstruments()));
  });
  bitIdentical(edits[0],edits[1],"Render-ahead differs before a mix edit",0,200*block);
  const std::vector<float>lateA(edits[0].begin()+static_cast<std::ptrdiff_t>(400*block*2),edits[0].end()),lateB(edits[1].begin()+static_cast<std::ptrdiff_t>(400*block*2),edits[1].end());
  check(maxDifference(lateA,lateB)<1e-5,"A mix edit on an ahead track did not converge to the callback result");
  check(ahead->snapshot().renderAheadTracks>0,"A mix edit stopped render-ahead");
}

void renderAheadLiveTracks(){
  constexpr std::uint32_t block=128;
  const auto b=busyProject(6,5,false);
  auto e=busyEngine(b,processing(2,RenderAhead::Normal,block));check(e->play(),"Play failed");
  std::vector<float>out(block*2);std::vector<float>input(block*2,.1f);
  const auto run=[&](int blocks){for(int k=0;k<blocks;++k)rt(*e,out.data(),input.data(),block,2);};
  const auto applied=[&](std::uint64_t ticket){int waited=0;while(e->snapshot().lastAppliedCommand<ticket){run(1);check(++waited<=4,"A live command waited longer than the ahead window");}};
  run(20);const auto ahead=e->snapshot().renderAheadTracks;check(ahead==6,"Eligible playing tracks did not render ahead");
  applied(e->noteOn(0,72,1,900));check(e->snapshot().renderAheadTracks==ahead-1,"A played track kept rendering ahead");
  run(150);check(e->snapshot().renderAheadTracks==ahead-1,"A played track rendered ahead again within its two-second hold");
  {const std::array<std::uint32_t,1>ids{3};applied(e->setMonitoring(ids));}
  check(e->snapshot().renderAheadTracks==ahead-2,"A monitored track kept rendering ahead");
  const std::array<std::uint32_t,1>armed{4};applied(e->startRecording(e->planRecording(armed)));
  check(e->snapshot().recording&&e->snapshot().renderAheadTracks==ahead-3,"A recording track kept rendering ahead");
  applied(e->stopRecording());std::vector<float>drain(4096);while(e->drainRecording(drain.data(),4096)){}
  applied(e->noteOff(0,72,900));run(800); // Past the two-second hold: the played track renders ahead again.
  check(e->snapshot().renderAheadTracks==ahead-1,"Tracks did not return to render-ahead once no longer live");
  applied(e->pause());check(e->snapshot().renderAheadTracks==0,"Paused tracks still render ahead");
  check(e->snapshot().renderAheadResyncs==0,"A render-ahead ring lost sync");
}

void processingStress(){
  workerHeapOperations=0;
  const auto b=busyProject(64,31,true);
  auto single=busyEngine(b,processing(0),false,256),four=busyEngine(b,processing(4),false,256),ahead=busyEngine(b,processing(3,RenderAhead::High,128),false,256);
  std::uint32_t rng=4242;
  const auto sizes=[&](std::size_t)->std::uint32_t{rng=rng*1664525u+1013904223u;const auto r=rng>>8;return r%4?1+r%300:1+r%900;};
  const auto commands=[&](RenderEngine&e,std::size_t k) {
    if(k==0)check(e.play(),"Play failed");
    if(k==250)check(e.seek(50000),"Seek failed");
    if(k%40==0)e.collectRetired();
  };
  const auto outs=drive({single.get(),four.get(),ahead.get()},700,sizes,commands);
  bitIdentical(outs[0],outs[1],"Four worker threads changed the mix under random buffer sizes");
  // Render-ahead keeps whole blocks of the previous buffer size, so varying
  // buffers split blocks differently: equal up to block-size rounding only.
  check(maxDifference(outs[0],outs[2])<1e-4,"Render-ahead under random buffer sizes diverged from callback rendering");
  check(ahead->snapshot().renderAheadResyncs==0,"A render-ahead ring lost sync under random buffer sizes");
  check(workerHeapOperations.load()==0,"An engine worker allocated or freed heap storage under stress");
}
} // namespace

// Rack-only pedals (fuzz 7, phaser 8, tremolo 9, reverb 10, tuner 11): each changes the audio only when
// it is both in the rack and switched on; the tuner mutes; the reverb rings on after the input stops.
Parameters rigRack(std::initializer_list<int> codes,Parameters extra={}){
  int slot=0;for(int code:codes)extra["rackSlot"+std::to_string(slot++)]=code;
  for(;slot<10;++slot)extra["rackSlot"+std::to_string(slot)]=0;
  return extra;
}
std::vector<float> rigRender(const Parameters&params,const std::vector<float>&input,std::uint32_t frames){
  auto rig=dsp::makeEffect("guitar-rig",params,48000,120);auto output=input;allocations=deallocations=0;watchAllocations=true;
  for(std::uint32_t at=0;at<frames;at+=128)rig->process(output.data()+2*at,std::min<std::uint32_t>(128,frames-at));
  watchAllocations=false;check(!allocations&&!deallocations,"Guitar rig pedal allocated in its callback");
  for(auto v:output)check(std::isfinite(v),"Guitar rig pedal produced non-finite audio");
  return output;
}
double rigDifference(const std::vector<float>&a,const std::vector<float>&b){double d=0;for(std::size_t i=0;i<a.size();++i)d+=std::abs(a[i]-b[i]);return d/a.size();}
void guitarRigPedalsAndTuner(){
  constexpr std::uint32_t frames=24000;
  std::vector<float>input(frames*2);for(std::size_t i=0;i<frames;++i)input[2*i]=input[2*i+1]=static_cast<float>(.2*std::sin(2*dsp::pi*220*i/48000));
  const struct{int code;const char*enabled;const char*knob;double other;}pedals[]={{7,"fuzzEnabled","fuzzTone",.9},{8,"phaserEnabled","phaserRate",3},{9,"tremoloEnabled","tremoloDepth",1},{10,"reverbEnabled","reverbMix",.8}};
  for(const auto&pedal:pedals){
    const auto dry=rigRender(rigRack({pedal.code}),input,frames);
    checkSame(input,dry,0,"A switched-off rack pedal is not transparent");
    const auto on=rigRender(rigRack({pedal.code},{{pedal.enabled,1}}),input,frames);
    check(rigDifference(input,on)>1e-3,"A rack pedal did not change the audio when switched on");
    const auto knob=rigRender(rigRack({pedal.code},{{pedal.enabled,1},{pedal.knob,pedal.other}}),input,frames);
    check(rigDifference(on,knob)>1e-4,"A rack pedal knob did not change the audio");
    const auto outside=rigRender(rigRack({},{{pedal.enabled,1}}),input,frames);
    checkSame(input,outside,0,"A pedal outside the rack still processed audio");
  }
  // Fuzz reports its oversampling delay only when it can be heard.
  check(dsp::makeEffect("guitar-rig",rigRack({7},{{"fuzzEnabled",1}}),48000,120)->latencyFrames()==8,"Fuzz latency was not reported");
  check(dsp::makeEffect("guitar-rig",rigRack({7}),48000,120)->latencyFrames()==0,"Bypassed fuzz reported latency");
  // Tuner engaged = silence after it; off = transparent.
  const auto tunerOff=rigRender(rigRack({11}),input,frames);checkSame(input,tunerOff,0,"Disengaged tuner is not transparent");
  const auto tunerOn=rigRender(rigRack({11},{{"tunerEnabled",1}}),input,frames);check(energy(tunerOn)==0,"Engaged tuner did not mute the output");
  // Reverb: a tail after an impulse-like burst and a reported tail length; longer decay rings longer.
  std::vector<float>burst(frames*2);for(std::size_t i=0;i<480;++i)burst[2*i]=burst[2*i+1]=static_cast<float>(.5*std::sin(2*dsp::pi*440*i/48000));
  const auto shortVerb=rigRender(rigRack({10},{{"reverbEnabled",1},{"reverbDecay",0},{"reverbMix",.8}}),burst,frames);
  const auto longVerb=rigRender(rigRack({10},{{"reverbEnabled",1},{"reverbDecay",1},{"reverbMix",.8}}),burst,frames);
  double tailShort=0,tailLong=0;for(std::size_t i=2*12000;i<burst.size();++i){tailShort+=shortVerb[i]*shortVerb[i];tailLong+=longVerb[i]*longVerb[i];}
  check(tailLong>1e-6,"Reverb produced no tail after the input stopped");check(tailLong>tailShort,"Reverb decay did not lengthen the tail");
  near(dsp::makeEffect("guitar-rig",rigRack({10},{{"reverbEnabled",1}}),48000,120)->tailSeconds(),4.45,1e-9,"Reverb tail length");
  check(dsp::makeEffect("guitar-rig",rigRack({10}),48000,120)->tailSeconds()==0,"Bypassed reverb reported a tail");
  // Order still matters with the new pedals: fuzz before vs after the tremolo.
  const Parameters both{{"fuzzEnabled",1},{"tremoloEnabled",1},{"tremoloDepth",1}};
  const auto fuzzFirst=rigRender(rigRack({7,9},both),input,frames),tremFirst=rigRender(rigRack({9,7},both),input,frames);
  check(rigDifference(fuzzFirst,tremFirst)>1e-3,"Moving the fuzz after the tremolo did not change the processing order");
  // The default rack (no new modules) is unchanged by the new parameters' defaults.
  const auto legacy=rigRender({},input,frames),explicitDefaults=rigRender({{"fuzzGain",26},{"reverbMix",.25},{"tunerEnabled",0}},input,frames);
  checkSame(legacy,explicitDefaults,0,"New pedal defaults changed the default rack");
  rejects([]{(void)dsp::makeEffect("guitar-rig",{{"rackSlot0",44}},48000,120);},"Out-of-range rack slot value was accepted");
  const auto unknown=rigRender(rigRack({12,15,16+12}),input,frames);checkSame(input,unknown,0,"An unknown rack module code still processed audio");
}
std::uint64_t pcmHash(const std::vector<float>&data){std::uint64_t h=1469598103934665603ull;for(auto v:data){std::uint32_t bits;std::memcpy(&bits,&v,4);for(int b=0;b<4;++b){h^=(bits>>(8*b))&255u;h*=1099511628211ull;}}return h;}
// Repeated rack modules: slot value = module code + 16 x instance; instance k > 0 reads `<param>_<k+1>`.
void guitarRigInstances(){
  constexpr std::uint32_t frames=24000;
  std::vector<float>input(frames*2);for(std::size_t i=0;i<frames;++i)input[2*i]=input[2*i+1]=static_cast<float>(.2*std::sin(2*dsp::pi*220*i/48000));
  // A single-instance project renders bit-identically to the pre-instance engine, including a live rebuild.
  const Parameters full{{"driveEnabled",1},{"chorusEnabled",1},{"delayEnabled",1},{"fuzzEnabled",1},{"phaserEnabled",1},{"tremoloEnabled",1},{"reverbEnabled",1},{"ampModel",2},{"cabinet",3},{"micType",4},
    {"rackSlot0",1},{"rackSlot1",7},{"rackSlot2",2},{"rackSlot3",3},{"rackSlot4",4},{"rackSlot5",8},{"rackSlot6",5},{"rackSlot7",9},{"rackSlot8",6},{"rackSlot9",10}};
  auto first=dsp::makeEffect("guitar-rig",full,48000,120);auto a=input;for(std::uint32_t at=0;at<frames;at+=128)first->process(a.data()+2*at,std::min<std::uint32_t>(128,frames-at));
  Parameters edited=full;edited["driveGain"]=20;edited["ampBass"]=5;edited["delayTime"]=500;
  auto second=dsp::makeEffect("guitar-rig",edited,48000,120);second->takeStateFrom(*first);auto b=input;for(std::uint32_t at=0;at<frames;at+=128)second->process(b.data()+2*at,std::min<std::uint32_t>(128,frames-at));
  // Golden values recorded from the single-instance engine before repeated modules were added.
  // The hashes were recorded on x86-64 (MSVC and MinGW agree). Other targets (Apple Silicon: FMA contraction and a
  // different libm) round the last bits differently, so the golden comparison only runs where it was recorded.
#if defined(__x86_64__) || defined(_M_X64)
  check(pcmHash(a)==6328021044086178046ull,"Single-instance guitar rig output changed");
  check(pcmHash(b)==12222664419027344049ull,"Single-instance guitar rig rebuild output changed");
#else
  (void)pcmHash;
#endif
  check(second->latencyFrames()==32,"Single-instance guitar rig latency changed");near(second->tailSeconds(),8.84,1e-12,"Single-instance guitar rig tail changed");
  // Slot value 2 + 16 is a second drive: alone (with its own switch) it sounds like the first drive alone.
  const auto drive1=rigRender(rigRack({2},{{"driveEnabled",1}}),input,frames);
  const auto drive2=rigRender(rigRack({2+16},{{"driveEnabled_2",1}}),input,frames);
  checkSame(drive1,drive2,0,"A second drive instance did not parse as a drive");
  checkSame(input,rigRender(rigRack({2+16},{{"driveEnabled",1}}),input,frames),0,"A second drive instance followed the first drive's switch");
  // Two drives in series differ from one; the second instance reads its own knobs.
  const auto twoDrives=rigRender(rigRack({2,2+16},{{"driveEnabled",1},{"driveEnabled_2",1}}),input,frames);
  check(rigDifference(drive1,twoDrives)>1e-3,"Two drives in series sounded like one");
  const auto hotter=rigRender(rigRack({2,2+16},{{"driveEnabled",1},{"driveEnabled_2",1},{"driveGain_2",28}}),input,frames);
  check(rigDifference(twoDrives,hotter)>1e-4,"driveGain_2 did not affect the second drive");
  check(dsp::makeEffect("guitar-rig",rigRack({2,2+16,2+32},{{"driveEnabled",1},{"driveEnabled_2",1},{"driveEnabled_3",1}}),48000,120)->latencyFrames()==24,"Drive instances did not sum their latency");
  // A repeated (code, instance) is skipped; a third instance is allowed, a fourth (2 + 48) is out of range.
  checkSame(drive1,rigRender(rigRack({2,2},{{"driveEnabled",1}}),input,frames),0,"A repeated drive slot was processed twice");
  rejects([]{(void)dsp::makeEffect("guitar-rig",{{"rackSlot0",2+48}},48000,120);},"A fourth module instance was accepted");
  // Only one tuner: instance 1 (11 + 16) is ignored even with its switch on.
  rejects([]{(void)dsp::makeEffect("guitar-rig",{{"tunerEnabled_2",1}},48000,120);},"A second tuner's parameter was accepted");
  const auto tuner2=rigRender(rigRack({11+16},{{"tunerEnabled",1}}),input,frames);checkSame(input,tuner2,0,"A second tuner instance was not ignored");
  // Instance parameters of every module exist with the base ranges.
  for(const char*name:{"compSustain_3","ampModel_2","cabinetEnabled_2","micType_2","micDistance_3","chorusMix_2","delayFeedback_3","fuzzLevel_2","phaserFeedback_3","tremoloShape_2","reverbMix_3"})
    (void)dsp::makeEffect("guitar-rig",{{name,0}},48000,120);
  rejects([]{(void)dsp::makeEffect("guitar-rig",{{"ampModel_2",5}},48000,120);},"An instance parameter ignored the base range");
  // Live rebuilds carry state by (code, instance): inserting a module before the second delay keeps its echoes.
  std::vector<float>burst(frames*2);for(std::size_t i=0;i<480;++i)burst[2*i]=burst[2*i+1]=static_cast<float>(.5*std::sin(2*dsp::pi*440*i/48000));
  const Parameters echo{{"delayEnabled_2",1},{"delayMix_2",.6},{"delayFeedback_2",.6},{"delayTime_2",200}};
  auto before=dsp::makeEffect("guitar-rig",rigRack({6+16},echo),48000,120);auto head=burst;before->process(head.data(),6000);
  auto after=dsp::makeEffect("guitar-rig",rigRack({8,6+16},echo),48000,120);after->takeStateFrom(*before);
  std::vector<float>silence(12000*2);after->process(silence.data(),12000);check(energy(silence)>1e-4,"Rebuilt rig dropped the second delay's echoes");
  check(dsp::makeEffect("guitar-rig",rigRack({6,6+16},{{"delayEnabled",1},{"delayEnabled_2",1}}),48000,120)->tailSeconds()>dsp::makeEffect("guitar-rig",rigRack({6},{{"delayEnabled",1}}),48000,120)->tailSeconds(),"Delay instances did not sum their tails");
}
// Dynamics meters for the compressor/limiter/gate views: per-insert input peak and
// gain reduction reach the snapshot keyed by the timeline insert index, with no
// allocation in the callback (render() checks every block).
// Unit impulses per level make every click's exact frame and level visible.
std::shared_ptr<const MetronomeClicks> impulseClicks(){auto c=std::make_shared<MetronomeClicks>();c->sampleRate=48000;c->levels={std::vector<float>{1.f},std::vector<float>{.5f},std::vector<float>{.25f}};return c;}
void checkClicks(const std::vector<float>&out,const std::vector<std::pair<std::size_t,float>>&expected,const char*message){
  std::vector<float>want(out.size()/2,0.f);for(const auto&[frame,value]:expected)want[frame]=value;
  for(std::size_t i=0;i<want.size();++i){near(out[2*i],want[i],1e-7,message);near(out[2*i+1],want[i],1e-7,message);}
}
// Tempo map (docs/TEMPO_MAP.md): garak/tempo.hpp must place beats on the same frames as src/core/tempoMap.ts.
// The expected frames below were computed by the TypeScript map (closed-form ramp integrals, not hashes).
void tempoMapFrames(){
  const TempoMap map(100,{{0,100,true},{6,180,false},{10,75,true},{18.5,75.5,true},{30,210,false}});
  const std::vector<std::pair<double,double>> ts{{0.5,13940.320566},{3,72678.003110},{6,126961.919619},{7.25,146961.919619},{10,190961.919619},{14,344321.481189},{18.5,516278.731125},{22,622951.886684},{30,768181.540361},{33.3,813438.683218}};
  for(const auto&[beat,frame]:ts){near(map.frameAt(beat,48000),frame,1,"Native tempo map disagrees with the TypeScript frames by more than one sample");near(map.frameAt(beat,48000),frame,1e-3,"Native tempo map drifted from the TypeScript closed form");}
  for(double beat=-2;beat<40;beat+=.37)near(map.beatAtFrame(map.frameAt(beat,48000),48000),beat,1e-9,"Tempo map beat/frame round trip failed");
  // An independent midpoint integral of 60/bpm(b) agrees with the closed form inside a ramp.
  double seconds=0;const int steps=200000;for(int i=0;i<steps;++i)seconds+=60/map.bpmAt(10+8.5*(i+.5)/steps)*8.5/steps;
  near(map.secondsAt(18.5)-map.secondsAt(10),seconds,1e-8,"Ramp integral is not exact");
  near(map.bpmAt(3),140,1e-12,"Ramp tempo is not linear in beats");check(map.bpmAt(8)==180&&map.bpmAt(40)==210,"Step tempo is wrong");
  check(TempoMap(120,{}).constant()&&!map.constant(),"Constant tempo detection failed");
  // Ramp 90→150 over two bars, then 150: clicks land on the TypeScript frames through the accelerando.
  auto p=project(48000,48000*6);p.bpm=90;p.tempoMap={{0,90,true},{8,150,false}};
  const std::vector<std::size_t> frames{0,30736,59194,85687,110470,133750,155699,176460,196157,215357,234557,253757,272957};
  {RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.setMetronome(impulseClicks(),true,1),"Metronome command failed");check(e.play(),"Play failed");
   std::vector<std::pair<std::size_t,float>> want;for(std::size_t i=0;i<frames.size();++i)want.push_back({frames[i],i%4?.25f:1.f});
   checkClicks(render(e,272958,97),want,"Metronome clicks do not follow the tempo ramp");}
  // A count-in from inside the ramp clicks evenly at the tempo where the transport starts (120 BPM at beat 4).
  {RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.setMetronome(impulseClicks(),false,1),"Metronome command failed");check(e.seek(110470),"Seek failed");check(e.play(96000),"Count-in play failed");
   checkClicks(render(e,96000,89),{{0,1.f},{24000,.25f},{48000,.25f},{72000,.25f}},"Count-in inside a tempo map does not use the local tempo");}
  // Tempo-synced effects follow setTempo: a 1-beat delay at 120 BPM echoes 24000 frames late, at 60 BPM 48000.
  auto delay=dsp::makeEffect("delay",{{"sync",1},{"time",1},{"amount",1},{"feedback",0},{"tone",16000},{"lowcut",20}},48000,120);
  delay->setTempo(60);std::vector<float>settle(48000*2,0.f);delay->process(settle.data(),48000);
  std::vector<float>pulse(60000*2,0.f);pulse[0]=pulse[1]=1;delay->process(pulse.data(),60000);
  std::size_t peak=1;for(std::size_t i=1;i<60000;++i)if(std::abs(pulse[2*i])>std::abs(pulse[2*peak]))peak=i;
  check(peak>=47990&&peak<=48010,"Synced delay did not follow the new tempo");
}
void metronomeClicks(){
  // 120 BPM 4/4: a quarter is 24000 frames; the bar downbeat is accented.
  auto p=project(48000,48000*8);
  {RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.setMetronome(impulseClicks(),true,1),"Metronome command failed");check(e.play(),"Play failed");
   checkClicks(render(e,48000*2+10,77),{{0,1.f},{24000,.25f},{48000,.25f},{72000,.25f},{96000,1.f}},"4/4 clicks are not on exact sample frames");}
  // 6/8: eighth pulses (12000 frames), dotted-quarter group accent on pulse 3.
  {auto m=p;m.timeSigNumerator=6;m.timeSigDenominator=8;RenderEngine e(48000,256);e.submit(e.prepare(m,{}));check(e.setMetronome(impulseClicks(),true,.5f),"Metronome command failed");check(e.play(),"Play failed");
   checkClicks(render(e,72001,61),{{0,.5f},{12000,.125f},{24000,.125f},{36000,.25f},{48000,.125f},{60000,.125f},{72000,.5f}},"Compound meter grouping or volume is wrong");}
  // Cycle 12000-36000: the click at 24000 repeats on every pass, never doubled at the wrap.
  {auto c=p;c.cycle=std::array<std::int64_t,2>{12000,36000};RenderEngine e(48000,256);e.submit(e.prepare(c,{}));check(e.setMetronome(impulseClicks(),true,1),"Metronome command failed");check(e.play(),"Play failed");
   checkClicks(render(e,36000+48000,100),{{0,1.f},{24000,.25f},{48000,.25f},{72000,.25f}},"Clicks did not follow the loop wrap");}
  // Count-in: one bar while the transport holds; it starts exactly after, as does a waiting capture.
  {auto r=p;TrackTimeline t;t.id="input";r.tracks.push_back(t);RenderEngine e(48000,256,48000*4);e.submit(e.prepare(r,{}));check(e.setMetronome(impulseClicks(),false,1),"Metronome command failed");
   check(e.seek(4800),"Seek failed");check(e.play(96000),"Count-in play failed");std::array<float,2>none{};rt(e,none.data(),nullptr,0);
   check(e.snapshot().playing&&e.snapshot().frame==4800,"Count-in did not hold the transport while reporting playback");
   check(e.startRecording(),"Record start failed");
   const auto counting=render(e,96000,89);check(e.snapshot().frame==4800&&e.snapshot().recordedFrames==0,"Transport or capture moved during the count-in");
   check(e.snapshot().recordingStartFrame==4800,"Count-in take does not start at the transport position");
   checkClicks(counting,{{0,1.f},{24000,.25f},{48000,.25f},{72000,.25f}},"Count-in clicks are wrong");
   const auto after=render(e,48000,89);check(e.snapshot().frame==4800+48000&&e.snapshot().recordedFrames==48000,"Transport and capture did not start right after the count-in");
   checkClicks(after,{},"Metronome off still clicked after the count-in");(void)e.stopRecording();}
  // Export: an offline engine never clicks, even with a metronome set.
  {RenderEngine e(48000,256);e.setOffline(true);e.submit(e.prepare(p,{}));check(e.setMetronome(impulseClicks(),true,1),"Metronome command failed");check(e.play(96000),"Play failed");
   checkClicks(render(e,48000,128),{},"Offline export rendered metronome clicks");check(e.snapshot().frame==48000,"Offline engine honored a count-in");}
  // A click set for another rate is ignored rather than played at the wrong speed.
  {RenderEngine e(44100,256);auto q=project(44100,44100*4);e.submit(e.prepare(q,{}));check(e.setMetronome(impulseClicks(),true,1),"Metronome command failed");check(e.play(),"Play failed");checkClicks(render(e,1000),{},"Mismatched-rate clicks played");}
}

void dynamicsMeters(){
  auto p=project(48000,96000);TrackTimeline t;t.id="audio";t.audio.push_back({1,"sine",0,24000,0,48000,0,24000,1,0,0});
  std::vector<float>pcm(24000);for(std::size_t i=0;i<pcm.size();++i)pcm[i]=static_cast<float>(.5*std::sin(2*dsp::pi*220*i/48000));
  AssetStore assets{{"sine",asset("sine",48000,std::move(pcm))}};
  t.inserts.push_back({"off","eq",false,{},{}});
  t.inserts.push_back({"comp","compressor",true,{{"threshold",-40},{"ratio",10},{"attack",1}},{}});
  t.inserts.push_back({"open","gate",true,{{"threshold",-80}},{}});
  t.inserts.push_back({"lim","limiter",true,{{"gain",24},{"ceiling",-24}},{}});
  p.tracks.push_back(t);
  RenderEngine e(48000,512);e.submit(e.prepare(p,assets));check(e.play(),"Play failed");(void)render(e,20000,256);
  const auto s=e.snapshot();check(s.dynamicsCount==3,"Expected one dynamics reading per enabled compressor/gate/limiter");
  const auto&comp=s.dynamics[0],&gate=s.dynamics[1],&lim=s.dynamics[2];
  check(comp.track==0&&comp.insert==1&&gate.insert==2&&lim.insert==3,"Dynamics readings lost their timeline insert index");
  check(comp.input>.05&&comp.input<4,"Compressor input level is not plausible");
  const double compDb=20*std::log10(comp.gain),inDb=20*std::log10(comp.input);
  // Hard-knee expectation: (in - threshold) * (1 - 1/ratio) dB of reduction; allow the envelope ripple.
  near(-compDb,(inDb+40)*.9,1.5,"Compressor gain reduction does not follow threshold/ratio");
  check(gate.gain>.9,"An open gate reported reduction");
  check(lim.gain<.5&&lim.input>.005,"Limiter driven 24 dB into a -24 dB ceiling reported no reduction");
  // After the note ends the hold falls: input decays and the gain recovers.
  (void)render(e,48000,256);const auto quiet=e.snapshot();
  check(quiet.dynamics[0].input<comp.input*.5&&quiet.dynamics[0].gain>comp.gain,"Dynamics meter did not fall back after the signal stopped");
}

#include "eq_test.inc"

// Sustain pedal (docs/SUSTAIN_PEDAL.md). Behavioural comparisons against reference engines, never golden PCM.
void sustainPedal(){
  // VST3 timeline: CC64 events arrive at their exact block offsets; same-sample order is controller, off, on.
  auto plugin=std::make_shared<TestPlugin>();plugin->instrument=true;auto p=project(48000,1000);
  TrackTimeline track;track.id="vst";track.source.kind=TrackSource::Kind::Vst3;track.source.plugin.instanceId="synth";track.source.plugin.isInstrument=true;
  track.notes={{1,10,20,1000,60,.7f},{2,20,40,1000,62,.7f}};track.controls={{5,64,127},{20,64,0},{20,64,127},{30,64,0}};p.tracks.push_back(track);
  RenderEngine e(48000,64);e.submit(e.prepare(p,{}, {},[&](const PluginSpec&,double,unsigned){return plugin;}));check(e.play(),"Play failed");(void)render(e,64,64);
  std::vector<PluginEvent> got(plugin->received.begin(),plugin->received.begin()+static_cast<std::ptrdiff_t>(plugin->eventCount));
  const auto controller=[](const PluginEvent&x,std::uint32_t offset,float value){return x.type==PluginEvent::Type::Controller&&x.parameterId==64&&x.offset==offset&&std::abs(x.value-value)<1e-6f;};
  check(got.size()>=8,"VST3 sustain events were lost");
  // Play chases the (up) pedal at frame 0 first: a CC64 = 0 at offset 0.
  check(controller(got[0],0,0),"Play did not chase the pedal state at the start position");
  check(controller(got[1],5,1),"Pedal down not delivered at its exact sample");
  check(got[2].type==PluginEvent::Type::NoteOn&&got[2].offset==10,"Note-on offset");
  check(controller(got[3],20,0)&&controller(got[4],20,1),"Same-sample pedal change lost its order");
  check(got[5].type==PluginEvent::Type::NoteOff&&got[5].offset==20&&got[6].type==PluginEvent::Type::NoteOn&&got[6].offset==20,"A pedal change must precede note-off and note-on at the same sample");
  check(controller(got[7],30,0),"Pedal up not delivered at its exact sample");
  // Seeking into a pedal-down span chases the pedal before any chased note; stopping lifts it.
  plugin->eventCount=0;check(e.seek(25),"Seek failed");(void)render(e,16,16);
  check(plugin->eventCount>=1&&controller(plugin->received[0],0,1),"Seek did not chase a held pedal");
  plugin->eventCount=0;check(e.stop(),"Stop failed");(void)render(e,16,16);
  check(plugin->eventCount>=1&&controller(plugin->received[0],0,0),"Stop did not lift the timeline pedal");
  // Live CC to a VST3 instrument is forwarded unchanged.
  plugin->eventCount=0;check(e.controlChange(0,64,100),"Live control change failed");(void)render(e,16,16);
  check(plugin->eventCount==1&&controller(plugin->received[0],0,100.f/127),"Live CC64 was not forwarded to the VST3 instrument");
  // A sustain track without controls never receives stray controller events.
  auto plain=p;plain.tracks[0].controls.clear();auto quiet=std::make_shared<TestPlugin>();quiet->instrument=true;
  RenderEngine q(48000,64);q.submit(q.prepare(plain,{}, {},[&](const PluginSpec&,double,unsigned){return quiet;}));check(q.play(),"Play failed");(void)render(q,64,64);
  check(std::none_of(quiet->received.begin(),quiet->received.begin()+static_cast<std::ptrdiff_t>(quiet->eventCount),[](const PluginEvent&x){return x.type==PluginEvent::Type::Controller;}),"Controller events sent without pedal data");

  // Built-in live sustain: while down, a note-off is deferred (output equals a held note); the release starts on
  // the exact frame the pedal lifts (output equals a note-off sent there); re-striking ends the sustained note.
  auto live=project();TrackTimeline t;t.id="live";t.source.kind=TrackSource::Kind::BuiltinSynth;t.source.instrumentId="keys";t.source.params={{"release",.1}};live.tracks.push_back(t);
  RenderEngine pedal,held,released;for(auto*x:{&pedal,&held,&released})x->submit(x->prepare(live,{}));
  check(pedal.noteOn(0,60,.8f,1)&&held.noteOn(0,60,.8f,1)&&released.noteOn(0,60,.8f,1),"Live note on failed");
  auto a=render(pedal,300),b=render(held,300),c=render(released,300);checkSame(a,b,0,"Live voices diverged before the pedal");
  check(pedal.controlChange(0,64,127)&&pedal.noteOff(0,60,1),"Pedal/note-off failed");
  a=render(pedal,4000);b=render(held,4000);(void)render(released,4000);checkSame(a,b,0,"A note-off under the pedal was not deferred");
  check(energy(a)>1e-4,"Sustained live note went silent");
  check(pedal.controlChange(0,64,0)&&released.noteOff(0,60,1),"Pedal up failed");
  a=render(pedal,8000);c=render(released,8000);checkSame(a,c,0,"Pedal up did not release exactly like a note-off at that frame");
  for(std::size_t i=7000*2;i<a.size();++i)near(a[i],0,0,"Released voice kept ringing after the pedal lifted");
  // Retrigger under the pedal: identical to releasing the first note right at the second strike.
  RenderEngine restrike,reference;for(auto*x:{&restrike,&reference})x->submit(x->prepare(live,{}));
  check(restrike.controlChange(0,64,127)&&restrike.noteOn(0,64,.8f,5),"Restrike setup failed");check(reference.noteOn(0,64,.8f,5),"Reference setup failed");
  (void)render(restrike,500);(void)render(reference,500);
  check(restrike.noteOff(0,64,5),"Deferred note-off failed");(void)render(restrike,500);(void)render(reference,500);
  check(restrike.noteOn(0,64,.6f,6)&&reference.noteOff(0,64,5)&&reference.noteOn(0,64,.6f,6),"Restrike failed");
  checkSame(render(restrike,6000),render(reference,6000),0,"Re-striking a sustained key did not end its previous note");
  // A panic lifts the live pedal: the next note-off releases immediately.
  check(restrike.allNotesOff(0)&&reference.allNotesOff(0),"Panic failed");(void)render(restrike,6000);(void)render(reference,6000);
  check(restrike.noteOn(0,67,.8f,9)&&reference.noteOn(0,67,.8f,9),"Note after panic failed");(void)render(restrike,300);(void)render(reference,300);
  check(restrike.noteOff(0,67,9)&&reference.noteOff(0,67,9),"Note-off after panic failed");
  checkSame(render(restrike,6000),render(reference,6000),0,"Pedal survived a panic");
  // Invalid controller numbers and values are rejected on the control thread.
  rejects([&]{(void)pedal.controlChange(0,64,128);},"Out-of-range controller value accepted");
  rejects([&]{(void)pedal.controlChange(0,132,0);},"Out-of-range controller number accepted");
  rejects([&]{(void)pedal.controlChange(0,129,8192);},"Out-of-range pitch bend accepted");
  rejects([&]{(void)pedal.controlChange(0,131,49);},"Out-of-range bend range accepted");
}

// MIDI controllers (docs/MIDI_CONTROLLERS.md). Measured pitch and level, never golden PCM.
// Positive-going zero crossings of the left channel with sub-sample interpolation, in [first, last) frames.
std::vector<double> crossings(const std::vector<float>&d,std::size_t first,std::size_t last){
  std::vector<double>result;
  for(std::size_t i=first+1;i<last;++i){const double a=d[(i-1)*2],b=d[i*2];if(a<0&&b>=0)result.push_back(static_cast<double>(i-1)+a/(a-b));}
  return result;
}
double frequencyOf(const std::vector<float>&d,std::size_t first,std::size_t last,double rate=48000){
  const auto x=crossings(d,first,last);check(x.size()>2,"No periodic signal to measure");
  return static_cast<double>(x.size()-1)*rate/(x.back()-x.front());
}
// Spread (cents) between the fastest and slowest single cycle.
double cycleSpreadCents(const std::vector<float>&d,std::size_t first,std::size_t last){
  const auto x=crossings(d,first,last);check(x.size()>3,"No periodic signal to measure");
  double shortest=1e9,longest=0;for(std::size_t i=1;i<x.size();++i){shortest=std::min(shortest,x[i]-x[i-1]);longest=std::max(longest,x[i]-x[i-1]);}
  return 1200*std::log2(longest/shortest);
}
double rmsOf(const std::vector<float>&d,std::size_t first,std::size_t last){double sum=0;for(std::size_t i=first*2;i<last*2;++i)sum+=static_cast<double>(d[i])*d[i];return std::sqrt(sum/static_cast<double>((last-first)*2));}
void midiControllers(){
  auto base=project(48000,96000);TrackTimeline t;t.id="keys";t.source.kind=TrackSource::Kind::BuiltinSynth;t.source.instrumentId="keys";
  t.source.params={{"bell",0},{"sustain",1},{"release",.05}};t.notes={{1,0,96000,96000,69,.5f}};base.tracks.push_back(t);
  const auto play=[&](std::vector<ControlEvent> controls,std::uint32_t frames=24000){auto p=base;p.tracks[0].controls=std::move(controls);RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.play(),"Play failed");return render(e,frames,256);};
  const auto plain=play({});const double f0=frequencyOf(plain,2400,24000);near(f0,440,.5,"Unbent built-in pitch");
  near(frequencyOf(play({{0,129,8191}}),2400,24000)/f0,std::pow(2,2/12.0),.001,"Full pitch bend up is not two semitones");
  near(frequencyOf(play({{0,129,-8192}}),2400,24000)/f0,std::pow(2,-2/12.0),.001,"Full pitch bend down is not two semitones");
  near(frequencyOf(play({{0,131,12},{0,129,8191}}),2400,24000)/f0,2,.002,"The bend range controller was ignored");
  near(frequencyOf(play({{0,129,4096}}),2400,24000)/f0,std::pow(2,1/12.0),.001,"Half pitch bend is not one semitone");
  // Neutral values change nothing: centred bend, CC7 at 100, a program change, and an unknown controller.
  checkSame(play({{0,129,0},{0,7,100},{0,130,5},{0,74,30}}),plain,0,"Neutral controllers changed the built-in sound");
  // Expression and volume scale the level by (value/127)^2 and (value/100)^2.
  near(rmsOf(play({{0,11,90}}),2400,24000)/rmsOf(plain,2400,24000),(90.0/127)*(90.0/127),.002,"CC11 expression level");
  near(rmsOf(play({{0,7,50}}),2400,24000)/rmsOf(plain,2400,24000),.25,.002,"CC7 volume level");
  // The mod wheel (and channel pressure) add a ~±50 cent vibrato; without it every cycle has the same length.
  check(cycleSpreadCents(plain,2400,24000)<2,"Unmodulated pitch wobbles");
  const double vibrato=cycleSpreadCents(play({{0,1,127}}),2400,24000);check(vibrato>80&&vibrato<110,"Mod wheel vibrato depth");
  const double pressure=cycleSpreadCents(play({{0,128,64}}),2400,24000);check(pressure>35&&pressure<60,"Channel pressure vibrato depth");
  // A bend is smoothed: the cycle right after the event is between the old and the new pitch.
  {const auto glide=play({{12000,129,8191}});const auto x=crossings(glide,12000,12400);check(x.size()>2,"No cycles after the bend");
   const double first=48000/(x[1]-x[0]);check(first>f0*1.01&&first<f0*std::pow(2,2/12.0)*.995,"Pitch bend jumped instead of gliding");
   near(frequencyOf(glide,16800,24000)/f0,std::pow(2,2/12.0),.001,"Pitch bend did not settle");}
  // Drum kits ignore bend and vibrato.
  {auto kit=project(48000,24000);TrackTimeline d;d.id="kit";d.source.kind=TrackSource::Kind::BuiltinSynth;d.source.instrumentId="drums";d.source.isKit=true;d.notes={{1,0,2000,24000,50,.8f}};kit.tracks.push_back(d);
   auto bentKit=kit;bentKit.tracks[0].controls={{0,129,8191},{0,1,127}};RenderEngine a,b;a.submit(a.prepare(kit,{}));b.submit(b.prepare(bentKit,{}));check(a.play()&&b.play(),"Play failed");
   checkSame(render(a,6000),render(b,6000),0,"A drum kit followed pitch bend or vibrato");}
  // Seek chases the bend in effect (no glide); stop and replay from the start returns it to centre.
  {auto p=base;p.tracks[0].controls={{1000,129,8191}};RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.play(),"Play failed");(void)render(e,2048,256);
   check(e.seek(48000),"Seek failed");const auto chased=render(e,4800,256);near(frequencyOf(chased,0,4800)/f0,std::pow(2,2/12.0),.001,"Seek did not chase the pitch bend");
   check(e.stop(),"Stop failed");(void)render(e,256,256);check(e.play(),"Replay failed");const auto again=render(e,960,256);near(frequencyOf(again,0,960)/f0,1,.003,"Replay kept the chased bend before its event");}
  // Live pitch bend (and the raw 0xE0 message) bends a live note; a panic re-centres it.
  {auto live=project();TrackTimeline l=t;l.notes.clear();live.tracks.push_back(l);RenderEngine e;e.submit(e.prepare(live,{}));
   check(e.noteOn(0,69,.5f,7),"Live note failed");check(e.controlChange(0,129,8191),"Live bend failed");
   near(frequencyOf(render(e,12000),2400,12000)/f0,std::pow(2,2/12.0),.001,"Live pitch bend");
   const std::array<LiveMidiEvent,1> centre{LiveMidiEvent{0,0,0xE0,0,64,-1}};check(e.queueLiveMidi(centre)==1,"Live MIDI queue");
   near(frequencyOf(render(e,12000),2400,12000)/f0,1,.001,"Live 0xE0 centre");
   check(e.controlChange(0,1,127)&&e.allNotesOff(0),"Live mod/panic failed");(void)render(e,6000);
   check(e.noteOn(0,69,.5f,8),"Live note after panic failed");check(cycleSpreadCents(render(e,12000),2400,12000)<2,"Panic did not reset the mod wheel");}
  // VST3: every controller as a normalized, sample-accurate event; the bend range stays in the host.
  {auto plugin=std::make_shared<TestPlugin>();plugin->instrument=true;auto p=project(48000,1000);
   TrackTimeline v;v.id="vst";v.source.kind=TrackSource::Kind::Vst3;v.source.plugin.instanceId="synth";v.source.plugin.isInstrument=true;
   v.notes={{1,10,500,1000,60,.7f}};v.controls={{5,129,8191},{6,128,64},{7,1,127},{8,131,12},{9,7,90},{9,129,-8192}};p.tracks.push_back(v);
   RenderEngine e(48000,64);e.submit(e.prepare(p,{}, {},[&](const PluginSpec&,double,unsigned){return plugin;}));check(e.play(),"Play failed");(void)render(e,64,64);
   std::vector<PluginEvent> got;for(std::size_t i=0;i<plugin->eventCount;++i)if(plugin->received[i].type==PluginEvent::Type::Controller)got.push_back(plugin->received[i]);
   const auto is=[](const PluginEvent&x,std::uint32_t id,std::uint32_t offset,float value){return x.parameterId==id&&x.offset==offset&&std::abs(x.value-value)<1e-6f;};
   const float centre=8192.f/16383;
   check(got.size()==8,"VST3 controller event count (chase + timeline, no bend range)");
   check(is(got[0],1,0,0)&&is(got[1],128,0,0)&&is(got[2],129,0,centre),"Play did not reset mod wheel, pressure and bend");
   check(is(got[3],129,5,1)&&is(got[4],128,6,64.f/127)&&is(got[5],1,7,1),"VST3 controller sample offsets or values");
   check(is(got[6],7,9,90.f/127)&&is(got[7],129,9,0),"Same-sample controllers lost their order");
   plugin->eventCount=0;check(e.seek(8),"Seek failed");(void)render(e,16,16);got.clear();
   for(std::size_t i=0;i<plugin->eventCount;++i)if(plugin->received[i].type==PluginEvent::Type::Controller&&plugin->received[i].offset==0)got.push_back(plugin->received[i]);
   check(got.size()==3&&is(got[0],1,0,1)&&is(got[1],128,0,64.f/127)&&is(got[2],129,0,1),"Seek did not chase the VST3 controllers");
   plugin->eventCount=0;check(e.stop(),"Stop failed");(void)render(e,16,16);got.clear();
   for(std::size_t i=0;i<plugin->eventCount;++i)if(plugin->received[i].type==PluginEvent::Type::Controller)got.push_back(plugin->received[i]);
   check(got.size()==3&&is(got[0],1,0,0)&&is(got[1],128,0,0)&&is(got[2],129,0,centre),"Stop did not reset the VST3 controllers (volume must keep its value)");
   plugin->eventCount=0;const std::array<LiveMidiEvent,3> live{LiveMidiEvent{0,0,0xE0,0x7F,0x7F,-1},LiveMidiEvent{0,0,0xD0,100,0,-1},LiveMidiEvent{0,0,0xC0,3,0,-1}};
   check(e.queueLiveMidi(live)==3&&e.controlChange(0,131,12),"Live controllers failed");(void)render(e,16,16);
   check(plugin->eventCount==3&&is(plugin->received[0],129,0,1)&&is(plugin->received[1],128,0,100.f/127)&&is(plugin->received[2],130,0,3.f/127)&&plugin->received[0].audition,"Live bend/pressure/program to VST3");}
  // Timeline validation.
  {auto p=base;p.tracks[0].controls={{0,129,9000}};RenderEngine e;rejects([&]{(void)e.prepare(p,{});},"Out-of-range timeline pitch bend accepted");
   p.tracks[0].controls={{10,1,5},{5,1,6}};rejects([&]{(void)e.prepare(p,{});},"Unsorted timeline controls accepted");}
}
void tempoSendsControllers(){
  // A synced delay on a return follows the tempo map: 120 BPM, then a step to 60 BPM at beat 4 (frame 96000).
  // An impulse at beat 6 (frame 192000) sent pre-fader (dry path silent) echoes one 60 BPM beat later, not 24000.
  {const std::int64_t length=252000;std::vector<float> pcm(static_cast<std::size_t>(length)*2,0.f);pcm[192000*2]=pcm[192000*2+1]=1;
   AssetStore assets{{"imp",asset("imp",48000,pcm,2)}};
   for(const std::uint32_t threads:{0u,2u}) {
     auto p=project(48000,length);p.bpm=120;p.tempoMap={{0,120,false},{4,60,false}};
     auto a=regionTrack("a","imp",0.f,length);a.sends={{"ret",1.f,true}};
     auto ret=returnTrack("ret");BuiltinInsert delay;delay.id="echo";delay.type="delay";
     delay.params={{"sync",1},{"time",1},{"amount",1},{"dry",0},{"feedback",0},{"tone",16000},{"lowcut",20},{"mode",0},{"age",0}};ret.inserts.push_back(delay);
     p.tracks={ret,a};
     RenderEngine e(48000,256);e.setProcessing(processing(threads));e.submit(e.prepare(p,assets));check(e.play(),"Play failed");
     const auto out=render(e,static_cast<std::uint32_t>(length),256);
     std::size_t peak=192000;for(std::size_t i=192000;i<static_cast<std::size_t>(length);++i)if(std::abs(out[2*i])>std::abs(out[2*peak]))peak=i;
     check(std::abs(out[2*peak])>.05f,"The return's synced delay produced no echo");
     check(peak>=240000-10&&peak<=240000+10,"A return's synced delay did not follow the tempo map (echo not one 60 BPM beat late)");
     for(std::size_t i=192000;i<230000;++i)check(std::abs(out[2*i])<1e-4f,"The return leaked dry signal or echoed at the beat-0 tempo");
   }}
  // Controller events are frames already placed through the tempo map: a bend at beat 6 of a 90→150 ramp
  // (frame 155699, the TypeScript/garak tempo.hpp list) bends exactly there, not at 6 beats of 90 BPM (192000).
  {const TempoMap map(90,{{0,90,true},{8,150,false}});near(map.frameAt(6,48000),155699,1,"Ramp frame for beat 6");
   auto p=project(48000,240000);p.bpm=90;p.tempoMap={{0,90,true},{8,150,false}};
   TrackTimeline t;t.id="keys";t.source.kind=TrackSource::Kind::BuiltinSynth;t.source.instrumentId="keys";
   t.source.params={{"bell",0},{"sustain",1},{"release",.05}};t.notes={{1,0,240000,240000,69,.5f}};t.controls={{155699,129,8191}};p.tracks.push_back(t);
   RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.play(),"Play failed");const auto out=render(e,200000,256);
   const double f0=frequencyOf(out,130000,155000);near(f0,440,.5,"Pitch before the bend under a tempo map");
   near(frequencyOf(out,160500,190000)/f0,std::pow(2,2/12.0),.001,"Pitch bend under a tempo ramp did not land on its tempo-map frame");}
}


// Track automation (docs/AUTOMATION.md): curve math, per-sample fader ramps, chunked effect parameters,
// VST3 parameter points at sample offsets, and an allocation-free callback throughout (render() checks).
AutomationLane lane(AutomationLane::Target target,double minimum,double maximum,std::vector<AutomationPoint> points){AutomationLane l;l.target=target;l.minimum=minimum;l.maximum=maximum;l.points=std::move(points);return l;}
void trackAutomation(){
  near(automationShape(.5,0),.5,1e-12,"Straight automation segment");
  near(automationShape(.5,1),(std::exp(3.0)-1)/(std::exp(6.0)-1),1e-12,"Curved automation segment matches automation.ts");
  near(automationShape(.5,-1),(std::exp(-3.0)-1)/(std::exp(-6.0)-1),1e-12,"Negative curvature");
  auto ramp=lane(AutomationLane::Target::Volume,0,2,{{1000,0,0},{2000,1,0},{2000,.25,0},{3000,.25,0}});
  std::size_t hint=0;
  near(evaluateAutomation(ramp,0,hint),0,0,"Before the first point the first value holds");
  near(evaluateAutomation(ramp,1500,hint),.5,1e-12,"Linear interpolation");
  near(evaluateAutomation(ramp,2000,hint),.25,0,"Two points on one frame jump");
  near(evaluateAutomation(ramp,1250,hint),.25,1e-12,"A backwards evaluation re-searches from the hint");
  near(evaluateAutomation(ramp,9000,hint),.25,0,"After the last point the last value holds");
  near(automationValue(ramp,.5),1,1e-12,"Linear mapping");
  auto cutoff=lane(AutomationLane::Target::Insert,20,20000,{});cutoff.logarithmic=true;near(automationValue(cutoff,.5),std::sqrt(20.0*20000),1e-9,"Logarithmic mapping");
  auto mode=lane(AutomationLane::Target::Insert,0,2,{{0,0,0},{100,1,0}});mode.options={0,1,2};std::size_t h=0;
  near(evaluateAutomation(mode,99,h),0,0,"Discrete lanes hold until the next point");near(automationValue(mode,.5),1,0,"Option mapping");

  // Volume ramp on a DC region: the fader follows the lane at every sample (no smoothing lag).
  auto p=project(48000,8000);TrackTimeline t;t.id="audio";t.audio.push_back({1,"dc",0,8000,0,48000,0,8000,1.f,0,0});
  t.automation.push_back(lane(AutomationLane::Target::Volume,0,2,{{2000,0,0},{6000,.5,0}}));p.tracks.push_back(t);
  AssetStore assets{{"dc",asset("dc",48000,std::vector<float>(8000,.1f))}};
  const double center=1/std::sqrt(2.0);
  {RenderEngine e(48000,256);e.setOffline(true);e.submit(e.prepare(p,assets));check(e.play(),"Play failed");const auto out=render(e,8000,97);
    near(out[1000*2],0,1e-9,"Volume lane before its first point");
    for(std::int64_t f:{2500,4000,5999})near(out[f*2],.1*(f-2000)/4000.0*center,2e-6,"Volume ramp applied at its exact frame");
    near(out[7000*2],.1*center,2e-6,"Volume holds after the last point");}

  // A mute lane fades over 12 ms instead of clicking.
  auto m=p;m.tracks[0].automation={lane(AutomationLane::Target::Mute,0,1,{{0,0,0},{4000,1,0}})};m.tracks[0].automation[0].options={0,1};
  {RenderEngine e(48000,256);e.setOffline(true);e.submit(e.prepare(m,assets));check(e.play(),"Play failed");const auto out=render(e,8000,128);
    near(out[3000*2],.1*center,1e-6,"Unmuted before the mute point");check(std::abs(out[4010*2])>1e-3,"Mute ramps instead of clicking");near(out[6000*2],0,1e-6,"Muted after the mute point");}

  // Built-in insert (stereo, so no mono pan law): utility gain jumps -36 dB -> 0 dB at frame 4800; the chunked update lands within 32 frames.
  auto u=project(48000,9600);TrackTimeline g;g.id="gain";g.audio.push_back({1,"dc",0,9600,0,48000,0,9600,1.f,0,0});
  BuiltinInsert utility;utility.id="utility";utility.type="utility";utility.params["gain"]=-36;g.inserts.push_back(utility);
  g.automation.push_back(lane(AutomationLane::Target::Insert,-36,24,{{4800,0,0},{4800,.6,0}}));g.automation[0].insertId="utility";g.automation[0].param="gain";u.tracks.push_back(g);
  AssetStore longAssets{{"dc",asset("dc",48000,std::vector<float>(9600,.1f))}};
  {RenderEngine e(48000,512);e.setOffline(true);e.submit(e.prepare(u,longAssets));check(e.play(),"Play failed");const auto out=render(e,9600,512);
    near(out[4700*2],.1*dsp::dbToGain(-36),1e-6,"Automated insert parameter before its point");
    check(std::abs(out[(4800+31)*2])>std::abs(out[4700*2])*1.05,"Insert automation did not start within one 32-frame chunk");
    near(out[9000*2],.1,1e-4,"Insert automation reached its value (12 ms glide)");}

  // A falling filter cutoff darkens noise.
  auto f=project(48000,48000);TrackTimeline n;n.id="noise";std::vector<float>noise(48000);std::uint32_t seed=1;for(auto&value:noise){seed=seed*1664525u+1013904223u;value=static_cast<float>(seed)/4294967295.f*.2f-.1f;}
  n.audio.push_back({1,"noise",0,48000,0,48000,0,48000,1.f,0,0});BuiltinInsert filter;filter.id="filter";filter.type="filter";n.inserts.push_back(filter);
  auto sweep=lane(AutomationLane::Target::Insert,20,20000,{{0,1,0},{48000,0,0}});sweep.logarithmic=true;sweep.insertId="filter";sweep.param="cutoff";n.automation.push_back(sweep);f.tracks.push_back(n);
  AssetStore noiseAssets{{"noise",asset("noise",48000,std::move(noise))}};
  {RenderEngine e(48000,1024);e.setOffline(true);e.submit(e.prepare(f,noiseAssets));check(e.play(),"Play failed");const auto out=render(e,48000,1024);
    double early=0,late=0;for(std::size_t i=1000;i<6000;++i)early+=out[i*2]*out[i*2];for(std::size_t i=42000;i<47000;++i)late+=out[i*2]*out[i*2];
    check(early>late*20,"A falling cutoff lane did not darken the noise");}

  // VST3 insert: parameter points arrive with sample offsets on a fixed grid; flat stretches are not repeated.
  auto v=project(48000,4096);TrackTimeline fx;fx.id="fx";fx.audio.push_back({1,"dc",0,4096,0,48000,0,4096,1.f,0,0});
  BuiltinInsert vst;vst.id="vstfx";vst.type="vst3";vst.plugin.instanceId="effect";fx.inserts.push_back(vst);
  auto param=lane(AutomationLane::Target::Insert,0,1,{{0,0,0},{512,1,0}});param.insertId="vstfx";param.param="7";fx.automation.push_back(param);v.tracks.push_back(fx);
  auto plugin=std::make_shared<TestPlugin>();
  {RenderEngine e(48000,512);e.submit(e.prepare(v,assets,{},[&](const PluginSpec&,double,unsigned){return plugin;}));check(e.play(),"Play failed");(void)render(e,1024,512);
    check(plugin->eventCount>=8,"VST3 parameter points missing");
    for(std::size_t i=0;i<plugin->eventCount;++i){const auto&ev=plugin->received[i];check(ev.type==PluginEvent::Type::Parameter&&ev.parameterId==7,"Unexpected VST3 automation event");check(ev.offset%64==0&&ev.offset<512,"VST3 parameter point off its grid");}
    near(plugin->received[1].value,64.f/512,1e-6,"VST3 parameter value at its sample offset");
    const auto flat=plugin->eventCount;(void)render(e,1024,512);check(plugin->eventCount==flat,"Flat VST3 automation repeated its value");}

  // Built-in instrument parameter: level is read at each note onset.
  auto s=project(48000,48000);auto keys=synthTrack();keys.source.params["level"]=1;keys.notes={{1,100,1000,48000,60,.8f},{2,30000,31000,48000,60,.8f}};
  auto level=lane(AutomationLane::Target::Instrument,0,2,{{0,.5,0},{20000,.5,0},{20000,0,0}});level.param="level";keys.automation.push_back(level);s.tracks.push_back(keys);
  {RenderEngine e(48000,256);e.setOffline(true);e.submit(e.prepare(s,{}));check(e.play(),"Play failed");const auto out=render(e,48000,256);
    double first=0,second=0;for(std::size_t i=100;i<2000;++i)first+=out[i*2]*out[i*2];for(std::size_t i=30000;i<32000;++i)second+=out[i*2]*out[i*2];
    check(first>1e-4&&second<first*1e-6,"Instrument level automation not applied at note onsets");}

  // Every built-in effect re-reads every parameter in place without allocating (EffectControl + automate()).
  for(const char* type:{"eq","filter","compressor","drive","reverb","delay","chorus","phaser","flanger","tremolo","limiter","gate","tape","bitcrusher","utility","guitar-rig"}){
    Parameters params;if(std::string_view(type)=="guitar-rig"){params["rackSlot0"]=3;params["rackSlot1"]=2+16;params["rackSlot2"]=10;}
    auto effect=dsp::makeEffect(type,params,48000,120);dsp::EffectControl control(type,params);
    std::vector<int> indices;for(const char* id:{"cutoff","b1Freq","threshold","drive","amount","rate","depth","mix","gain","bits","ampGain","driveGain_2","reverbMix","tone","feedback","width"}){const int i=control.index(id);if(i>=0)indices.push_back(i);}
    check(!indices.empty(),"Effect has no automatable parameter");
    std::vector<float> buffer(512,.1f);
    allocations=deallocations=0;watchAllocations=true;
    for(int step=0;step<8;++step){for(int i:indices)control.set(i,control.get(i)*(step%2?1.1:.9));control.apply(*effect);effect->process(buffer.data(),256);}
    watchAllocations=false;check(!allocations&&!deallocations,"Effect automation allocated");
    for(auto value:buffer)check(std::isfinite(value),"Effect automation produced non-finite audio");
  }

  // Invalid lanes are rejected on the control thread.
  auto bad=p;bad.tracks[0].automation[0].points={{100,0,0},{50,1,0}};bool rejected=false;try{RenderEngine e(48000,256);(void)e.prepare(bad,assets);}catch(const std::exception&){rejected=true;}check(rejected,"Unsorted automation points were accepted");
}

// Cross-feature (docs/AUTOMATION.md): lanes placed through a tempo map, send-level lanes and return-track lanes.
// Frames come from the native TempoMap exactly as timeline.ts places them (a lane segment crossing a tempo point
// is split there, so the frame-linear segments stay beat-linear).
void automationTempoSendsReturns(){
  const std::uint32_t rate=48000;
  const TempoMap tempo(240,{{0,240,false},{2,120,false}}); // Beat 2 at 0.5 s, beat 3 at 1 s, beat 4 at 1.5 s.
  const auto at=[&](double beat){return tempo.frameAt(beat,rate);};
  const auto frame=[&](double beat){return static_cast<std::size_t>(std::llround(at(beat)));};
  const auto length=static_cast<std::int64_t>(std::llround(at(4)));
  AssetStore assets{{"dc",asset("dc",rate,std::vector<float>(static_cast<std::size_t>(length)*2,.1f),2)}};
  const std::vector<AutomationPoint> rise{{at(1),0,0},{at(2),.25,0},{at(3),.5,0}}; // Normalized 0 -> .5 = gain 0 -> 1 over beats 1..3.
  for(const std::uint32_t threads:{0u,2u}) {
    // Volume lane under the tempo step, then a jump to silence at beat 3.5.
    auto p=project(rate,length);p.bpm=240;p.tempoMap=tempo.points();
    auto a=regionTrack("a","dc",1.f,length);
    auto volume=lane(AutomationLane::Target::Volume,0,2,rise);volume.points.push_back({at(3.5),.5,0});volume.points.push_back({at(3.5),0,0});
    a.automation={volume};p.tracks={a};
    RenderEngine e(rate,64);e.setProcessing(processing(threads));e.setOffline(true);e.submit(e.prepare(p,assets));check(e.play(),"Play failed");
    const auto out=render(e,static_cast<std::size_t>(length),64);
    near(out[2*frame(.5)],0,1e-9,"Volume lane before its first beat");
    near(out[2*frame(1.5)],.1*.25,1e-6,"Volume lane at beat 1.5 under the fast tempo");
    near(out[2*frame(2.5)],.1*.75,1e-6,"Volume lane at beat 2.5 after the tempo step");
    near(out[2*(frame(3.5)-1)],.1,1e-6,"Volume lane holds until its jump");
    near(out[2*(frame(3.5)+1)],0,1e-9,"Volume jump lands on the tempo-mapped frame");
  }
  for(const std::uint32_t threads:{0u,2u}) {
    // A silent sender (fader 0) feeds a return only through its automated pre-fader send level; the return's
    // own volume lane halves it from beat 3.5.
    auto p=project(rate,length);p.bpm=240;p.tempoMap=tempo.points();
    auto a=regionTrack("a","dc",0.f,length);a.sends={{"ret",0.f,true}};
    auto send=lane(AutomationLane::Target::Send,0,2,rise);send.returnId="ret";a.automation={send};
    auto ret=returnTrack("ret");ret.automation={lane(AutomationLane::Target::Volume,0,2,{{0,.5,0},{at(3.5),.5,0},{at(3.5),.25,0}})};
    p.tracks={ret,a};
    RenderEngine e(rate,64);e.setProcessing(processing(threads));e.setOffline(true);e.submit(e.prepare(p,assets));check(e.play(),"Play failed");
    const auto out=render(e,static_cast<std::size_t>(length),64);
    near(out[2*frame(.5)],0,1e-9,"Send lane before its first beat");
    near(out[2*frame(1.5)],.1*.25,1e-6,"Send level lane at beat 1.5");
    near(out[2*frame(2.5)+1],.1*.75,1e-6,"Send level lane at beat 2.5 after the tempo step");
    near(out[2*frame(3.25)],.1,1e-6,"Send level holds after its last point");
    near(out[2*frame(3.75)],.05,1e-6,"Return-track volume lane");
  }
  // Editing only a lane is a structural change: render-ahead audio made with the old lane is not reused.
  {
    auto p=project(rate,length);auto a=regionTrack("a","dc",1.f,length);a.automation={lane(AutomationLane::Target::Volume,0,2,{{0,.5,0}})};p.tracks={a};
    RenderEngine e(rate,64);e.setProcessing(processing(2,RenderAhead::High,64));e.submit(e.prepare(p,assets));check(e.play(),"Play failed");(void)render(e,640,64);
    p.tracks[0].automation[0].points[0].value=.25;e.submit(e.prepare(p,assets));
    const auto out=render(e,640,64);
    near(out[2*600],.05,1e-6,"An edited lane did not replace the playing one");
  }
}

// ---- Incremental updates (docs/RENDER_DIFF_PROTOCOL.md) ---------------------------------------------------
// A synth with a long note into a reverb, plus a second track: the diff paths keep voices and tails.
ProjectTimeline editProject(){
  auto p=project(48000,96000);
  auto keys=synthTrack();keys.id="keys";keys.source.params["level"]=.2;keys.source.params["release"]=.6;
  keys.notes={{1,0,60000,96000,60,.9f},{2,30000,36000,96000,67,.7f},{3,70000,80000,96000,64,.6f}};
  keys.inserts={{"eq","eq",true,{{"mid",-3}},{}},{"verb","reverb",true,{{"amount",.6},{"size",.4}},{}}};
  auto bass=synthTrack("bass");bass.id="bass";bass.gain=.5f;bass.notes={{1,5000,20000,96000,36,.8f},{2,50000,65000,96000,43,.8f}};
  p.tracks={keys,bass};
  return p;
}
std::vector<float> renderSpan(RenderEngine&e,std::uint32_t frames,std::uint32_t block=128){return render(e,frames,block);}
void append(std::vector<float>&to,const std::vector<float>&from){to.insert(to.end(),from.begin(),from.end());}

void updateDiffsMatchRebuild(){
  const auto p=editProject();
  // Mix diff (gain, pan, solo flags) == the same edit through a full graph rebuild.
  {
    RenderEngine diff(48000,256),full(48000,256);
    diff.submit(diff.prepare(p,{}));full.submit(full.prepare(p,{}));check(diff.play()&&full.play(),"Play failed");
    auto a=renderSpan(diff,8000),b=renderSpan(full,8000);
    auto edited=p;edited.revision=4;edited.tracks[0].gain=.55f;edited.tracks[0].pan=-.4f;edited.tracks[1].audible=false;edited.tracks[1].solo=false;
    const auto result=diff.update(edited,{});
    check(result.kind==UpdateResult::Kind::Diff&&result.replacedTracks==0,"A mixer edit did not become a diff command");
    full.submit(full.prepare(edited,{}));
    append(a,renderSpan(diff,20000,67));append(b,renderSpan(full,20000,67));
    checkSame(a,b,1e-6,"Mix diff differs from a full rebuild");
    check(diff.snapshot().revision==4,"Diff revision was not applied");
  }
  // Live insert parameters (EQ band, reverb amount/tone) == the same edit through a full rebuild.
  {
    RenderEngine diff(48000,256),full(48000,256);
    diff.submit(diff.prepare(p,{}));full.submit(full.prepare(p,{}));check(diff.play()&&full.play(),"Play failed");
    auto a=renderSpan(diff,9000),b=renderSpan(full,9000);
    auto edited=p;edited.revision=5;edited.tracks[0].inserts[0].params["mid"]=4;edited.tracks[0].inserts[1].params["amount"]=.3;edited.tracks[0].inserts[1].params["tone"]=5000;
    const auto builds=dsp::impulseCacheStats().builds;
    const auto result=diff.update(edited,{});
    check(result.kind==UpdateResult::Kind::Diff,"A live insert parameter did not become a diff command");
    check(dsp::impulseCacheStats().builds==builds,"A live reverb parameter rebuilt an impulse response");
    full.submit(full.prepare(edited,{}));
    append(a,renderSpan(diff,30000,67));append(b,renderSpan(full,30000,67));
    check(maxDifference(a,b)<2e-4,"Parameter diff differs from a full rebuild");
    // After the glides settle both paths render the same signal.
    const std::vector<float>lateA(a.end()-4000,a.end()),lateB(b.end()-4000,b.end());
    check(maxDifference(lateA,lateB)<2e-5,"Parameter diff did not converge to the rebuilt graph");
    // Reverb size shapes the impulse response: that edit rebuilds the track (and keeps its tail).
    auto sized=edited;sized.revision=6;sized.tracks[0].inserts[1].params["size"]=.8;
    check(diff.update(sized,{}).kind==UpdateResult::Kind::Tracks,"A reverb size edit was applied in place");
  }
  // A note edit ahead of the playhead, through update(), == a graph built with that note from the start.
  {
    auto edited=p;edited.revision=7;edited.tracks[0].notes[2].onFrame=72000;edited.tracks[0].notes[2].pitch=65;
    RenderEngine live(48000,256),reference(48000,256);
    live.submit(live.prepare(p,{}));reference.submit(reference.prepare(edited,{}));check(live.play()&&reference.play(),"Play failed");
    auto a=renderSpan(live,10000),b=renderSpan(reference,10000);
    const auto result=live.update(edited,{});
    check(result.kind==UpdateResult::Kind::Tracks&&result.replacedTracks==1,"A note edit did not replace exactly its track");
    append(a,renderSpan(live,80000,97));append(b,renderSpan(reference,80000,97));
    checkSame(a,b,1e-6,"A note edit through update() differs from the edited graph");
    // IDs are renumbered against the running graph: an unchanged note keeps its running voice.
    auto renumbered=edited;renumbered.revision=8;for(auto&n:renumbered.tracks[0].notes)n.id+=100;
    check(live.update(renumbered,{}).kind==UpdateResult::Kind::None,"Renumbered but equal notes were treated as an edit");
  }
  // Tempo is a header change: a full graph whose tracks still continue by id.
  {
    RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.play(),"Play failed");(void)renderSpan(e,4000);
    auto tempo=p;tempo.revision=9;tempo.bpm=90;
    check(e.update(tempo,{}).kind==UpdateResult::Kind::Full,"A tempo change did not rebuild the graph");
    (void)renderSpan(e,2000);
    auto invalid=tempo;invalid.revision=10;invalid.tracks[0].gain=7;
    rejects([&]{(void)e.update(invalid,{});},"An out-of-range diff value was accepted");
  }
}

// The held note (0..60000) and the reverb tail continue across a note edit and parameter edits: compared
// against an engine that never edits, nothing restarts or drops out.
void updatesKeepVoicesAndTails(){
  const auto p=editProject();
  RenderEngine live(48000,256),reference(48000,256);
  live.submit(live.prepare(p,{}));reference.submit(reference.prepare(p,{}));check(live.play()&&reference.play(),"Play failed");
  auto a=renderSpan(live,12000),b=renderSpan(reference,12000);
  // Note edit on the same track while note 1 sounds: note 3 (later) moves, note 1 must not be retriggered.
  auto edited=p;edited.revision=1;edited.tracks[0].notes[2].onFrame=71000;
  check(live.update(edited,{}).kind==UpdateResult::Kind::Tracks,"Note edit was not a track replacement");
  append(a,renderSpan(live,20000,101));append(b,renderSpan(reference,20000,101));
  checkSame(a,b,1e-6,"A note edit restarted the held note or the reverb tail");
  // Delete note 2 while it sounds (30000..36000): only that note releases; the held note and tail go on.
  auto removed=edited;removed.revision=2;removed.tracks[0].notes.erase(removed.tracks[0].notes.begin()+1);
  (void)renderSpan(live,1000);(void)renderSpan(reference,1000); // Into note 2 (frame 33000).
  check(live.update(removed,{}).kind==UpdateResult::Kind::Tracks,"Note removal was not a track replacement");
  const auto after=renderSpan(live,4000);
  check(energy(after)>1e-3,"Removing one note silenced the track");
  // A live parameter edit (reverb amount) and a bass note edit keep everything else ringing.
  auto knob=removed;knob.revision=3;knob.tracks[0].inserts[1].params["amount"]=.5;knob.tracks[1].notes[1].offFrame=64000;
  const auto result=live.update(knob,{});
  check(result.kind==UpdateResult::Kind::Tracks&&result.replacedTracks==1,"Parameter + other-track note edit replaced the wrong tracks");
  const auto ringing=renderSpan(live,4000);check(energy(ringing)>1e-3,"A parameter edit dropped the tail");
  // Stop the notes: the reverb tail continues past the last note through a further edit.
  RenderEngine tail(48000,256),tailReference(48000,256);
  auto shortNote=p;shortNote.tracks.resize(1);shortNote.tracks[0].notes={{1,0,4800,96000,60,.9f}};
  tail.submit(tail.prepare(shortNote,{}));tailReference.submit(tailReference.prepare(shortNote,{}));check(tail.play()&&tailReference.play(),"Play failed");
  auto x=renderSpan(tail,9000),y=renderSpan(tailReference,9000);
  auto later=shortNote;later.revision=1;later.tracks[0].notes.push_back({2,80000,82000,96000,72,.5f});
  check(tail.update(later,{}).kind==UpdateResult::Kind::Tracks,"Adding a later note was not a track replacement");
  append(x,renderSpan(tail,30000,89));append(y,renderSpan(tailReference,30000,89));
  checkSame(x,y,1e-6,"A note edit cut the running reverb tail");
  check(energy(std::vector<float>(x.end()-20000,x.end()))>1e-6,"The reverb tail had already ended");
}

// Adding or removing a track rebuilds the graph, but every other track continues by id.
void graphChangesKeepOtherTracks(){
  const auto p=editProject();
  RenderEngine live(48000,256),reference(48000,256);
  live.submit(live.prepare(p,{}));reference.submit(reference.prepare(p,{}));check(live.play()&&reference.play(),"Play failed");
  auto a=renderSpan(live,10000),b=renderSpan(reference,10000);
  auto grown=p;grown.revision=1;auto extra=synthTrack("pad");extra.id="extra";extra.notes={{1,90000,95000,96000,72,.5f}};
  grown.tracks.insert(grown.tracks.begin(),extra); // Shifts every index.
  check(live.update(grown,{}).kind==UpdateResult::Kind::Full,"Adding a track did not rebuild the graph");
  append(a,renderSpan(live,40000,77));append(b,renderSpan(reference,40000,77));
  checkSame(a,b,1e-6,"Adding a silent track restarted the other tracks' voices or tails");
  auto shrunk=grown;shrunk.revision=2;shrunk.tracks.erase(shrunk.tracks.begin()+2); // Remove bass.
  check(live.update(shrunk,{}).kind==UpdateResult::Kind::Full,"Removing a track did not rebuild the graph");
  const auto ringing=renderSpan(live,3000);check(energy(ringing)>1e-3,"Removing another track cut the keys track");
}

// 32 tracks with a reverb each fit the memory budget (shared impulse spectra) and build one impulse response.
void manyReverbsShareImpulses(){
  auto p=project(48000,48000);
  const auto builds=dsp::impulseCacheStats().builds;
  for(int i=0;i<32;++i){auto t=synthTrack();t.id="t"+std::to_string(i);t.notes={{1,0,4000,48000,60+i%12,.5f}};t.inserts={{"verb","reverb",true,{{"amount",.25},{"size",.61}},{}}};p.tracks.push_back(t);}
  RenderEngine e(48000,256);e.submit(e.prepare(p,{}));check(e.play(),"Play failed");
  check(dsp::impulseCacheStats().builds-builds<=1,"Equal reverbs built their impulse response more than once");
  check(energy(renderSpan(e,2000))>0,"32 reverb tracks rendered silence");
  // 32 differently sized reverbs (one impulse response each) still fit the budget.
  for(int i=0;i<32;++i)p.tracks[static_cast<std::size_t>(i)].inserts[0].params["size"]=.2+.01*i;
  p.revision=1;check(e.update(p,{}).replacedTracks==32,"Reverb size edits did not rebuild their tracks");(void)renderSpan(e,512);
  RenderEngine fresh(48000,256);fresh.submit(fresh.prepare(p,{}));
}

// Render-ahead tracks take diffs after their ring drains; a note edit far ahead renders bit-identically to the
// callback-only engine, and nothing in the callback allocates (rt() checks every block).
void updatesWithRenderAhead(){
  workerHeapOperations=0;
  constexpr std::uint32_t block=128;
  const auto b=busyProject(10,31,false);
  auto plain=busyEngine(b,processing(0)),ahead=busyEngine(b,processing(2,RenderAhead::High,block));
  auto notes=b.project;notes.revision=3;
  // A note well after the edit time (the cycle runs 12000..60000; the edit lands at buffer 60, frame 7680).
  for(auto&t:notes.tracks)for(auto&n:t.notes)if(n.onFrame>40000&&n.onFrame<50000){n.velocity=std::min(1.f,n.velocity+.2f);break;}
  auto mix=notes;mix.revision=4;mix.tracks[0].gain=.6f;mix.tracks[2].pan=-.5f;
  std::uint32_t mostAhead=0;
  const auto outs=drive({plain.get(),ahead.get()},560,[](std::size_t){return block;},[&](RenderEngine&e,std::size_t k) {
    if(k==0)check(e.play(),"Play failed");
    if(k==60)check(e.update(notes,b.assets,b.sets,testInstruments()).kind==UpdateResult::Kind::Tracks,"Note edits were not track replacements");
    if(k==460)(void)e.update(mix,b.assets,b.sets,testInstruments());
    if(k%25==0)e.collectRetired();
    if(&e==ahead.get())mostAhead=std::max(mostAhead,e.snapshot().renderAheadTracks);
  });
  check(mostAhead>=5,"Non-live tracks did not render ahead");
  // Blocks 0..459 cover the edited notes (frames 40000..50000) before the cycle wraps at 60000.
  bitIdentical(outs[0],outs[1],"A note edit on render-ahead tracks differs from callback rendering",0,460*block);
  const std::vector<float>lateA(outs[0].begin()+static_cast<std::ptrdiff_t>(520*block*2),outs[0].end()),lateB(outs[1].begin()+static_cast<std::ptrdiff_t>(520*block*2),outs[1].end());
  check(maxDifference(lateA,lateB)<1e-5,"A mix diff on render-ahead tracks did not converge");
  check(ahead->snapshot().renderAheadResyncs==0,"A render-ahead ring lost sync during updates");
  check(workerHeapOperations.load()==0,"A render-ahead worker allocated or freed heap storage");
}

int main(){
  const std::pair<const char*,void(*)()>tests[]={{"synths and block independence",synthsAndBlockIndependence},{"audio windows, resampling and cycle",audioWindowsAndLoop},{"region gain, fade curves and crossfade",regionGainFadesAndCrossfade},{"sample zones and required assets",sampledZonesAndMissingAssets},{"live MIDI release and equal-power panning",liveMidiAndPanning},{"piano key-release noise",pianoReleaseNoise},{"native monitoring and capture ring",monitoringAndRecording},{"per-track physical inputs and layout swap",perTrackInputRouting},{"simultaneous multi-take capture",simultaneousTakes},{"loopback latency detection",latencyDetection},{"callback overload counting",overloadCounting},{"built-in effects and guitar rig",builtinEffectsAndGuitar},{"guitar rig rack pedals and tuner",guitarRigPedalsAndTuner},{"guitar rig repeated modules",guitarRigInstances},{"nonuniform reverb convolution",reverbPartitionAccuracy},{"sigimsae effects",sigimsaeEffects},{"VST event timing and delay compensation",pluginTimingAndCompensation},{"live edits preserve voices and tails",editsPreserveVoicesAndTails},{"offline consistency and validation",offlineConsistencyAndValidation},{"concurrent control/audio isolation",concurrentControlAndRender},
    {"multi-core tracks are bit-identical",multicoreBitIdentical},{"render-ahead equals callback rendering",renderAheadMatchesCallback},
    {"render-ahead yields live tracks",renderAheadLiveTracks},{"multi-core stress with random buffers",processingStress},{"parametric EQ and sweep filter",parametricEqAndSweep},{"dynamics meters",dynamicsMeters},{"metronome clicks, count-in and export",metronomeClicks},{"tempo map frames, clicks and synced effects",tempoMapFrames},{"track-input routes, taps and loop prevention",trackInputRoutes},{"sustain pedal: VST3 CC64 timing, chase, live deferral and retrigger",sustainPedal},{"send/return buses: gains, single processing, PDC and tails",sendReturns},{"MIDI controllers: bend, vibrato, expression, chase, live and VST3",midiControllers},{"tempo map x returns x controllers",tempoSendsControllers},{"track automation lanes",trackAutomation},{"automation x tempo map x sends x returns",automationTempoSendsReturns},
    {"update: diffs equal a full rebuild",updateDiffsMatchRebuild},{"update: voices and tails survive edits",updatesKeepVoicesAndTails},
    {"update: track add/remove keeps other tracks",graphChangesKeepOtherTracks},{"update: 32 reverbs share impulse responses",manyReverbsShareImpulses},
    {"update: render-ahead tracks take diffs",updatesWithRenderAhead}};
  unsigned failed=0;for(const auto&[name,test]:tests){try{test();std::cout<<"PASS "<<name<<'\n';}catch(const std::exception&error){watchAllocations=false;++failed;std::cerr<<"FAIL "<<name<<": "<<error.what()<<'\n';}}
  return failed?1:0;
}
