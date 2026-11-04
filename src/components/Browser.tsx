import { useState } from 'react'
import type { AudioAsset } from '../core/types'
import { Icon } from './Icon'
import { Waveform } from './Waveform'
import './Inspector.css'

export interface BrowserProps {
  assets: Map<string, AudioAsset>
  /** Adds the stored asset to the timeline. */
  onAddAsset: (asset: AudioAsset) => void
  onImport: () => void
}

/** The old "내 파일" tab as its own right-side panel (Logic: Browser, F). */
export function Browser({ assets, onAddAsset, onImport }: BrowserProps) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const items = Array.from(assets.values()).filter(a => a.name.toLowerCase().includes(query))
  return <div className="file-browser" aria-label="브라우저">
    <div className="browser-search"><Icon name="search" size={14} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="파일 찾기…" aria-label="파일 검색" /></div>
    <div className="browser-content">
      <div className="browser-section-title"><span>PROJECT AUDIO <small>{assets.size || ''}</small></span><button type="button" onClick={onImport} title="오디오·MIDI 가져오기" aria-label="오디오·MIDI 가져오기"><Icon name="plus" size={15} /></button></div>
      {items.map(asset => <button type="button" className="audio-file-item" key={asset.id} onClick={() => onAddAsset(asset)} title="클릭하여 타임라인에 추가"><span><Icon name="wave" size={14} /><strong>{asset.name}</strong></span><Waveform peaks={asset.peaks} /><small>{asset.buffer.duration.toFixed(1)} s · {asset.buffer.numberOfChannels === 2 ? 'STEREO' : 'MONO'} <Icon name="plus" size={12} /></small></button>)}
      {!items.length && <div className="file-browser-empty"><Icon name="folder" size={22} /><p>{assets.size ? '일치하는 파일이 없습니다' : '아직 가져온 오디오가 없습니다'}</p><button type="button" onClick={onImport}><Icon name="upload" size={13} />오디오·MIDI 가져오기</button></div>}
    </div>
  </div>
}
