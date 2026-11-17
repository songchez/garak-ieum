/**
 * Why the vintage instruments (옥구슬 EP · 한밤 106) cannot sound, per engine. They exist only in the Rust
 * instrument core: on the web it is part of the render engine (garak-engine.wasm), on the desktop the host
 * links it. Without it the instruments stay in the library, editable and saved, but greyed out and silent.
 */
export const VINTAGE_WEB_UNAVAILABLE = '이 브라우저에서 가락이음 오디오 엔진(WASM)을 불러오지 못해 빈티지 악기를 재생할 수 없습니다. 음색 편집과 프로젝트 저장은 사용할 수 있습니다.'
export const VINTAGE_NATIVE_UNAVAILABLE = '이 데스크톱 오디오 엔진은 Rust 코어 없이 빌드되어 빈티지 악기를 재생할 수 없습니다. 앱을 업데이트해 주세요. 음색 편집과 저장은 사용할 수 있습니다.'
