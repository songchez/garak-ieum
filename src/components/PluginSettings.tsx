import type { NativeAudioEngine } from '../audio/native/NativeAudioEngine'
import { Icon } from './Icon'
import { pluginKey, usePluginCatalog } from './usePluginCatalog'

/** Settings › 플러그인: where VST3 files are registered. Instruments and effects are then picked in the device chain and library. */
export function PluginSettings({ engine }: { engine: NativeAudioEngine }) {
  const catalog = usePluginCatalog(engine)
  const instruments = catalog.plugins.filter(plugin => plugin.isInstrument)
  const effects = catalog.plugins.filter(plugin => !plugin.isInstrument)
  const group = (title: string, items: typeof instruments) => <section className="plugin-settings-group" aria-label={title}>
    <h4>{title} <small>{items.length}</small></h4>
    {items.length ? <ul>{items.map(plugin => <li key={pluginKey(plugin)}><Icon name="plug" size={13}/><strong>{plugin.name}</strong><span>{[plugin.vendor, plugin.version].filter(Boolean).join(' · ')}</span></li>)}</ul>
      : <p className="audio-settings-note">등록된 {title}가 없습니다.</p>}
  </section>
  return <>
    <div className="audio-settings-section-title"><h3>VST3 플러그인</h3><button className="audio-small-button" disabled={catalog.scanning} onClick={() => void catalog.scan()}>{catalog.scanning ? '플러그인 확인 중…' : 'VST3 파일 추가…'}</button></div>
    <p className="audio-settings-note">VST3는 형식입니다. 등록한 <b>악기</b>는 트랙의 악기 선택과 라이브러리에, <b>이펙트</b>는 디바이스 체인의 추가 목록에 내장 디바이스와 함께 나타납니다.</p>
    {catalog.lastScanAdded !== null && <p className="audio-settings-feedback" role="status">{catalog.lastScanAdded ? `${catalog.lastScanAdded}개 VST3 플러그인을 확인했습니다.` : '새로 등록한 플러그인이 없습니다.'}</p>}
    {catalog.error && <p className="audio-settings-feedback error" role="alert">{catalog.error}</p>}
    {!catalog.loaded && !catalog.error ? <p className="audio-settings-note" role="status">플러그인 목록을 읽는 중…</p> : <div className="plugin-settings">{group('악기', instruments)}{group('이펙트', effects)}</div>}
    <p className="audio-settings-note">다른 컴퓨터에서 연 프로젝트의 플러그인은 여기에서 같은 플러그인을 등록한 뒤, 디바이스 카드의 <b>설치본 연결</b>을 누르면 저장한 상태 그대로 이어집니다.</p>
  </>
}
