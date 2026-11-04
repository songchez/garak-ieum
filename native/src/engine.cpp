#include "garak/engine.hpp"
#include "garak/dsp.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace garak {
namespace {
constexpr std::size_t maxVoices = 128, maxPluginEvents = 2048;
constexpr std::size_t memoryLimit = 512u * 1024u * 1024u;
constexpr double epsilon = .00001;
constexpr std::int64_t unlimitedFrame = std::numeric_limits<std::int64_t>::max() / 4;

void require(bool condition, const char* description) { if (!condition) throw std::invalid_argument(description); }
double checked(double value, double minimum, double maximum, const char* description) {
  require(std::isfinite(value) && value >= minimum && value <= maximum, description); return value;
}
double parameter(const Parameters& p, std::string_view name, double fallback, double minimum, double maximum) {
  const auto it = p.find(name); return checked(it == p.end() ? fallback : it->second, minimum, maximum, "Invalid native instrument parameter");
}
template<class T, std::size_t N> class SpscQueue {
 public:
  bool push(const T& value) noexcept {
    const auto write = write_.load(std::memory_order_relaxed), next = (write + 1) % N;
    if (next == read_.load(std::memory_order_acquire)) return false;
    data_[write] = value; write_.store(next, std::memory_order_release); return true;
  }
  bool pop(T& value) noexcept {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    value = data_[read]; read_.store((read + 1) % N, std::memory_order_release); return true;
  }
 private:
  std::array<T, N> data_{};
  alignas(64) std::atomic<std::size_t> write_{0};
  alignas(64) std::atomic<std::size_t> read_{0};
};

struct Synth {
  enum class Kind { Keys, Bass, Pad, Pluck, Rhodes, Drums, Sampled } kind = Kind::Keys;
  double level = 1, tone = 0, attack = .004, decay = .22, sustain = .2, release = .3;
  double sub = .65, bell = .2, detune = 7, sweep = .25, bark = .5, tune = 0, punch = 1;
};
Synth compileSynth(const TrackSource& source) {
  Synth result;
  const auto& p = source.params;
  std::set<std::string_view> permitted{"level", "tone"};
  if (source.kind == TrackSource::Kind::BuiltinSampled) {
    result.kind = Synth::Kind::Sampled;
    if (source.isKit) {
      permitted.insert({"tune", "decay"});
      result.tune=parameter(p,"tune",0,-12,12); result.decay=parameter(p,"decay",1,.1,1);
    } else {
      permitted.insert({"attack","release"}); result.attack=parameter(p,"attack",.001,.001,2); result.release=parameter(p,"release",.25,.02,5);
    }
  } else if (source.instrumentId == "drums") {
    result.kind=Synth::Kind::Drums; permitted.insert({"tune","decay","punch"});
    result.tune=parameter(p,"tune",0,-12,12); result.decay=parameter(p,"decay",1,.3,3); result.punch=parameter(p,"punch",1,.5,2);
  } else {
    permitted.insert({"attack","decay","sustain","release"});
    if (source.instrumentId == "bass") { result.kind=Synth::Kind::Bass;result.attack=.006;result.decay=.09;result.sustain=.65;result.release=.13;permitted.insert("sub");result.sub=parameter(p,"sub",.65,0,1); }
    else if (source.instrumentId == "keys") { result.kind=Synth::Kind::Keys;permitted.insert("bell");result.bell=parameter(p,"bell",.2,0,.6); }
    else if (source.instrumentId == "pad") { result.kind=Synth::Kind::Pad;result.attack=.08;result.decay=.24;result.sustain=.7;result.release=.7;permitted.insert("detune");result.detune=parameter(p,"detune",7,0,40); }
    else if (source.instrumentId == "pluck") { result.kind=Synth::Kind::Pluck;result.attack=.003;result.decay=.12;result.sustain=.08;result.release=.16;permitted.insert("sweep");result.sweep=parameter(p,"sweep",.25,.02,1); }
    else if (source.instrumentId == "rhodes") { result.kind=Synth::Kind::Rhodes;result.attack=.003;result.decay=2.5;result.sustain=0;result.release=.25;permitted.insert("bark");result.bark=parameter(p,"bark",.5,0,1); }
    else throw std::invalid_argument("Unknown native synthesizer: " + source.instrumentId);
    result.attack=parameter(p,"attack",result.attack,.001,2);
    result.decay=parameter(p,"decay",result.decay,result.kind==Synth::Kind::Rhodes?.2:.01,result.kind==Synth::Kind::Rhodes?6:3);
    result.sustain=parameter(p,"sustain",result.sustain,0,1);result.release=parameter(p,"release",result.release,.01,5);
  }
  result.level=parameter(p,"level",1,0,2);result.tone=parameter(p,"tone",0,-1,1);
  for (const auto& [name,value] : p) { (void)value; require(permitted.contains(name), "Unknown native instrument parameter"); }
  return result;
}

struct ResolvedZone { SampleZone zone; std::shared_ptr<const PcmAsset> asset; };
struct ResolvedSet {
  bool isKit=false;double gainDb=0,startOffset=0;
  std::vector<ResolvedZone> zones,releases;
};
const ResolvedZone* pickZone(const std::vector<ResolvedZone>& zones,bool kit,int pitch,float velocity) noexcept {
  double top=-1;
  for(const auto& z:zones)if(kit?z.zone.root==pitch:pitch>=z.zone.lo&&pitch<=z.zone.hi)top=std::max(top,z.zone.vhi);
  const ResolvedZone* best=nullptr;double bestDistance=std::numeric_limits<double>::max();bool matched=false;
  for(const auto& z:zones) {
    if(!(kit?z.zone.root==pitch:pitch>=z.zone.lo&&pitch<=z.zone.hi))continue;
    const bool layer=velocity>=z.zone.vlo&&(velocity<z.zone.vhi||(z.zone.vhi==top&&velocity<=z.zone.vhi));
    const double distance=layer?0:std::max({z.zone.vlo-velocity,velocity-z.zone.vhi,0.0});
    if(!best||(layer&&!matched)||(layer==matched&&(distance<bestDistance||(distance==bestDistance&&std::abs(z.zone.root-pitch)<std::abs(best->zone.root-pitch))))) {best=&z;bestDistance=distance;matched=layer;}
  }
  return best;
}

float pcmChannel(const PcmAsset& a,double position,unsigned channel) noexcept {
  if(position<0||position>=static_cast<double>(a.frames()))return 0;
  const auto index=static_cast<std::uint64_t>(position);
  const auto c=std::min<std::uint32_t>(channel,a.channels-1);
  const float left=a.samples[static_cast<std::size_t>(index)*a.channels+c];
  const float right=index+1<a.frames()?a.samples[static_cast<std::size_t>(index+1)*a.channels+c]:0;
  return left+static_cast<float>(position-index)*(right-left);
}
float pcmSample(const PcmAsset& a,double position,unsigned channel) noexcept {
  // Speaker downmix used by the former stereo output bus. Non-standard layouts
  // use discrete first-two-channel mapping, matching Web Audio's fallback.
  if(a.channels==4)return .5f*(pcmChannel(a,position,channel)+pcmChannel(a,position,channel+2));
  if(a.channels==6)return pcmChannel(a,position,channel)+.7071067811865476f*(pcmChannel(a,position,2)+pcmChannel(a,position,channel+4));
  return pcmChannel(a,position,channel);
}

double polyBlep(double phase,double step) noexcept {
  if(phase<step){const double t=phase/step;return t+t-t*t-1;}
  if(phase>1-step){const double t=(phase-1)/step;return t*t+t+t+1;}
  return 0;
}
double oscillator(double& phase,double frequency,double sr,int waveform=0) noexcept {
  const double step=std::clamp(frequency/sr,0.0,.45);double value=0;
  if(waveform==1)value=2*phase-1-polyBlep(phase,step);
  else if(waveform==2) {
    // A short, band-limited triangle Fourier series. Each partial is below Nyquist.
    for(int harmonic=1;harmonic<=15&&frequency*harmonic<sr*.45;harmonic+=2)
      value+=((harmonic%4==1)?1.0:-1.0)*std::sin(2*dsp::pi*phase*harmonic)/(harmonic*harmonic);
    value*=8/(dsp::pi*dsp::pi);
  } else value=std::sin(2*dsp::pi*phase);
  phase+=step;if(phase>=1)phase-=1;return value;
}

struct Voice {
  Synth synth;
  bool active=false,sampled=false,releaseSample=false,releaseSpawned=false,live=false,forcedRelease=false;
  std::int32_t id=0;int pitch=60,choke=-1;
  std::int64_t age=0,noteFrames=0,endFrames=0;
  float velocity=1;double samplePosition=0,sampleStep=1,peak=1,naturalFrames=0,releaseGain=0;
  double frequency=440,drumDecay=0,drumSweep=0,drumStart=0,drumEnd=0;
  std::array<double,4> phases{};
  dsp::Biquad tone,noiseFilter;
  const ResolvedZone* zone=nullptr;
  const ResolvedZone* releaseZone=nullptr;
  std::uint32_t noise=47081;
  double chokeGain=1;bool choking=false;
};
struct ResolvedWindow { AudioWindow window; std::shared_ptr<const PcmAsset> asset; };
struct TimedPluginEvent { std::int64_t frame; PluginEvent event; };
struct InsertRuntime {
  std::unique_ptr<dsp::StereoProcessor> builtin;
  std::shared_ptr<PluginProcessor> plugin;
};
class CompensationDelay {
 public:
  explicit CompensationDelay(std::uint32_t frames=0):frames_(frames),samples_(static_cast<std::size_t>(frames+1)*2),generations_(frames+1){}
  void process(float* s,std::uint32_t frames)noexcept {
    if(!frames_)return;
    for(std::uint32_t i=0;i<frames;++i) {
      const auto read=(write_+1)%generations_.size();
      const float l=generations_[read]==generation_?samples_[read*2]:0,r=generations_[read]==generation_?samples_[read*2+1]:0;
      samples_[write_*2]=s[2*i];samples_[write_*2+1]=s[2*i+1];generations_[write_]=generation_;
      s[2*i]=l;s[2*i+1]=r;write_=read;
    }
  }
  void reset()noexcept{++generation_;if(!generation_)++generation_;write_=0;}
  void takeStateFrom(CompensationDelay& previous)noexcept {
    if(frames_!=previous.frames_)return;
    samples_.swap(previous.samples_);generations_.swap(previous.generations_);
    std::swap(write_,previous.write_);std::swap(generation_,previous.generation_);
  }
 private:
  std::uint32_t frames_;std::vector<float>samples_;std::vector<std::uint64_t>generations_;
  std::size_t write_=0;std::uint64_t generation_=1;
};

struct TrackRuntime {
  TrackTimeline timeline;
  Synth synth;
  ResolvedSet samples;
  std::vector<Voice> voices=std::vector<Voice>(maxVoices);
  std::vector<ResolvedWindow> windows;
  std::vector<InsertRuntime> inserts;
  std::shared_ptr<PluginProcessor> instrument;
  std::vector<TimedPluginEvent> events;
  std::array<PluginEvent,maxPluginEvents> blockEvents{};
  std::array<PluginEvent,maxVoices> pendingEvents{};
  std::size_t pendingCount=0;
  struct LivePluginNote { bool active=false;std::int32_t id=-1;std::uint8_t pitch=60;std::int64_t remaining=0; };
  std::array<LivePluginNote,maxVoices> pluginNotes{};
  std::size_t nextNote=0,nextEvent=0;
  std::uint32_t latency=0;
  CompensationDelay compensation;
  std::vector<float> buffer;
  double sampleRate=48000;
  float peak=0;
  double fader=1,panValue=0;
  bool stereoSource=false,stereoEffects=false;

  void takeStateFrom(TrackRuntime& previous)noexcept {
    voices.swap(previous.voices);std::swap(samples,previous.samples);
    nextNote=previous.nextNote;nextEvent=previous.nextEvent;pendingCount=previous.pendingCount;
    pendingEvents=previous.pendingEvents;pluginNotes=previous.pluginNotes;
    instrument.swap(previous.instrument);
    for(std::size_t i=0;i<inserts.size();++i) {
      if(inserts[i].builtin)inserts[i].builtin->takeStateFrom(*previous.inserts[i].builtin);
      else inserts[i].plugin.swap(previous.inserts[i].plugin);
    }
    compensation.takeStateFrom(previous.compensation);peak=previous.peak;
    fader=previous.fader;panValue=previous.panValue;
  }

  Voice& availableVoice(std::uint64_t& overflows)noexcept {
    for(auto& v:voices)if(!v.active)return v;
    ++overflows;
    return *std::max_element(voices.begin(),voices.end(),[](const Voice&a,const Voice&b){return a.age<b.age;});
  }
  void spawn(int pitch,float velocity,std::int64_t duration,std::int64_t available,std::int32_t id,bool live,std::uint64_t& overflows)noexcept {
    if(velocity<=0||duration<=0||available<=0||!timeline.enabled||timeline.source.kind==TrackSource::Kind::Audio)return;
    if(instrument) {
      if(pendingCount==pendingEvents.size()){++overflows;return;}
      if(live){
        auto slot=std::find_if(pluginNotes.begin(),pluginNotes.end(),[](const LivePluginNote&n){return !n.active;});
        if(slot==pluginNotes.end()){++overflows;return;}
        *slot={true,id,static_cast<std::uint8_t>(pitch),duration};
      }
      pendingEvents[pendingCount++]={PluginEvent::Type::NoteOn,0,id,static_cast<std::uint8_t>(pitch),0,std::min(1.f,velocity),0};
      // Chased timeline notes already have an exact scheduled note-off. Only
      // live/preview notes need a callback-local countdown.
      return;
    }
    const ResolvedZone* zone=nullptr;
    if(timeline.source.kind==TrackSource::Kind::BuiltinSampled) {
      zone=pickZone(samples.zones,samples.isKit,pitch,std::clamp(velocity,0.f,1.f));
      // Kit notes with no mapped pad are intentional silence, as in the manifest.
      if(!zone)return;
    }
    auto& voice=availableVoice(overflows);voice=Voice{};voice.synth=synth;voice.active=true;voice.pitch=pitch;voice.velocity=velocity;
    voice.id=id;voice.live=live;voice.noteFrames=std::max<std::int64_t>(1,std::min(duration,available));
    voice.frequency=440*std::pow(2,(pitch-69)/12.0);voice.noise=47081;
    const double noteSeconds=static_cast<double>(voice.noteFrames)/sampleRate;
    const double toneFactor=std::pow(2,synth.tone*2);
    if(zone) {
      voice.sampled=true;voice.zone=zone;voice.choke=zone->zone.choke;
      voice.samplePosition=samples.startOffset*zone->asset->sampleRate;
      const double ratio=std::pow(2,(samples.isKit?0:(pitch-zone->zone.root)/12.0)+zone->zone.tune/1200+(samples.isKit?synth.tune/12:0));
      voice.sampleStep=ratio*zone->asset->sampleRate/sampleRate;
      voice.naturalFrames=std::max(1.0,(zone->asset->frames()-voice.samplePosition)/voice.sampleStep);
      voice.peak=dsp::dbToGain(samples.gainDb+zone->zone.gainDb-6)*(.25+.75*velocity)*synth.level;
      if(synth.tone<0)voice.tone.configure(dsp::Filter::Lowpass,sampleRate,20000*std::pow(2,synth.tone*3),.5);
      else voice.tone.configure(dsp::Filter::HighShelf,sampleRate,2500,1,synth.tone*6);
      if(samples.isKit) {
        voice.drumDecay=synth.decay<1?std::max(.02*sampleRate,synth.decay*voice.naturalFrames):voice.naturalFrames;
        voice.endFrames=static_cast<std::int64_t>(voice.drumDecay+.004*sampleRate);
        if(voice.choke>=0)for(auto& previous:voices)if(&previous!=&voice&&previous.active&&previous.choke==voice.choke)previous.choking=true;
      } else {
        voice.endFrames=voice.noteFrames+static_cast<std::int64_t>((synth.release*1.5+.02)*sampleRate);
        if(!zone->zone.loop)voice.endFrames=std::min(voice.endFrames,static_cast<std::int64_t>(voice.naturalFrames+.01*sampleRate));
        if(live||voice.noteFrames<voice.naturalFrames)voice.releaseZone=pickZone(samples.releases,false,pitch,std::clamp(velocity,0.f,1.f));
      }
      return;
    }
    voice.endFrames=voice.noteFrames+static_cast<std::int64_t>((synth.release+.005)*sampleRate);
    double cutoff=6800,amplitude=.35;
    switch(synth.kind) {
      case Synth::Kind::Bass:cutoff=700+velocity*1700;amplitude=.32;break;
      case Synth::Kind::Pad:cutoff=2600;amplitude=.25;break;
      case Synth::Kind::Pluck:cutoff=4800;amplitude=.35;break;
      case Synth::Kind::Rhodes:cutoff=9000;amplitude=.28+.1*std::min(1.f,velocity);voice.endFrames=voice.noteFrames+static_cast<std::int64_t>((synth.release*1.5+.02)*sampleRate);break;
      case Synth::Kind::Drums: {
        const double tune=std::pow(2,synth.tune/12);double decay=.23;
        if(pitch==35||pitch==36){decay=.32;amplitude=.8;voice.drumStart=(47+98*synth.punch)*tune;voice.drumEnd=47*tune;voice.drumSweep=.12;}
        else if(pitch==38||pitch==40||pitch==39){decay=pitch==39?.12:.18;amplitude=.32;voice.frequency=185*tune;voice.noiseFilter.configure(dsp::Filter::Highpass,sampleRate,900*std::pow(2,synth.tone*1.5),1);}
        else if(pitch==42||pitch==44||pitch==46||pitch==49||pitch==51){decay=pitch==46?.32:(pitch==49||pitch==51)?.62:.065;amplitude=(pitch==42||pitch==44)?.18:.16;voice.noiseFilter.configure(dsp::Filter::Highpass,sampleRate,6500*std::pow(2,synth.tone*1.5),1);}
        else {amplitude=.5;voice.drumEnd=440*std::pow(2,(std::clamp(pitch,24,84)-69)/12.0)*tune;voice.drumStart=voice.drumEnd*1.8;voice.drumSweep=.1;}
        voice.drumDecay=std::max(.008*sampleRate,std::min(decay*synth.decay*sampleRate,static_cast<double>(available)));
        voice.endFrames=static_cast<std::int64_t>(voice.drumDecay+.004*sampleRate);break;
      }
      default:break;
    }
    voice.peak=amplitude*velocity*synth.level;voice.tone.configure(dsp::Filter::Lowpass,sampleRate,cutoff*toneFactor,.7);
    (void)noteSeconds;
  }
  void spawnRelease(Voice& source,std::uint64_t& overflows)noexcept {
    if(!source.releaseZone||source.releaseSpawned)return;
    source.releaseSpawned=true;
    auto* zone=source.releaseZone;const int pitch=source.pitch;const float velocity=source.velocity;const auto voiceSynth=source.synth;
    auto& v=availableVoice(overflows);v=Voice{};v.synth=voiceSynth;v.active=true;v.sampled=true;v.releaseSample=true;v.zone=zone;v.pitch=pitch;
    v.samplePosition=samples.startOffset*zone->asset->sampleRate;
    v.sampleStep=std::pow(2,(pitch-zone->zone.root)/12.0+zone->zone.tune/1200)*zone->asset->sampleRate/sampleRate;
    v.peak=dsp::dbToGain(samples.gainDb+zone->zone.gainDb-6)*.35*std::min(1.f,velocity)*voiceSynth.level;
    v.endFrames=static_cast<std::int64_t>(std::max(0.0,(zone->asset->frames()-v.samplePosition)/v.sampleStep));
  }
  void noteOff(int pitch,std::int32_t id,std::uint64_t& overflows)noexcept {
    if(instrument) {
      bool cancelledPending=false;
      for(std::size_t i=0;i<pendingCount;){
        const auto&e=pendingEvents[i];
        if(e.type==PluginEvent::Type::NoteOn&&(id>=0?e.noteId==id:e.pitch==pitch)){
          std::move(pendingEvents.begin()+static_cast<std::ptrdiff_t>(i+1),pendingEvents.begin()+static_cast<std::ptrdiff_t>(pendingCount),pendingEvents.begin()+static_cast<std::ptrdiff_t>(i));
          --pendingCount;cancelledPending=true;
        }else ++i;
      }
      if(!cancelledPending){
        if(pendingCount<pendingEvents.size())pendingEvents[pendingCount++]={PluginEvent::Type::NoteOff,0,id,static_cast<std::uint8_t>(pitch),0,0,0};
        else{++overflows;instrument->requestReset();pendingCount=0;for(auto&n:pluginNotes)n.active=false;}
      }
      for(auto& n:pluginNotes)if(n.active&&(id>=0?n.id==id:n.pitch==pitch))n.active=false;
    }
    for(auto& v:voices)if(v.active&&v.live&&(id>=0?v.id==id:v.pitch==pitch)) {
      if(!timeline.source.isKit&&!v.forcedRelease){v.releaseGain=envelope(v);v.forcedRelease=true;}
      v.noteFrames=std::min(v.noteFrames,v.age);
      if(v.sampled&&v.age>=v.naturalFrames)v.releaseZone=nullptr;
      if (!timeline.source.isKit) v.endFrames=std::min(v.endFrames,v.age+static_cast<std::int64_t>((v.synth.release*1.5+.02)*sampleRate));
    }
  }
  double envelope(const Voice& v)const noexcept {
    const auto&synth=v.synth;
    const double t=static_cast<double>(v.age)/sampleRate,duration=static_cast<double>(v.noteFrames)/sampleRate;
    if(v.releaseSample)return v.peak;
    if(v.forcedRelease){
      if(v.sampled||synth.kind==Synth::Kind::Rhodes)return v.releaseGain*std::exp(-(t-duration)/(synth.release/4));
      if(t>=duration+synth.release||v.releaseGain<=0)return 0;
      return v.releaseGain*std::pow(epsilon/std::max(epsilon,v.releaseGain),(t-duration)/synth.release);
    }
    if(v.sampled) {
      if(samples.isKit) {
        if(synth.decay>=1)return v.peak;
        const double end=v.drumDecay/sampleRate;
        if(t>=end)return 0;
        return v.peak*std::pow(epsilon/std::max(epsilon,v.peak),t/end);
      }
      const double attack=std::min(synth.attack,duration);
      if(t<attack)return v.peak*t/std::max(1/sampleRate,attack);
      return t<duration?v.peak:v.peak*std::exp(-(t-duration)/(synth.release/4));
    }
    if(synth.kind==Synth::Kind::Drums) {
      const double end=v.drumDecay/sampleRate,attack=std::min(.002,end/4);
      if(t<attack)return v.peak*t/attack;
      if(t>=end)return 0;
      return v.peak*std::pow(epsilon/std::max(epsilon,v.peak),(t-attack)/(end-attack));
    }
    if(synth.kind==Synth::Kind::Rhodes) {
      const double attack=std::min(synth.attack,duration),decay=synth.decay*std::pow(2,-(v.pitch-60)/24.0),sustain=std::max(epsilon,synth.sustain*v.peak);
      auto beforeOff=[&](double at){if(at<attack)return v.peak*at/std::max(attack,1/sampleRate);const double a=at-attack;
        if(a<decay*.25)return v.peak*.45+v.peak*.55*std::exp(-a/(decay*.1));
        const double initial=v.peak*.45+v.peak*.55*std::exp(-2.5);
        return sustain+(initial-sustain)*std::exp(-(a-decay*.25)/(decay/3));};
      return t<duration?beforeOff(t):beforeOff(duration)*std::exp(-(t-duration)/(synth.release/4));
    }
    const double attack=std::min(synth.attack,duration*.3),decayEnd=std::min(attack+synth.decay,duration*.85),sustain=std::max(epsilon,v.peak*synth.sustain);
    if(t<attack)return v.peak*t/std::max(attack,1/sampleRate);
    if(t<decayEnd&&decayEnd>attack)return v.peak*std::pow(sustain/std::max(epsilon,v.peak),(t-attack)/(decayEnd-attack));
    if(t<duration)return sustain;
    if(t>=duration+synth.release)return 0;
    return sustain*std::pow(epsilon/sustain,(t-duration)/synth.release);
  }
  void voicesInto(float* out,std::uint32_t frames,std::uint64_t& overflows)noexcept {
    for(std::uint32_t i=0;i<frames;++i) {
      for(auto& v:voices) if(v.active&&v.releaseZone&&!v.releaseSpawned&&v.age>=v.noteFrames) spawnRelease(v,overflows);
      for(auto& v:voices) {
      if(!v.active)continue;
      if(v.age>=v.endFrames){v.active=false;continue;}
      const auto&synth=v.synth;
      double l=0,r=0;
      if(v.sampled) {
        const auto& a=*v.zone->asset;
        if(v.zone->zone.loop&&!samples.isKit&&!v.releaseSample) {
          const double start=(v.zone->zone.loop->at(0)+samples.startOffset)*a.sampleRate,end=(v.zone->zone.loop->at(1)+samples.startOffset)*a.sampleRate;
          if(v.samplePosition>=end)v.samplePosition=start+std::fmod(v.samplePosition-start,end-start);
        }
        if(v.samplePosition>=a.frames()){v.active=false;continue;}
        l=pcmSample(a,v.samplePosition,0);r=pcmSample(a,v.samplePosition,1);v.samplePosition+=v.sampleStep;
        if(!v.releaseSample){l=v.tone.sample(static_cast<float>(l),0);r=v.tone.sample(static_cast<float>(r),1);}
      } else {
        const double t=static_cast<double>(v.age)/sampleRate;
        if(synth.kind==Synth::Kind::Drums) {
          if(v.drumSweep>0){const double freq=v.drumStart*std::pow(v.drumEnd/v.drumStart,std::min(1.0,t/v.drumSweep));l=oscillator(v.phases[0],freq,sampleRate);}
          else {v.noise=v.noise*1664525u+1013904223u;l=v.noiseFilter.sample(static_cast<float>(static_cast<double>(v.noise)/4294967295.0*2-1));
            if(v.pitch==38||v.pitch==40||v.pitch==39)l+=.25*oscillator(v.phases[0],v.frequency,sampleRate,2);}
        } else if(synth.kind==Synth::Kind::Bass)l=.45*oscillator(v.phases[0],v.frequency,sampleRate,1)+synth.sub*oscillator(v.phases[1],v.frequency,sampleRate);
        else if(synth.kind==Synth::Kind::Pad)l=.27*oscillator(v.phases[0],v.frequency*std::pow(2,-synth.detune/1200),sampleRate,1)+.27*oscillator(v.phases[1],v.frequency*std::pow(2,synth.detune/1200),sampleRate,1)+.2*oscillator(v.phases[2],v.frequency*2,sampleRate,2);
        else if(synth.kind==Synth::Kind::Pluck){
          const double sweep=std::max(.03,std::min(static_cast<double>(v.noteFrames)/sampleRate,synth.sweep));
          if((v.age&15)==0)v.tone.configure(dsp::Filter::Lowpass,sampleRate,4800*std::pow(900.0/4800,std::min(1.0,t/sweep))*std::pow(2,synth.tone*2),.7);
          l=.85*oscillator(v.phases[0],v.frequency,sampleRate,2)+.2*oscillator(v.phases[1],v.frequency*2,sampleRate);
        } else if(synth.kind==Synth::Kind::Rhodes) {
          const double hit=std::min(1.f,v.velocity),index=(.3+2.4*synth.bark)*(.35+.65*hit)*std::pow(2,synth.tone*1.2);
          const double depth=v.frequency*index*(t<.012?1:.1+.9*std::exp(-(t-.012)/.13));
          const double mod=oscillator(v.phases[1],v.frequency,sampleRate)*depth;
          // Frequency modulation can cross zero; reversing phase is part of the
          // tine's original 1:1 FM sound, not a frequency clamp at zero.
          l=.75*std::sin(2*dsp::pi*v.phases[0]);
          v.phases[0]+=std::clamp((v.frequency+mod)/sampleRate,-.45,.45);
          v.phases[0]-=std::floor(v.phases[0]);
          l+=.12*hit*(.3+synth.bark)*(t<.006?1:std::exp(-(t-.006)/.03))*oscillator(v.phases[2],v.frequency*7,sampleRate);
          l=std::tanh(1.2*l+.25*l*l)/std::tanh(1.45);
        } else l=.8*oscillator(v.phases[0],v.frequency,sampleRate)+synth.bell*oscillator(v.phases[1],v.frequency*2,sampleRate,2)+synth.bell*.4*oscillator(v.phases[2],v.frequency*3,sampleRate);
        if(synth.kind!=Synth::Kind::Drums) l=v.tone.sample(static_cast<float>(l));
        r=l;
      }
      double gain=envelope(v);
      if(v.choking){v.chokeGain*=std::exp(-1/(.003*sampleRate));gain*=v.chokeGain;if(v.chokeGain<.006)v.active=false;}
      out[2*i]+=static_cast<float>(l*gain);out[2*i+1]+=static_cast<float>(r*gain);++v.age;
      }
    }
  }
  void reset(std::int64_t frame,bool chase,bool resetEffects,std::uint64_t& overflows)noexcept {
    for(auto& v:voices) v.active=false;
    for(auto& n:pluginNotes) n.active=false;
    pendingCount=0;
    if(instrument)instrument->requestReset();
    if(resetEffects){for(auto& effect:inserts){if(effect.builtin)effect.builtin->reset();if(effect.plugin)effect.plugin->requestReset();}compensation.reset();}
    nextNote=static_cast<std::size_t>(std::lower_bound(timeline.notes.begin(),timeline.notes.end(),frame,[](const NotePair& n,std::int64_t f){return n.onFrame<f;})-timeline.notes.begin());
    nextEvent=static_cast<std::size_t>(std::lower_bound(events.begin(),events.end(),frame,[](const TimedPluginEvent&e,std::int64_t f){return e.frame<f;})-events.begin());
    if(chase&&!timeline.source.isKit&&timeline.enabled)for(std::size_t i=0;i<nextNote;++i){const auto& n=timeline.notes[i];if(n.offFrame>frame)spawn(n.pitch,n.velocity,n.offFrame-frame,n.limitFrame-frame,n.id,false,overflows);}
  }
  void render(std::int64_t frame,std::uint32_t frames,bool playing,const float* input,bool monitor,bool stereoInput,
              const ProcessContext& context,std::uint64_t& overflows,std::uint64_t& invalid)noexcept {
    std::fill_n(buffer.data(),static_cast<std::size_t>(frames)*2,0.f);
    if(!timeline.enabled){peak=0;return;}
    if(playing)for(const auto& resolved:windows) {
      const auto&w=resolved.window;
      if(w.startFrame>=frame+frames)break;
      if(w.endFrame<=frame)continue;
      const auto start=std::max(frame,w.startFrame),end=std::min<std::int64_t>(frame+frames,w.endFrame);
      const double click=std::min(sampleRate*.004,(w.endFrame-w.startFrame)/4.0);
      for(auto absolute=start;absolute<end;++absolute){const auto delta=absolute-w.startFrame;const auto offset=static_cast<std::size_t>(absolute-frame);
        const double envelopePos=w.clipOffsetFrames+delta;
        double gain=w.gain;
        if(w.fadeInFrames>0)gain*=std::min(1.0,envelopePos/w.fadeInFrames);
        if(w.fadeOutFrames>0)gain=std::min(gain,w.gain*std::clamp((w.clipLengthFrames-envelopePos)/w.fadeOutFrames,0.0,1.0));
        if(click>0)gain*=std::min({1.0,delta/click,(w.endFrame-absolute)/click});
        const double position=w.sourceStartFrame+delta*w.sourceSampleRate/sampleRate;
        buffer[2*offset]+=static_cast<float>(pcmSample(*resolved.asset,position,0)*gain);buffer[2*offset+1]+=static_cast<float>(pcmSample(*resolved.asset,position,1)*gain);
      }
    }
    std::size_t eventCount=0;
    for(std::size_t i=0;i<pendingCount&&eventCount<blockEvents.size();++i) blockEvents[eventCount++]=pendingEvents[i];
    pendingCount=0;
    if(instrument) {
      if(playing)while(nextEvent<events.size()&&events[nextEvent].frame<frame+frames){const auto& e=events[nextEvent++];if(e.frame>=frame){if(eventCount<blockEvents.size()){blockEvents[eventCount]=e.event;blockEvents[eventCount++].offset=static_cast<std::uint32_t>(e.frame-frame);}else ++overflows;}}
      for(auto& n:pluginNotes)if(n.active){if(n.remaining<frames){if(eventCount<blockEvents.size())blockEvents[eventCount++]={PluginEvent::Type::NoteOff,static_cast<std::uint32_t>(std::max<std::int64_t>(0,n.remaining)),n.id,n.pitch,0,0,0};else ++overflows;n.active=false;}else n.remaining-=frames;}
      std::sort(blockEvents.begin(),blockEvents.begin()+static_cast<std::ptrdiff_t>(eventCount),[](const PluginEvent&a,const PluginEvent&b){return a.offset<b.offset||(a.offset==b.offset&&a.type==PluginEvent::Type::NoteOff&&b.type!=PluginEvent::Type::NoteOff);});
      instrument->process(buffer.data(),frames,std::span(blockEvents).first(eventCount),context);
    } else {
      std::uint32_t cursor=0;
      if(playing)while(nextNote<timeline.notes.size()&&timeline.notes[nextNote].onFrame<frame+frames) {
        const auto& n=timeline.notes[nextNote++];if(n.onFrame<frame)continue;
        const auto onset=static_cast<std::uint32_t>(n.onFrame-frame);
        voicesInto(buffer.data()+cursor*2,onset-cursor,overflows);cursor=onset;
        spawn(n.pitch,n.velocity,n.offFrame-n.onFrame,n.limitFrame-n.onFrame,n.id,false,overflows);
      }
      voicesInto(buffer.data()+cursor*2,frames-cursor,overflows);
    }
    if(monitor&&input)for(std::size_t i=0;i<static_cast<std::size_t>(frames)*2;++i)buffer[i]+=input[i];
    for(auto& effect:inserts){if(effect.builtin)effect.builtin->process(buffer.data(),frames);else effect.plugin->process(buffer.data(),frames,{},context);}
    // A reduced-latency monitor deliberately avoids waiting for unrelated tracks.
    if(!(monitor&&context.playing&&!context.offline&&contextLowLatency))compensation.process(buffer.data(),frames);
    const double targetPan=timeline.pan,targetGain=timeline.audible?timeline.gain:0;
    const double smoothing=1-std::exp(-1/(sampleRate*.012));
    peak=0;
    for(std::uint32_t i=0;i<frames;++i) {
      fader+=(targetGain-fader)*smoothing;panValue+=(targetPan-panValue)*smoothing;
      const double pan=panValue,gain=fader;
      double l=buffer[2*i],r=buffer[2*i+1];
      // Preserve equal-power mono panning. Duplicating a mono voice into the
      // native stereo scratch buffer must not turn full-left into a +6 dB sum.
      if(!(stereoSource||stereoEffects||(monitor&&stereoInput))){const double angle=(pan+1)*dsp::pi/4;r=l*std::sin(angle);l*=std::cos(angle);}
      else if(pan<0){const double angle=(pan+1)*dsp::pi/2;l+=r*std::cos(angle);r*=std::sin(angle);}
      else if(pan>0){const double angle=pan*dsp::pi/2;r+=l*std::sin(angle);l*=std::cos(angle);}
      l*=gain;r*=gain;
      if(!std::isfinite(l)){l=0;++invalid;}if(!std::isfinite(r)){r=0;++invalid;}
      buffer[2*i]=static_cast<float>(std::clamp(l,-32.0,32.0));buffer[2*i+1]=static_cast<float>(std::clamp(r,-32.0,32.0));
      peak=std::max(peak,static_cast<float>(std::max(std::abs(l),std::abs(r))));
    }
  }
  bool contextLowLatency=true;
};

std::shared_ptr<const PcmAsset> resolveAsset(const AssetStore& assets,const std::string&id) {
  const auto a=assets.find(id);require(a!=assets.end()&&a->second,"Native PCM asset is not registered");
  require(a->second->channels>=1&&a->second->channels<=32&&a->second->sampleRate>=8000&&a->second->sampleRate<=192000,"Invalid native PCM asset format");
  require(!a->second->samples.empty()&&a->second->samples.size()%a->second->channels==0,"Invalid native PCM asset length");
  return a->second;
}
ResolvedSet resolveSet(const SampleSet& set,const AssetStore& assets) {
  ResolvedSet result;result.isKit=set.isKit;result.gainDb=checked(set.gainDb,-120,48,"Invalid sample set gain");result.startOffset=checked(set.startOffset,0,10,"Invalid sample codec offset");
  require(!set.zones.empty()&&set.zones.size()<=10000&&set.releaseZones.size()<=10000,"Invalid sample zone count");
  auto convert=[&](const std::vector<SampleZone>& zones){std::vector<ResolvedZone> out;out.reserve(zones.size());
    for(const auto&z:zones){require(z.root>=0&&z.root<=127&&z.lo>=0&&z.hi<=127&&z.lo<=z.hi,"Invalid sample key range");
      checked(z.vlo,0,1,"Invalid velocity zone");checked(z.vhi,z.vlo,1,"Invalid velocity zone");checked(z.gainDb,-120,48,"Invalid sample gain");checked(z.tune,-4800,4800,"Invalid sample tuning");
      auto a=resolveAsset(assets,z.assetId);require(set.startOffset*a->sampleRate<a->frames(),"Sample codec offset exceeds asset");
      if(z.loop){checked(z.loop->at(0),0,static_cast<double>(a->frames())/a->sampleRate,"Invalid sample loop start");checked(z.loop->at(1),z.loop->at(0),static_cast<double>(a->frames())/a->sampleRate-set.startOffset,"Invalid sample loop end");require(z.loop->at(1)>z.loop->at(0),"Empty sample loop");}
      out.push_back({z,std::move(a)});
    }return out;};
  result.zones=convert(set.zones);result.releases=convert(set.releaseZones);return result;
}

struct ControlRecipe {
  ProjectTimeline timeline;
  std::vector<std::shared_ptr<const PcmAsset>> assets;
  std::vector<SampleSet> sets;
};
// This potentially large exact comparison happens only on the control thread.
// The callback receives a predecessor serial, not a hash or JSON to compare.
bool sameStructure(const ControlRecipe& a,const ControlRecipe& b) {
  const auto&x=a.timeline;const auto&y=b.timeline;
  if(x.projectId!=y.projectId||x.sampleRate!=y.sampleRate||x.bpm!=y.bpm||x.beatsPerBar!=y.beatsPerBar||x.timeSigNumerator!=y.timeSigNumerator||x.timeSigDenominator!=y.timeSigDenominator||x.lengthFrames!=y.lengthFrames||x.cycle!=y.cycle||x.tracks.size()!=y.tracks.size()||a.assets!=b.assets||a.sets!=b.sets)return false;
  for(std::size_t i=0;i<x.tracks.size();++i) {
    const auto&tx=x.tracks[i];const auto&ty=y.tracks[i];
    const auto samePlugin=[](const PluginSpec&a,const PluginSpec&b){return a.instanceId==b.instanceId&&a.path==b.path&&a.classId==b.classId&&a.state==b.state&&a.controllerState==b.controllerState&&a.isInstrument==b.isInstrument;};
    const auto&sx=tx.source;const auto&sy=ty.source;
    if(tx.id!=ty.id||sx.kind!=sy.kind||sx.instrumentId!=sy.instrumentId||sx.sampleSetId!=sy.sampleSetId||sx.isKit!=sy.isKit||!samePlugin(sx.plugin,sy.plugin)||tx.enabled!=ty.enabled||tx.notes!=ty.notes||tx.audio!=ty.audio||tx.inserts.size()!=ty.inserts.size())return false;
    for(std::size_t j=0;j<tx.inserts.size();++j){const auto&ex=tx.inserts[j];const auto&ey=ty.inserts[j];
      if(ex.id!=ey.id||ex.type!=ey.type||ex.enabled!=ey.enabled||(ex.type=="vst3"&&!samePlugin(ex.plugin,ey.plugin)))return false;
    }
  }
  return true;
}

} // namespace

struct PreparedProject::Impl {
  ProjectTimeline timeline;
  std::vector<TrackRuntime> tracks;
  dsp::Master master;
  std::uint32_t latency=0;
  double tail=.85;
  std::shared_ptr<const ControlRecipe> recipe;
  std::uint64_t serial=0,preserveFrom=0;
  explicit Impl(const ProjectTimeline& p):timeline(p),master(p.sampleRate){}
  void reset(std::int64_t frame,bool chase,bool effects,std::uint64_t& overflows)noexcept {
    for(auto&track:tracks) track.reset(frame,chase,effects,overflows);
    if(effects) master.reset();
  }
  void takeStateFrom(Impl& previous)noexcept {
    for(std::size_t i=0;i<tracks.size();++i)tracks[i].takeStateFrom(previous.tracks[i]);
    master.takeStateFrom(previous.master);
  }
};
PreparedProject::PreparedProject(std::unique_ptr<Impl> impl):impl_(std::move(impl)){}
PreparedProject::~PreparedProject()=default;
PreparedProject::PreparedProject(PreparedProject&&)noexcept=default;
PreparedProject& PreparedProject::operator=(PreparedProject&&)noexcept=default;
std::size_t PreparedProject::trackCount()const noexcept{return impl_->tracks.size();}
double PreparedProject::tailSeconds()const noexcept{return impl_->tail;}
std::uint32_t PreparedProject::latencyFrames()const noexcept{return impl_->latency;}

struct RenderEngine::Impl {
  enum class Kind { Graph,Play,Pause,Stop,Seek,Preview,NoteOn,NoteOff,Monitor,RecordStart,RecordStop,Master,Input };
  struct Command {Kind kind=Kind::Stop;std::uint64_t ticket=0;PreparedProject*graph=nullptr;std::uint32_t track=0;std::int64_t frame=0;int pitch=60;std::int32_t noteId=-1;float value=1;std::array<std::uint64_t,4>mask{};};
  std::uint32_t rate,maxBlock;
  PreparedProject*active=nullptr;
  SpscQueue<Command,1024> commands;
  SpscQueue<PreparedProject*,4096>retired;
  std::uint64_t nextTicket=1,lastTicket=0,voiceOverflows=0,invalidSamples=0;
  std::atomic<std::uint64_t>commandOverflows{0};
  std::shared_ptr<const ControlRecipe>lastSubmittedRecipe;
  std::uint64_t lastSubmittedSerial=0;
  std::int64_t position=0;
  std::int64_t continuousFrame=0;
  bool playing=false,offline=false,recording=false;
  float masterGain=1;
  float targetMasterGain=1;
  std::array<std::uint64_t,4>monitor{};
  int inputLeft=0,inputRight=1;
  std::vector<float>inputScratch;
  std::vector<float>recordingRing;
  std::uint32_t recordingCapacity;
  alignas(64) std::atomic<std::uint64_t>recordingWrite{0},recordingRead{0};
  std::uint64_t recordedFrames=0,droppedFrames=0;
  std::int64_t recordingStart=0;
  struct AtomicSnapshot {
    std::atomic<std::uint64_t>revision{0},ticket{0},voiceOverflows{0},invalidSamples{0},recorded{0},dropped{0};
    std::atomic<std::int64_t>frame{0},recordingStart{0};
    std::atomic<std::uint32_t>trackCount{0},latency{0};
    std::atomic<bool>ready{false},playing{false},recording{false};
    std::atomic<float>masterPeak{0};std::array<std::atomic<float>,256>trackPeaks{};
  }published;
  Impl(std::uint32_t r,std::uint32_t b,std::uint32_t capacity):rate(r),maxBlock(b),inputScratch(static_cast<std::size_t>(b)*2),recordingRing(static_cast<std::size_t>(capacity)*2),recordingCapacity(capacity){}
  ~Impl(){Command c;while(commands.pop(c))if(c.kind==Kind::Graph)delete c.graph;PreparedProject*p=nullptr;while(retired.pop(p))delete p;delete active;}
  std::uint64_t enqueue(Command command) {
    command.ticket=nextTicket++;
    if(!commands.push(command)){commandOverflows.fetch_add(1,std::memory_order_relaxed);return 0;}return command.ticket;
  }
  void reset(bool chase,bool effects)noexcept{if(active)active->impl_->reset(position,chase,effects,voiceOverflows);}
  void normalize(bool starting=false)noexcept {
    if(!active){position=0;return;}
    const auto&p=active->impl_->timeline;position=std::clamp<std::int64_t>(position,0,p.lengthFrames);
    if(!offline&&p.cycle&&position>=p.cycle->at(1))position=p.cycle->at(0);
    else if(starting&&position==p.lengthFrames)position=0;
  }
  void consume()noexcept {
    Command c;
    while(commands.pop(c)) {
      switch(c.kind) {
        case Kind::Graph: {
          const bool projectChanged=!active||active->impl_->timeline.projectId!=c.graph->impl_->timeline.projectId;
          auto*previous=active;
          const bool preserve=previous&&c.graph->impl_->preserveFrom&&previous->impl_->serial==c.graph->impl_->preserveFrom;
          active=c.graph;targetMasterGain=active->impl_->timeline.masterGain;
          if(preserve)active->impl_->takeStateFrom(*previous->impl_);
          else masterGain=targetMasterGain;
          if(projectChanged){position=0;playing=false;monitor={};}
          normalize();if(!preserve)reset(playing,true);
          if(previous){const bool accepted=retired.push(previous);(void)accepted;}
          break;
        }
        case Kind::Play:if(!playing){normalize(true);playing=active!=nullptr;reset(playing,false);}break;
        case Kind::Pause:playing=false;reset(false,false);break;
        case Kind::Stop:playing=false;position=0;reset(false,true);break;
        case Kind::Seek:position=c.frame;normalize();reset(playing,true);break;
        case Kind::Preview:case Kind::NoteOn:
          if(active&&c.track<active->impl_->tracks.size()) active->impl_->tracks[c.track].spawn(c.pitch,c.value,c.frame,c.frame,c.noteId,true,voiceOverflows);
          break;
        case Kind::NoteOff:
          if(active&&c.track<active->impl_->tracks.size()) active->impl_->tracks[c.track].noteOff(c.pitch,c.noteId,voiceOverflows);
          break;
        case Kind::Monitor:monitor=c.mask;break;
        case Kind::RecordStart:recording=true;recordingStart=position;recordedFrames=0;droppedFrames=0;break;
        case Kind::RecordStop:recording=false;break;
        case Kind::Master:targetMasterGain=c.value;break;
        case Kind::Input:inputLeft=c.pitch;inputRight=static_cast<int>(c.frame);break;
      }
      lastTicket=c.ticket;
    }
  }
  void publish(float masterPeak)noexcept {
    published.frame.store(position,std::memory_order_relaxed);published.playing.store(playing,std::memory_order_relaxed);published.ready.store(active!=nullptr,std::memory_order_relaxed);
    const auto count=active?active->impl_->tracks.size():0;
    published.trackCount.store(static_cast<std::uint32_t>(count),std::memory_order_relaxed);
    published.revision.store(active?active->impl_->timeline.revision:0,std::memory_order_relaxed);
    published.latency.store(active?active->impl_->latency:0,std::memory_order_relaxed);
    for(std::size_t i=0;i<count;++i)published.trackPeaks[i].store(active->impl_->tracks[i].peak,std::memory_order_relaxed);
    published.masterPeak.store(masterPeak,std::memory_order_relaxed);published.voiceOverflows.store(voiceOverflows,std::memory_order_relaxed);published.invalidSamples.store(invalidSamples,std::memory_order_relaxed);
    published.recording.store(recording,std::memory_order_relaxed);published.recordingStart.store(recordingStart,std::memory_order_relaxed);
    published.recorded.store(recordedFrames,std::memory_order_relaxed);published.dropped.store(droppedFrames,std::memory_order_relaxed);
    published.ticket.store(lastTicket,std::memory_order_release);
  }
};

RenderEngine::RenderEngine(std::uint32_t sr,std::uint32_t maxBlock,std::uint32_t recordCapacity) {
  require(sr>=8000&&sr<=192000&&maxBlock>=1&&maxBlock<=65536,"Invalid native engine format");
  require(recordCapacity>=maxBlock&&recordCapacity<=sr*60,"Invalid recording ring capacity");
  static_assert(std::atomic<float>::is_always_lock_free&&std::atomic<std::uint64_t>::is_always_lock_free,"Native audio requires lock-free float and 64-bit atomics");
  impl_=std::make_unique<Impl>(sr,maxBlock,recordCapacity);
}
RenderEngine::~RenderEngine()=default;

std::unique_ptr<PreparedProject> RenderEngine::prepare(const ProjectTimeline& p,const AssetStore& assets,const SampleSetStore& sets,const PluginResolver& resolvePlugin)const {
  require(p.version==1&&p.sampleRate==impl_->rate,"Native project/device sample rates must agree");
  require(p.tracks.size()<=256&&p.lengthFrames>0&&p.lengthFrames<=static_cast<std::int64_t>(p.sampleRate)*3600,"Native project exceeds track/duration limits");
  require(p.projectId.size()<=200&&!p.projectId.empty(),"Invalid native project ID");
  checked(p.bpm,20,400,"Invalid native tempo");checked(p.masterGain,0,2,"Invalid native master gain");
  require(p.timeSigNumerator>=1&&p.timeSigNumerator<=32&&(p.timeSigDenominator==2||p.timeSigDenominator==4||p.timeSigDenominator==8||p.timeSigDenominator==16),"Invalid native meter");
  if(p.cycle)require(p.cycle->at(0)>=0&&p.cycle->at(1)<=p.lengthFrames&&p.cycle->at(1)>p.cycle->at(0),"Invalid native cycle");
  std::size_t estimated=0,noteCount=0,windowCount=0;
  std::set<std::string>ids,pluginIds;
  for(const auto&t:p.tracks){require(!t.id.empty()&&t.id.size()<=200&&ids.insert(t.id).second,"Invalid or duplicate native track ID");
    noteCount+=t.notes.size();windowCount+=t.audio.size();require(t.inserts.size()<=64&&t.audio.size()<=2048,"Native track exceeds limits");
    const auto uniquePlugin=[&](const PluginSpec&plugin){require(!plugin.instanceId.empty()&&pluginIds.insert(plugin.instanceId).second,"Invalid or duplicate native plugin instance ID");};
    if(t.source.kind==TrackSource::Kind::Vst3)uniquePlugin(t.source.plugin);
    for(const auto&e:t.inserts)if(e.type=="vst3")uniquePlugin(e.plugin);
    for(const auto&e:t.inserts)if(t.enabled&&e.enabled)estimated+=dsp::estimateEffectMemory(e.type,p.sampleRate);
  }
  require(noteCount<=100000&&windowCount<=8192&&estimated<=memoryLimit,"Native project exceeds bounded memory/event limits");
  auto result=std::make_unique<PreparedProject::Impl>(p);result->tracks.reserve(p.tracks.size());
  auto recipe=std::make_shared<ControlRecipe>();recipe->timeline=p;
  for(const auto&t:p.tracks) {
    TrackRuntime track;track.timeline=t;track.sampleRate=p.sampleRate;track.contextLowLatency=p.lowLatencyMonitoring;
    track.fader=t.audible?t.gain:0;track.panValue=t.pan;
    checked(t.gain,0,2,"Invalid native track gain");checked(t.pan,-1,1,"Invalid native pan");
    track.buffer.resize(static_cast<std::size_t>(impl_->maxBlock)*2);
    require(t.source.kind!=TrackSource::Kind::Audio||t.notes.empty(),"Audio tracks cannot contain instrument notes");
    require(t.source.kind==TrackSource::Kind::Audio||t.audio.empty(),"Instrument tracks cannot contain audio windows");
    if(t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)track.synth=compileSynth(t.source);
    // An explicitly disabled source is retained in the immutable recipe but
    // needs neither its sample library nor a loadable third-party plug-in.
    if(!t.enabled){result->tracks.push_back(std::move(track));continue;}
    double trackTail=0;
    if(t.source.kind==TrackSource::Kind::BuiltinSampled){const auto set=sets.find(t.source.sampleSetId);require(set!=sets.end(),"Required native sample set is not registered");require(set->second.isKit==t.source.isKit,"Sample kind differs from instrument");track.samples=resolveSet(set->second,assets);recipe->sets.push_back(set->second);
      for(const auto&z:track.samples.zones){recipe->assets.push_back(z.asset);track.stereoSource|=z.asset->channels>1;
        if(t.source.isKit)trackTail=std::max(trackTail,(static_cast<double>(z.asset->frames())/z.asset->sampleRate-track.samples.startOffset)/std::pow(2,z.zone.tune/1200+track.synth.tune/12)*track.synth.decay+.014);
      }
      for(const auto&z:track.samples.releases){recipe->assets.push_back(z.asset);track.stereoSource|=z.asset->channels>1;
        trackTail=std::max(trackTail,(static_cast<double>(z.asset->frames())/z.asset->sampleRate-track.samples.startOffset)/std::pow(2,(z.zone.lo-z.zone.root)/12.0+z.zone.tune/1200));
      }
    }
    if(t.source.kind==TrackSource::Kind::Vst3){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");track.instrument=resolvePlugin(t.source.plugin,p.sampleRate,impl_->maxBlock);require(static_cast<bool>(track.instrument),"VST3 instrument could not be prepared");track.latency=track.instrument->latencyFrames();track.stereoSource=true;trackTail=checked(track.instrument->tailSeconds(),0,3600,"Invalid plugin tail time");require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");}
    if(t.source.kind==TrackSource::Kind::BuiltinSynth||t.source.kind==TrackSource::Kind::BuiltinSampled)trackTail=std::max(trackTail,t.source.isKit?(track.synth.kind==Synth::Kind::Drums?.62*track.synth.decay+.004:0):track.synth.release*1.5+.02);
    std::set<std::int32_t>noteIds;
    for(const auto&n:t.notes){require(noteIds.insert(n.id).second&&n.pitch>=0&&n.pitch<=127&&n.onFrame>=-p.lengthFrames&&n.offFrame>n.onFrame&&n.offFrame>0&&n.offFrame<=p.lengthFrames&&n.limitFrame>=n.offFrame&&n.limitFrame<=p.lengthFrames,"Invalid native note event");checked(n.velocity,0,2,"Invalid native note velocity");
      if(track.instrument&&n.velocity>0){track.events.push_back({n.onFrame,{PluginEvent::Type::NoteOn,0,n.id,static_cast<std::uint8_t>(n.pitch),0,std::min(1.f,n.velocity),0}});track.events.push_back({n.offFrame,{PluginEvent::Type::NoteOff,0,n.id,static_cast<std::uint8_t>(n.pitch),0,0,0}});}
    }
    std::stable_sort(track.timeline.notes.begin(),track.timeline.notes.end(),[](const NotePair&a,const NotePair&b){return a.onFrame<b.onFrame||(a.onFrame==b.onFrame&&a.id<b.id);});
    std::stable_sort(track.events.begin(),track.events.end(),[](const TimedPluginEvent&a,const TimedPluginEvent&b){return a.frame<b.frame||(a.frame==b.frame&&a.event.type==PluginEvent::Type::NoteOff&&b.event.type!=PluginEvent::Type::NoteOff);});
    for(std::size_t begin=0,end=0;end<track.events.size();++end){
      while(track.events[end].frame-track.events[begin].frame>=impl_->maxBlock)++begin;
      // Leave room for all queued live notes and their auto-release events.
      require(end-begin+1<=maxPluginEvents-maxVoices*2,"VST note density exceeds the bounded event buffer");
    }
    for(const auto&w:t.audio){require(w.startFrame>=0&&w.endFrame>w.startFrame&&w.endFrame<=p.lengthFrames&&w.clipLengthFrames>0&&w.clipOffsetFrames>=0&&w.fadeInFrames>=0&&w.fadeOutFrames>=0,"Invalid native audio window");
      checked(w.gain,0,2,"Invalid audio window gain");checked(w.sourceStartFrame,0,1e15,"Invalid audio source offset");checked(w.sourceSampleRate,8000,192000,"Invalid source sample rate");
      auto a=resolveAsset(assets,w.assetId);require(w.sourceSampleRate==a->sampleRate&&w.sourceStartFrame<a->frames(),"Audio window does not match registered PCM");
      track.stereoSource|=a->channels>1;
      recipe->assets.push_back(a);
      track.windows.push_back({w,std::move(a)});
    }
    std::stable_sort(track.windows.begin(),track.windows.end(),[](const ResolvedWindow&a,const ResolvedWindow&b){return a.window.startFrame<b.window.startFrame;});
    std::set<std::string>insertIds;
    for(const auto&e:t.inserts){require(!e.id.empty()&&insertIds.insert(e.id).second,"Duplicate native insert ID");if(!e.enabled)continue;
      InsertRuntime effect;
      if(e.type=="vst3"){require(static_cast<bool>(resolvePlugin),"No native VST3 host is available");effect.plugin=resolvePlugin(e.plugin,p.sampleRate,impl_->maxBlock);require(static_cast<bool>(effect.plugin),"VST3 effect could not be prepared");const auto latency=effect.plugin->latencyFrames();require(latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.latency+=latency;trackTail+=checked(effect.plugin->tailSeconds(),0,3600,"Invalid plugin tail time");track.stereoEffects=true;}
      else {effect.builtin=dsp::makeEffect(e.type,e.params,p.sampleRate,p.bpm);track.latency+=effect.builtin->latencyFrames();trackTail+=effect.builtin->tailSeconds();track.stereoEffects|=e.type=="reverb"||e.type=="guitar-rig";}
      require(track.latency<=p.sampleRate*30,"Plugin latency exceeds native memory budget");track.inserts.push_back(std::move(effect));
    }
    result->tail=std::max(result->tail,trackTail+.15);
    result->latency=std::max(result->latency,track.latency);result->tracks.push_back(std::move(track));
  }
  estimated+=static_cast<std::size_t>(result->latency)*p.tracks.size()*16;
  require(estimated<=memoryLimit,"Plugin compensation exceeds native memory budget");
  for(auto&t:result->tracks)t.compensation=CompensationDelay(result->latency-t.latency);
  result->recipe=std::move(recipe);
  return std::unique_ptr<PreparedProject>(new PreparedProject(std::move(result)));
}

void RenderEngine::submit(std::unique_ptr<PreparedProject> project) {
  require(project!=nullptr,"Cannot submit an empty native graph");collectRetired();
  auto recipe=project->impl_->recipe;
  project->impl_->serial=impl_->nextTicket;
  project->impl_->preserveFrom=impl_->lastSubmittedRecipe&&sameStructure(*recipe,*impl_->lastSubmittedRecipe)?impl_->lastSubmittedSerial:0;
  Impl::Command c;c.kind=Impl::Kind::Graph;c.graph=project.get();
  const auto serial=impl_->enqueue(c);
  if(!serial)throw std::runtime_error("Native graph command queue is full");
  impl_->lastSubmittedRecipe=std::move(recipe);impl_->lastSubmittedSerial=serial;
  (void)project.release();
}
void RenderEngine::collectRetired(){PreparedProject*p=nullptr;while(impl_->retired.pop(p))delete p;}
std::uint64_t RenderEngine::play(){Impl::Command c;c.kind=Impl::Kind::Play;return impl_->enqueue(c);}
std::uint64_t RenderEngine::pause(){Impl::Command c;c.kind=Impl::Kind::Pause;return impl_->enqueue(c);}
std::uint64_t RenderEngine::stop(){Impl::Command c;c.kind=Impl::Kind::Stop;return impl_->enqueue(c);}
std::uint64_t RenderEngine::seek(std::int64_t frame){Impl::Command c;c.kind=Impl::Kind::Seek;c.frame=frame;return impl_->enqueue(c);}
std::uint64_t RenderEngine::previewNote(std::uint32_t track,int pitch,float velocity,std::uint32_t duration){require(track<256&&pitch>=0&&pitch<=127&&duration>0&&duration<=impl_->rate*30,"Invalid preview note");checked(velocity,0,2,"Invalid preview velocity");Impl::Command c;c.kind=Impl::Kind::Preview;c.track=track;c.pitch=pitch;c.value=velocity;c.frame=duration;c.noteId=-2;return impl_->enqueue(c);}
std::uint64_t RenderEngine::noteOn(std::uint32_t track,int pitch,float velocity,std::int32_t id){require(track<256&&pitch>=0&&pitch<=127,"Invalid live MIDI note");checked(velocity,0,2,"Invalid MIDI velocity");Impl::Command c;c.kind=Impl::Kind::NoteOn;c.track=track;c.pitch=pitch;c.value=velocity;c.noteId=id;c.frame=unlimitedFrame;return impl_->enqueue(c);}
std::uint64_t RenderEngine::noteOff(std::uint32_t track,int pitch,std::int32_t id){require(track<256&&pitch>=0&&pitch<=127,"Invalid MIDI note off");Impl::Command c;c.kind=Impl::Kind::NoteOff;c.track=track;c.pitch=pitch;c.noteId=id;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setMonitoring(std::span<const std::uint32_t> tracks){Impl::Command c;c.kind=Impl::Kind::Monitor;for(const auto t:tracks){require(t<256,"Invalid monitor track index");c.mask[t/64]|=std::uint64_t{1}<<(t%64);}return impl_->enqueue(c);}
std::uint64_t RenderEngine::startRecording(){require(impl_->recordingRead.load(std::memory_order_acquire)==impl_->recordingWrite.load(std::memory_order_acquire),"Previous recording must be drained before starting a take");Impl::Command c;c.kind=Impl::Kind::RecordStart;return impl_->enqueue(c);}
std::uint64_t RenderEngine::stopRecording(){Impl::Command c;c.kind=Impl::Kind::RecordStop;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setMasterGain(float gain){checked(gain,0,2,"Invalid master gain");Impl::Command c;c.kind=Impl::Kind::Master;c.value=gain;return impl_->enqueue(c);}
std::uint64_t RenderEngine::setInputChannels(int left,int right){require(left>=0&&left<64&&right>=-1&&right<64,"Invalid native input channel");Impl::Command c;c.kind=Impl::Kind::Input;c.pitch=left;c.frame=right;return impl_->enqueue(c);}
void RenderEngine::setOffline(bool value)noexcept{impl_->offline=value;}

void RenderEngine::render(float* output,const float* input,std::uint32_t frames,std::uint32_t channels)noexcept {
  if(!output)return;
  auto& e=*impl_;e.consume();
  std::uint32_t cursor=0;float masterPeak=0;
  while(cursor<frames) {
    auto count=std::min(e.maxBlock,frames-cursor);
    if(e.active&&e.playing) {
      const auto&p=e.active->impl_->timeline;
      const auto boundary=!e.offline&&p.cycle?p.cycle->at(1):p.lengthFrames;
      if(e.position>=boundary) {
        if(!e.offline&&p.cycle){e.position=p.cycle->at(0);e.reset(true,false);}
        else if(!e.offline){e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.instrument)track.instrument->requestReset();}
      }
      if(e.playing&&e.position<boundary)count=static_cast<std::uint32_t>(std::min<std::int64_t>(count,boundary-e.position));
    }
    for(std::uint32_t i=0;i<count;++i) {
      for(unsigned c=0;c<2;++c) {
        const int channel=c?(e.inputRight<0?e.inputLeft:e.inputRight):e.inputLeft;
        float value=input&&channel>=0&&static_cast<std::uint32_t>(channel)<channels?input[static_cast<std::size_t>(cursor+i)*channels+channel]:0;
        if(!std::isfinite(value)){value=0;++e.invalidSamples;}
        e.inputScratch[2*i+c]=value;
      }
    }
    if(e.recording) {
      auto write=e.recordingWrite.load(std::memory_order_relaxed);const auto read=e.recordingRead.load(std::memory_order_acquire);
      const auto available=e.recordingCapacity-(write-read),take=std::min<std::uint64_t>(available,count);
      for(std::uint64_t i=0;i<take;++i){const auto index=(write+i)%e.recordingCapacity;e.recordingRing[index*2]=e.inputScratch[i*2];e.recordingRing[index*2+1]=e.inputScratch[i*2+1];}
      e.recordingWrite.store(write+take,std::memory_order_release);e.recordedFrames+=count;e.droppedFrames+=count-take;
      if(take<count)e.recording=false;
    }
    auto*out=output+static_cast<std::size_t>(cursor)*2;std::fill_n(out,static_cast<std::size_t>(count)*2,0.f);
    if(e.active) {
      auto& p=*e.active->impl_;
      ProcessContext context{static_cast<double>(e.rate),p.timeline.bpm,e.position,e.playing&&e.position<p.timeline.lengthFrames,e.offline,p.timeline.timeSigNumerator,p.timeline.timeSigDenominator};
      context.recording=e.recording;context.continuousFrame=e.continuousFrame;
      if(p.timeline.cycle&&!e.offline){context.cycleActive=true;context.cycleStartFrame=p.timeline.cycle->at(0);context.cycleEndFrame=p.timeline.cycle->at(1);}
      for(std::size_t index=0;index<p.tracks.size();++index) {
        auto&t=p.tracks[index];const bool monitor=(e.monitor[index/64]&(std::uint64_t{1}<<(index%64)))!=0;
        const bool stereoInput=e.inputRight>=0&&e.inputRight!=e.inputLeft&&static_cast<std::uint32_t>(e.inputRight)<channels;
        t.render(e.position,count,e.playing&&e.position<p.timeline.lengthFrames,e.inputScratch.data(),monitor,stereoInput,context,e.voiceOverflows,e.invalidSamples);
        for(std::size_t sample=0;sample<static_cast<std::size_t>(count)*2;++sample)out[sample]+=t.buffer[sample];
      }
      const float smoothing=static_cast<float>(1-std::exp(-1/(e.rate*.012)));
      for(std::uint32_t i=0;i<count;++i){e.masterGain+=(e.targetMasterGain-e.masterGain)*smoothing;out[2*i]*=e.masterGain;out[2*i+1]*=e.masterGain;}
      p.master.process(out,count);
    }
    for(std::size_t i=0;i<static_cast<std::size_t>(count)*2;++i){if(!std::isfinite(out[i])){out[i]=0;++e.invalidSamples;}masterPeak=std::max(masterPeak,std::abs(out[i]));}
    if(e.playing) e.position+=count;
    e.continuousFrame+=count;
    cursor+=count;
  }
  if(e.active&&e.playing&&!e.offline) {
    const auto&p=e.active->impl_->timeline;
    if(p.cycle&&e.position>=p.cycle->at(1)){e.position=p.cycle->at(0);e.reset(true,false);}
    else if(!p.cycle&&e.position>=p.lengthFrames){e.playing=false;for(auto&track:e.active->impl_->tracks)if(track.instrument)track.instrument->requestReset();}
  }
  e.publish(masterPeak);
}

EngineSnapshot RenderEngine::snapshot()const noexcept {
  const auto&e=*impl_;const auto&p=e.published;EngineSnapshot s;
  s.lastAppliedCommand=p.ticket.load(std::memory_order_acquire);s.revision=p.revision.load(std::memory_order_relaxed);s.frame=p.frame.load(std::memory_order_relaxed);s.sampleRate=e.rate;
  s.trackCount=p.trackCount.load(std::memory_order_relaxed);s.latencyFrames=p.latency.load(std::memory_order_relaxed);s.ready=p.ready.load(std::memory_order_relaxed);s.playing=p.playing.load(std::memory_order_relaxed);
  s.masterPeak=p.masterPeak.load(std::memory_order_relaxed);for(std::uint32_t i=0;i<std::min(256u,s.trackCount);++i)s.trackPeaks[i]=p.trackPeaks[i].load(std::memory_order_relaxed);
  s.commandOverflows=e.commandOverflows.load(std::memory_order_relaxed);s.voiceOverflows=p.voiceOverflows.load(std::memory_order_relaxed);s.invalidSamples=p.invalidSamples.load(std::memory_order_relaxed);
  s.recording=p.recording.load(std::memory_order_relaxed);s.recordingStartFrame=p.recordingStart.load(std::memory_order_relaxed);s.recordedFrames=p.recorded.load(std::memory_order_relaxed);s.recordingDroppedFrames=p.dropped.load(std::memory_order_relaxed);return s;
}
std::uint32_t RenderEngine::drainRecording(float* destination,std::uint32_t capacity)noexcept {
  if(!destination||!capacity)return 0;
  auto&e=*impl_;const auto read=e.recordingRead.load(std::memory_order_relaxed),write=e.recordingWrite.load(std::memory_order_acquire);
  const auto count=static_cast<std::uint32_t>(std::min<std::uint64_t>(write-read,capacity));
  for(std::uint32_t i=0;i<count;++i){const auto index=(read+i)%e.recordingCapacity;destination[2*i]=e.recordingRing[index*2];destination[2*i+1]=e.recordingRing[index*2+1];}
  e.recordingRead.store(read+count,std::memory_order_release);return count;
}

} // namespace garak
