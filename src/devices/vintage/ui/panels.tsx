import { ParamKnob, Section, Segmented, useVintage } from './controls'
import { AdsrGraph, DamperCurve, DcoPreview, FilterResponse, LfoDisplay, PickupCurve, TremoloDisplay } from './graphs'

/** 옥구슬 EP: tine + hammer, pickup, damper, tremolo/autopan, amp. */
export function OkguEpPanel() {
  const { value } = useVintage()
  return <div className="vt-grid-layout vt-grid-layout--ep">
    <Section eyebrow="TINE · HAMMER" title="타인 / 해머" className="vt-span-2">
      <ParamKnob id="tone"/><ParamKnob id="decay"/><ParamKnob id="bell"/><ParamKnob id="hammer"/><ParamKnob id="dynamics"/><ParamKnob id="tune"/>
    </Section>
    <Section eyebrow="PICKUP" title="픽업" graph={<PickupCurve bark={value('bark')} pickup={value('pickup')}/>}>
      <ParamKnob id="bark"/><ParamKnob id="pickup"/>
    </Section>
    <Section eyebrow="DAMPER" title="댐퍼" graph={<DamperCurve release={value('release')} decay={value('decay')} thump={value('thump')}/>}>
      <ParamKnob id="release"/><ParamKnob id="thump"/>
    </Section>
    <Section eyebrow="TREMOLO · AUTOPAN" title="트레몰로" graph={<TremoloDisplay rate={value('tremRate')} depth={value('tremDepth')} autopan={value('autopan')}/>}>
      <ParamKnob id="tremRate"/><ParamKnob id="tremDepth"/><ParamKnob id="autopan"/>
    </Section>
    <Section eyebrow="AMP" title="앰프" className="vt-amp">
      <ParamKnob id="drive" size={46}/><ParamKnob id="level" size={46}/>
    </Section>
  </div>
}

/** 한밤 106: DCO, HPF, VCF, ENV, VCA, LFO, performance, chorus, level. */
export function Hanbam106Panel() {
  const { value } = useVintage()
  return <div className="vt-grid-layout vt-grid-layout--synth">
    <Section eyebrow="LFO" title="LFO" graph={<LfoDisplay rate={value('lfoRate')} delay={value('lfoDelay')}/>}>
      <ParamKnob id="lfoRate"/><ParamKnob id="lfoDelay"/><ParamKnob id="vibrato"/>
    </Section>
    <Section eyebrow="DCO" title="오실레이터" className="vt-span-2 vt-dco"
      graph={<DcoPreview saw={value('saw')} pulse={value('pulse')} pwm={value('pwm')} sub={value('sub')} noise={value('noise')}/>}>
      <Segmented id="range"/>
      <ParamKnob id="saw"/><ParamKnob id="pulse"/><ParamKnob id="pwm"/>
      <Segmented id="pwmSource"/>
      <ParamKnob id="sub"/><ParamKnob id="noise"/>
    </Section>
    <Section eyebrow="HPF · VCF" title="필터" className="vt-span-2" graph={<FilterResponse cutoff={value('cutoff')} resonance={value('resonance')} hpf={value('hpf')}/>}>
      <Segmented id="hpf" variant="switch" vertical/>
      <ParamKnob id="cutoff" size={46}/><ParamKnob id="resonance" size={46}/><ParamKnob id="envAmount"/><ParamKnob id="lfoFilter"/><ParamKnob id="keyTrack"/>
    </Section>
    <Section eyebrow="ENV" title="엔벨로프" className="vt-span-2"
      graph={<AdsrGraph attack={value('attack')} decay={value('decay')} sustain={value('sustain')} release={value('release')} gate={value('vcaMode') === 1}/>}>
      <ParamKnob id="attack"/><ParamKnob id="decay"/><ParamKnob id="sustain"/><ParamKnob id="release"/><ParamKnob id="velocity"/>
    </Section>
    <Section eyebrow="VCA" title="VCA">
      <Segmented id="vcaMode" variant="switch" vertical/>
    </Section>
    <Section eyebrow="PERFORMANCE" title="퍼포먼스">
      <ParamKnob id="glide"/><ParamKnob id="drift"/><Segmented id="voices"/>
    </Section>
    <Section eyebrow="CHORUS" title="코러스" className="vt-chorus">
      <Segmented id="chorus" variant="hardware"/>
    </Section>
    <Section eyebrow="OUTPUT" title="출력" className="vt-amp">
      <ParamKnob id="level" size={46}/>
    </Section>
  </div>
}
