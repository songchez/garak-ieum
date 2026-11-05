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
  near(r[0],.01*.35*.8/std::sqrt(2.0),1e-8,"Live sample release zone missed its exact note-off");
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
  for(const auto*name:{"eq","filter","compressor","drive","delay","reverb","guitar-rig"}){
    auto effect=dsp::makeEffect(name,{},48000,120);auto output=input;allocations=deallocations=0;watchAllocations=true;
    for(std::size_t at=0;at<12000;at+=127)effect->process(output.data()+2*at,static_cast<std::uint32_t>(std::min<std::size_t>(127,12000-at)));
    watchAllocations=false;check(!allocations&&!deallocations,"Native insert allocated in its callback");check(energy(output)>.001,"Native effect unexpectedly silenced input");
  }
  Parameters bypass{{"compEnabled",0},{"driveEnabled",0},{"ampEnabled",0},{"cabinetEnabled",0},{"chorusEnabled",0},{"delayEnabled",0}};
  auto rig=dsp::makeEffect("guitar-rig",bypass,48000,120);auto output=input;rig->process(output.data(),12000);checkSame(input,output,0,"All-bypass guitar rig is not transparent");check(rig->latencyFrames()==0,"All-bypass guitar rig reported unnecessary delay");
  auto a=dsp::makeEffect("guitar-rig",{{"micPosition",0},{"micType",0}},48000,120),b=dsp::makeEffect("guitar-rig",{{"micPosition",1},{"micType",1}},48000,120);
  auto x=input,y=input;a->process(x.data(),12000);b->process(y.data(),12000);double difference=0;for(std::size_t i=0;i<x.size();++i)difference+=std::abs(x[i]-y[i]);check(difference>.1,"Native microphone controls did not affect the audio");
  rejects([]{(void)dsp::makeEffect("unimplemented",{},48000,120);},"Unknown effect was silently skipped");
  rejects([]{(void)dsp::makeEffect("eq",{{"wrongParameter",1}},48000,120);},"Unknown parameter was silently ignored");
  rejects([]{(void)dsp::makeEffect("delay",{{"feedback",1}},48000,120);},"Unstable feedback was accepted");
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

int main(){
  const std::pair<const char*,void(*)()>tests[]={{"synths and block independence",synthsAndBlockIndependence},{"audio windows, resampling and cycle",audioWindowsAndLoop},{"sample zones and required assets",sampledZonesAndMissingAssets},{"live MIDI release and equal-power panning",liveMidiAndPanning},{"native monitoring and capture ring",monitoringAndRecording},{"per-track physical inputs and layout swap",perTrackInputRouting},{"simultaneous multi-take capture",simultaneousTakes},{"loopback latency detection",latencyDetection},{"callback overload counting",overloadCounting},{"built-in effects and guitar rig",builtinEffectsAndGuitar},{"nonuniform reverb convolution",reverbPartitionAccuracy},{"VST event timing and delay compensation",pluginTimingAndCompensation},{"live edits preserve voices and tails",editsPreserveVoicesAndTails},{"offline consistency and validation",offlineConsistencyAndValidation},{"concurrent control/audio isolation",concurrentControlAndRender},
    {"multi-core tracks are bit-identical",multicoreBitIdentical},{"render-ahead equals callback rendering",renderAheadMatchesCallback},
    {"render-ahead yields live tracks",renderAheadLiveTracks},{"multi-core stress with random buffers",processingStress}};
  unsigned failed=0;for(const auto&[name,test]:tests){try{test();std::cout<<"PASS "<<name<<'\n';}catch(const std::exception&error){watchAllocations=false;++failed;std::cerr<<"FAIL "<<name<<": "<<error.what()<<'\n';}}
  return failed?1:0;
}
