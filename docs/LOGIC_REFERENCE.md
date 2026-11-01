# 로직 프로 트랙 UI 참조 (12.3 기준)

가락이음의 트랙 영역과 인스펙터는 이 문서를 기준으로 로직 프로와 같은 동작을 목표로 합니다. 출처는 Apple 로직 프로 사용 설명서(2026-10-31 확인, 버전 12.3). `⚠️`는 Apple 문서에서 확인하지 못한 항목, `fig.`는 Apple 스크린샷으로만 확인한 항목입니다. 링크는 문서 끝에 있습니다.

리전 선택·이동·트림·반복·부분 편집은 [리전 편집 사용성 벤치마크](REGION_EDITING_BENCHMARK.md)를 함께 적용합니다. 공식 동작, 제품 설계, 현재 코드의 차이와 실제 Logic에서 더 확인할 항목을 구분하고 22개 비교 시나리오를 제공합니다.

로직 12에서 바뀐 것: "모든 기능 활성화" 설정이 사라져 켬/끔·가리기·트랙 번호·색상 막대가 항상 사용 가능합니다. Drummer는 Session Player 트랙 유형 아래로 들어갔습니다.

## 1. 트랙 헤더

### 1a. 배치 (왼쪽 → 오른쪽, fig.)

```
[제어판 막대?][그루브][색상 막대][번호][▸스택][아이콘] 이름 | 대체 ⌃⌄        [볼륨 슬라이더+미터] (팬)
                                                     [H][M][S] [R][I] [❄?][🔒?][⏻?]
(오토메이션 표시 시)                                  ▸ [Read ⌄][Volume ⌄][+0.0 dB]
```

- 이름이 윗줄, 버튼 줄이 그 아래, 볼륨 슬라이더와 팬 노브는 오른쪽.
- H는 M/S 왼쪽.
- ⚠️ 켬/끔·프리즈·보호 버튼의 위치는 미확인.

### 1b. 헤더 요소

| 요소 | 역할 | 기본 | 마우스 | 키 | 출처 |
|---|---|---|---|---|---|
| 트랙 번호 | 자동 번호. 다중 선택 시 포커스 트랙만 밝은 회색 | 표시 | 다중 선택 중 번호 클릭 = 선택 유지한 채 포커스 이동 | — | SEL, TH |
| 색상 막대 | 헤더 왼쪽 가장자리 색 띠 | 꺼짐 ⚠️ | — | ⌥C 색상 팔레트 | COL |
| 스택 펼침 ▸ | 스택 메인 트랙에만 | 저장됨 | 클릭 펼침/접기, ⌥클릭 모든 스택 | ⌃⌘→ / ⌃⌘← | STK |
| 아이콘 | 패치 아이콘 | 표시 | 더블클릭 → 라이브러리(패치 없을 때) 또는 Smart Controls, 우클릭 → 아이콘 메뉴 | — | ICON |
| 이름 | 트랙 이름 | — | 더블클릭 인라인 편집. Tab 다음 트랙 ⚠️ | ⇧Return | REN |
| 대체 트랙 ⌃⌄ | 트랙 대체본 메뉴 | 꺼짐 | — | ⌃⌥⌘N 등 | ALT |
| **M** 뮤트 | 채널 뮤트, 파랑 | 표시 | 클릭 토글. 드래그로 연속 전환. ⌥클릭 = 이 트랙만 뮤트(나머지 해제). ⌘클릭 = 같은 상태인 버튼 전부 반전 | **M** | MUTE, PS-TA |
| **S** 솔로 | 노랑. 솔로 안 된 트랙의 M이 파랗게 깜빡임. 첫 솔로 때 헤더 위에 **Clear/Recall Solo** 버튼 등장 | 표시 | 클릭·드래그·⌥클릭 배타 솔로·⌘클릭 전체·⌃클릭 Solo Safe(빨간 사선) | **S**, ⌥S 솔로 해제/복구 | SOLO |
| **R** 녹음 활성 | 회색(끔)·빨강 깜빡임(대기)·빨강(녹음 중)·회색+빨간 R(포커스 트랙) | 표시. 입력이 No Input인 오디오 트랙은 숨김 | 클릭. ⌥클릭 = 이 트랙만. 깜빡이는 버튼 ⌥클릭 = 전부 해제 | ⌃R | REC |
| 자동 녹음 활성 | 소프트웨어 악기 트랙은 포커스 트랙을 자동으로 활성 | 포커스 트랙 | — | — | RECSET |
| **I** 입력 모니터링 | 녹음 대기 없이 입력 듣기 | 오디오·악기 트랙에 표시 | 클릭 | ⌃I | IM |
| 볼륨 슬라이더 | 출력 레벨 미터 내장 | 표시 | 좌우 드래그. **⌥클릭 = 0 dB**. ⇧드래그 = 그룹 무시 | — | VOL |
| 팬/밸런스 노브 | 모노는 팬, 스테레오는 밸런스 | 표시 | 드래그. **⌥클릭 = 중앙**. ⌃클릭 → 센드 선택 | — | PAN |
| **H** 가리기 | Hide View가 초록일 때만 표시 | 숨김 | 클릭 토글 | ⌃H 선택 트랙 가리기, **H** 가리기 보기 토글, ⌃⇧H 전부 해제 | HIDE |
| ⏻ 켬/끔 | 끄면 플러그인 언로드. 리전과 이름이 회색 | 숨김 | 클릭. ⌥클릭 = 플러그인 유지. ⌘클릭 = 전체 | ⌥M | OFF |
| 🔒 보호 | 초록. 녹음·편집 차단 | 숨김 | 클릭. ⌘클릭 전체 | — | PROT |
| ❄ 프리즈 | 트랙을 파일로 바운스. Source Only=초록, Pre Fader=파랑. 재생 시 실행 | 숨김 | 클릭 | — | FRZ |
| 오토메이션 줄 (A 켬) | 트랙/리전 버튼 · 파라미터 팝업 · 모드 팝업 · 값 · ▸ 추가 레인 | 꺼짐 | ▸ 레인 표시, ⌥클릭 ▸ 데이터 있는 레인 모두 | A | AUTO |
| 오토메이션 모드 색 | Off 회색 · Read 초록 · Touch 겨자 · Latch 주황 · Write 보라 | Read ⚠️ | 다중 선택 중 하나 바꾸면 전부 적용 | — | AMODE |

### 1c. 헤더 영역 동작

| 동작 | 설명 | 마우스 | 키 | 출처 |
|---|---|---|---|---|
| 헤더 배경 클릭 | 트랙 **과 그 리전 전부** 선택(사이클 켜져 있으면 사이클 안쪽만). 첫 선택 트랙이 포커스 | ⇧클릭 연속 범위, ⌘클릭 추가/제거, **⌥클릭 = 리전 선택은 그대로 두고 트랙만**, ⇧더블클릭 배경 = 그 위치부터 재생 | ↑/↓ 이전/다음, ⇧↑/⇧↓ 확장 | SEL, EDSET |
| 순서 변경 | 헤더 빈 곳을 누르고 드래그. 스택 서브트랙 사이에 놓으면 스택에 들어감 | 드래그 | Track > Sort Tracks By | ORD |
| 트랙 높이(개별) | 헤더 **왼쪽 아래 모서리**에서 포인터가 ↕. 도움말 태그 "Individual track zoom: N" | 드래그 = 이 트랙. **⌘드래그 = 전체**. ⇧드래그/⇧클릭 = 전체 초기화. ⌥스크롤 = 전체 비례 | ⌥⌘↓ 확대, ⌥⌘↑ 축소, ⌥⌘Z 토글, ⌥⌘⌫ 초기화, ⌃Z 포커스 트랙 줌 | ZOOM |
| 높이별 표시 | ⚠️ 미문서. 그림상 이름 → 버튼 줄 → 슬라이더 → 노브 순으로 늘어남 | — | — | VOL |
| 헤더 열 너비 | 헤더와 레인 사이 선 드래그 | — | — | TH |
| 헤더 아래 빈 곳 | 더블클릭 = 선택 트랙과 같은 유형의 새 트랙 | — | — | NEW |
| 우클릭 메뉴 (확인된 항목, 순서 ⚠️) | 트랙 이름 변경 / N개 트랙 이름 변경 · (트랙 유형들: 빈 곳 우클릭 → 아래에 새 트랙) · 트랙 재할당 ▸ · 설정을 복제한 새로운 트랙 · 설정 및 콘텐츠를 복제한 새로운 트랙 · 트랙 색상 지정 · 트랙 삭제 · 선택한 트랙 가리기 · 가리기 보기 토글 · 트랙 가리기 모두 해제 · 트랙 헤더 구성 요소 ▸ · 트랙 헤더 구성 · Track Stack 생성 · 스택 평탄화 · 오토메이션 통합 | — | ⌘⌫ 삭제, ⌥⌘⌫ 미사용 삭제 | 여러 출처 |

### 1d. 트랙 헤더 구성 (⌥T 또는 우클릭 > 트랙 헤더 구성)

| 구역 | 항목 | 기본 |
|---|---|---|
| 버튼 | 뮤트·솔로·녹음 활성·입력 모니터링·켬/끔·가리기·보호·프리즈 | **M, S, R, I 켬**, 나머지 끔 |
| 컨트롤 | 볼륨 체크, 팬 체크 + 팝업(팬/밸런스 또는 센드) | 켬 fig. ⚠️ |
| 추가 이름 열 | 팝업 | ⚠️ |
| 기타 보기 옵션 | 제어판 막대·트랙 번호·색상 막대·그루브 트랙·트랙 아이콘·대체 트랙 | 번호+아이콘 켬 fig. 나머지 끔 ⚠️ |

### 1e. 색상

- ⌥C 또는 우클릭 > 트랙 색상 지정 → 팔레트 96색(4줄 × 24). ⌘클릭 색 = 리전 제외 트랙만.
- 기본 색: 오디오 파랑, MIDI 초록, 패턴 보라, Session Player 금색 fig.
- 트랙 색은 믹서 스트립 색도 바꿈.
- 설정: Track Color Static(기본)/자동 24/자동 96, Region Color Individual/As Track Color.
- 기능 메뉴: 트랙 색상을 리전에 적용 ⌥⇧C, 리전 색상을 트랙에 적용 ⌥⇧⌘C.

## 2. 트랙 유형

| 유형 | 생성 | 헤더 차이 | 출처 |
|---|---|---|---|
| 오디오 | New Tracks > Audio, ⌥⌘A | 파란 파형 아이콘. M S R I. 입력 없음이면 R·I 숨김 | NEW, REC |
| 소프트웨어 악기 | New Tracks > MIDI(Software Instrument), ⌥⌘S | M S R I. 선택하면 자동 녹음 활성·모니터링 | NEW, IM |
| Session Player | ⌥⌘P. 8마디 리전 하나와 함께 생성 | 금색 리전 | NEW |
| 외부 MIDI | ⌥⌘X | 추가 이름 열에 "\| ChN" fig. M S R | NEW |
| 폴더 스택 | ⇧⌘D > Folder 또는 ⇧⌘F | 메인: ▸, M S, 볼륨(VCA처럼). 리전 없음, 접으면 서브트랙 개요 | STK |
| 서밍 스택 | ⇧⌘D > Summing 또는 ⇧⌘G | 메인 = Aux. ▸, 테두리 아이콘, M S, 볼륨. 패치 가능 | STK |
| Aux / 출력(마스터) | 믹서 > 옵션 > 선택 채널 스트립의 트랙 생성 ⌃T. 출력 트랙 ⇧⌘M | 리전 없음, 오토메이션용 | SIGF |

**글로벌 트랙**: 눈금자 아래. G 또는 헤더 오른쪽 위 버튼. 종류: Arrangement, Movie, Tempo, Chord, Marker, Signature, Beat Mapping. **기본 표시: Arrangement, Marker, Signature, Tempo**. 구분선 드래그로 영역 크기, 각 트랙 아랫선 드래그로 개별 높이, 헤더 드래그로 순서. 우클릭: 목록, 글로벌 트랙 구성, 단일 글로벌 트랙(⌥G).

## 3. 트랙 영역 크롬

| 요소 | 역할 | 기본 | 출처 |
|---|---|---|---|
| 메뉴 막대 (fig.) | ↑ · **편집 ⌄ · 기능 ⌄ · 보기 ⌄** · Live Loops/Tracks · **오토메이션(A)** · **Flex(F)** · **Catch Playhead** · 좌클릭 툴 ⌄ · ⌘클릭 툴 ⌄ · **Snap:** · **Drag:** · 파형 줌 · 세로 줌 슬라이더 · 가로 줌 슬라이더 | — | TAI |
| Snap 팝업 | 그리드에 스냅(⌘G + 켬/끔 버튼) · Smart · Bar · Beat · Division · Ticks · Frames · Quarter Frames · Samples · 절대/상대 · Zero Crossings · 오토메이션 스냅 ▸ · 정렬 가이드(⌥⌘G) | **Smart, 절대** | SNAP |
| Drag 팝업 | 겹침 · 겹치지 않음 · 크로스 페이드 · 셔플 R · 셔플 L | ⚠️ 그림 불일치(겹치지 않음 / 겹침) | DRAG |
| Catch | 재생 위치 따라가기. 설정: 재생 시작 시 catch, 재생 위치 이동 시 catch, 위치별 콘텐츠 catch. **보기 > 재생 중 스크롤** + Catch = 재생 위치 고정하고 배경 스크롤. Catch만 = 페이지 넘김 | ⚠️ | CATCH |
| 눈금자 / 사이클 | **윗부분 클릭 = 사이클 토글**. 윗부분 드래그 = 노란 사이클 생성(켜짐). 가운데 드래그(손 포인터) = 이동. 가장자리 드래그 = 크기. ⇧클릭 확장. ⌘드래그 = Skip Cycle. ⌥⌘클릭 = 오토펀치. 재생 위치 삼각형 드래그·스크럽. ⇧클릭 레인 = 재생 위치 이동 | 사이클 꺼짐 | CYC, RULER |
| 스크롤 / 줌 | 아래 가로 스크롤바, 필요 시 오른쪽 세로. 줌은 포인터 중심(재생 위치 근처면 재생 위치). "스크롤 중 트랙/마디 번호 표시" 옵션 | — | SCRL |
| 헤더 위 줄 | **+ 트랙 추가** · **트랙 복제** · **H** 가리기 보기(첫 가리기 후 등장. 주황=가린 트랙 있음, 초록=가린 트랙 표시 중) · **S** Clear/Recall Solo(첫 솔로 후) · 글로벌 트랙(오른쪽) | +와 복제만 | HIDE, SOLO |
| + 트랙 추가 | New Tracks 창. ⌥클릭 = 포커스 트랙과 같은 유형·기본 패치. ⌥⇧ = 같은 유형·빈 스트립. ⌘ = 다른 유형 | — | NEW |
| 트랙 복제 | 클릭 = 설정 복제(⌘D). ⌥클릭 = 콘텐츠 포함(⌥⇧⌘D). ⇧클릭 = 같은 채널 스트립(⌃⇧Return). 녹음 활성·모니터링 상태가 새 트랙으로 이동 | — | DUP |
| New Tracks 창 | **MIDI**(Software Instrument/External MIDI) · **Pattern** · **Session Player** · **Audio**(Mic or Line/Guitar or Bass). 세부 ▸: 악기 · 오디오 입력 + 오름차순 · 오디오 출력 + 오름차순 · 기본 패치 로드 · **라이브러리 열기** · 에디터 열기 · 입력 모니터링 · 녹음 활성 · **생성할 트랙 수**(1) · 생성/취소 | — | NEW |

## 4. 인스펙터 (I)

- 메인 창의 **가장 왼쪽 열**(라이브러리가 열리면 그 오른쪽). 너비 조절 여부 ⚠️.
- 위에서부터: 리전 인스펙터 → 트랙 인스펙터 → 채널 스트립 2개(선택 트랙 + 그 출력).

| 부분 | 필드 | 비고 | 출처 |
|---|---|---|---|
| **리전 인스펙터** (펼침 "Region: 이름". 다중이면 "N selected", 없으면 "Default Settings") | **MIDI:** 뮤트 · 루프 · 퀀타이즈(라벨 클릭 = Classic/Smart) · Q-Swing · 트랜스포즈 · Pitch Source · 벨로시티 오프셋 · **More ▸** 딜레이 · 다이내믹스 · 게이트 타임 · 클립 길이 · 악보 · Q-Velocity · Q-Length · Q-Flam · Q-Range · Q-Strength | 선택 간 값이 다르면 `*` 표시, 편집은 상대값. ⌥⇧ 누르고 편집 = 전부 같은 값 | RINS, MRP |
| | **오디오:** 뮤트 · 루프 · 퀀타이즈 · Q-Swing · 트랜스포즈 · 파인 튠 · Pitch Source · **Flex** 체크 · **Smart Tempo** ⌄ · **File Tempo** · 게인 · **More ▸** 딜레이 · 페이드 인 + 커브 · 페이드 아웃 + 커브 · 리버스 · 스피드 · Q-Range · Q-Strength | | ARP |
| **트랙 인스펙터** ("Track: 이름") | **오디오:** 이름 · 아이콘 · 채널 · 프리즈 모드 · Q-Reference · Flex 모드. **악기:** 기본 리전 유형 · 채널 · MIDI 입력(All) · 내부 MIDI 입력(Off) · 녹음 · MIDI In/Out 채널 · 프리즈 모드 · 트랜스포즈 · 벨로시티 오프셋 · 키 제한(C-2–G8) · 벨로시티 제한(1–127) · 딜레이 · No Transpose · Hermode · No Reset · 악보 스타일 · 아티큘레이션 세트 | ⚠️ 12.3엔 색상 필드 없음 | TPAR |
| 채널 스트립 | 왼쪽 = 선택 트랙, 오른쪽 = 그 출력. ⇧클릭 Output/Send/VCA 슬롯으로 오른쪽 스트립 전환 | 스택 서브트랙 선택 시 오른쪽은 메인 트랙 | INSPI |

## 5. 트랙 위 리전 표시

| 항목 | 동작 | 출처 |
|---|---|---|
| 모양·이름 | 둥근 사각형. 이름은 왼쪽 위 띠. 트랜스포즈된 리전은 "(+12)" 접미사 fig. | REGO |
| 색 | 새 리전은 트랙 색. 개별 색은 Region Color 설정에 따름 | RCOL |
| 선택 | 밝게 강조 | RSEL |
| 뮤트 리전 | 리전과 이름 회색, 이름 앞에 작은 점 (⌃M) | RMUTE |
| 뮤트/솔로 제외 트랙 | 리전 회색, 이름은 색 유지 | MUTE |
| 꺼진 트랙 | 리전과 이름 모두 회색 | MUTE |
| 루프 | 오른쪽 위 가장자리 루프 포인터. 반복마다 노치. "Shaded loops" 설정. **L** = 끝까지 반복 | LOOP |
| 클릭 존 | 윗모서리 페이드 툴 존, 아래 절반 마키 툴 존 (설정, 기본 ⚠️) | EDSET |
| 페이드 | 파형이 보일 만큼 확대했을 때만 그림 | FADE |
| 게인 툴 | 노란 선 + dB. ⌥클릭 초기화 | GAIN |
| 겹침 | Drag 모드에 따름. 오디오는 나중 리전만 들림 | DRAG |
| MIDI 리전 더블클릭 | 설정의 에디터(기본 피아노롤 ⚠️) | EDSET |

## 6. 라이브러리 (Y)

- Y, 컨트롤 바 버튼, 보기 > 라이브러리 보기. 인스펙터 왼쪽.
- 패치 선택 = 포커스 트랙의 **악기·이펙트·Smart Controls·라우팅 전부 교체**. 다중 선택이면 포커스 트랙만.
- 구성: 아이콘+패치 이름, 보기 ⌄, 사운드 검색, 카테고리·패치 열, 더 많은 사운드 받기, 옵션 ⌄, 되돌리기, 삭제, 저장….
- 인스펙터 스트립의 플러그인 슬롯 왼쪽 클릭 = 라이브러리가 그 플러그인 프리셋으로 전환.

## 7. 믹서(X)와 헤더 비교

| 항목 | 위치 |
|---|---|
| 둘 다 (같은 것을 제어) | 뮤트 · 솔로(Solo Safe 포함) · 녹음 활성 · 입력 모니터링 · 볼륨 · 팬 · 아이콘 · 이름/색 · 오토메이션 모드. 스트립 선택 = 트랙 선택 |
| 믹서만 | 설정 · 게인 리덕션 · EQ · MIDI FX · 입력/악기 · 인서트 · 포맷 · 센드 · 출력 · **그룹** · **VCA** · 피크 · 바운스 · Dim |
| 헤더만 | 가리기 · 보호 · 프리즈 · 켬/끔 · 대체 트랙 · 번호 · 오토메이션 파라미터/레인 |

## 8. 한국어 메뉴 이름 (Apple ko-kr)

| 영어 | 한국어 |
|---|---|
| Track / Edit / Functions / View / Mix | 트랙 / 편집 / 기능 / 보기 / 믹스 |
| Configure Track Header | 트랙 헤더 구성 |
| Track Header Components | 트랙 헤더 구성 요소 |
| Hide Selected Tracks / Toggle Hide View / Unhide All Tracks | 선택한 트랙 가리기 / 보기 가리기 토글 / 트랙 가리기 모두 해제 |
| New Track with Duplicate Settings | 설정을 복제한 새로운 트랙 |
| New Track with Duplicate Settings and Content | 설정 및 콘텐츠를 복제한 새로운 트랙 |
| New Track With Same Instrument | 동일한 악기가 있는 새로운 트랙 |
| Create Track Stack / Flatten Stack | Track Stack 생성 / 스택 평탄화 |
| Show Global Tracks / Configure Global Tracks | 글로벌 트랙 보기 / 글로벌 트랙 구성 |
| Scroll in Play / Grid Lines / Zoom Focused Track / Show Inspector | 재생 중 스크롤 / 그리드 선 / 포커스된 트랙 확대/축소 / 인스펙터 보기 |
| Show Automation | 오토메이션 보기 |
| Drag modes | 겹침 / 겹치지 않음 / 크로스 페이드 / 셔플 R / 셔플 L |
| Header buttons | 음소거 · 솔로 · 녹음 가능 · 입력 모니터링 · 켬/끔 · 가리기 |
| Header config options | 트랙 번호 · 색상 막대 · 그루브 트랙 · 트랙 아이콘 · 대체 트랙 · 추가 이름 열 |

## 9. 가락이음에서 의도적으로 제외하는 것

Track Stack, 대체 트랙, 프리즈, 보호, 외부 MIDI, Session Player, Flex, 오토메이션(향후), 글로벌 트랙 중 Movie·Beat Mapping·Chord, VCA, 제어판 막대, 그루브 트랙. 이 항목들은 메뉴에 넣지 않습니다(비활성 항목으로도 보이지 않게).

2026-11-01 범위 동기화: 채널 공유 구조가 필요한 트랙 재할당·동일 악기 채널 공유 복제, Aux·출력 트랙 생성, Pattern 트랙, 센드·그룹, 오디오 리전 트랜스포즈·퀀타이즈·Smart Tempo·File Tempo, 추가 이름 열도 현재 구현 범위에서 제외합니다. 기존 Stereo Out 채널 스트립 표시는 유지합니다. 이는 가락이음의 구현 범위 결정이며 Logic Pro의 기능 부재를 뜻하지 않습니다.

## 출처

TH https://support.apple.com/guide/logicpro/track-header-overview-lgcpe53c68af/mac · MUTE …/mute-tracks-lgcp08bafdee/mac · SOLO …/solo-tracks-lgcp58240315/mac · VOL …/set-track-volume-levels-lgcp86b5c092/mac · PAN …/set-track-pan-positions-lgcpeea2e44c/mac · REC …/make-tracks-ready-for-recording-lgcp0c445ccf/mac · IM …/turn-on-input-monitoring-for-audio-tracks-lgcpbfbefa96/mac · ALT …/use-track-alternatives-lgcp002c4e63/mac · OFF …/turn-off-tracks-lgcpcaa7aaa5/mac · PROT …/protect-tracks-lgcpc20c80f9/mac · FRZ …/freeze-tracks-lgcpf1cbfd51/mac · HIDE …/hide-tracks-lgcpf27451ae/mac · TOV …/tracks-overview-lgcpd9638760/mac · NEW …/create-tracks-lgcpff5da064/mac · SEL …/select-tracks-lgcp66ed91bd/mac · DUP …/duplicate-tracks-lgcp9e2b7de4/mac · REN …/rename-tracks-lgcp591273b9/mac · ICON …/change-track-icons-lgcpe3db5f84/mac · COL …/change-track-colors-lgcp7a5a5423/mac · ORD …/reorder-tracks-lgcpc84d96bd/mac · ZOOM …/zoom-tracks-lgcpc79f5bcd/mac · DEL …/delete-tracks-lgcp82a7a786/mac · STK …/create-and-edit-track-stacks-lgcp5bafa811/mac · TAI …/tracks-area-interface-lgcpe9cc3f60/mac · INSPI …/inspector-interface-lgcpe9cc3b1d/mac · LIBI …/library-interface-lgcpe9cc40af/mac · SNAP …/snap-items-to-the-grid-lgcpf7c0f66a/mac · DRAG …/control-positioning-with-drag-modes-lgcpf7c0a2ec/mac · SCRL …/scroll-and-zoom-in-the-tracks-area-lgcpf7c0b924/mac · CATCH …/control-windows-using-catch-modes-lgcp5cbf1727/mac · CYC …/use-the-cycle-area-lgcp59e41e86/mac · RULER …/position-items-using-the-ruler-lgcpf7c0ec53/mac · TSET …/tracks-settings-lgcp8e0207b2/mac · TPAR …/edit-track-parameters-lgcpfe5986f5/mac · RINS …/use-the-region-inspector-lgcpd8a8780c/mac · ARP …/audio-region-parameters-lgcpf7c0af60/mac · MRP …/midi-region-parameters-lgcpf7c0d270/mac · REGO …/regions-overview-lgcpf7c0d0bb/mac · RMUTE …/mute-and-solo-regions-lgcp2217b80d/mac · LOOP …/loop-regions-lgcpf7c0e0db/mac · RCOL …/change-the-color-of-regions-lgcpf7c0db8c/mac · GTO …/global-tracks-overview-lgcp4994bead/mac · KC-MWT …/main-window-tracks-lgcpb99be9c5/mac · PS-TA …/tracks-area-lgcpea796663/mac · KC-G …/global-commands-lgcp02bf31b6/mac · AUTO …/show-automation-curves-lgcpb1a3f099/mac · AMODE …/choose-automation-modes-lgcpb1a6ab26/mac · EDSET …/editing-settings-lgcp35dc6d37/mac · RECSET …/recording-settings-lgcp411dd5c8/mac · FADE …/create-fades-on-audio-regions-lgcpf7c0ee6c/mac · GAIN …/change-gain-audio-regions-tracks-area-lgcp8e4c781d/mac · PATCH …/choose-a-patch-lgcp689ae6e8/mac · CSC …/channel-strip-controls-lgcpbc219210/mac · SIGF …/create-tracks-for-signal-flow-channel-strips-lgcp15757aa8/mac · NEW12 …/whats-new-in-logic-pro-lgcp4a62a494/mac
