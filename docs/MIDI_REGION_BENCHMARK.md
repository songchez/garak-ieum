# MIDI 리전 벤치마크 — Ableton Live 12 · Logic Pro 11 대비 가락이음

작성: 2026-11-15 · 범위: MIDI 클립/리전과 그 편집기(피아노롤 등), 녹음·입력, 컨트롤러 데이터, 변환·생성 도구, 가져오기/내보내기.
이 문서는 조사·격차 분석 문서입니다. 코드는 바꾸지 않았습니다. (이후 0.3.2에서 두 호스트가 통합 Rust 엔진을 쓰게 됐고, 0.3.3에서 브라우저 `audio/graph.ts`·`graph.test.ts`는 삭제됐습니다.) 현재 구현 판정은 2026-11-15 `feat/sustain-pedal` 체크아웃(커밋 `ca79867` + 진행 중인 서스테인 작업)의 코드를 직접 읽어 내렸습니다.

표기:

- **가락이음 현재**: `있음` / `부분` / `없음`. 근거 파일을 괄호에 적었습니다.
- **우선순위**: P0 = 실사용 DAW로서 필수(없으면 MIDI 작업 흐름이 막힘) · P1 = 주요 생산성 · P2 = 차별화·고급.
- **노력**: S = 하루~수일, 단일 모듈 · M = 1~2주, 데이터 모델+UI+한 엔진 · L = 여러 주, 데이터 모델·두 엔진(브라우저 `audio/graph.ts` + 데스크톱 `audio/native/timeline.ts` → C++ `native/src/engine.cpp`)·저장 스키마·MCP 모두 변경.
- **[서스테인]**: 진행 중인 `feat/sustain-pedal`(CC64) 작업이 다루거나 기반을 놓는 항목. 현재 작업 트리에는 `src/core/sustain.ts`(공용 CC64 의미론: 64 이상 = 눌림, 리전 왼쪽 경계 chase, 리전 끝·루프 경계에서 해제, 같은 음 재타건 시 이전 음 종료)가 추가되어 있고, 설명상 두 엔진·가져오기/내보내기·피아노롤이 공유합니다. 세부 범위는 그 브랜치의 `docs/SUSTAIN_PEDAL.md`를 기준으로 합니다.

---

## 1. 핵심 결론 (요약)

1. **MIDI 입력·녹음이 전혀 없습니다.** `requestMIDIAccess`, CoreMIDI/WinMM/RtMidi 등 네이티브 MIDI 입력 코드가 웹·데스크톱·C++ 어디에도 없습니다. `App.tsx:1176`은 악기 트랙 녹음 시 `MIDI 녹음은 아직 지원하지 않습니다`를 알리고 중단합니다. 컴퓨터 키보드 연주(Musical Typing)도 없습니다. 두 DAW 모두 MIDI 작업의 출발점이 실시간 입력·녹음이므로 **최대 격차(P0)** 입니다.
2. **음표 외의 MIDI 데이터가 없습니다.** `MidiNote`는 `pitch/start/duration/velocity`뿐이고, `MidiClip`에는 CC·피치벤드·애프터터치·프로그램 체인지가 없습니다(서스테인 CC64가 첫 예외로 추가 중). 리전 엔벨로프/오토메이션 레인도, 트랙 오토메이션도 없습니다(`IMPLEMENTATION_STATUS.md:467`). 네이티브 이음웨이브 신스는 이미 `EventType::PitchBend`·`Sustain`을 받으므로 엔진 쪽 기반은 일부 있습니다.
3. **리전 비파괴 파라미터는 Logic의 기본 세트에 근접합니다.** 퀀타이즈(1/1~1/64, 셋잇단)·스윙·트랜스포즈(±96)·벨로시티(±99)·딜레이(틱)·게인·뮤트·루프·수동 루프 끝·비파괴 트림이 있고 재생 시 두 엔진에 적용됩니다(`core/playback.ts`). 빠진 것은 **Q-Strength·Q-Range·Q-Flam·Q-Velocity·Q-Length, 다이내믹스(벨로시티 압축/확장), 게이트 타임**과 Ableton식 **그루브 풀**입니다.
4. **피아노롤은 기본 편집(생성·이동·좌우 길이·벨로시티 레인·복사/붙여넣기·Q/Shift+Q·옥타브·자석 스냅·드럼 모드)은 갖췄지만** 확률(Chance)·벨로시티 범위·음표 비활성(뮤트)·레가토·분할/합치기·스트레치·음계 하이라이트/폴드·Scale Quantize·Humanize·다중 리전 동시 편집·MIDI 변환 도구가 없습니다. 퀀타이즈는 파괴적이고 강도 100% 고정입니다.
5. **내보내기(.mid)가 없습니다.** 가져오기는 SMF Type 0/1과 CC64(음 길이에 반영 — 서스테인 작업이 이벤트 보존으로 바꾸는 중)를 지원하지만 피치벤드·CC·템포 변경은 경고만 띄우고 버립니다.
6. **보기 종류**는 피아노롤(+드럼 모드) 하나입니다. 스텝 시퀀서, 악보, 이벤트 리스트, MIDI Transform 창은 없습니다.

권장 순서: **1단계(P0) MIDI 입력·녹음 + 벨로시티/퀀타이즈 보강** → **2단계(P0~P1) 컨트롤러 데이터 모델(CC·피치벤드·애프터터치) + 리전 컨트롤러 레인 + .mid 내보내기** → **3단계(P1) 편집 생산성(음계·폴드·레가토·분할/합치기·뮤트·Q-Strength/Range·다이내믹스·게이트·그루브)** → **4단계(P2) 변환/생성 도구·코드 트랙·아르페지에이터·스텝/이벤트 뷰·MPE**. 자세한 수용 기준은 4절.

---

## 2. 현재 가락이음 MIDI 리전 기능 인벤토리 (코드 근거)

| 영역 | 현재 동작 | 근거 |
| --- | --- | --- |
| 데이터 모델 | `MidiNote{id,pitch,start,duration,velocity(0–1)}`, `MidiClip{notes, sourceOffsetBeats, quantize, swing, transpose, velocity}` + `ClipBase{startBeat,lengthBeats,gain,mute,loop,loopLengthBeats,delayTicks}`. 진행 중: CC64 서스테인 이벤트(`SustainEvent{beat,value}`) | `src/core/types.ts`, `src/core/sustain.ts`(미커밋) |
| 트랙 MIDI 파라미터 | 트랜스포즈·벨로시티 오프셋·키 제한·벨로시티 제한·딜레이(틱) — 재생 시 적용 | `types.ts` Track, `core/playback.ts` `trackNote` |
| 재생 변환 | 루프 회차 → 퀀타이즈(가장 가까운 격자, 홀수 칸에 스윙) → 딜레이 → 이조 → 벨로시티 오프셋 → 키/벨로시티 제한 → 회차 창 자르기 → `velocity × gain`. 원본 보존 | `core/playback.ts` `playbackNotes`, `audio/graph.ts`, `audio/native/timeline.ts` |
| 비파괴 트림 | 왼쪽/오른쪽 트림은 `sourceOffsetBeats`로 숨김. 피아노롤 편집은 보이는 구간만 원본에 병합 | `core/midiRegions.ts` |
| 리전 인스펙터 | 뮤트·루프·퀀타이즈(끔,1/1…1/64,1/2T…1/16T)·스윙·트랜스포즈·벨로시티, `더 보기` 딜레이(틱+ms)·게인·클립 길이(읽기 전용). 다중 선택 `*` 혼합값·상대 편집·⌥⇧ 절대값 | `components/RegionInspector.tsx` |
| 타임라인 리전 | 레인 더블클릭으로 빈 MIDI 클립 생성, 이동·Alt 복사·트랙 간 이동, 분할(⌘T/⌘E), 합치기(⌘J, 보이는 음표를 새 소스로), 반복 붙이기(⌘R), 루프(L) + 수동 루프 끝, 뮤트, 이름, 인접 경계 자석 스냅, 반복 블록 미리보기 | `core/input.ts` `split/join/repeat/loopClip`, `components/TimelineClip.tsx`, `core/project.ts` |
| 타임라인 ⌥↑/↓ | 선택 MIDI 리전의 `transpose`를 비파괴로 ±1/±12 | `LOGIC_GAP.md` V-12, `core/input.ts` |
| 피아노롤 편집 | 빈 격자에서 음표 생성(마지막 길이·벨로시티 기억), 이동(Shift 축 고정, Alt 복사), 오른쪽/왼쪽 경계 길이 조절, 사각형 선택·Shift 추가, 자석 경계 스냅+정렬선, 자유 이동 기본·스냅 선택(⌘G 토글, Ctrl 세밀, Ctrl+Shift 무시), 방향키 이동(보이는 격자 한 칸)·반음/옥타브(⌥⇧↑↓), ⌥←→ 넛지, ⌥⇧←→ 길이, Shift+방향키 선택 확장, 복사/잘라내기/붙여넣기(클립 간), ⌘D 복제, Del 삭제, Esc 취소 | `components/PianoRoll.tsx`, `core/pianoEditing.ts` |
| 퀀타이즈(파괴적) | `Q` = 시작만, `Shift+Q` = 시작+길이. 현재 스냅(없으면 1/16)으로 100% 이동. 강도·범위·스윙 옵션 없음 | `PianoRoll.tsx` `quantize()` |
| 벨로시티 | 하단 VEL 레인(보이기/숨기기), 막대 드래그(선택 전체 상대 변경, Shift = 앵커 값으로 통일), 슬라이더 1–127, 우클릭 100/75/50/25% | `PianoRoll.tsx` `beginVelocity`, 메뉴 |
| 미리 듣기 | 건반 클릭·음표 클릭/이동 시 악기 미리 듣기 | `PianoRoll.tsx` `onPreview` |
| 드럼 모드 | 킷 악기면 드럼 이름 행만 표시(Fold 유사), 옥타브 이동 비활성 | `PianoRoll.tsx` `drumMode` |
| 확대 | 가로/세로 확대·맞춰 보기(Z)·휠, 확대 시 1/64·셋잇단 격자 | `core/zoom.ts`, `core/musicalGrid.ts` |
| 표기 | MIDI 60 = C3, C-2…G8, ♯ | `core/pitch.ts` |
| 가져오기 | SMF Type 0/1 PPQ, 채널·트랙·포트 분리, velocity 0 Note-Off, 겹친 음, CC64(현재 음 길이에 반영), All Notes Off 등, 초기 템포·박자(빈 프로젝트만). 피치벤드·애프터터치·대부분의 CC·SysEx·템포 변경은 경고 후 무시 | `core/midiImport.ts`, `core/mediaImport.ts`, `docs/MIDI_IMPORT.md` |
| 내보내기 | `.mid` 내보내기 없음(`.garak` 번들·오디오 내보내기만) | `core/storage.ts` |
| MIDI 입력/녹음 | **없음.** `requestMIDIAccess`·네이티브 MIDI 입력 없음, 악기 트랙 녹음 시 알림 후 중단, 입력 모니터링 I는 악기 트랙에서 상태만 | `App.tsx:1176`, `LOGIC_GAP.md` H-19 |
| 오토메이션 | 트랙·리전 오토메이션 없음. 오디오 리전 게인/페이드 엔벨로프만 | `core/clipEnvelope.ts`, `IMPLEMENTATION_STATUS.md:467` |
| 엔진 이벤트 | 이음웨이브 네이티브 신스: `NoteOn/NoteOff/Parameter/PitchBend/Sustain/AllNotesOff/AllSoundOff`. VST3 호스트는 MIDI 이벤트 오프셋 지원 | `rust/garak-engine/src/wave/synth.rs`, `native/src/vst3.cpp` |
| 자동화 외부 | MCP: MIDI 리전 추가·이동·반복·뮤트·이조, 음표 쓰기 | `core/commands.ts`, `docs/MCP.md` |

---

## 3. 기능 비교표

열: 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선순위 | 노력

### 3.1 녹음·입력

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 외부 MIDI 키보드 입력 | 트랙 입력 장치/채널 선택, 모든 활성 입력 기본 | 트랙 inspector의 MIDI 입력·채널, 모든 입력 기본 | 없음 | 웹 `navigator.requestMIDIAccess` + 데스크톱 네이티브(WinMM/CoreMIDI) 입력 경로 전체 필요 | P0 | L |
| 실시간 연주(입력 모니터링) | Arm/In 모니터링 시 악기로 재생 | 녹음 활성/입력 모니터링 시 재생 | 없음(I는 상태만) | 입력→악기 저지연 경로(웹은 AudioContext 스케줄, 네이티브는 오디오 스레드 큐) | P0 | M |
| 컴퓨터 키보드 연주 | Computer MIDI Keyboard(M) | Musical Typing(⌘K), Keyboard 창 | 없음 | 키보드→노트 매핑, 옥타브/벨로시티 키. 하드웨어 없는 사용자용 | P0 | S |
| 서스테인 페달 입력 | CC64 녹음·재생 | CC64 녹음·재생, 이벤트로 표시 | 진행 중 [서스테인]: 데이터·재생·가져오기. 입력은 MIDI 입력 단계에서 연결 | 입력 경로가 생기면 CC64 기록만 추가 | P0 | S |
| 리전 녹음(아레인지) | 새 클립 생성, Arrangement Overdub(병합) | 새 리전, 겹치면 Merge / Take 폴더 / Replace 설정 | 없음 | 녹음 리전 생성, 표시용 임시 리전(오디오 녹음 `RecordingRegion` 재사용) | P0 | M |
| 사이클(루프) 녹음 | 세션 클립 오버더브 루프, 아레인지 루프 녹음 | Cycle 녹음: 병합 또는 테이크 폴더 | 없음 | 사이클마다 병합/테이크 결정 | P1 | M |
| 녹음 퀀타이즈 | Record Quantization | 리전 Quantize 파라미터(비파괴)로 대체 | 없음 | 녹음 후 리전 `quantize` 자동 설정으로 비파괴 처리 가능 | P1 | S |
| 회고 녹음 | Capture MIDI(녹음 안 눌렀어도 마지막 연주 복구) | Capture Recording / 11.2 이후 Flashback Capture | 없음 | 입력 링버퍼 보관 + 명령 하나 | P1 | S |
| 스텝 입력 | 정지 상태에서 키 누르고 방향키로 전진 | Step Input Keyboard, MIDI 스텝 입력 | 없음 | 입력 경로 위에 얹는 모드 | P2 | S |
| 펀치 인/아웃 | Punch 스위치 | Autopunch / Quick Punch-In | 없음(오디오도 없음) | 오디오와 공용 펀치 구간 | P2 | M |
| 카운트인 | 1~4마디 | 카운트인/프리롤 | 있음(오디오 녹음: 끔·1·2마디, 두 엔진, `METRONOME.md`) | MIDI 녹음 시작에도 같은 경로 연결. 카운트인 중 연주 음 처리(버림/첫 박에 포함) 결정 | P1 | S |
| 다중 트랙 동시 MIDI 녹음 | 여러 Arm 트랙 | 여러 녹음 활성 트랙(채널 분리) | 없음 | 녹음 대상 정책(`toggleRecord`) 확장 | P2 | M |
| 테이크 레인/콤프 | Take Lanes(12) | Take 폴더·Quick Swipe(MIDI는 테이크 선택) | 없음(오디오 멀티테이크는 `core/multiTake.ts`) | MIDI 테이크 저장 구조 | P2 | M |

### 3.2 음표 편집

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 그리기/생성 | Draw 모드(B), 음높이 고정 그리기 | 연필 도구, ⌘클릭 | 있음(빈 격자 생성, 마지막 길이 기억) | 드래그로 연속 그리기(페인트) 없음 | P2 | S |
| 선택 | 사각형, 시간 선택, 같은 음 선택 | 사각형, 같은 음/채널/범위 선택 메뉴 | 부분(사각형·Shift·방향키 확장) | "같은 음높이 선택", "이후 모두 선택", 키 클릭으로 음 전체 선택 | P1 | S |
| 이동·복사 | 드래그, Alt 복사, 방향키 | 드래그, ⌥ 복사, 넛지 | 있음 | — | — | — |
| 길이 | 양 끝 드래그, Fit to Time Range | 양 끝, Length 명령 | 있음(양 끝) | 지정 길이 일괄 설정 없음 | P1 | S |
| 레가토 | Legato(⌘L), Span 도구 | Note Force Legato / Overlap Correction | 없음 | 선택 음을 다음 음까지 연장 | P1 | S |
| 벨로시티 레인 | 하단 레인, 램프, Randomize | 벨로시티 도구·슬라이더·Velocity 레인(MIDI Draw) | 있음(레인·드래그·슬라이더·프리셋) | 램프(선 그리기)·랜덤화·음표 색=벨로시티 | P1 | S |
| 벨로시티 범위(재생마다 랜덤) | Velocity Deviation | 없음(MIDI FX Randomizer로 대체) | 없음 | `MidiNote.velocityDeviation` + 결정적 시드 재생 | P2 | M |
| Release(Off) 벨로시티 | 지원 | Event List·인스펙터에서 편집 | 없음 | 엔진·VST3 note-off velocity 전달 | P2 | S |
| 확률(Chance) | 음표별 0–100%, 확률 그룹(Play All/One) | 없음(Session Player·MIDI FX로 대체) | 없음 | `MidiNote.chance`, 결정적 랜덤(오프라인 렌더 재현성) | P2 | M |
| 음표 뮤트/비활성 | 0 키로 비활성 | 음표 뮤트(⌃M) | 없음 | `MidiNote.muted`, 재생 제외·회색 표시 | P1 | S |
| 분할/합치기(음표) | Split(E 드래그), Chop(⌘E), Join(⌘J) | 가위 도구, Glue 도구 | 없음(리전 단위만) | 피아노롤 범위에서 ⌘T/⌘J 재사용 | P1 | S |
| 스트레치 | Note Stretch 마커, ×2 / ÷2 | Time Handles, Region ×2 | 없음 | 선택 범위 비례 늘이기 | P1 | M |
| Reverse/Invert | 지원 | Transform 프리셋(Reverse Position, Pitch Inversion) | 없음 | 단순 순수 함수 | P2 | S |
| 음계 하이라이트 | 클립 스케일(Root·Scale), 키 행 하이라이트(K) | 프로젝트 조표 + Scale Quantize 메뉴 | 없음(피치 편집기만 음계 보정 있음) | 클립 또는 프로젝트 조성 + 행 배경 표시 | P1 | S |
| 폴드 | Fold(F) / Fold to Scale(G) | Collapse 모드(사용 음만) | 부분(드럼 모드는 이름 있는 행만) | 일반 악기 Fold/Fold to Scale | P1 | S |
| Scale Quantize | 음계 모드에서 이조가 음계 도수로 | Scale Quantize(조·음계 선택) | 없음 | 음계 데이터 + 가까운 음계 음으로 이동 | P1 | S |
| 이조 단위 | 반음/음계 도수 | 반음, 옥타브 | 있음(반음·옥타브) | 음계 도수 이조 | P2 | S |
| 다중 리전 동시 편집 | 최대 8 클립(Focus mode) | 여러 리전을 한 피아노롤에(Link) | 없음(선택 첫 리전만) | 리전 간 음표 좌표 변환, 색 구분 | P1 | M |
| 음표 라벨/색 | 음 이름·벨로시티 색 | 벨로시티 색/리전 색/채널 색 | 부분(트랙 색, 음 이름) | 벨로시티 색 모드 | P2 | S |
| 휴머나이즈 | Randomize(벨로시티), Time Warp·Chop variation | Humanize Transform 프리셋 | 없음 | 위치·벨로시티·길이 랜덤 폭 | P1 | S |
| 실행 취소 | 전체 | 전체 | 있음(50단계, 제스처 묶음) | — | — | — |

### 3.3 퀀타이즈·그루브

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 파괴적 퀀타이즈 | ⌘U, Quantize 설정(격자, 시작/끝, Amount %) | 피아노롤 Time Quantize(값·Strength·Swing), Q 버튼 | 부분(Q/Shift+Q, 100%, 현재 스냅) | 강도·스윙·끝 퀀타이즈 대화상자 | P0 | S |
| 비파괴 리전 퀀타이즈 | (그루브 풀로 대체) | Region Quantize(1/1…1/96, 셋잇단, 스윙 프리셋, 홀수) | 있음(1/1~1/64, 1/2T~1/16T) | 1/96·1/6 같은 값·8F/16E 스윙 프리셋 일부 없음 | P2 | S |
| 스윙 | Groove의 swing | Q-Swing 0–100% | 있음(0–100, 퀀타이즈 켜짐 시) | — | — | — |
| 퀀타이즈 강도 | Amount % | Q-Strength 0–100% | 없음 | `MidiClip.qStrength` + 파괴적 대화상자 | P0 | S |
| 범위 퀀타이즈 | — | Q-Range(± 틱, 음수 = 격자 가까운 것만/양수 = 먼 것만) | 없음 | 재생 변환에 조건 추가 | P1 | S |
| 플램 | Ornament(MIDI Tool) | Q-Flam(동시 음 펼치기) | 없음 | 재생 변환(코드 음 시차) | P2 | S |
| 퀀타이즈 벨로시티/길이 | Groove Velocity | Q-Velocity, Q-Length(그루브 템플릿 적용 비율) | 없음 | 그루브 템플릿과 함께 | P2 | M |
| 그루브 템플릿/풀 | Groove Pool(Base, Quantize, Timing, Random, Velocity, Global Amount), 클립에서 그루브 추출 | Groove Template 만들기(리전 → 퀀타이즈 메뉴) | 없음 | 그루브 데이터 + 리전 연결 + 재생 변환 | P1 | M |
| 스마트 퀀타이즈 | — | Smart Quantize(인간적 변화 보존) | 없음 | Q-Strength+Q-Range로 근사 | P2 | S |
| 오디오→MIDI 그루브 | 오디오에서 그루브 추출 | Flex 트랜지언트에서 그루브 | 없음 | 워프 분석 재사용 가능 | P2 | M |

### 3.4 리전(클립) 비파괴 파라미터

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 뮤트 | Clip Activator | Mute | 있음 | — | — | — |
| 루프 | Loop 스위치, Loop Position/Length (Start/End 분리) | Loop 파라미터 + 루프 도구로 끝점 | 있음(루프 + 수동 끝점) | 루프 시작 ≠ 클립 시작(Ableton 시작 마커) 없음 | P2 | M |
| 트랜스포즈 | Notes 패널 Transpose(파괴), 클립 Transpose | Transpose ±96 | 있음(±96) | — | — | — |
| 벨로시티 오프셋 | Velocity(파괴적) | Velocity ±99 | 있음(±99) | — | — | — |
| 다이내믹스 | — | Dynamics(벨로시티 압축/확장: 3:1…1:3, Fixed) | 없음 | `playbackNotes`에 64 기준 비율 | P1 | S |
| 게이트 타임 | — | Gate Time(길이 %, Fixed, Legato) | 없음 | 재생 길이 배율 | P1 | S |
| 딜레이 | Track Delay | Delay(틱/ms) | 있음(틱 ±1920, ms 병기) | — | — | — |
| 클립 길이 | — | Clip Length(리전 끝에서 음 자르기) | 부분(표시만, 트림이 끝에서 자름) | 끝에서 음을 자를지 여부 옵션 | P2 | S |
| 게인 | Clip Volume(오디오), MIDI는 없음 | — | 있음(MIDI 게인 = 벨로시티 배율) | — | — | — |
| 그루브 연결 | 클립 Groove 선택 | Quantize에서 그루브 템플릿 | 없음 | 3.3 그루브 참조 | P1 | M |
| 클립 스케일 | Root+Scale | 프로젝트 조표, 리전 코드(11) | 없음 | 3.7 참조 | P1 | S |
| 프로그램 체인지 | Clip Bank/Sub/Program | 리전 시작 Program 이벤트 | 없음 | VST3 Program Change | P2 | S |
| 굳히기(Normalize) | Consolidate·Commit groove | Normalize Region Parameters | 부분(합치기만 보이는 음 새 소스) | 리전 파라미터를 음표에 굽기 명령 | P1 | S |

### 3.5 CC·피치벤드·애프터터치·MPE·오토메이션

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| CC 데이터(리전 내) | 클립 엔벨로프 MIDI Ctrl(CC·PB·Channel Pressure) | MIDI Draw(Region-based automation), Event List | 없음(CC64만 진행 중 [서스테인]) | `MidiClip.controllers[]`(번호별 점 목록) 데이터 모델, 저장 스키마, 두 엔진 전달 | P0 | L |
| 서스테인(CC64) | 엔벨로프·녹음 | 이벤트·MIDI Draw | 진행 중 [서스테인] | 서스테인 데이터가 일반 CC 모델의 첫 사례가 되도록 정렬 | P0 | — |
| 피치벤드 | 클립 엔벨로프(±8192), MPE 음별 | MIDI Draw·Event List | 없음(이음웨이브 네이티브 신스는 `PitchBend` 이벤트 지원) | 데이터·레인·웹 엔진 샘플 악기 처리(재생률) | P0 | M |
| 채널/폴리 애프터터치 | Pressure 엔벨로프, MPE Pressure | Channel/Poly Pressure | 없음 | 일반 CC 모델에 포함, 악기 매핑 | P1 | M |
| 컨트롤러 레인 UI | 피아노롤 아래 엔벨로프 레인(여러 개) | Automation/MIDI Draw 레인 펼침 | 부분(벨로시티 레인만) | 레인 추가 메뉴(CC 번호 선택), 점 그리기·연필·직선·곡선 | P0 | M |
| 계단/곡선 보간 | 엔벨로프 점·곡선 | 점 + 곡선 | 없음 | CC는 계단, 피치벤드는 보간 | P1 | S |
| 리전 엔벨로프(장치 파라미터) | Clip Envelope로 장치 변조(Modulation 모드 포함) | Region-based automation(채널 스트립·플러그인 파라미터) | 없음 | 트랙 오토메이션과 공통 파라미터 주소 체계 필요 | P1 | L |
| 트랙 오토메이션 | Arrangement automation, Automation 모드 | Track automation, Read/Touch/Latch/Write | 없음 | 별도 대형 작업(ROADMAP) | P1 | L |
| 트랙↔리전 오토메이션 변환 | Clip ↔ Arrangement 복사 | Convert Track ↔ Region automation | 없음 | 위 두 개 후 | P2 | M |
| MPE | MPE 편집기(음별 Pitch/Slide/Pressure), MPE 녹음, Glissando·LFO 도구 | MPE 지원 악기·MIDI 입력 MPE 모드 | 없음 | 음별 표현 곡선 데이터 + VST3 Note Expression | P2 | L |
| 오토메이션 녹음 | 녹음 시 CC 기록 | Latch/Touch 기록 | 없음 | MIDI 입력 후 | P1 | M |
| 차트/연속값 감량 | — | Thin/Reduce events | 없음 | 녹음 CC 감량 | P2 | S |

### 3.6 변환·생성 도구

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 조건+연산 변환 창 | MIDI Tools(Transform 패널) | MIDI Transform 창(선택 조건·연산, 프리셋: Humanize, Fixed Velocity, Crescendo, Reverse, Half Speed, Quantize Note Length…) | 없음 | 선택 조건(음높이·벨로시티·위치 범위)+연산(고정/더함/곱/랜덤/스케일/반전) | P1 | M |
| Arpeggiate / Strum / Ornament / Chop | MIDI Tools | Arpeggiator MIDI FX, Transform | 없음 | 순수 함수 도구 묶음 | P2 | M |
| Span(레가토/테누토/스타카토) | MIDI Tool | Gate Time/Transform | 없음 | 레가토(3.2)·게이트(3.4)로 일부 | P2 | S |
| Time Warp(가속/감속) | MIDI Tool | Transform(Crescendo류) | 없음 | 곡선 기반 위치 재매핑 | P2 | S |
| Velocity Shaper / Crescendo | MIDI Tool | Transform Crescendo | 없음 | 벨로시티 램프(3.2)로 일부 | P1 | S |
| Recombine(셔플·회전·미러) | MIDI Tool | — | 없음 | | P2 | S |
| Rhythm/Euclidean 생성 | 생성 도구 | Step Sequencer 패턴, Drummer | 없음 | 드럼 모드에서 유용 | P2 | S |
| Seed/Shape(랜덤·모양 생성) | 생성 도구 | — | 없음 | 결정적 시드 저장 | P2 | S |
| Stacks(코드/진행 생성) | 생성 도구(.stacks 뱅크) | Chord track + Session Players | 없음 | 3.7 코드와 연계 | P2 | M |
| 사용자 도구 | Max for Live 도구 | Scripter(JS MIDI FX) | 없음(작곡 언어 POC·MCP 음표 쓰기) | 작곡 코드(`COMPOSITION_LANGUAGE_POC.md`)·MCP를 도구 API로 노출 | P2 | M |

### 3.7 코드·음계·아르페지오·노트 리피트

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 음계 설정 | 클립 스케일 + 전역 스케일 연동 | 프로젝트 조표, Scale Quantize | 없음 | 프로젝트 조성 기본 + 리전 재정의. 국악 음계(평조·계면조 등) 프리셋은 차별화 요소 | P1 | S |
| 코드 트랙/Chord ID | — (Stacks) | Chord 글로벌 트랙, 리전 코드, MIDI/오디오에서 코드 분석, 코드 리듬 | 없음 | 글로벌 트랙 인프라(마커 트랙 있음) 재사용 | P2 | L |
| 세션 플레이어 | — | Drummer·Bass·Keyboard Session Players(코드 트랙 추종) | 없음(LOGIC_GAP 제외 범위) | 제외 유지 권장 | — | — |
| 아르페지에이터 | Arpeggiator MIDI 이펙트, Arpeggiate 도구 | Arpeggiator MIDI FX(실시간, 리전으로 굽기) | 없음 | 실시간 MIDI FX 체인 개념 필요(입력 경로 후) | P2 | M |
| 코드 트리거 | Chord MIDI 이펙트 | Chord Trigger MIDI FX | 없음 | MIDI FX 체인 | P2 | S |
| 노트 리피트 | Note Repeat(Push), Note Echo | Note Repeat(MIDI 입력·패드) | 없음 | 입력 경로 + 템포 동기 | P2 | S |
| Scale MIDI 이펙트 | Scale 이펙트 | Scale Quantize, Modifier | 없음 | 실시간 입력 음계 고정 | P2 | S |
| 아티큘레이션 ID | — | Articulation Set/ID(음표별, 키스위치 변환) | 없음 | 음표 속성 + 키스위치 매핑. 국악 주법(농현·전성 등) 표기에 응용 가능 | P2 | M |

### 3.8 보기(에디터)

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 피아노롤 | MIDI Note Editor | Piano Roll Editor | 있음 | — | — | — |
| 드럼 에디터 | Drum Rack 패드 행(폴드) | Drummer Editor / Step Sequencer / Piano Roll 컬랩스 | 있음(드럼 이름 행) | 패드별 기본 길이·스텝 입력 | P2 | S |
| 스텝 시퀀서 | Push 스텝 / Rhythm 도구 | Step Sequencer(Pattern 리전, 행별 파라미터 레인) | 없음 | Pattern 리전은 제외 범위, 피아노롤 스텝 보기 정도 | P2 | M |
| 악보 | — | Score Editor(조표, 성부, 인쇄) | 없음 | 정간보 보기는 가락이음 고유 차별화 후보 | P2 | L |
| 이벤트 리스트 | — | Event List(모든 이벤트 수치 편집) | 없음 | 표 형식, CC 모델 이후 | P1 | M |
| MIDI Transform 창 | (MIDI Tools) | 있음 | 없음 | 3.6 참조 | P1 | M |
| 타임라인 리전 미리보기 | 음표 미니어처 | 음표 미니어처, 확대 시 편집 | 있음(미니어처, 반복 블록) | 타임라인에서 직접 음표 편집(Logic 11 확대 편집) | P2 | M |
| 다른 리전 참조(고스트) | Focus mode에서 회색 표시 | 다른 트랙 리전 보기 | 없음 | 3.2 다중 편집과 함께 | P1 | S |
| 플로팅/분리 창 | 별도 창 | 별도 창·탭 | 부분(하단 편집 패널, 최대화) | 데스크톱 분리 창 | P2 | M |

### 3.9 루프·폴드·통합·분할·합치기

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| 리전 분할 | ⌘E(Split) | ⌘T 재생 위치, 가위 도구, 마커에서 | 있음(⌘T/⌘E, 비파괴 소스 오프셋) | 걸친 음 처리 옵션(Logic: 자르기/유지/짧게) | P1 | S |
| 리전 합치기 | Consolidate(⌘J) | Join(⌘J), Glue 도구 | 있음(보이는 음 새 소스) | — | — | — |
| 반복 | Duplicate(⌘D), Duplicate Loop | Repeat(⌘R), Loop | 있음 | Duplicate Loop(루프 길이 2배+내용 복제) | P2 | S |
| 비파괴 트림 | Start/End 마커 | 리전 경계 | 있음 | — | — | — |
| 루프 → 실제 리전 | — | Convert Loops to Regions | 없음 | 루프 회차를 실제 리전으로 | P1 | S |
| 리전 → 새 트랙 분리 | — | Separate MIDI events by Note Pitch / Channel | 없음 | 드럼 파트 분리에 유용 | P2 | S |
| 오디오로 바운스 | Freeze & Flatten, Bounce to audio(12) | Bounce in Place | 없음 | 오프라인 렌더 경로 재사용 | P1 | M |
| 오디오 → MIDI | Convert Harmony/Melody/Drums to MIDI | Flex Pitch → MIDI | 없음(피치 편집기 단선율 분석 있음) | 피치 편집기 분석 결과를 MIDI 리전으로 내보내기 — 비교적 쉬운 차별화 | P1 | M |
| 시간 선택 범위 편집 | 시간 선택 후 삭제/복제 | Marquee 도구 | 없음(IMPLEMENTATION_STATUS 후속 명시) | 리전 일부 범위 편집 | P1 | M |

### 3.10 가져오기·내보내기

| 기능 | Ableton Live 12 | Logic Pro 11 | 가락이음 현재 | 격차 | 우선 | 노력 |
| --- | --- | --- | --- | --- | --- | --- |
| .mid 가져오기 | 드래그로 클립 생성(CC·PB 엔벨로프 포함) | 템포·마커·CC·PB 포함 가져오기 | 부분(음표+CC64는 길이 반영, 나머지 경고) | CC·피치벤드 보존(2단계 데이터 모델 후), 서스테인은 진행 중 [서스테인] | P1 | M |
| 템포·박자 변경 가져오기 | 템포 오토메이션 | 템포 트랙 | 없음(초기값만) | 템포 맵(별도 기능) 의존 | P2 | L |
| .mid 리전 내보내기 | 클립 드래그/Export MIDI Clip | Export Selection as MIDI File | 없음 | SMF Type 1 writer(리전·트랙·프로젝트) | P0 | S |
| 리전 파라미터 굽기 내보내기 | 굽힌 결과 | Normalize 후 내보내기 | 없음 | `playbackNotes` 결과를 그대로 씀 | P0 | S |
| 클립보드/다른 앱 | 클립 드래그 | 리전 드래그 | 없음 | 데스크톱 드래그 아웃 | P2 | M |

---

## 4. 권장 구현 로드맵

공통 원칙(기존 구조 유지):

- 모든 비파괴 변환은 `core/playback.ts`의 순수 함수 한 곳에서 계산하고, 브라우저 `audio/graph.ts`와 데스크톱 `audio/native/timeline.ts`가 같은 결과를 받습니다. 새 리전 파라미터는 이 함수와 `graph.test.ts`·`timeline.test.ts` 동치 테스트를 함께 추가합니다.
- 데이터 모델 변경은 `types.ts` → `project.ts` `validateProject`(구버전 기본값) → 저장 스키마 버전 → `.garak` 왕복 테스트 → MCP 스키마(`core/commands.ts`, `docs/MCP.md`) 순서로 반영합니다.
- 서스테인 작업(`core/sustain.ts`)의 "리전 왼쪽 경계 chase, 리전 끝·루프 경계에서 해제" 규칙을 모든 컨트롤러 데이터의 공통 규칙으로 일반화합니다.

### 1단계 — MIDI 입력·녹음 (P0)

목표: MIDI 키보드나 컴퓨터 키보드로 연주하고 녹음해서 MIDI 리전을 만든다.

| 항목 | 수용 기준 | 영향 파일/시스템 |
| --- | --- | --- |
| MIDI 입력 서비스 | 웹: `navigator.requestMIDIAccess()`로 장치 목록·핫플러그·권한 거부 안내. 데스크톱: 네이티브 입력(Windows WinMM 또는 RtMidi, macOS CoreMIDI)에서 타임스탬프 있는 이벤트를 렌더러로 전달. 장치 미지원 브라우저(Safari)는 이유를 표시 | 신규 `src/audio/MidiInput.ts`(+test), `src/audio/native/contracts.ts`, `native/src/host.cpp`·`protocol.hpp`, `desktop/` IPC, `AudioSettingsDialog`/`NativeAudioSettingsDialog`에 MIDI 입력 장치 섹션 |
| 트랙 MIDI 입력 선택 | 악기 트랙 인스펙터에 `MIDI 입력: 모든 입력 / 장치 / 채널(전체·1–16)`. 저장·Undo. 기본 = 모든 입력 | `types.ts` Track(`midiInput?`), `TrackInspector.tsx`, `core/trackInputs.ts` |
| 실시간 연주 | 녹음 대기(R) 또는 I 켜짐, 혹은 포커스 악기 트랙(Logic 자동 활성)에서 입력이 악기로 소리남. 웹 지연: 입력→발음 목표 < 1 오디오 버퍼 + 10 ms. 네이티브: 다음 오디오 블록에 샘플 오프셋으로 주입. 트랙 이조/벨로시티/키 제한 적용 | `WebAudioEngine.ts`(`previewNote` 일반화: note-on/off 분리), `NativeAudioEngine.ts`, `native/src/engine.cpp` 라이브 이벤트 큐, 이음웨이브·VST3 |
| 컴퓨터 키보드 연주 | 토글 명령(Logic ⌘K), A~K 행 = 백건, W/E/T/Y/U = 흑건, Z/X 옥타브, C/V 벨로시티. 활성 중에는 해당 키의 앱 단축키를 가로채지 않도록 범위 분리. 화면 표시 | `core/input.ts`(새 명령·범위), 신규 `components/MusicalTyping.tsx`, `docs/SHORTCUTS.md` |
| MIDI 녹음 | 녹음 시 armed 악기 트랙(없으면 포커스 악기 트랙)에 임시 리전을 그리고 음표가 실시간으로 나타남. 정지 시 리전 확정, Undo 1단계(`MIDI 녹음`). 겹친 기존 리전: 설정 `병합(기본) / 새 리전` | `App.tsx` `toggleRecord`(1176행 알림 제거), `core/recording.ts`, `components/RecordingRegion.tsx` 재사용, `core/ProjectSession.ts` |
| 서스테인·CC 기록 | 녹음 중 CC64는 서스테인 이벤트로 저장 [서스테인]. 다른 CC/피치벤드는 2단계 모델 전까지 버리고 1회 안내 | `core/sustain.ts`, 녹음 버퍼 |
| 사이클 녹음 | 사이클 켠 채 녹음 시 매 회차 병합(기본). 옵션: 회차마다 새 리전(테이크) | `core/recording.ts`, 사이클 transport |
| 회고 캡처 | 정지/재생 중 입력을 최근 N분 링버퍼에 보관, 명령 `마지막 연주 캡처`(Logic ⇧R, Ableton Capture)로 리전 생성. 재생 중 연주면 박 위치 유지, 정지 중 연주면 템포 추정 없이 재생 커서부터 | 신규 `core/midiCapture.ts`, `core/input.ts` |
| 녹음 보정 | 녹음 후 리전 `quantize` 기본값 설정 옵션(비파괴), 수동 지연 ms(오디오 `recordingOffset` 재사용) | `core/recordingOffset.ts`, RegionInspector |
| 퀀타이즈 강화(동반) | 피아노롤 Q 옵션 팝오버: 격자·강도 0–100%·스윙·시작/끝 대상. Q는 마지막 설정 사용. 리전 인스펙터에 `Q-Strength`(기본 100) 추가, 재생 변환 반영 | `PianoRoll.tsx` `quantize()`, `RegionInspector.tsx`, `core/playback.ts` |
| 벨로시티 레인 보강(동반) | 레인 위 직선 드래그로 램프, 랜덤화(±폭), 음표 색 = 벨로시티 옵션 | `PianoRoll.tsx`, `PianoRoll.css` |
| 테스트 | 가짜 MIDIAccess로 장치 연결/해제, 녹음 시작·정지 경계, 병합, Undo, 캡처 링버퍼, 사이클 병합, 두 엔진 라이브 이벤트 순서. 실기기 수동 검증 항목은 `IMPLEMENTATION_STATUS.md`에 분리 기록 | `*.test.ts`, `native/tests` |

### 2단계 — 컨트롤러 데이터 + 레인 + MIDI 내보내기 (P0~P1)

목표: 음표 외 MIDI 표현(CC·피치벤드·애프터터치)을 녹음·편집·재생·가져오기/내보내기한다.

| 항목 | 수용 기준 | 영향 파일/시스템 |
| --- | --- | --- |
| 컨트롤러 데이터 모델 | `MidiClip.controllers?: { kind: 'cc'\|'pitchBend'\|'channelPressure'\|'polyPressure'\|'program'; number?: number; points: {beat, value, curve?}[] }[]`. 서스테인(`SustainEvent`)은 `cc 64`의 특수 표현으로 정렬하거나 마이그레이션 경로 문서화 [서스테인]. 소스 좌표(`sourceOffsetBeats` 기준)로 저장해 트림·분할·합치기·루프에서 음표와 같은 규칙 | `types.ts`, `project.ts`, `midiRegions.ts`, 저장 스키마, `core/sustain.ts` 일반화 |
| 재생 | 리전 시작에서 마지막 값 chase, 끝·루프 경계에서 기본값 복귀(CC는 마지막 값 유지 여부를 번호별 정책: 1/11/64는 리셋). 피치벤드는 보간(블록당 최소 1회), CC는 계단. 웹: 샘플 악기 피치벤드 = playbackRate, CC1/CC11/CC7 = 게인 매핑. 네이티브: 이음웨이브 `PitchBend`/`Parameter`, VST3 MIDI CC·Note Expression 전달 | `core/playback.ts`(컨트롤러 이벤트 스트림), `audio/graph.ts`, `audio/native/timeline.ts`, `native/src/engine.cpp`·`vst3.cpp` |
| 피아노롤 컨트롤러 레인 | VEL 옆에 `+ 레인`: CC 번호(이름: 모듈레이션, 익스프레션, 서스테인 …)·피치벤드·애프터터치. 여러 레인 동시 표시·높이 조절. 연필(자유 그리기 + 감량), 직선, 점 선택·이동·삭제, 복사/붙여넣기는 음표와 함께. 서스테인 레인은 서스테인 작업의 UI와 통일 [서스테인] | `PianoRoll.tsx`(레인 컴포넌트 분리 권장: 신규 `components/ControllerLane.tsx`), `PianoRoll.css` |
| 녹음 연동 | 1단계 녹음에서 CC/피치벤드/애프터터치 기록, 연속값 감량(동일값 제거·허용 오차) | `core/recording.ts`, 신규 `core/controllerThin.ts` |
| 가져오기 | `midiImport.ts`가 CC·피치벤드·채널 압력을 리전 컨트롤러로 보존. 경고 목록에서 해당 항목 제거. 지원하지 않는 SysEx만 안내 | `core/midiImport.ts`, `docs/MIDI_IMPORT.md` |
| 내보내기 | 선택 리전/트랙/프로젝트를 SMF Type 1(480 또는 960 PPQ)로. 옵션: `리전 파라미터 굽기`(퀀타이즈·이조·벨로시티·딜레이 적용 = `playbackNotes` 결과) 기본 켬. 트랙 이름·초기 템포·박자 포함. 가져오기→내보내기 왕복 테스트 | 신규 `core/midiExport.ts`(+test), `HeaderMenus.tsx` 파일 메뉴, 리전 컨텍스트 메뉴, MCP `midiFileIO` |
| 리전 파라미터 굽기 | `리전 파라미터 굽기`(Logic Normalize) 명령: 재생 결과를 음표에 쓰고 파라미터 초기화, Undo 1단계 | `core/project.ts`, 메뉴 |
| 수용 테스트 | 컨트롤러 chase/리셋, 트림·분할·합치기·루프 왕복, 두 엔진 동치, 저장 왕복, 가져오기/내보내기 바이트 수준 왕복 | `*.test.ts` |

### 3단계 — 편집 생산성 (P1)

| 항목 | 수용 기준 | 영향 파일/시스템 |
| --- | --- | --- |
| 음계 | 프로젝트 조성(으뜸음+음계) + 리전 재정의. 음계: 장·단(자연/화성/선율)·펜타토닉·블루스·도리안 등 + 국악(평조·계면조, 오음 기준) 프리셋. 피아노롤 행 하이라이트, 으뜸음 표시 | `types.ts`(Project `scale?`, MidiClip `scale?`), 신규 `core/scales.ts`(피치 편집기 음계 보정과 공용화), `PianoRoll.tsx` |
| 폴드 | `F` 사용 음만 / `Shift+F` 음계 음만(피아노롤 범위 단축키, 앱 `F` 충돌 확인) | `PianoRoll.tsx`, `core/input.ts` |
| Scale Quantize | 선택(없으면 전체)을 가장 가까운 음계 음으로(동률 = 아래/위 설정). 음계 도수 이조 옵션 | `PianoRoll.tsx`, `core/scales.ts` |
| 음표 뮤트·레가토·분할·합치기·길이 | `0` 또는 ⌃M 음표 뮤트(회색, 재생 제외), ⌘L 레가토, 피아노롤 범위 ⌘T(재생 커서/선택 중앙에서 분할)·⌘J(같은 음 이어 붙이기), 길이 일괄 설정. 모두 Undo 1단계 | `types.ts` `MidiNote.muted?`, `core/pianoEditing.ts`, `core/playback.ts`(뮤트 제외) |
| 스트레치·×2/÷2·Reverse | 선택 범위 비례 늘이기 핸들, ×2/÷2 버튼, 뒤집기 | `PianoRoll.tsx`, `core/pianoEditing.ts` |
| 리전 파라미터 확장 | 인스펙터 `더 보기`: Q-Range(±틱), Q-Flam(±틱), 다이내믹스(Fixed, 3:1…1:3), 게이트 타임(Fixed, 25–200%, Legato). 재생 변환 순서 문서화 후 두 엔진 동치 테스트 | `RegionInspector.tsx`, `core/playback.ts`, `LOGIC_GAP.md` 2.2 표 |
| 그루브 | 리전/선택에서 그루브 추출(격자 대비 시작·벨로시티 편차), 그루브 목록(프로젝트 내 저장), 리전 `groove`+양(타이밍/벨로시티/랜덤) 적용은 재생 변환, `굽기`로 확정 | 신규 `core/groove.ts`, `types.ts` Project `grooves?`, RegionInspector, Browser 탭(선택) |
| 휴머나이즈·Transform 창(기본) | 대화상자: 선택 조건(음높이/벨로시티/위치 범위) + 연산(고정·더함·곱·랜덤·램프) + 프리셋(휴머나이즈, 고정 벨로시티, 크레센도, 절반 속도, 두 배 속도, 길이 퀀타이즈) | 신규 `components/MidiTransformDialog.tsx`, 신규 `core/midiTransform.ts` |
| 다중 리전 편집·고스트 | 여러 MIDI 리전 선택 시 한 피아노롤에 표시(리전 색 구분, 편집 대상 전환), 같은 트랙의 다른 리전은 회색 고스트 | `PianoRoll.tsx`(좌표: 리전 시작 기준 → 프로젝트 박), `App.tsx` PianoRollBridge |
| 선택 보강 | 건반 클릭으로 그 음 전체 선택, `같은 음높이 선택`, `이후 모두 선택` | `PianoRoll.tsx` |
| 루프→리전, 분할 시 걸친 음 옵션 | `루프를 리전으로 변환`, 분할 시 걸친 음 처리(유지/자르기) 설정 | `core/project.ts`, `core/input.ts` |
| 오디오→MIDI(차별화) | 피치 편집기 단선율 분석 음표를 MIDI 리전으로 내보내기 | `devices/pitch-editor/`, `core/project.ts` |

### 4단계 — 생성·고급 (P2)

| 항목 | 수용 기준 | 영향 파일/시스템 |
| --- | --- | --- |
| 확률·벨로시티 범위 | 음표별 Chance 0–100%, 벨로시티 편차. 재생은 프로젝트 시드 + 회차 번호로 결정적(오프라인 렌더·두 엔진 동일 결과). 확률 그룹(하나만 연주) | `types.ts`, `core/playback.ts`, `PianoRoll.tsx` 레인 |
| MIDI 도구 묶음 | Arpeggiate, Strum, Ornament(플램/꾸밈음 — 국악 꾸밈음 `시김새` 연계), Chop, Recombine, Time Warp, Rhythm/Euclidean, Seed, Stacks(코드). 선택 → 시간 선택 → 리전 루프 순 적용 범위(Ableton 규칙). 작곡 언어·MCP에서도 같은 도구 호출 | 신규 `core/midiTools/*`, `components/MidiToolsPanel.tsx`, `core/commands.ts` |
| 실시간 MIDI FX 체인 | 트랙 장치 체인 앞단 MIDI FX: 아르페지에이터, 코드 트리거, Scale, Note Repeat, 랜덤. 녹음 시 입력 기록/결과 기록 선택, `리전으로 굽기` | `types.ts` Track `midiEffects?`, `DeviceChain.tsx`, 두 엔진 스케줄러(웹 lookahead, 네이티브 C++ 이벤트 처리) |
| 코드 트랙 | 글로벌 코드 트랙(마커 트랙 인프라 재사용), MIDI 리전 코드 분석, 코드에 맞춘 Scale Quantize | `Timeline.tsx` 글로벌 트랙, 신규 `core/chords.ts` |
| 보기 | 이벤트 리스트(표, 컨트롤러 포함), 스텝 보기(드럼 모드 격자 토글), 정간보/악보 보기(조사 후) | 신규 `components/EventList.tsx` 등 |
| MPE·아티큘레이션 | 음별 피치/슬라이드/압력 곡선, MPE 입력 모드, VST3 Note Expression. 음표별 아티큘레이션 ID + 키스위치 맵 | `types.ts`, 두 엔진, `native/src/vst3.cpp` |
| 트랙/리전 오토메이션 | 장치·믹서 파라미터 오토메이션 레인과 리전 엔벨로프, 상호 변환 — 별도 설계 문서 필요(ROADMAP 항목) | 광범위 |

---

## 5. 출처

Ableton Live 12 Reference Manual

- Editing MIDI(Draw 모드, Chance·확률 그룹, Velocity Deviation·Ramp·Randomize·Note-Off velocity, Fold/Fold to Scale/Highlight Scale, Stretch, Legato, Split/Chop/Join, 비활성 음표, Quantize Amount, Multi-Clip Editing): https://www.ableton.com/en/live-manual/12/editing-midi/
- MIDI Tools(Transform: Arpeggiate, Chop, Connect, Glissando, LFO, Ornament, Quantize, Recombine, Span, Strum, Time Warp, Velocity Shaper / Generate: Rhythm, Seed, Shape, Stacks, Euclidean, 적용 범위 규칙, 스케일 인식): https://www.ableton.com/en/live-manual/12/midi-tools/
- Clip View(Scale 모드, Loop/Start/End, Groove 선택·Commit, Transpose·Stretch·×2/÷2·Reverse·Invert·Legato·Duplicate Loop, 엔벨로프, MPE 편집기): https://www.ableton.com/en/live-manual/12/clip-view/
- Recording New Clips(Arrangement Overdub, 세션 오버더브, Record Quantization, Step Recording, Capture MIDI, Punch, Count-in, 컴퓨터 MIDI 키보드): https://www.ableton.com/en/live-manual/12/recording-new-clips/
- Using Grooves(Groove Pool: Base·Quantize·Timing·Random·Velocity·Global Amount, 그루브 추출): https://www.ableton.com/en/live-manual/12/using-grooves/
- Automation and Editing Envelopes(클립 엔벨로프, MIDI Ctrl 엔벨로프): https://www.ableton.com/en/live-manual/12/automation-and-editing-envelopes/
- Editing MPE: https://www.ableton.com/en/live-manual/12/editing-mpe/
- Arrangement View(Consolidate, Take Lanes, Bounce): https://www.ableton.com/en/live-manual/12/arrangement-view/
- Live MIDI Effect Reference(Arpeggiator, Chord, Note Echo, Scale, Random): https://www.ableton.com/en/live-manual/12/live-midi-effect-reference/

Logic Pro User Guide for Mac (Apple 지원 페이지는 스크립트로 본문을 렌더링해 자동 수집으로 본문 확인이 불가했던 페이지가 있습니다. 해당 항목은 Apple 가이드 목차·iPad 가이드·이전 판 도움말로 교차 확인했습니다.)

- 가이드 목차: https://support.apple.com/guide/logicpro/welcome/mac
- Use the Region inspector: https://support.apple.com/guide/logicpro/use-the-region-inspector-lgcpd8a8780c/mac
- MIDI region parameters(Quantize, Q-Swing, Transpose, Velocity, Dynamics, Gate Time, Clip Length, Delay, Score): https://support.apple.com/guide/logicpro/midi-region-parameters-lgcpf7c0d270/mac
- MIDI quantization types / Quantize parameter values / Advanced quantization parameters(Q-Strength, Q-Range, Q-Flam, Q-Velocity, Q-Length): https://support.apple.com/guide/logicpro/midi-quantization-types-lgcpbc6a2df2/mac · https://support.apple.com/guide/logicpro/quantize-parameter-values-lgcp47452db8/mac · https://support.apple.com/guide/logicpro/advanced-quantization-parameters-lgcp35029a2b/mac
- Piano Roll Time Quantize(Strength·Swing, 비파괴) / Scale Quantize: https://help.apple.com/logicpro/mac/10.1/en.lproj/lgcpfa6e7f80.html · https://help.apple.com/logicpro/mac/10.1/en.lproj/lgcpf4f544d2.html · iPad: https://support.apple.com/guide/logicpro-ipad/lpip97b92520/ipados
- Step Sequencer basics: https://support.apple.com/en-kg/guide/logicpro/step-sequencer-basics-lgsifdc00b89/10.7.3/mac
- Event List / Step Editor 개요: https://help.apple.com/logicpro/mac/10.1/en.lproj/lgcp2158ea5b.html · https://support.apple.com/en-kz/guide/logicpro/step-editor-overview-lgcp2158a6db/10.7.3/mac/11.0
- MIDI Transform window examples: https://support.apple.com/en-asia/guide/logicpro/midi-transform-window-examples-lgcp2159199c/10.7/mac
- Chord track·Session Players(코드 추종, 리전 코드, 코드 분석): https://support.apple.com/en-kw/guide/logicpro/chord-grid-selector-lgcp1e933806/12.0/mac/15.6 · https://support.apple.com/guide/logicpro-ipad/lpip4222465c/ipados
- MIDI 녹음 병합/테이크(Merge·Create Take Folder) 및 Capture Recording(11.2에서 Flashback Capture): https://support.apple.com/ro-md/guide/logicpro-ipad/lpip6f5c643d/1.0/ipados/16.0 · https://support.apple.com/guide/logicpro-ipad/lpip32b4ef1d/ipados · https://www.soundonsound.com/techniques/logic-pro-flashback-capture
- 그 밖의 Logic 항목(Articulation Set, Note Repeat, Smart Controls, MIDI Draw/Region-based vs Track-based automation, Arpeggiator, Musical Typing, Retrospective record)은 위 가이드 목차의 해당 장에서 확인할 수 있습니다. 이번 조사에서는 본문 자동 수집이 되지 않아 일반적으로 알려진 동작으로 표를 채웠으므로, 구현 착수 전 해당 페이지를 직접 대조하기를 권합니다.

내부 문서: `docs/LOGIC_GAP.md`(I-04 MIDI 리전 필드, 2.2 Clip 필드, 녹음 대상 규칙), `docs/IMPLEMENTATION_STATUS.md`, `docs/MIDI_IMPORT.md`, `docs/SHORTCUTS.md`, `docs/ROADMAP.md`.
