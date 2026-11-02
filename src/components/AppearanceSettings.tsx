import { useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getThemeSnapshot, setTheme, subscribeTheme, themeDefinition, THEMES, type ThemeDefinition, type ThemeId } from '../core/theme'
import { Icon } from './Icon'
import './AppearanceSettings.css'

function Preview({ theme }: { theme: ThemeDefinition }) {
  const c=theme.colors
  const style={
    '--preview-base':c.base,'--preview-panel':c.panel,'--preview-canvas':c.canvas,
    '--preview-border':c.border,'--preview-text':c.muted,'--preview-accent':c.accent,
    '--preview-brand':c.brand,'--preview-loop':c.loopFill,'--preview-roof':c.giwa,
    '--preview-soft':c.panelSoft,
  } as CSSProperties
  return <span className="appearance-preview" style={style} aria-hidden="true">
    <span className="appearance-preview-roof"/>
    <span className="appearance-preview-header"><i/><b/><em/><small/></span>
    <span className="appearance-preview-workspace"><span className="appearance-preview-sidebar"><i/><i/><i/></span><span className="appearance-preview-arrangement"><b/><i/><i/><i/><em/></span></span>
    <span className="appearance-preview-footer"><i/><b/></span>
  </span>
}

export default function AppearanceSettings({ disabled=false }: { disabled?: boolean }) {
  const current=useSyncExternalStore(subscribeTheme,getThemeSnapshot,getThemeSnapshot)
  const selected=themeDefinition(current)
  const [feedback,setFeedback]=useState<{persisted:boolean;text:string}|null>(null)
  function choose(id:ThemeId){
    const result=setTheme(id)
    setFeedback({persisted:result.persisted,text:result.persisted?`${themeDefinition(id).name} 테마를 적용하고 이 브라우저에 저장했습니다.`:'테마는 적용했지만 이 브라우저에 저장하지 못했습니다. 새로고침하면 이전 테마로 돌아갈 수 있습니다.'})
  }
  return <section className="appearance-settings" aria-labelledby="appearance-settings-title">
    <div className="appearance-heading"><div><h3 id="appearance-settings-title">화면 테마</h3><p>한국의 색을 작업실의 빛과 재료로 담았습니다.</p></div><span className="appearance-local-label"><Icon name="palette" size={13}/> 이 브라우저</span></div>
    <p className="appearance-intro">테마를 고르면 바로 적용됩니다. 오디오 설정의 적용·취소와 별개로 저장하며, 곡과 트랙 색상은 유지합니다.</p>
    <fieldset className="appearance-options" disabled={disabled}>
      <legend>작업실의 색 선택</legend>
      {THEMES.map(theme=><label key={theme.id} className={`appearance-card${theme.id===current?' selected':''}`}>
        <input type="radio" name="garak-theme" value={theme.id} checked={theme.id===current} onChange={()=>choose(theme.id)} aria-label={`${theme.name}, ${theme.mode==='light'?'밝은 테마':'어두운 테마'}`}/>
        <Preview theme={theme}/>
        <span className="appearance-card-label"><strong>{theme.name}</strong><span className="appearance-card-check">{theme.id===current?<Icon name="check" size={13}/>:null}</span></span>
        <span className="appearance-card-subtitle"><span>{theme.subtitle}</span><b>{theme.mode==='light'?'밝음':'어두움'}</b></span>
        <span className="appearance-card-swatches" aria-hidden="true">{theme.palette.map(swatch=><i key={swatch.name} style={{background:swatch.color}}/>)}</span>
      </label>)}
    </fieldset>
    <div className="appearance-palette" aria-labelledby="appearance-palette-title">
      <h4 id="appearance-palette-title">{selected.name}의 색 배치</h4><p>{selected.description}</p>
      <dl>{selected.palette.map(swatch=><div key={swatch.name}><dt><i style={{background:swatch.color}}/>{swatch.name}</dt><dd>{swatch.role}</dd></div>)}</dl>
      <small>제공된 원색을 바탕으로 글자와 조절기의 명도를 조정해 대비를 확보했습니다.</small>
    </div>
    {feedback&&<div className={`appearance-feedback${feedback.persisted?'':' error'}`} role="status" data-selectable-text="" tabIndex={0}><span>{feedback.text}</span>{!feedback.persisted&&<button type="button" disabled={disabled} onClick={()=>choose(current)}>저장 다시 시도</button>}</div>}
  </section>
}
