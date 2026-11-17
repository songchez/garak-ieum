import { HANBAM_106_ID, HANBAM_106_PARAMS, OKGU_EP_ID, OKGU_EP_PARAMS } from './params'

/**
 * Library entries (악기 › 빈티지). `kind: 'vintage'`: the DSP is the Rust core — the native engine
 * links it (GARAK_RUST), the browser runs it in the engine (garak-engine.wasm); without either the instrument is
 * shown but cannot play (see src/audio/instrumentSupport.ts).
 */
export const OKGU_EP_DEFINITION = {
  id: OKGU_EP_ID,
  name: 'Okguseul EP',
  nameKo: '옥구슬 EP',
  type: 'TINE ELECTRIC PIANO',
  category: 'vintage',
  kind: 'vintage',
  isKit: false,
  icon: 'keys',
  color: '#7fb4e6',
  description: '맑은 타인과 톤바, 세게 치면 으르렁대는 바크 — 트레몰로·오토팬·앰프 드라이브까지',
  params: OKGU_EP_PARAMS,
} as const

export const HANBAM_106_DEFINITION = {
  id: HANBAM_106_ID,
  name: 'Hanbam 106',
  nameKo: '한밤 106',
  type: 'POLY SYNTH',
  category: 'vintage',
  kind: 'vintage',
  isKit: false,
  icon: 'synth',
  color: '#c48ad9',
  description: '보이스마다 DCO 하나, 24 dB 필터와 그 스테레오 코러스 — 한밤의 80년대 폴리 신스',
  params: HANBAM_106_PARAMS,
} as const
