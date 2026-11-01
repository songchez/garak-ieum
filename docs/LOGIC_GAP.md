# 로직 프로 대비 트랙 영역 격차 명세 (LOGIC_GAP)

기준: [`LOGIC_REFERENCE.md`](LOGIC_REFERENCE.md) (로직 프로 12.3). 대상: 트랙 영역·트랙 헤더·인스펙터·라이브러리·믹서 대응 항목. 조사 시점 코드: `src/App.tsx`, `src/components/Timeline.tsx`, `src/components/Mixer.tsx`, `src/core/*`, `src/audio/graph.ts`, `src/audio/WebAudioEngine.ts`.

**2026-11-01 상태 안내:** 아래 대조표는 A–F 작업을 나눌 때의 격차와 설계 근거를 보관한 문서입니다. A·B·C·D의 주요 구현은 `46bd454`에 포함됐으며, 이번 E/F 후속 패스에서 루프 콘텐츠·부분 반복·뮤트 색상·리전 전용 이조 접미사·반복 블록 포커스, 피치 **MIDI 60=C3** 통일, 단축키 문서 동기화를 반영했습니다. 현재 구현·테스트·남은 장치 검증은 [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md), 실제 키맵은 [SHORTCUTS](SHORTCUTS.md)를 기준으로 합니다. 이 표의 조사 당시 `없음`·`다름`을 현재 미구현 목록으로 읽지 않습니다. 루프 끝 직접 지정 등 P2/P3 항목과 실제 청취 검증은 완료 표시하지 않습니다.

표기
- 상태: **동일** / **다름** / **없음**.
- `해야 할 일` 맨 앞 굵은 글자 = 담당 패스(A–F, 4절). `[P1]` 이번 목표 필수, `[P2]` 다음 단계, `[P3]` 후순위. `⚠️` = 레퍼런스 미확인이라 이 문서가 정한 동작.
- 키 표기는 macOS 기준. Windows/Linux 변환 규칙은 1.13절과 현재 [단축키 문서](SHORTCUTS.md)를 봅니다.
- P2/P3 항목은 구현 전까지 메뉴·UI에 **보이지 않게** 합니다(비활성 표시 금지, §9 규칙과 동일).

## 0. 제외 (LOGIC_REFERENCE §9 + 이번 조사로 추가 제안)

- §9: Track Stack(▸ 펼침, 생성/평탄화), 대체 트랙, 프리즈, 보호, 외부 MIDI, Session Player, Flex, 오토메이션(A, 오토메이션 줄·모드 색·통합), 글로벌 트랙 Movie·Beat Mapping·Chord, VCA, 제어판 막대, 그루브 트랙.
- 추가 제외 범위(2026-11-01 LOGIC_REFERENCE §9에 동기화): 트랙 재할당 ▸(채널 스트립 객체 없음), "동일한 악기가 있는 새로운 트랙"/⇧클릭 복제(같은 채널 공유 구조 없음), Aux·출력 트랙(오토메이션 의존), Pattern 트랙, 센드, 그룹, 오디오 리전 트랜스포즈·퀀타이즈·Smart Tempo·File Tempo(Flex 의존), 추가 이름 열(외부 MIDI 채널용, ⚠️ 미문서).

## 1. 대조표

### 1.1 헤더 배치 (§1a)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| H-01 전체 배치 | 왼→오: [색상 막대][번호][아이콘] 이름 … [볼륨 슬라이더+미터](팬). 이름 아래 줄에 [H][M][S][R][I](+⏻) | 번호(세로 위) · 아이콘 · 이름 아래 줄에 M S 🔌 AUDIO/MIDI 라벨 · 오른쪽에 38×4 미니미터. 슬라이더·팬 없음 | 다름 | **B** [P1] 새 `src/components/TrackHeader.tsx`. CSS grid: 1행 `[colorbar 4px][number 22px][icon 22px][name 1fr][volume 64–96px][pan 22px]`, 2행 name 칼럼 아래부터 `[⏻][H][M][S][R][I]`(구성에서 켠 것만, 이 순서). 🔌 버튼·AUDIO/MIDI 라벨·별도 MiniMeter 삭제(미터는 볼륨 슬라이더 안으로) |
| H-02 높이별 표시 ⚠️ | 높이가 커지면 이름 → 버튼 줄 → 슬라이더 → 노브 순으로 나타남(미문서) | `row-compact`(<48) / `row-large`(≥110) 클래스만 | 다름 | **B** [P1] 트랙별 실제 높이 h로 클래스: h<44 = 한 줄 `[번호][아이콘][이름][M][S][R][I]`(슬라이더·노브 숨김) · 44≤h<60 = 두 줄, 슬라이더 표시, 노브 숨김 · h≥60 = 두 줄 + 노브. 헤더 폭<230px이면 슬라이더·노브 숨김 |
| H-03 ⏻ 위치 ⚠️ | 미확인 | 없음 | 없음 | **B** [P1] 버튼 줄 맨 앞(H 왼쪽)에 배치 |

### 1.2 헤더 요소 (§1b)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| H-10 트랙 번호 | 자동 번호. 다중 선택 시 포커스 트랙 번호만 밝은 회색. 다중 선택 중 번호 클릭 = 선택 유지, 포커스만 이동 | `01` 2자리 패딩, 드래그로 순서 변경 손잡이 | 다름 | **B** [P1] 패딩 없는 `index+1`(숨긴 트랙도 번호 유지). `selectedTrackIds.size>1`이고 `id===focusedTrackId`면 `.track-number.focused`(밝은 회색 #c8c8c8 계열). 번호 클릭: 다중 선택 중이면 `onTrackFocus(id)`, 아니면 배경 클릭과 동일. 순서 변경 드래그는 헤더 배경으로 옮김(A-02) |
| H-11 색상 막대 | 헤더 왼쪽 색 띠. 기본 꺼짐 ⚠️ | 선택 트랙에만 3px `--track-color` 띠 | 다름 | **B** [P1] `headerConfig.colorBar`일 때 모든 트랙에 4px 띠(선택 무관). 선택 표시는 배경색으로만 |
| H-12 아이콘 | 패치 아이콘. 더블클릭 → 라이브러리, 우클릭 → 아이콘 메뉴 | 악기 카테고리 아이콘 + 샘플 로딩 점. 더블클릭 = 디바이스 탭 | 다름 | **B** [P1] `track.icon ?? 기본(오디오 'wave', 악기 categoryIcon)`. 더블클릭 → `onOpenLibrary(trackId)`(라이브러리 열고 해당 트랙 포커스). 우클릭 → 아이콘 그리드 메뉴(`Icon` 이름 목록) → `icon` 변경. SampleDot 유지 |
| H-13 이름 | 더블클릭 인라인 편집. ⇧↩ 편집. Tab = 다음 트랙 편집 ⚠️ | 더블클릭·⇧↩ 인라인 편집 | 다름 | **B** [P1] `InlineName`에 Tab: 커밋 후 다음 표시 트랙 편집 시작, ⇧Tab 이전. 다중 선택 중 편집 커밋은 A-12 규칙 |
| H-14 M 뮤트 | 파랑. 클릭 토글. 드래그로 연속 전환. ⌥클릭 = 이 트랙만 뮤트·나머지 해제. ⌘클릭 = 같은 상태 버튼 전부 반전 | 클릭 토글만. 색은 기존 테마 | 다름 | **B** [P1] 새 `src/components/TrackButtons.tsx` 공용 버튼. 켜짐 색 파랑(#3d8fd6 계열). 동작은 `pressTrackButton`(A, 2.4절). 드래그 연속 전환은 1.12절 sweep 규칙 |
| H-15 S 솔로 | 노랑. 솔로 안 된 트랙의 M이 파랗게 깜빡임. 클릭·드래그·⌥클릭 배타·⌘클릭 전체·⌃클릭 Solo Safe(빨간 사선) | 클릭 토글만. 깜빡임·Safe 없음 | 다름 | **B** [P1] 켜짐 노랑. 다른 트랙이 솔로 중이고 이 트랙이 솔로·Solo Safe·꺼짐이 아니면 M 버튼에 `.implicit-mute`(파랑 1s 깜빡임 애니메이션). Solo Safe = `track.soloSafe`, 버튼에 빨간 사선(`linear-gradient` 대각선). mac ⌃클릭은 `contextmenu` 이벤트로 들어오므로 S 버튼 `onContextMenu`에서 `ctrlKey`면 preventDefault 후 Safe 토글. Win/Linux는 Alt+Shift+클릭 |
| H-16 Clear/Recall Solo 버튼 | 첫 솔로 때 헤더 위에 S 버튼 등장. 클릭 = 전부 해제/복구. ⌥S | 없음 | 없음 | **C** [P1] 헤더 위 줄(R-30)에 `S` 버튼: `anySolo \|\| soloRecall!==null`일 때 표시. 솔로 있음 = 노랑 → 클릭 시 `soloRecall=솔로 id 목록`, 전부 해제. 솔로 없음 = 회색 → 클릭 시 `soloRecall`의 존재 트랙 솔로 복구. 키 ⌥S 같은 동작(`clearRecallSolo`) |
| H-17 R 녹음 활성 | 회색(끔)·빨강 깜빡임(대기)·빨강(녹음 중)·회색+빨간 R(자동 활성된 포커스 트랙). ⌥클릭 = 이 트랙만. 깜빡이는 버튼 ⌥클릭 = 전부 해제. ⌃R | 트랙별 활성 없음. 녹음은 선택된 오디오 트랙 또는 새 트랙 | 없음 | **A** `Track.armed` 추가(2.1). **B** [P1] 버튼 4상태: `armed && !recording` = 빨강 깜빡임, `armed && recording` = 빨강 고정, `effectiveArm==='auto'` = 회색 바탕+빨간 글자 R, 그 외 회색. **C** 녹음 대상 규칙(2.5) |
| H-18 자동 녹음 활성 | 소프트웨어 악기 트랙은 포커스 트랙을 자동 활성 | 없음 | 없음 | **A** `effectiveArm(track, focusedTrackId, tracks)`: 명시적 `armed`면 'armed'. 아니고 악기 트랙 + 포커스 트랙 + 다른 악기 트랙 중 명시적 armed 없음이면 'auto'. 저장하지 않는 파생값 |
| H-19 I 입력 모니터링 | 녹음 대기 없이 입력 듣기. 오디오·악기 트랙. ⌃I | 없음 | 없음 | **A** `Track.monitor` + 엔진 `setInputMonitor`(2.5). **B** [P1] 켜짐 주황. 악기 트랙은 상태만(MIDI 입력 미지원, 툴팁에 명시) |
| H-20 볼륨 슬라이더 | 가로 슬라이더, 출력 미터 내장. ⌥클릭 = 0 dB. ⇧드래그 = 그룹 무시 | 헤더엔 없음. 인스펙터에 0–1.5 range | 없음 | **B** [P1] 새 `src/components/VolumeSlider.tsx`(가로). dB 테이퍼(로직 페이더 곡선 근사: −∞…+6 dB, 0 dB 위치 75%), 값 범위 0–2(=+6 dB). 트랙 미터를 슬라이더 바탕에 canvas로(기존 MiniMeter 로직 재사용). ⌥클릭 = `volume:1`. 툴팁 `-3.2 dB`. 드래그 한 번 = 히스토리 1단계(merge key `${id}:volume`). ⇧ 그룹 무시는 그룹 없음 → 무시 |
| H-21 팬 노브 | 드래그. ⌥클릭 = 중앙. ⌃클릭 → 센드 선택 | 헤더엔 없음 | 없음 | **B** [P1] 새 `PanKnob`(기존 `Knob.tsx` 기반, 지름 20px, −64…+63 표시). ⌥클릭 = `pan:0`. 더블클릭도 중앙(기존 Knob 관례). ⌃클릭 센드는 제외 |
| H-22 H 가리기 | 가리기 보기가 초록일 때만 표시. 클릭 토글 | 없음 | 없음 | **A** `Track.hidden`. **B** [P1] `headerConfig.hide && ui.hideView`일 때만 H 버튼 렌더. 켜짐 초록 |
| H-23 ⏻ 켬/끔 | 끄면 플러그인 언로드, 리전·이름 회색. ⌥클릭 = 플러그인 유지. ⌘클릭 = 전체. ⌥M | 없음 | 없음 | **A** `Track.enabled` + 엔진 우회(2.6). **B** [P1] `headerConfig.onOff`일 때 렌더. 꺼지면 행에 `.track-off`: 이름·아이콘·번호 회색, 리전 회색(V-05). ⌥클릭은 일반 클릭과 같음(플러그인 언로드 개념 없음). ⌘클릭 = 전체를 새 값으로 |
| H-24 대체 트랙·🔒·❄·오토메이션 줄·모드 색·스택 ▸ | — | 없음 | 없음 | 제외(0절) |

### 1.3 헤더 영역 동작 (§1c)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| A-01 헤더 배경 클릭 | 트랙과 그 리전 전부 선택(사이클 켜짐이면 사이클 안쪽만). 첫 선택 트랙이 포커스 | 트랙의 모든 클립 선택(사이클 무시). 단일 트랙만 | 다름 | **C** [P1] `onTrackClick(id, mods)` → App: `selectedTrackIds={id}`, `focusedTrackId=id`, 클립 = `cycleClipIds(track, project.loop)`(A): 사이클 켜짐이면 `[start,end)`가 사이클과 겹치는 클립 ⚠️, 꺼짐이면 전부 |
| A-02 ⇧클릭 | 연속 범위 | 없음 | 없음 | **C** [P1] 포커스 트랙~클릭 트랙 사이 **표시 중인** 트랙 전부 선택 + 그 클립(사이클 규칙). 포커스 유지 |
| A-03 ⌘클릭 | 추가/제거 | 없음 | 없음 | **C** [P1] 토글. 추가 시 클립도 추가, 제거 시 그 트랙 클립 제거. 포커스 트랙을 제거하면 남은 선택 중 가장 위 트랙이 포커스 |
| A-04 ⌥클릭 | 리전 선택은 그대로, 트랙만 선택 | 없음 | 없음 | **C** [P1] `selectedTrackIds={id}`, `focusedTrackId=id`, `selectedClipIds` 변경 없음. ⌥⇧/⌥⌘도 같은 원칙(트랙 집합만 범위/토글) |
| A-05 ⇧더블클릭 배경 | 그 위치부터 재생 | 없음(레인 더블클릭 = MIDI 클립 생성) | 없음 | **C** [P1] 레인 빈 곳 `onDoubleClick`에서 `shiftKey`면 클립 생성 대신 `onSeekPlay(beat)`(스냅 적용 안 함) → App: `engine.seek(beat)` 후 정지 상태면 재생 |
| A-06 ↑/↓, ⇧↑/⇧↓ | 이전/다음 트랙, 확장 | ↑/↓ 이전/다음(클립 선택 해제). 확장 없음 | 다름 | **A** `trackUpExtend`/`trackDownExtend` 명령(⇧↑/⇧↓, 타임라인·작업 공간). **C** ↑/↓ = 포커스 이동, 단일 선택, 클립 선택 해제(현재 유지 ⚠️). ⇧ = 선택 집합에 추가하며 포커스 이동. 숨긴 트랙(보기 꺼짐)은 건너뜀 |
| A-07 순서 변경 | 헤더 빈 곳을 누르고 드래그 | 번호에서만 드래그 | 다름 | **B** [P1] 헤더 배경(버튼·이름·슬라이더·노브·코너 제외) pointerdown → 4px 넘으면 순서 변경 제스처(현재 `beginTrackDrag` 재사용, 트랙별 높이 반영), 안 넘으면 클릭(A-01). 다중 선택 트랙 묶음 이동 [P2] ⚠️ |
| A-08 트랙 높이(개별) | 헤더 왼쪽 아래 모서리 ↕. 태그 "Individual track zoom: N". 드래그 = 이 트랙, ⌘드래그 = 전체, ⇧드래그/⇧클릭 = 전체 초기화, ⌥스크롤 = 전체 비례. ⌥⌘↓/↑ 확대/축소, ⌥⌘Z 토글, ⌥⌘⌫ 초기화, ⌃Z 포커스 트랙 줌 | 전체 공통 rowHeight만(⌘↑/↓, Ctrl+Shift/Alt+휠) | 다름 | **A** UI 상태 `trackZoom`(3절) + 명령 `trackZoomIn/Out/Toggle/Reset`, `zoomFocusedTrack`. **B** 헤더 왼쪽 아래 10×6px 핫존(`.track-resize-corner`, cursor `ns-resize`, 툴팁 `개별 트랙 확대/축소: N`, N=`round((factor−1)×10)`). **C** [P1] 드래그 → `trackZoom[id]=clamp(h/rowHeight)`, ⌘드래그 → 전역 `rowHeight`, ⇧클릭/⇧드래그 → `trackZoom={}`. 행 높이 = `clamp(rowHeight×(trackZoom[id]??1), 36, 320)`; `zoomFocused`면 포커스 트랙 ×2.5. ⌥⌘Z = 포커스 트랙 factor 1↔2.5 토글. ⌥휠은 기존 세로 줌 그대로 |
| A-09 헤더 열 너비 | 헤더와 레인 사이 선 드래그 | 208px 고정(`HEADER_WIDTH` 상수, App `zoomToFit`도 사용) | 없음 | **C** [P1] `HEADER_WIDTH` 상수를 `ui.headerWidth` prop으로 교체(Timeline 내부 전부 + App `zoomToFit`). 헤더 오른쪽 4px 핸들 드래그, 범위 160–420, 기본 248, localStorage 저장 |
| A-10 헤더 아래 빈 곳 더블클릭 | 선택 트랙과 같은 유형의 새 트랙 | 맨 아래 "트랙 추가" 버튼 행(항상 Keys 악기 트랙) | 다름 | **C** [P1] `add-track-row` 버튼 삭제 → 빈 영역(`.tracks-empty-area`, 최소 높이 = 남은 공간) 더블클릭 = 포커스 트랙과 같은 종류·기본 패치(악기 = 포커스 트랙 악기 ⚠️, 오디오 = 오디오) 새 트랙을 맨 끝에 추가 ⚠️ |
| A-11 빈 곳 우클릭 | 트랙 유형 항목 → 아래에 새 트랙 | 없음 | 없음 | **C** [P1] 빈 헤더 영역 우클릭 메뉴: `새로운 소프트웨어 악기 트랙`(⌥⌘S) · `새로운 오디오 트랙`(⌥⌘A) · 구분선 · `새로운 트랙…`(⌥⌘N) ⚠️ 한국어 명칭 |
| A-12 헤더 우클릭 메뉴 | 아래 1.4절 항목 집합 | 이름 바꾸기 · 색상▸(6) · 트랙 복제 · 위/아래로 이동 · 디바이스 열기 · 트랙 삭제… | 다름 | **C** [P1] 1.4절 그대로 교체. "위/아래로 이동"·"디바이스 열기" 삭제 |
| A-13 트랙 삭제 | ⌘⌫, 선택 트랙 전부. 확인 창 없음(실행 취소 가능) ⚠️ | 선택 트랙 1개, 확인 모달 | 다름 | **C** [P1] `selectedTrackIds` 전부 삭제, 모달 없이 토스트 `트랙 N개를 삭제했습니다 · ⌘Z로 되돌리기`. 포커스는 삭제 범위 아래 트랙(없으면 위) |

### 1.4 헤더 우클릭 메뉴 (§1c, §8 한국어)

순서 ⚠️(레퍼런스 미확인). 다중 선택이면 모든 항목이 `selectedTrackIds`에 적용.

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| CM-01 트랙 이름 변경 / N개 트랙 이름 변경 | 이름 편집. 다중이면 N개 | 이름 바꾸기(1개) | 다름 | **C** [P1] 라벨 N>1이면 `N개 트랙 이름 변경`. 포커스 트랙에서 인라인 편집 → 커밋 시 모든 선택 트랙에 적용: 이름 끝이 숫자면 위에서부터 +1씩, 아니면 `이름 1`, `이름 2`… ⚠️ 단축키 ⇧↩ |
| CM-02 설정을 복제한 새로운 트랙 | 설정만 복제(⌘D) | "트랙 복제" = 클립 포함 복제 | 다름 | **A** `duplicateTrackSettings(track)`(클립 없음, 새 id, devices/instrumentParams 깊은 복사). **C** [P1] 선택 트랙 각각 바로 아래 삽입, ⌘D |
| CM-03 설정 및 콘텐츠를 복제한 새로운 트랙 | 클립 포함(⌥⇧⌘D) | 위 "트랙 복제"가 이것 | 다름 | **C** [P1] 기존 `duplicateTrack` 사용, 라벨·위치(바로 아래)·단축키 ⌥⇧⌘D |
| CM-04 트랙 색상 지정… | ⌥C 팔레트 | 색상▸ 6색 하위 메뉴 | 다름 | **C** [P1] 항목 클릭 = 색상 팔레트 열기(C-01), ⌥C |
| CM-05 트랙 삭제 / 사용하지 않는 트랙 삭제 | ⌘⌫ / 미사용 삭제 | 트랙 삭제…(모달) | 다름 | **C** [P1] `트랙 삭제`(⌘⌫, A-13). `사용하지 않는 트랙 삭제` ⚠️ 명칭 = 클립 0개 트랙 전부 삭제(단축키 없음, 1.12 충돌 참고) |
| CM-06 선택한 트랙 가리기 | ⌃H | 없음 | 없음 | **C** [P1] 선택 트랙 `hidden=true`. 가리기 보기 꺼져 있으면 즉시 사라짐, 포커스는 다음 표시 트랙 |
| CM-07 보기 가리기 토글 | H | 없음 | 없음 | **C** [P1] `ui.hideView` 토글(체크 표시). §1c의 "가리기 보기 토글"이 아니라 §8 명칭 사용 |
| CM-08 트랙 가리기 모두 해제 | ⌃⇧H | 없음 | 없음 | **C** [P1] 모든 트랙 `hidden=false` |
| CM-09 트랙 헤더 구성 요소 ▸ | 하위 메뉴 체크 항목 | 없음 | 없음 | **C** [P1] 하위 항목(체크): 음소거 · 솔로 · 녹음 가능 · 입력 모니터링 · 켬/끔 · 가리기 · 볼륨 · 팬 · 트랙 번호 · 색상 막대 · 트랙 아이콘 → `headerConfig` 토글(선택 시 메뉴 닫힘 허용) |
| CM-10 트랙 헤더 구성… | ⌥T, 구성 창 | 없음 | 없음 | **C** [P1] K-01 팝오버 열기 |
| CM-11 트랙 재할당 ▸ · 동일한 악기가 있는 새로운 트랙 · Track Stack 생성 · 스택 평탄화 · 오토메이션 통합 | — | 없음 | 없음 | 제외(0절). 메뉴에 넣지 않음 |

### 1.5 트랙 헤더 구성 (§1d)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| K-01 구성 창 | ⌥T 또는 우클릭. 구역: 버튼 / 컨트롤 / 추가 이름 열 / 기타 보기 옵션 | 없음 | 없음 | **B** [P1] 새 `src/components/HeaderConfigPopover.tsx`: 헤더 위 줄 근처에 뜨는 팝오버(Esc·바깥 클릭 닫힘, `role="dialog"` 아님 — 단축키 차단 방지 위해 `role="group"`). 구역 3개, 체크박스 |
| K-02 버튼 구역 | 뮤트·솔로·녹음 활성·입력 모니터링·켬/끔·가리기(·보호·프리즈). 기본 M S R I 켬 | 없음 | 없음 | **B** [P1] 체크박스 6개(보호·프리즈 제외). 기본 `mute,solo,record,monitor=true; onOff,hide=false` |
| K-03 컨트롤 구역 | 볼륨 체크, 팬 체크 + 팝업(팬/센드) | 없음 | 없음 | **B** [P1] 볼륨·팬 체크(기본 켬 ⚠️). 팬 팝업은 센드 제외로 생략 |
| K-04 추가 이름 열 | 팝업 ⚠️ | 없음 | 없음 | 제외(0절) |
| K-05 기타 보기 옵션 | 제어판 막대·트랙 번호·색상 막대·그루브·아이콘·대체 트랙. 번호+아이콘 기본 켬 ⚠️ | 없음 | 없음 | **B** [P1] 트랙 번호(켬)·색상 막대(끔)·트랙 아이콘(켬). 나머지 제외 |
| K-06 저장 | 프로젝트별 ⚠️ | — | 없음 | **A** `trackUi.ts` `loadHeaderConfig/saveHeaderConfig`, localStorage `garak-ieum:track-header`(앱 전역) |

### 1.6 색상 (§1e)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| C-01 색상 팔레트 | ⌥C / 우클릭. 96색(4줄×24). 클릭 = 선택 트랙(+리전) 색. ⌘클릭 = 트랙만 | 6색(`TRACK_COLORS`) 메뉴·인스펙터 견본 | 다름 | **A** 새 `src/core/colors.ts`: `TRACK_PALETTE: string[96]` = 24색상(hue `i×15°`, 0°=빨강부터) × 4줄(위→아래 `s/l` = 45/76, 58/62, 62/48, 55/34 %), `#rrggbb`. **B** 새 `ColorPalette.tsx`(+css): 떠 있는 패널(닫기 버튼, Esc), 24열 그리드, 현재 색 테두리. 클릭 = `selectedTrackIds` 전부 `color` 변경(한 히스토리 단계). ⌘클릭 = 동일(리전 개별 색 없음). 기존 6색 `TRACK_COLORS` 삭제 |
| C-02 기본 색 | 오디오 파랑, MIDI 초록 fig. | 악기 = 악기별 색, 오디오 = `#c9a06a` | 다름 | **A** [P1] `createTrack`: 오디오 = 팔레트 파랑(2줄 hue 210°), 악기 = 팔레트 초록(2줄 hue 120°). 데모 곡의 지정 색은 유지 |
| C-03 믹서 색 연동 | 트랙 색 = 믹서 스트립 색 | 믹서가 `--track-color` 사용 | 동일 | 유지 |
| C-04 색 설정(Static/자동, Region Color) · 기능 메뉴 ⌥⇧C / ⌥⇧⌘C | 설정·메뉴 | 리전은 항상 트랙 색 | 다름 | [P3] 가락이음은 `Track Color Static` + `Region Color As Track Color` 고정. 리전 개별 색 도입 전까지 메뉴 없음 |

### 1.7 트랙 유형·새 트랙·글로벌 트랙 (§2, §3 일부)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| T-01 오디오 트랙 | ⌥⌘A. 파형 아이콘. M S R I | 브라우저/파일 드롭/녹음으로만 생성. M S | 다름 | **A** 명령 `newAudioTrack`(⌥⌘A). **C** 포커스 트랙 아래 삽입·선택 |
| T-02 소프트웨어 악기 트랙 | ⌥⌘S. 선택 시 자동 녹음 활성·모니터링 | ⌥⌘N이 Keys 트랙 즉시 추가 | 다름 | **A** `newInstrumentTrack`(⌥⌘S, 기본 패치 `keys`). **C** 포커스 아래 삽입 |
| T-03 New Tracks 창 | ⌥⌘N/+ : MIDI·Pattern·Session Player·Audio. 세부: 악기, 입력, 출력, 기본 패치, 라이브러리 열기, 입력 모니터링, 녹음 활성, 생성할 트랙 수, 생성/취소 | 없음 | 없음 | **D** [P1] 새 `src/components/NewTracksDialog.tsx`(모달): 유형 카드 2개 `소프트웨어 악기`(MIDI) / `오디오`. 세부: 악기 select(악기만), `생성할 트랙 수` 1–32, 체크 `라이브러리 열기`(악기만, 기본 켬)·`입력 모니터링`·`녹음 활성`. 생성 = 포커스 트랙 아래에 N개 삽입, 첫 트랙 포커스·나머지 선택. 입력/출력 팝업은 표시만 하지 않음 |
| T-04 새 트랙 삽입 위치 | 선택 트랙 아래 | 항상 맨 끝 | 다름 | **A** `insertTracks(project, afterId, tracks)`. **C** 모든 새 트랙 경로(+, ⌥⌘A/S, 창, 복제)에 적용. 빈 곳 더블클릭(A-10)·파일 드롭 새 트랙은 맨 끝 |
| T-05 Session Player·외부 MIDI·스택·Aux·출력·Pattern | — | 없음 | 없음 | 제외(0절) |
| G-01 글로벌 트랙 표시 | 눈금자 아래. G 또는 헤더 오른쪽 위 버튼. 기본 표시 Arrangement·Marker·Signature·Tempo | 없음 | 없음 | **A** 명령 `globalTracks`(G), `Project.markers`(2.3). **C** [P1] 1단계 = **Marker만**. 헤더 위 줄 오른쪽 버튼(아이콘 `≡`)·G로 `ui.globalTracks` 토글. 눈금자 바로 아래 22px 행(sticky top), 헤더 칸 "마커" + `+`(재생 위치에 마커). [P2] Tempo·Signature(4/4 읽기 전용)·Arrangement |
| G-02 마커 편집 | 마커 생성(⌥' ⚠️), 드래그 이동, 더블클릭 이름, 삭제 | 없음 | 없음 | **C** [P1] 마커 행: 빈 곳 더블클릭 = 그 마디 시작에 `마커 N` 생성 · 마커 드래그 = 이동(마디 스냅, ⇧ = 박 스냅) · 마커 더블클릭 = 이름 인라인 편집 · 클릭 = 재생 위치 이동 + 마커 선택 · 선택 후 ⌫ = 삭제 · 우클릭 = 이름 변경/삭제. 마커 블록 폭 = 다음 마커까지. 단축키 ⌥' `createMarker` ⚠️ |
| G-03 글로벌 트랙 높이·순서·구성 메뉴(⌥G) | 구분선·아랫선 드래그, 헤더 드래그, 우클릭 구성 | 없음 | 없음 | [P2] 트랙 종류가 늘어난 뒤 |

### 1.8 트랙 영역 크롬·눈금자 (§3)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| R-01 메뉴 막대 | ↑ · 편집⌄ · 기능⌄ · 보기⌄ · … · Catch · 툴⌄ · Snap: · Drag: · 줌 슬라이더 | 제목 "WORKSPACE 어레인지먼트" + 힌트 + ZoomControls + 따라가기 버튼 | 다름 | **C** [P1] `.arrangement-title` → `.tracks-menubar`: `[편집 ⌄][기능 ⌄][보기 ⌄] · [Catch] · [Snap: 스마트 ⌄] [Drag: 겹치지 않음 ⌄] · (오른쪽) 세로 줌·가로 줌`. 편집 = 기존 클립 명령(잘라내기·복사·붙여넣기·삭제·분할·합치기·반복·모두 선택·실행 취소/다시 실행). 기능 = 리전 뮤트(⌃M)·루프(L)·재생 위치로 이동(;)·이름 변경. 보기 = 인스펙터 보기(I)·라이브러리 보기(Y)·글로벌 트랙 보기(G)·트랙 헤더 구성(⌥T)·보기 가리기 토글(H)·재생 중 스크롤·그리드 선·포커스된 트랙 확대/축소(⌃Z). 드롭 힌트 문구 삭제 |
| R-02 줌 슬라이더 | 세로·가로 줌 슬라이더, 파형 줌 | −/+/맞춤 버튼 | 다름 | [P2] **C** 버튼 대신 가로 슬라이더 2개(`ZOOM_LIMITS.timelineY/X`, 로그 스케일). 파형 줌 [P3] |
| R-03 툴 메뉴(좌클릭/⌘클릭) | 포인터·연필·지우개·가위·풀·뮤트 등, T = 툴 메뉴 | 포인터만 | 없음 | [P3] 별도 명세. 이번 범위 밖 |
| R-04 Snap 팝업 | 그리드에 스냅(⌘G) · Smart · Bar · Beat · Division · Ticks · Frames · Quarter Frames · Samples · 절대/상대 · Zero Crossings · 정렬 가이드. 기본 Smart·절대 | 트랜스포트 select: 끔/1/16/1/8/1/4/1 bar, ⌘G 토글. 이동은 상대 스냅(원래 오프셋 유지) | 다름 | **A** `SnapMode='smart'/'bar'/'beat'/'division'/'ticks'`, `resolveSnap(mode, ppb, division=0.25)`: bar=4, beat=1, division=0.25(1/16), ticks=1/960, smart = `[0.25,1,4,16]` 중 `값×ppb ≥ 12px`인 최솟값. **C** [P1] 메뉴 막대 `Snap:` 팝업: `그리드에 스냅`(체크, ⌘G) · 구분선 · 스마트/마디/박/분할/틱(라디오) · 구분선 · 절대값 스냅/상대값 스냅(라디오, 기본 절대). 트랜스포트의 snap select 삭제. 기존 `snap:number` prop은 `snapOn ? resolveSnap(...) : 0`으로 계산해 전달. 절대 = 이동 시 잡은 클립 시작을 그리드에 맞춤(`snapDragDelta`에 `absoluteFrom` 인자 추가, A). Frames·Samples·Zero Crossings·정렬 가이드 = 표시 안 함 |
| R-05 Drag 팝업 | 겹침 · 겹치지 않음 · 크로스 페이드 · 셔플 R · 셔플 L. 기본 ⚠️ | 항상 겹침(클립이 자유롭게 겹침) | 다름 | **A** `DragMode='overlap'/'noOverlap'`, `applyDragMode(track, movedIds, mode)`(project.ts): noOverlap = 놓인/늘인 클립이 덮는 같은 트랙 다른 클립 부분을 잘라냄(완전히 덮이면 삭제, 가운데면 둘로 분할 = `splitClip`+`trimClip*`). **C** [P1] 팝업 `겹침`/`겹치지 않음`, 기본 `겹치지 않음` ⚠️(로직 기본으로 판단). 적용 지점: 드래그 이동·복사, 트림, 붙여넣기, 복제, 넛지. [P2] `크로스 페이드`(오디오만: 겹친 구간 길이만큼 앞 클립 fadeOut·뒤 클립 fadeIn, 엔진 V-09 예외), `셔플 R/L` |
| R-06 Catch | 재생 위치 따라가기. 재생 시작/위치 이동 시 catch. 수동 스크롤하면 꺼짐 ⚠️ | "재생 위치 따라가기" 토글(기본 켬): 화면 밖이면 10% 위치로 페이지 이동 | 다름 | **C** [P1] 버튼 이름·아이콘 `Catch`(재생 위치 따라가기). 페이지 넘김 위치 0%(왼쪽 끝) ⚠️. `seek`·재생 시작 때도 화면 밖이면 즉시 맞춤. 재생 중 사용자 가로 스크롤(휠·스크롤바·드래그, 제스처 자동 스크롤 제외) → `ui.catch=false` ⚠️ |
| R-07 재생 중 스크롤 | 보기 > 재생 중 스크롤 + Catch = 재생 위치 고정, 배경 스크롤 | 없음 | 없음 | **C** [P1] `ui.scrollInPlay`(보기 메뉴 체크). Catch와 함께 켜지면 재생 중 `scrollLeft = beat×ppb − 보이는 폭×0.5`(재생 위치 화면 가운데 고정 ⚠️) |
| R-08 눈금자 윗부분 클릭 | 사이클 토글 | 사이클 안 클릭 = 토글, 밖 클릭 = 그 마디 1마디 사이클 생성 | 다름 | **C** [P1] 이동 없는 클릭은 위치와 무관하게 `enabled` 토글만 |
| R-09 윗부분 드래그 | 노란 사이클 생성(켜짐) | 마디 단위 생성, ⇧ = 박 단위 | 다름 | **C** [P1] 단위 = 현재 스냅 값(스냅 꺼짐이면 1/16), ⇧ 해제 대신 ⌃⇧ = 스냅 무시(기존 드래그 규칙과 통일) |
| R-10 가운데 드래그 / 가장자리 드래그 | 손 포인터 이동 / 크기 조절 | 안쪽 드래그 이동(grab 커서), 가장자리 ±6px 크기 | 동일 | 유지. 이동 커서를 `grab`→드래그 중 `grabbing` |
| R-11 ⇧클릭 확장 | 가까운 가장자리를 클릭 지점까지 확장 | 없음 | 없음 | **C** [P1] 윗부분 ⇧클릭: 클릭 박이 시작보다 앞이면 시작, 끝보다 뒤면 끝을 그 위치(스냅)로. 안쪽이면 가까운 쪽. 사이클 켬 |
| R-12 ⌘드래그 Skip Cycle · ⌥⌘클릭 오토펀치 | — | 없음 | 없음 | [P3] 엔진 skip 구간·펀치 녹음 필요 |
| R-13 재생 위치 이동 | 아래 눈금자 클릭·삼각형 드래그·스크럽. ⇧클릭 레인 = 재생 위치 이동 | 아래 띠 클릭·드래그 = 이동(스냅, ⇧ = 스냅 무시). ⇧클릭 레인 = 마키 추가 | 다름 | **C** [P1] 레인 빈 곳 ⇧클릭(이동 없음) = `engine.seek(beat)`(스냅 적용). ⇧드래그 = 기존대로 추가 마키. 눈금자 아래 띠 ⇧ 의미를 ⌃⇧ = 스냅 무시로 통일 |
| R-14 스크롤/줌 | 포인터 중심 줌, 재생 위치 근처면 재생 위치 | 휠 줌 포인터 중심, 키 줌은 보이는 재생 위치 기준 | 동일 | 유지. "스크롤 중 번호 표시" [P3] |
| R-15 그리드 선 | 보기 > 그리드 선 | 항상 표시 | 다름 | **C** [P2] `ui.gridLines`(기본 켬), 끄면 레인 배경 그리드 제거 |
| R-30 헤더 위 줄 | + 트랙 추가 · 트랙 복제 · H(첫 가리기 후, 주황=가린 트랙 있음, 초록=보기 켬) · S(첫 솔로 후) · 글로벌 트랙(오른쪽) | "TRACKS 4/4" 라벨 | 없음 | **C** [P1] `.track-ruler-label` 칸을 `[+][⧉] … [H][S] … [≡]` 툴바로 교체. H 표시 조건 `tracks.some(hidden) \|\| hideView`, 색: `hideView` = 초록, 아니면 주황. 클릭 = `hideView` 토글. S = H-16 |
| R-31 + 트랙 추가 | 클릭 = New Tracks 창. ⌥클릭 = 포커스 트랙 유형·기본 패치 즉시. ⌥⇧ = 같은 유형·빈 스트립. ⌘ = 다른 유형 ⚠️ | 맨 아래 버튼 = Keys 즉시 | 다름 | **C** [P1] 클릭 = T-03 창. ⌥ = 같은 종류(악기면 `keys` ⚠️ 기본 패치) 즉시. ⌥⇧ = 같은 종류, devices 빈 상태(악기 `keys`) 즉시. ⌘ = 반대 종류 즉시 ⚠️. 모두 포커스 아래 삽입 |
| R-32 트랙 복제 버튼 | 클릭 = 설정 복제(⌘D). ⌥ = 콘텐츠 포함. ⇧ = 같은 채널(⌃⇧↩). 녹음 활성·모니터링이 새 트랙으로 이동 | 없음(메뉴 "트랙 복제" = 콘텐츠 포함) | 없음 | **C** [P1] 클릭 = CM-02, ⌥ = CM-03, ⇧ = 클릭과 같음(같은 채널 제외). 원본의 `armed`/`monitor`를 새 트랙으로 옮기고 원본은 false |

### 1.9 인스펙터 (§4)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| I-01 위치·토글 | 메인 창 **가장 왼쪽 열**(라이브러리 열리면 그 오른쪽). I 키 | 오른쪽 232px 패널, 상태 막대 버튼으로 토글(키 없음) | 다름 | **A** 명령 `toggleInspector`(I). **D** [P1] 새 `src/components/Inspector.tsx`. 레이아웃 `[Library][Inspector][studio-main][Browser(F)]`. 기존 오른쪽 인스펙터 JSX 전부 삭제. 폭 고정 240px ⚠️ |
| I-02 구성 순서 | 리전 인스펙터 → 트랙 인스펙터 → 채널 스트립 2개 | 트랙 카드 → TRACK(색·볼륨·팬·M/S) → INSTRUMENT → DEVICES → CLIP → MASTER | 다름 | **D** [P1] 접이식 섹션 3개(▸ 펼침 상태 localStorage): `RegionInspector` → `TrackInspector` → 채널 스트립 영역(가로 2개) |
| I-03 리전 인스펙터 머리 | "Region: 이름" / "N selected" / "Default Settings" | "CLIP" + N개 선택 | 다름 | **D** [P1] `리전: {이름}`(더블클릭 이름 편집) / `{N}개 선택됨` / 선택 없음 = `기본 설정` 머리만 표시하고 본문 숨김([P2] 새 클립 기본값) |
| I-04 MIDI 리전 필드 | 뮤트 · 루프 · 퀀타이즈(Classic/Smart) · Q-Swing · 트랜스포즈 · Pitch Source · 벨로시티 · More▸ 딜레이 · 다이내믹스 · 게이트 타임 · 클립 길이 · 악보 · Q-Velocity/Length/Flam/Range/Strength | 이름 · 뮤트 토글 · 시작 · 길이(읽기 전용) | 다름 | **A** Clip 필드(2.2). **D** [P1] `뮤트`(체크) · `루프`(체크) · `퀀타이즈`(팝업: 끔, 1/1, 1/2, 1/4, 1/8, 1/16, 1/32, 1/64, 1/6, 1/12, 1/24, 1/48) · `Q-Swing`(0–100%, 기본 50, 퀀타이즈 끔이면 흐리게) · `트랜스포즈`(±96) · `벨로시티`(±99) · `More ▸` 안에 `딜레이`(틱, ±1920, ms 병기). Classic/Smart 라벨 전환·Pitch Source·나머지 More 항목 [P3] |
| I-05 오디오 리전 필드 | 뮤트 · 루프 · 퀀타이즈 · Q-Swing · 트랜스포즈 · 파인 튠 · Flex · Smart Tempo · 게인 · More▸ 딜레이 · 페이드 인/아웃+커브 · 리버스 · 스피드 | 위와 같음 | 다름 | **D** [P1] `뮤트` · `루프` · `게인`(dB, −∞…+6 → `gain` 0–2) · `More ▸` `딜레이`(틱) · `페이드 인`/`페이드 아웃`(ms → `fadeIn/fadeOut` 초). 퀀타이즈·트랜스포즈·파인 튠·Flex·Smart Tempo = 제외(0절). 커브·리버스·스피드 [P3] |
| I-06 다중 선택 값 | 값이 다르면 `*`, 편집은 상대값. ⌥⇧ 누르고 편집 = 전부 같은 값 | 앵커 클립만 표시 | 없음 | **D** [P1] 숫자 필드: 값이 다르면 `*` 표시, 입력/드래그 변화량을 각 클립에 더함(클램프). ⌥⇧ 누른 채 커밋 = 절대값. 체크박스: 섞임 = indeterminate, 클릭 = 전부 켬. 퀀타이즈 팝업은 항상 절대값. 한 편집 = 히스토리 1단계 |
| I-07 트랙 인스펙터 머리 | "Track: 이름" | 트랙 카드(아이콘·이름 입력) | 다름 | **D** [P1] `트랙: {이름}` |
| I-08 트랙 필드(악기) | 기본 리전 유형 · 채널 · MIDI 입력 · 녹음 · MIDI 채널 · 프리즈 모드 · **트랜스포즈 · 벨로시티 오프셋 · 키 제한(C-2–G8) · 벨로시티 제한(1–127) · 딜레이** · No Transpose · Hermode … | 없음 | 없음 | **A** Track 필드(2.1). **D** [P1] `이름` · `아이콘`(H-12 메뉴) · `트랜스포즈`(±96) · `벨로시티`(±99) · `키 제한`(두 칸, 0–127, 로직 표기 C3=60 → `C-2`–`G8`) · `벨로시티 제한`(두 칸 1–127) · `딜레이`(틱 ±1920). 아래 칸이 위 칸을 넘으면 위 칸도 밀어 올림. 프리즈 모드 등 나머지 = 제외/[P3] |
| I-09 트랙 필드(오디오) | 이름 · 아이콘 · 채널 · 프리즈 모드 · Q-Reference · Flex 모드 | 없음 | 없음 | **D** [P1] `이름` · `아이콘`만 |
| I-10 트랙 색상 필드 | 12.3엔 없음 ⚠️ | TRACK 6색 견본 | 다름 | **D** [P1] 인스펙터에서 색 견본 삭제(색은 C-01) |
| I-11 채널 스트립(왼쪽 = 선택 트랙) | 위→아래: 설정 · EQ · 입력/악기 슬롯 · 오디오 FX(인서트) · 센드 · 출력 · 오토메이션 · 그룹 · 팬 · dB · 페이더+미터 · M S / R I · 아이콘 · 이름 | 볼륨·팬 range, M/S, INSTRUMENT 카드(select), DEVICES 목록(바이패스) | 다름 | **D** [P1] 새 `src/components/ChannelStrip.tsx`(세로, 인스펙터·믹서 공용): `[악기 슬롯](악기 트랙만)` · `[인서트 슬롯 = devices]` · `[출력: Stereo Out]`(표시만) · `팬 노브` · `dB 값` · `세로 페이더+미터` · `[M][S]` · `[R][I]` · `아이콘` · `이름`(트랙 색 바탕). 설정·EQ·센드·오토메이션·그룹 = 표시 안 함 |
| I-12 악기 슬롯 | 클릭 = 플러그인 창 / 메뉴 | INSTRUMENT 카드 select | 다름 | **D** [P1] 슬롯 클릭 = 하단 `디바이스` 탭 열기, 슬롯 오른쪽 ⌄ = 악기 목록 메뉴(`INSTRUMENT_SECTIONS` 하위 메뉴) → `changeInstrument` |
| I-13 인서트 슬롯 | 빈 슬롯 클릭 = 플러그인 메뉴, 채워진 슬롯 클릭 = 창, 마우스 올리면 바이패스 버튼, 드래그 순서 변경 | DEVICES 목록(바이패스 버튼만) + "디바이스 체인 열기" | 다름 | **D** [P1] 채워진 슬롯: 클릭 = 디바이스 탭 열고 해당 디바이스로 스크롤, 호버 시 왼쪽 ⏻ = `enabled` 토글(꺼지면 회색), 세로 드래그 = `moveDevice`. 맨 아래 빈 슬롯 1개: 클릭 = `EFFECT_DEFS` 메뉴 → `addDevice`. 우클릭 = `제거` |
| I-14 오른쪽 스트립 = 출력 | 선택 트랙의 출력(Stereo Out). ⇧클릭 출력/센드 슬롯으로 전환 | 하단 MASTER OUT 슬라이더 | 다름 | **D** [P1] `ChannelStrip variant="output"`: 이름 `Stereo Out`, 페이더 = `project.masterVolume`, 마스터 미터, ⌥클릭 0 dB. 인서트·M/S·R/I 없음(마스터 디바이스 모델 없음). ⇧클릭 전환 = 제외 |
| I-15 스트립 페이더·팬 조작 | ⌥클릭 페이더 = 0 dB, ⌥클릭 팬 = 중앙 | range input | 다름 | **D** [P1] 세로 페이더 = VolumeSlider의 세로 변형(B가 `orientation` prop 제공), dB 테이퍼·0–2·⌥클릭 0 dB. 팬 = PanKnob |

### 1.10 라이브러리 (Y) (§6, 사용자 요청 범위)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| L-01 위치·토글 | Y, 인스펙터 왼쪽 | 왼쪽 "브라우저" 패널(악기 탭/내 파일 탭), 상태 막대 버튼 | 다름 | **A** 명령 `toggleLibrary`(Y). **D** [P1] 새 `src/components/Library.tsx`, 가장 왼쪽 |
| L-02 구성 | 아이콘+패치 이름 · 보기⌄ · 사운드 검색 · 카테고리/패치 열 · 옵션⌄ · 되돌리기 · 삭제 · 저장 | 검색 + 섹션별 악기 목록(미리 듣기 · 이름 · +) | 다름 | **D** [P1] 머리: 포커스 트랙 아이콘 + 현재 패치(악기) 이름. `사운드 검색` 입력. 2열: 왼쪽 카테고리(`INSTRUMENT_SECTIONS` 제목: 신스/피아노·건반/드럼/국악), 오른쪽 그 카테고리 패치(악기). 검색 중이면 1열 평면 결과. 패치 행 왼쪽 아이콘 클릭 = 미리 듣기(가락이음 추가 기능, 유지). 되돌리기·삭제·저장·보기·옵션 = [P3](사용자 패치 없음) |
| L-03 패치 선택 | 포커스 트랙의 악기·이펙트·Smart Controls·라우팅 교체. 다중 선택이면 포커스만 | 이름/+ 클릭 = 새 트랙 추가 | 다름 | **D** [P1] 클릭 = 포커스 트랙(악기 트랙일 때만) `changeInstrument(id, instrument)`(instrumentParams 초기화, **devices 유지** — 패치 = 악기만, 메뉴 구조는 로직과 동일하게 유지). 현재 패치 행 강조. 오디오 트랙 포커스 = 목록 흐리게 + 안내 `오디오 트랙에는 패치가 없습니다`. 새 트랙 추가(+ 버튼) 삭제 |
| L-04 파일 탭 | 로직은 라이브러리가 아닌 오른쪽 브라우저(F) ⚠️ | 같은 패널 "내 파일" 탭 | 다름 | **D** [P1] "내 파일"(프로젝트 오디오 목록 + 가져오기 버튼)을 오른쪽 새 `Browser` 패널로 이동, 키 F `toggleBrowser` ⚠️(레퍼런스 미확인). 기존 오른쪽 인스펙터 자리 재사용 |

### 1.11 리전 표시 (§5)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| V-01 모양·이름 | 둥근 사각형, 왼쪽 위 이름 띠 | 둥근 사각형, 아이콘+이름 띠 | 동일 | 유지(이름 앞 종류 아이콘은 가락이음 유지) |
| V-02 트랜스포즈 접미사 | "(+12)" | 없음 | 없음 | **E** [P1] `clip.transpose`≠0이면 이름 뒤 ` (+12)`/` (−3)` |
| V-03 선택 | 밝게 강조 | 테두리+채움 35% | 다름 | **E** [P1] 선택 = 채움을 `color-mix(var(--clip-color) 60%, white 15%)` 수준으로 밝게, 이름 띠 글자 진하게. 테두리 강조는 보조 |
| V-04 뮤트 리전 | 리전·이름 회색, 이름 앞 작은 점(⌃M) | opacity .42 + 채도↓ + 취소선 + "M" 배지 | 다름 | **E** [P1] `clip.mute` → 회색(채움 `#5a5a5a` 계열, 미리보기 회색), 이름 앞 `•`. 취소선·M 배지 삭제 |
| V-05 뮤트/솔로 제외 트랙 · 꺼진 트랙 | 뮤트·솔로 제외 = 리전 회색, 헤더 이름 색 유지. 꺼진 트랙 = 리전·헤더 이름 모두 회색 | 없음 | 없음 | **E** [P1] `!audible(track)`(A의 `audibleTracks`)이면 행에 `.track-silent` → 그 행 클립 회색. `enabled===false`면 `.track-off` → 클립 회색 + 헤더 이름·아이콘 회색(B가 클래스 스타일) |
| V-06 루프 | 오른쪽 위 루프 포인터, 반복마다 노치, Shaded loops, L = 끝까지 반복 | L = "곧 지원" 알림 | 없음 | **A** `clip.loop` + 엔진. **C** `loopClip`(L) = 선택 클립 `loop` 토글(섞여 있으면 전부 켬). **E** [P1] 루프 구간 렌더: 클립 끝~`loopEnd`(A: 다음 클립 시작 또는 프로젝트 끝)까지 반투명(Shaded) 사본, 반복 경계마다 위·아래 노치(삼각 홈). 루프 구간 클릭 = 원본 선택. 오른쪽 위 루프 포인터 드래그로 반복 길이 지정 [P2](`loopLength` 필드 필요) |
| V-07 클릭 존(페이드 존·마키 존) | 설정, 기본 ⚠️ | 없음 | 없음 | [P3] |
| V-08 페이드 표시 | 파형이 보일 만큼 확대 시 페이드 곡선 | 없음 | 없음 | **E** [P2] 오디오 클립 높이 ≥40px이고 `ppb≥20`이면 페이드 인/아웃 곡선 오버레이(선형) |
| V-09 겹침 재생 | Drag 모드에 따름. 오디오는 나중 리전만 들림 | 겹친 오디오가 둘 다 재생 | 다름 | **A** [P1] 엔진: 같은 오디오 트랙에서 뒤에 시작하는 클립이 앞 클립을 그 시작 지점에서 끊음(앞 클립은 다시 재생되지 않음 ⚠️). 뮤트 클립은 끊지 않음 |
| V-10 게인 툴 | 노란 선 + dB | 없음 | 없음 | [P3] 툴 메뉴(R-03)와 함께 |
| V-11 MIDI 리전 더블클릭 | 에디터(피아노롤 ⚠️) | 피아노롤 열기 | 동일 | 유지 |
| V-12 ⌥↑/⌥↓ (타임라인) | 리전 트랜스포즈 파라미터 변경 ⚠️ | 노트 피치를 파괴적으로 변경 | 다름 | **C** [P1] 타임라인 범위의 `transposeUp/Down/OctaveUp/OctaveDown` = 선택 MIDI 클립 `transpose` ±1/±12(클램프 ±96, 비파괴). 피아노롤 범위는 기존 노트 이동 유지 |

### 1.12 믹서 대응 (§7)

| 항목 | 로직 동작 | 현재 가락이음 | 상태 | 해야 할 일 |
|---|---|---|---|---|
| M-01 뮤트·솔로 | 헤더와 같은 상태, 같은 수정 키(⌥/⌘/⌃ Solo Safe) | 클릭 토글만 | 다름 | **D** [P1] `Mixer.tsx`를 `ChannelStrip` 반복으로 교체 → `TrackButtons` 공용 동작 |
| M-02 녹음 활성·입력 모니터링 | 스트립에 R I | 없음 | 없음 | **D** [P1] ChannelStrip의 R/I |
| M-03 볼륨·팬 | 같은 값. ⌥클릭 초기화 | range 0–1.5, 팬 가로 range | 다름 | **D** [P1] 세로 VolumeSlider(0–2, dB 테이퍼, ⌥클릭 0 dB), PanKnob(⌥클릭 중앙) |
| M-04 아이콘·이름/색 | 스트립 아래 아이콘, 이름(트랙 색) | 번호+이름(더블클릭 이름 변경) | 다름 | **D** [P1] 아이콘 + 트랙 색 이름표. 이름 더블클릭 편집 유지. 번호 삭제(§7: 번호는 헤더만) |
| M-05 스트립 선택 = 트랙 선택 | 스트립 클릭 = 트랙 선택(⇧/⌘ 다중) | 클릭 = 단일 선택 | 다름 | **D** [P1] 스트립 배경 클릭 → `onTrackClick(id, mods)`(헤더와 동일, A-01~A-04) |
| M-06 인서트·악기 슬롯·출력 | 믹서에 있음 | 없음(디바이스 탭에서만) | 없음 | **D** [P1] ChannelStrip 슬롯(I-12, I-13) 그대로 |
| M-07 마스터 | Stereo Out 스트립 | "MASTER" + "Stereo out" | 다름 | **D** [P1] `ChannelStrip variant="output"`, 이름 `Stereo Out` |
| M-08 피크 표시 | 페이더 위 피크 값, 클릭 초기화 | 없음 | 없음 | **D** [P2] 미터 피크 홀드(dBFS), 클릭 초기화 |
| M-09 ⋯ 메뉴 | 로직 스트립에 없음(우클릭 메뉴) | ⋯ 버튼(이름 바꾸기·복제·삭제) | 다름 | **D** [P1] ⋯ 버튼 삭제, 우클릭 메뉴는 헤더 메뉴(1.4)와 같은 항목 중 이름 변경·복제 2종·색상·삭제 |
| M-10 헤더 전용 | 가리기·켬/끔·번호 | — | — | 믹서에 H/⏻/번호 넣지 않음. 숨긴 트랙도 믹서에 표시 ⚠️ |
| M-11 설정·EQ·MIDI FX·포맷·센드·그룹·VCA·바운스·Dim·게인 리덕션 | 믹서 전용 | 없음 | 없음 | 제외/[P3] |

### 1.13 단축키 (대조표 항목들이 요구하는 키)

| 명령(신규 `ProjectShortcut`) | 로직 키 | Win/Linux | 범위 | 비고 |
|---|---|---|---|---|
| `toggleInspector` | I | I | TW | |
| `toggleLibrary` | Y | Y | TW | |
| `toggleMixer` | X | X | TW | 하단 탭 믹서 ↔ 직전 탭 |
| `toggleBrowser` | F ⚠️ | F | TW | 레퍼런스 미확인 |
| `globalTracks` | G | G | TW | |
| `toggleHideView` | H | H | TW | |
| `hideSelectedTracks` | ⌃H | Alt+Shift+H | TW | |
| `unhideAllTracks` | ⌃⇧H | Ctrl+Alt+H | TW | 새 mods `ctrlShift`(mac) |
| `colorPalette` | ⌥C | Alt+C | TW | |
| `configureTrackHeader` | ⌥T | Alt+T | TW | |
| `armTrack` | ⌃R | Alt+Shift+R | TW | 선택 트랙 `armed` 토글(새 값 = !포커스) |
| `monitorTrack` | ⌃I | Alt+Shift+I | TW | |
| `toggleTrackOn` | ⌥M | Alt+M | TW | |
| `muteClip`(변경) | ⌃M | Alt+Shift+M | T | 기존 ⌥M에서 이동(로직: ⌃M 리전 뮤트, ⌥M 트랙 켬/끔) |
| `clearRecallSolo` | ⌥S | Alt+S | TW | |
| `muteTrack`/`soloTrack`(변경) | M / S | M / S | TW | 선택 트랙 전부, 새 값 = !포커스 트랙 값 |
| `trackUpExtend`/`trackDownExtend` | ⇧↑/⇧↓ | Shift+↑/↓ | TW | |
| `trackZoomIn`/`trackZoomOut` | ⌥⌘↓/⌥⌘↑ | Ctrl+Alt+↓/↑ | TW | 포커스 트랙 factor ×1.2/÷1.2 |
| `trackZoomToggle` | ⌥⌘Z | Ctrl+Alt+Z | TW | |
| `trackZoomReset` | ⌥⌘⌫ | Ctrl+Alt+Backspace | TW | 레퍼런스가 같은 키를 "미사용 트랙 삭제"에도 적음 → 줌 초기화로 확정, 미사용 삭제는 메뉴만 |
| `zoomFocusedTrack` | ⌃Z | (없음, 메뉴만) | TW | Win Ctrl+Z = 실행 취소 |
| `newTracksDialog`(=기존 `newTrack` 변경) | ⌥⌘N | Ctrl+Alt+N | TW | 즉시 생성 → 창 열기 |
| `newAudioTrack` / `newInstrumentTrack` | ⌥⌘A / ⌥⌘S | Ctrl+Alt+A / S | TW | |
| `duplicateTrack` | ⌘D | Ctrl+D | TW | 기존 클립 `duplicate`의 ⌘D를 회수(클립은 ⌘R 반복·메뉴) |
| `duplicateTrackContent` | ⌥⇧⌘D | Ctrl+Alt+Shift+D | TW | 새 mods `modAltShift` |
| `createMarker` | ⌥' ⚠️ | Alt+' | TW | |

키 규칙 변경(**A**, `input.ts`)
- 현재 `MODS.mod`는 mac에서 Ctrl 단독도 ⌘로 받음 → ⌃ 바인딩(⌃R/⌃I/⌃H/⌃M/⌃Z/⌃⇧H)은 `platforms:['mac']`으로 **배열 앞쪽**(같은 키의 `mod` 바인딩보다 먼저)에 둔다. 결과: mac에서 Ctrl+R은 반복이 아니라 녹음 활성. `docs/SHORTCUTS.md`의 "macOS Ctrl = ⌘" 규칙에 예외 명시(F).
- 로직 ⌃ 조합의 Win/Linux 대응 = Alt+Shift+같은 키(⌃⇧H만 Ctrl+Alt+H).
- 마우스 수정 키도 같은 대응: 로직 ⌃클릭 = mac `contextmenu`+ctrlKey, Win/Linux Alt+Shift+클릭. 로직 ⌘클릭 = Win/Linux Ctrl+클릭.

버튼 드래그 연속 전환(sweep, **B**)
- M/S/R/I/⏻/H 버튼 pointerdown(수정 키 없음) → 그 버튼 새 값 v 계산·적용 → 포인터를 누른 채 움직이면 `document.elementFromPoint`로 `[data-track-button=<kind>][data-track-id]`를 찾아 같은 종류 버튼에 v 적용(이미 v면 무시). 버튼에 pointer capture를 걸지 않는다. pointerup/Escape/blur에서 종료. 한 sweep = 히스토리 1단계(merge key `sweep:<kind>:<startId>`). arm/monitor sweep은 히스토리 밖(2.5).

## 2. 데이터 모델 변경 목록 (Pass A)

### 2.1 Track (`src/core/types.ts`)

필수 필드로 추가하고 `validateProject`가 없으면 기본값으로 채운다(schemaVersion 2 유지, 이전 저장 파일 호환).

| 필드 | 타입 | 기본 | 검증 | 엔진 반영 | 히스토리 |
|---|---|---|---|---|---|
| `enabled` | boolean | true | flag | **예**: false면 스케줄·페이더·미리 듣기 제외 | 예 |
| `armed` | boolean | false | flag | 녹음 대상 결정(App) | **아니오**(live) |
| `monitor` | boolean | false | flag | 오디오 트랙 입력 모니터링 연결 | **아니오**(live) |
| `hidden` | boolean | false | flag | 없음(숨겨도 재생) | 예 |
| `soloSafe` | boolean | false | flag | 예: 다른 솔로가 있어도 들림 | 예 |
| `transpose` | integer | 0 | −96…96 정수 | 예(악기 트랙) | 예 |
| `velocityOffset` | integer | 0 | −99…99 정수 | 예 | 예 |
| `keyLimit` | `[number, number]` | `[0,127]` | 각 0…127 정수, `lo≤hi` 아니면 오류 | 예: 범위 밖 노트 제외 | 예 |
| `velocityLimit` | `[number, number]` | `[1,127]` | 각 1…127 정수, `lo≤hi` | 예: 범위 밖 노트 제외 | 예 |
| `delayTicks` | integer | 0 | −1920…1920 정수(960 PPQ = ±2박) | 예: 노트/오디오 시작 이동 | 예 |
| `icon` | string? (선택) | 없음 = 기본 아이콘 | 1–40자, `Icon` 이름 목록에 없으면 버림 | 없음 | 예 |

- `createTrack`: 위 기본값 + 기본 색(C-02). `duplicateTrack`/`duplicateTrackSettings`: 필드 복사하되 `armed`/`monitor`는 호출 측이 이동(R-32).
- 오디오 트랙의 `transpose`/`velocityOffset`/`keyLimit`/`velocityLimit`은 저장은 하되 무시.

### 2.2 Clip (`ClipBase` / `MidiClip`)

선택 필드(없으면 기본) — 클립 리터럴이 App 곳곳에 있으므로 필수로 만들지 않는다.

| 필드 | 위치 | 타입·기본 | 검증 | 엔진 반영 |
|---|---|---|---|---|
| `loop` | ClipBase | boolean, 없음=false | flag | 예: 다음 클립 시작(같은 트랙, 이 클립보다 뒤에 시작하는 첫 클립, 뮤트 포함 ⚠️) 또는 `project.lengthBeats`까지 `lengthBeats` 주기로 반복. 오디오도 같은 구간 반복 |
| `delayTicks` | ClipBase | integer, 없음=0 | −1920…1920 정수 | 예 |
| `quantize` | MidiClip | number(박), 없음=0(끔) | `QUANTIZE_VALUES=[0,4,2,1,0.5,0.25,0.125,0.0625,2/3,1/3,1/6,1/12]` 중 하나(1e-6 허용) | 예: 재생 시 비파괴 |
| `swing` | MidiClip | 0…100, 없음=50 | number | 예(퀀타이즈 켜짐일 때만) |
| `transpose` | MidiClip | integer, 없음=0 | −96…96 정수 | 예 |
| `velocity` | MidiClip | integer, 없음=0 | −99…99 정수 | 예 |

- 오디오 클립에 `quantize/swing/transpose/velocity`가 있으면 버린다(알 수 없는 키 정책과 동일).
- 저장 시 기본값인 필드는 생략해도 된다(`mute`와 같은 방식).
- `splitClip`/`joinClips`/`duplicateClip`/`trim*`: 스프레드로 필드 유지 — 테스트로 확인. `joinClips`는 첫 클립 값.

### 2.3 Project

| 필드 | 타입·기본 | 검증 |
|---|---|---|
| `markers` | `Marker[]`, 기본 `[]` | `Marker = { id: string; name: string; startBeat: number }`, id 중복 금지(기존 `seen`), name 1–512자, startBeat 0…10,000,000, 최대 10,000개, 저장 시 startBeat 정렬 |

`createEmptyProject`에 `markers: []`. 엔진 영향 없음.

### 2.4 순수 함수 (`src/core/trackActions.ts`, 신규, 테스트 필수)

- `pressTrackButton(project, trackId, kind, mods:{alt,mod,soloSafe}): Project`
  - mute: 기본 토글 · alt = 대상만 true, 나머지 false · mod = 대상의 현재 값 s와 같은 트랙 전부 !s.
  - solo: 기본 토글 · alt = 대상만 true, 나머지 false · mod = 전부 대상의 새 값 · soloSafe = `soloSafe` 토글(켜면 `solo=false`).
  - arm: 기본 토글 · alt = 대상이 armed면 전부 false, 아니면 대상만 true.
  - monitor / hidden: 토글(수정 키 무시 ⚠️).
  - enabled: 기본·alt 토글 · mod = 전부 대상의 새 값.
- `sweepTrackButton(project, trackId, kind, value): Project`
- `clearRecallSolo(project, recall: string[] | null): { project; recall }` (H-16)
- `effectiveArm(track, focusedTrackId, tracks): 'off'|'auto'|'armed'` (H-18)
- `audibleTracks(project): Set<string>` = `enabled && !mute && (!anySolo || solo || soloSafe)`, `anySolo`는 enabled 트랙만 계산.
- `implicitlyMuted(track, project)` = audible 아님 && !mute && enabled.
- `cycleClipIds(track, loop)` (A-01), `insertTracks(project, afterId|null, tracks)`, `visibleTracks(project, hideView)`.
- `project.ts`: `duplicateTrackSettings(track)`, `applyDragMode(project, trackIds, movedClipIds, mode)` (R-05).

### 2.5 녹음 활성·모니터링 (App + 엔진)

- App `historyReducer`에 `{type:'live', edit}` 추가: `present`만 바꾸고 past/future에 넣지 않음. undo/redo 결과에 현재 `present`의 `armed`/`monitor`를 같은 id 트랙에 덮어씀(`carryLiveState`). arm/monitor 변경은 항상 live. 저장(자동 저장)에는 포함.
- 녹음 대상(`toggleRecord`): ① armed 오디오 트랙 중 가장 위 → ② 없으면 포커스 트랙이 오디오면 그 트랙(로직 자동 활성) → ③ 포커스가 악기 트랙(auto/armed)이고 armed 오디오 없음 → 알림 `MIDI 녹음은 아직 지원하지 않습니다` 후 중단 → ④ 트랙이 없으면 기존처럼 새 오디오 트랙. armed 오디오 트랙이 2개 이상이면 첫 트랙에 녹음 + 알림 `한 번에 한 트랙만 녹음합니다`.
- 엔진 `AudioEngine.setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void` (types.ts 인터페이스 + WebAudioEngine): `MediaStreamAudioSourceNode` 1개를 대상 트랙 `channel.input`마다 연결, `replaceGraph` 후 재연결, `null`이면 해제. 대상 = `kind==='audio' && enabled && (monitor || (armed && recording))`. App은 대상이 생길 때 `getUserMedia` 1회(녹음과 같은 옵션), 대상이 없어지면 스트림 정지. 첫 사용 시 알림 `피드백을 막으려면 헤드폰을 사용하세요`.

### 2.6 엔진 반영 (`graph.ts`, `WebAudioEngine.ts`, 신규 `src/core/playback.ts`)

- `graph.ts` `updateGraph` 한 줄: `const audible = audibleSet.has(track.id)` (= `track.enabled && !track.mute && (!anySolo || track.solo || track.soloSafe)`, `audibleTracks` 사용).
- `graph.ts` `scheduleRange` 한 줄: `if (!channel || !track.enabled) continue`.
- `WebAudioEngine.previewNote`: 같은 audible 규칙 + 트랙 transpose/velocityOffset/limits 적용(라이브 입력도 트랙 파라미터를 받음).
- `WebAudioEngine.setProject` `musicalKey`에 트랙별 `enabled, transpose, velocityOffset, keyLimit, velocityLimit, delayTicks` 추가(클립 필드는 이미 `track.clips` 직렬화에 포함). `soloSafe`/`mute`/`solo`는 `updateGraph`(페이더)로.
- `playback.ts`(순수, 테스트):
  - `loopEnd(track, clip, projectEnd)`, `clipOccurrences(track, clip, projectEnd): {start, end}[]`(loop 꺼짐이면 1개).
  - `playbackNotes(track, clip, occ): {pitch, start, end, velocity}[]` 순서: ① 퀀타이즈 `q`: `i=round(start/q)`, `start'=i·q + (i 홀수 ? (swing−50)/50·q : 0)`, `[0, length)`로 클램프, 길이 유지 ② 딜레이 `(clip.delayTicks + track.delayTicks)/960`박 ③ 피치 `+clip.transpose+track.transpose`, 0–127 밖이면 제외 ④ 벨로시티 `v=clamp(round(vel·127)+clip.velocity+track.velocityOffset, 1, 127)` ⑤ 키 제한·벨로시티 제한 밖이면 제외 ⑥ 회차 창 `[occ.start, occ.end)`로 자르기 ⑦ 결과 velocity = `v/127 · clip.gain`.
  - `audioWindows(track, projectEnd)`: 회차 전개 + 딜레이 + V-09 "나중 클립 우선" 잘라내기 → `{clip, start, end, sourceOffset}`.
  - `scheduleRange`는 이 함수들의 결과만 사용(시작 판정 `startsInRange`, chase는 기존 규칙).
- 드럼 키트도 트랜스포즈 적용(로직 동일, No Transpose 없음).

## 3. UI 상태 변경 목록

| 상태 | 위치 | 타입·기본 | 저장 | 비고 |
|---|---|---|---|---|
| `focusedTrackId` | App | string | 아니오 | 기존 `selectedTrackId` 이름 변경. 키 명령·인스펙터·라이브러리·자동 녹음 활성 기준 |
| `selectedTrackIds` | App | `ReadonlySet<string>`, `{focused}` | 아니오 | 클립 클릭 = `{그 클립 트랙}`, 마키 = `{앵커 트랙}`. 삭제·undo 후 존재하지 않는 id 제거(기존 정리 effect 확장) |
| `selectedClipIds`, `anchorClipId` | App | 기존 | 아니오 | 유지. 포커스 트랙 = 앵커 트랙 규칙은 클립 선택 시에만 |
| `trackZoom` | App(`trackUi.ts`) | `Record<trackId, number>` factor, `{}` | localStorage `garak-ieum:track-zoom:<projectId>` | 범위 0.5–4, 없는 트랙 키는 로드 시 제거 |
| `zoomFocused` | App | boolean, false | `garak-ieum:view` | ⌃Z / 보기 메뉴 |
| `headerWidth` | App | number, 248 (160–420) | `garak-ieum:track-header` | `HEADER_WIDTH` 상수 대체 |
| `headerConfig` | App | `{mute,solo,record,monitor,onOff,hide,volume,pan,trackNumber,colorBar,icon}` (기본 1.5절) | `garak-ieum:track-header` | |
| `hideView` | App | boolean, false | 아니오 | 끄면 `hidden` 트랙을 타임라인에서 렌더 안 함(재생은 함) |
| `soloRecall` | App | `string[] \| null`, null | 아니오 | H-16 |
| `catch` | App | boolean, true | `garak-ieum:view` | 기존 Timeline 내부 `follow` 상태를 올림 |
| `scrollInPlay` | App | boolean, false | `garak-ieum:view` | |
| `snap` | App | `{on: boolean; mode: SnapMode; relative: boolean}`, `{true,'smart',false}` | `garak-ieum:view` | 기존 `snap:number`·`lastSnap` 대체. 숫자는 `resolveSnap`로 계산 |
| `dragMode` | App | `'overlap'/'noOverlap'`, `'noOverlap'` ⚠️ | `garak-ieum:view` | |
| `globalTracks` | App | boolean, false ⚠️ (로직 기본 표시지만 마커 1종뿐이라 끔) | `garak-ieum:view` | |
| `gridLines` | App | boolean, true | `garak-ieum:view` | [P2] |
| `inspectorOpen` (I) | App | boolean, true | `garak-ieum:view` | 기존 상태 유지, 위치만 왼쪽 |
| `libraryOpen` (Y) | App | boolean, true | `garak-ieum:view` | 기존 `browserOpen` 대체 |
| `browserOpen` (F) | App | boolean, false | `garak-ieum:view` | 오른쪽 파일 브라우저 |
| `paletteOpen` / `headerConfigOpen` / `newTracksOpen` | App | boolean | 아니오 | 팝오버·창. `modal`에 `'newTracks'` 추가 |
| `inspectorSections` | Inspector | `{region,track,strips}` 펼침, 전부 true | `garak-ieum:view` | |

`src/core/trackUi.ts`(A): 위 타입, 기본값, `sanitize*`, `load*/save*`(zoom.ts 패턴: 잘못된 값은 기본값으로), `resolveSnap`, 테스트.

### 3.1 컴포넌트 계약 (병렬 작업용)

- `TrackButtons`(B): `{track; kinds: TrackButtonKind[]; arm: 'off'|'auto'|'armed'; recording: boolean; implicitMute: boolean; onPress(trackId, kind, mods:{alt,mod,soloSafe}); onSweep(trackId, kind, value)}`, `TrackButtonKind='mute'|'solo'|'arm'|'monitor'|'enabled'|'hidden'`.
- `VolumeSlider`(B): `{value; onChange(v, final:boolean); orientation:'horizontal'|'vertical'; meter?: {engine; trackId?}}`. `PanKnob`(B): `{value; onChange}`.
- `TrackHeader`(B): `{track; index; focused; selected; multi; height; config; ui:{hideView, recording}; arm; implicitMute; renaming; engine; 콜백: onClick(mods), onFocus(), onButton, onSweep, onChange(patch, key), onRename(name|null), onOpenLibrary(), onIconMenu(e), onContextMenu(e), onReorderStart(e), onResizeStart(e)}`.
- `Timeline` props(C ↔ App): `selectedTrackId` → `focusedTrackId`, 추가 `selectedTrackIds`, `ui`(3절 중 타임라인 관련), `onUiChange(patch)`, `onTrackClick(id, {range,toggle,trackOnly})`, `onTrackFocus(id)`, `onTrackButton`, `onTrackSweep`, `onTracksChange(patches:{id,patch}[], key?)`, `onNewTrack({kind?, sameAsFocused?, empty?, dialog?, afterId?})`, `onDuplicateTracks(ids, 'settings'|'content')`, `onDeleteTracks(ids)`, `onRenameTracks(ids, name)`, `onSeekPlay(beat)`, `onClearRecallSolo()`, `onOpenLibrary(id)`, `onMarker('add'|'move'|'rename'|'delete', …)`. 삭제: `onAddTrack`, `onTrackOpen`, `onTrackAction`의 `up/down`. B 단계에서는 새 props를 선택(optional)으로 추가, C에서 필수로.
- `Inspector`(D): `{project; focusedTrack; selection: ClipEntry[]; engine; onClipsEdit(fn, key); onTrackChange(id, patch, key); onTrackButton; onTrackSweep; onInstrumentChange; onAddDevice; onToggleDevice; onMoveDevice; onRemoveDevice; onOpenDevices(deviceId?); onMasterChange}`. `Library`(D): `{focusedTrack; engine; onSelectPatch(instrumentId); onPreview(instrumentId)}`.

## 4. 구현 순서 제안

의존 관계: **A → (B ∥ D1) → (C ∥ D2) → (E ∥ F)**. 같은 시점에 한 파일은 한 패스만 수정.

| 패스 | 내용 | 수정/생성 파일 | 시점 |
|---|---|---|---|
| **A** 데이터·엔진·키 | 2절 전부: Track/Clip/Project 필드, `validateProject`, `createTrack` 기본 색, `duplicateTrackSettings`, `applyDragMode`, 팔레트, UI 상태 모듈, 버튼 수정 키 의미, 재생 변환(루프·퀀타이즈·스윙·트랜스포즈·벨로시티·제한·딜레이·오디오 나중 우선·enabled·soloSafe), `setInputMonitor`, 1.13 단축키 전부(명령·바인딩·META·mac ⌃ 순서). **사용자 목록의 E 엔진 부분(클립 루프/퀀타이즈/트랜스포즈)을 여기로 옮김** — graph.ts를 한 패스가 끝까지 맡게 하려는 것 | `src/core/types.ts`, `src/core/project.ts`, `src/core/project.test.ts`, `src/core/playback.ts`(신규)+`.test.ts`, `src/core/trackActions.ts`(신규)+`.test.ts`, `src/core/colors.ts`(신규)+`.test.ts`, `src/core/trackUi.ts`(신규)+`.test.ts`, `src/core/input.ts`, `src/core/input.test.ts`, `src/audio/graph.ts`, `src/audio/WebAudioEngine.ts`, `src/core/storage.test.ts`(필요 시) | 1단계(단독) |
| **B** 트랙 헤더 | 1.1·1.2·1.5·1.6 UI: TrackHeader, TrackButtons(+sweep), VolumeSlider(가로/세로), PanKnob, HeaderConfigPopover, ColorPalette, 헤더 행 렌더 교체·순서 변경 드래그 위치·코너 핫존 마크업 | `src/components/TrackHeader.tsx`(신규), `src/components/TrackHeader.css`(신규), `src/components/TrackButtons.tsx`(신규), `src/components/VolumeSlider.tsx`(신규), `src/components/PanKnob.tsx`(신규), `src/components/HeaderConfigPopover.tsx`(신규), `src/components/ColorPalette.tsx`(신규)+`.css`, `src/components/Knob.tsx`(⌥클릭 기본값), `src/components/Timeline.tsx`(헤더 JSX·`TRACK_COLORS` 제거만) | 2단계 |
| **D1** 인스펙터·라이브러리 부품 | 1.9·1.10 컴포넌트, New Tracks 창 | `src/components/Inspector.tsx`, `RegionInspector.tsx`, `TrackInspector.tsx`, `ChannelStrip.tsx`, `Library.tsx`, `Browser.tsx`, `NewTracksDialog.tsx`, `Inspector.css`(모두 신규) | 2단계(B와 병렬, `TrackButtons`/`VolumeSlider`/`PanKnob`은 3.1 계약으로 import) |
| **C** 선택 모델·트랙 영역 | 1.3·1.4·1.7(G)·1.8: 헤더 클릭 수정 키, 포커스/다중 선택 렌더, 사이클 인식, 눈금자 규칙, ⇧클릭 레인 이동, ⇧더블클릭 재생, Catch·재생 중 스크롤, 트랙별 높이·코너 드래그, 헤더 너비, 헤더 위 줄(+·복제·H·S·≡), 메뉴 막대(편집/기능/보기/Snap/Drag), 우클릭 메뉴 1.4, 빈 곳 더블클릭/우클릭, 마커 글로벌 트랙, Drag 모드 적용 호출, 숨김 렌더 | `src/components/Timeline.tsx`, `src/components/ContextMenu.tsx`(체크 항목 유지 옵션이 필요하면) | 3단계 |
| **D2** App 배선·레이아웃·믹서 | 3절 상태 전부 App으로, `historyReducer` live 액션, `run()` 신규 명령 처리, 녹음 대상 규칙·모니터링 스트림, 선택 함수(`onTrackClick` 등), 레이아웃 `[Library][Inspector][main][Browser]`, 오른쪽 인스펙터·트랜스포트 snap select 삭제, 삭제 확인 모달 제거, Mixer를 ChannelStrip 기반으로 교체 | `src/App.tsx`, `src/components/Mixer.tsx`, `src/styles.css` | 3단계(C와 병렬, 3.1 Timeline 계약 기준) |
| **E** 리전 표시 | 1.11: 클립 컴포넌트 분리, 뮤트 점·회색, 트랙 무음/꺼짐 회색, 선택 밝게, 트랜스포즈 접미사, 루프 회차·노치 렌더, [P2] 페이드 곡선 | `src/components/TimelineClip.tsx`(신규, Timeline.tsx의 `TimelineClip` 이동), `src/components/TimelineClip.css`(신규), `src/components/Timeline.tsx`(클립 import·루프 구간 클릭 처리만) | 4단계 |
| **F** 문서·도움말 | 단축키 표(1.13)와 mac ⌃ 예외 규칙, 구현 현황, 인터랙션 명세(인스펙터 왼쪽, 선택 모델, arm/monitor 비-undo), LOGIC_REFERENCE §9에 0절 추가 제안 반영, 피치 표기 통일 결정(인스펙터 C3=60 vs 피아노롤 C4=60) | `docs/SHORTCUTS.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/INTERACTION_SPEC.md`, `docs/LOGIC_REFERENCE.md`(§9만), `docs/interaction-spec.html`(동기화 필요 시) | 4단계(E와 병렬) |

패스별 완료 조건
- A: `npm test` 통과, 새 순수 함수 단위 테스트(버튼 수정 키 6종, clearRecall 왕복, effectiveArm, 퀀타이즈+스윙, 루프 회차·다음 클립에서 멈춤, 키/벨로시티 제한, 딜레이 음수, 오디오 나중 우선, 마커 검증, 구버전 프로젝트 기본값 채움). UI는 기존과 동일하게 동작해야 함(새 필드 기본값).
- B/D1: 단독 렌더 가능(타입 체크 통과), 기존 화면 기능 손실 없음.
- C/D2: `tsc` + 테스트 통과, 1.3·1.4·1.8·1.9·1.12의 [P1] 행 전부 동작.
- E: 1.11 [P1] 행 전부.
- F: 문서 표가 `SHORTCUT_TABLE`과 일치.
