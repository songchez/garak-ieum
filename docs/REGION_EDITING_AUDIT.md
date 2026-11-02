# 리전 편집 사용성 코드 감사

2026-11-01 · 기준 커밋: `c3203092dcc1217b45c7c5d2c9e75c08b1ba470e`

이 문서는 가락이음의 현재 코드를 읽어 리전 편집 동작과 검증 과제를 정리한 기록입니다.
이번 감사에서는 실제 Logic Pro 실행, 가락이음의 브라우저 제스처 재현, 청음 검증을 수행하지 않았습니다.
**코드에서 확인한 사실**, **브라우저에서 확인할 재현 후보**, **후속 구현의 완료 기준**을 구분합니다.
Apple 공식 동작과의 대조 및 설정별 예외는 [리전 편집 벤치마크](REGION_EDITING_BENCHMARK.md)를 기준으로 합니다.

## 판정과 범위

- **코드 확인:** 현재 함수와 데이터 흐름에서 직접 확인한 동작입니다.
- **재현 후보:** 코드상 가능성이 있으나 실제 포인터·키보드 입력으로 확인하지 않은 사용성 문제입니다.
- **추가 구현:** 필요한 상태나 처리 경로가 현재 리전 편집 흐름에 없습니다.
- **완료 기준:** 수정 후 통과해야 할 제품 동작이며, 이 문서 작성으로 완료된다는 뜻은 아닙니다.
- P1은 내용 보존·표시 정확성·일상 편집에 직접 영향을 주는 항목, P2는 정밀 조작과 피드백 보완입니다.
- 여기서 박스 선택은 리전 전체 선택을, Marquee는 시간 범위의 부분 편집을 뜻합니다.

## 이미 구현된 기본기

| 영역 | 코드에서 확인한 동작 | 근거 |
|---|---|---|
| 선택과 그룹 이동 | 선택된 리전을 드래그하면 그룹을 유지하고, 이동 후 선택 ID를 유지합니다. | [Timeline](../src/components/Timeline.tsx) `beginClipGesture`, [App](../src/App.tsx) `moveClips` |
| 드래그 구분 | 가로 또는 세로 4px 이상 움직여야 드래그로 시작합니다. | [input](../src/core/input.ts) `crossedDragThreshold` |
| 복사 | Option/Alt 상태를 이동 중과 놓는 시점에 읽고, 복사 후 새 리전을 선택합니다. | [Timeline](../src/components/Timeline.tsx) `beginClipGesture`, [App](../src/App.tsx) `selectNew` |
| 시간·트랙 이동 | 그룹의 상대 위치를 보존하고, 음수 시작점과 다른 종류 트랙으로의 이동을 제한합니다. | [Timeline](../src/components/Timeline.tsx) `beginClipGesture`의 `validRow` |
| 다중 트림 | 좌우 트림을 여러 리전에 적용하며, 왼쪽 트림은 배치로 한 번 확정합니다. | [project](../src/core/project.ts) `trimClipStarts`, [Timeline](../src/components/Timeline.tsx) `beginClipGesture` |
| 취소 | Escape, blur, 페이지 숨김, pointercancel, capture 상실에서 편집 draft를 폐기합니다. | [Timeline](../src/components/Timeline.tsx) `trackPointer` |
| 자동 스크롤 | 화면 가장자리에서 드래그할 때 스크롤을 이동시키며 좌표를 재계산합니다. | [Timeline](../src/components/Timeline.tsx) `edgeScroller` |
| 반복 표시 | 반복 배치와 부분 반복을 계산하고, 반복 블록에서도 원본 리전을 편집합니다. | [TimelineClip](../src/components/TimelineClip.tsx) `TimelineClip`, [regionDisplay](../src/core/regionDisplay.ts) `previewRegionTracks` |
| 키보드 소유권 | 제스처 도중 Undo·삭제·저장 명령이 draft와 경쟁하지 않도록 차단합니다. | [App](../src/App.tsx) 키보드 처리 `useEffect` |

아래 항목을 수정할 때 이 기본기를 회귀시키지 않아야 합니다. 구현되어 있다는 사실과 실기기 검증 통과는 구분합니다.

## 01. MIDI 왼쪽 트림 후 내용 복원 — P1

**판정: 코드 확인 / 추가 구현.** 왼쪽 트림은 새 시작점 앞의 음표를 삭제하고 경계를 가로지르는 음표를 짧게 만듭니다.
이후 왼쪽으로 다시 늘려도 제거된 음표와 잘린 길이는 복원되지 않습니다. 오른쪽 트림은 길이만 변경합니다.

- **근거:** [project](../src/core/project.ts) `trimClipStart`, `trimClipEnd`.
- **재현 조건:** 시작 부분에 짧은 음표와 긴 음표를 배치하고, 왼쪽을 1박 줄인 후 원래 위치로 늘립니다.
- **사용자 영향:** 경계 조절을 되돌리는 손동작만으로 원래 연주 내용을 다시 드러낼 수 없습니다.
- **완료 기준:** 원본 MIDI 내용과 표시·재생 창을 구분하고, 경계를 복원하면 원래 음표가 다시 드러나야 합니다.
- **추가 확인:** 경계 밖 음표의 재생, 지속음 처리, 분할·합치기·저장 형식과의 관계를 함께 정의해야 합니다.

[project 테스트](../src/core/project.test.ts)의 `trim, join and arrangement helpers`는 현재의 crop·삭제 동작을 기대합니다. 기존 통과를 비파괴 트림의 증거로 사용할 수 없습니다.

## 02. 오디오 트림과 파형 표시의 대응 — P1

**판정: 코드 확인 / 브라우저 재현 후보.** 리전 파형에는 `asset.peaks` 전체가 전달되며, `offsetSeconds`와 재생 길이는 전달되지 않습니다.
`Waveform`은 받은 peaks 전체를 현재 캔버스 폭에 맞춰 그리므로, 트림 후 표시가 실제 소스 구간과 어긋날 수 있습니다.

- **근거:** [TimelineClip](../src/components/TimelineClip.tsx) `contents`, [Waveform](../src/components/Waveform.tsx) `Waveform`의 `draw`, [project](../src/core/project.ts) `trimClipStart`.
- **재현 조건:** 앞 절반이 조용하고 뒤 절반에 타격음이 있는 파일의 시작·끝을 각각 트림합니다.
- **사용자 영향:** 눈으로 본 타격음 위치를 기준으로 자르거나 정렬해도 실제 들리는 시점이 다를 수 있습니다.
- **완료 기준:** 표시 창이 `offsetSeconds`부터 실제 리전 길이까지의 소스 구간과 일치해야 합니다.
- **추가 확인:** 다른 리전이 공유하는 원본 peaks는 보존하고, 부분 루프에서도 같은 배율과 창을 사용해야 합니다.

이 항목은 마지막 반복 블록의 폭을 잘라 표시한 기존 개선과 별개입니다. 원본 리전 자체의 파형 창을 검증합니다.

## 03. 루프 손잡이의 반복 끝 지정 — P1

**판정: 코드 확인 / 추가 구현.** 손잡이 클릭은 루프를 토글하고, 오른쪽 드래그는 꺼진 루프를 켜는 역할만 합니다.
이미 켜진 루프의 끝을 드래그로 줄이거나 늘리는 모델과 프리뷰는 없습니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `loopHandle`, [TimelineClip](../src/components/TimelineClip.tsx) `TimelineClip`, [types](../src/core/types.ts) `ClipBase`.
- **재현 조건:** 1마디 리전을 정확히 3.5마디까지만 반복하고, 그 끝을 다시 2마디로 줄입니다.
- **사용자 영향:** 손잡이를 원하는 지점까지 움직여도 반복 끝을 지정할 수 없습니다.
- **완료 기준:** 명시적 반복 끝, 부분 반복, 스냅, 프리뷰, 취소, 한 번의 Undo를 함께 구현해야 합니다.
- **추가 확인:** 원본 길이 변경, 다음 리전 이동, 프로젝트 끝 변경, 저장·재열기 시의 규칙이 필요합니다.

현재 다음 리전·프로젝트 끝까지 반복되는 토글 동작은 별도의 유효한 기능으로 기록합니다.

## 04. 박스 선택과 Marquee 시간 범위 편집 — P1

**판정: 코드 확인 / 추가 구현.** `beginMarquee`는 사각형과 겹친 리전 전체의 ID를 모으는 박스 선택입니다.
시간 범위의 시작·끝을 유지하거나, 리전 일부 범위만 이동·복사·삭제하는 상태는 없습니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `beginMarquee`, `beginClipGesture`.
- **재현 조건:** 긴 리전 내부의 중간 1박만 선택하여 복사하거나 삭제하려고 합니다.
- **사용자 영향:** 부분 편집을 위해 리전을 먼저 분할하는 추가 조작이 필요합니다.
- **완료 기준:** 박스 선택과 시간 범위 선택을 구분하고, 범위 선택에 적용되는 편집 명령을 명시해야 합니다.
- **추가 확인:** 리전 내부에서 드래그를 시작하는 방법, 보조 도구, 선택 범위의 재생과 키보드 포커스를 정의합니다.

코드의 변수명 `marquee`만으로 Logic Marquee 도구가 구현됐다고 판정하지 않습니다.

## 05. 선택 수정키와 반복 블록의 박스 선택 — P1

**판정: 코드 확인 / 공식 대조와 브라우저 재현 필요.** 리전 클릭은 Shift 또는 macOS Command·Windows Ctrl로 선택을 토글합니다.
Shift 박스 선택은 합집합 추가이며, Shift 빈 영역 클릭은 재생 위치를 이동합니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `isToggleClick`, `beginClipGesture`, `beginMarquee`.
- **재현 조건:** 다중 선택에서 일반 클릭·수정키 클릭·드래그를 구분하고, 반복 고스트만 사각형으로 둘러쌉니다.
- **사용자 영향:** 클릭과 드래그에서 선택이 유지되는 시점, 보조 도구와 수정키의 역할이 예상과 다를 수 있습니다.
- **완료 기준:** 클릭·추가·해제·그룹 드래그·빈 영역의 규칙을 공식 기준 및 제품의 플랫폼 매핑과 맞춰야 합니다.
- **추가 확인:** 박스 선택은 현재 원본 리전 범위만 검사하므로, 고스트만 포함하는 경우의 선택 정책을 정해야 합니다.

macOS Command 클릭의 보조 도구 역할은 [벤치마크](REGION_EDITING_BENCHMARK.md)와 함께 판단합니다.

## 06. 스냅·축 제한·수직 이동의 결합 — P1

**판정: 코드 확인 / 브라우저 재현 후보.** absolute는 잡은 edge를 grid에, relative는 이동량을 grid에 맞춥니다.
Ctrl은 현재 grid의 1/4, Ctrl+Shift는 해제이며, Shift 축 제한은 매 move마다 현재 가로·세로 이동량으로 재판정합니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `deltaFor`, `unitFor`, `beginClipGesture`; [input](../src/core/input.ts) `dragModifiers`; [trackUi](../src/core/trackUi.ts) `resolveSnap`.
- **재현 조건:** grid에서 조금 벗어난 리전을 absolute 상태에서 수직 이동하고, 드래그 중 이동 방향과 수정키를 바꿉니다.
- **사용자 영향:** 가로 이동이 거의 없어도 시작점이 grid로 이동하거나, 제한한 축이 중간에 바뀔 수 있습니다.
- **완료 기준:** 시간 위치 보존 조건, 축을 결정하는 시점, 임시 미세 이동 단위를 조작별로 명시해야 합니다.
- **추가 확인:** 다른 리전 edge·재생 위치·마커를 대상으로 한 스냅 후보 계산은 현재 경로에 없습니다.

기본 설정은 Smart·absolute·No Overlap입니다. Logic 기본값 일치는 설정별 공식 대조 후 별도로 판정합니다.

## 07. 이동 중 복사 수정키의 즉시 피드백 — P2

**판정: 코드 확인 / 브라우저 재현 후보.** Option/Alt는 pointer-move와 pointer-up에서 읽습니다.
키를 누르거나 놓는 이벤트만으로 복사 프리뷰를 다시 계산하는 경로는 없습니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `beginClipGesture`의 `compute`·`end`, 복사 `clip-ghost` 렌더.
- **재현 조건:** 리전을 드래그한 채 포인터를 멈추고 Option/Alt를 눌렀다가 놓습니다.
- **사용자 영향:** 놓을 때 적용되는 복사 여부와 현재 보이는 프리뷰가 잠시 달라질 수 있습니다.
- **완료 기준:** 수정키를 바꾸면 포인터가 정지한 상태에서도 커서와 프리뷰가 최종 동작을 알려야 합니다.
- **추가 확인:** 복사 해제, Escape 취소, 복사 후 새 리전 선택, 원본 유지, 한 번의 Undo를 함께 확인합니다.

드래그 중 수정키 변경 자체와 pointer-up 최종 상태 반영은 이미 구현돼 있습니다.

## 08. 짧은 리전의 hit zone과 페이드 편집 — P1

**판정: 코드 확인 / 브라우저 재현 후보.** 리전 최소 표시 폭은 3px이며 좌우 트림은 각각 7px, 루프는 12×12px 영역입니다.
트림은 높이 전체를 사용하므로 짧은 리전에서는 이동·트림·루프 영역이 겹칠 수 있습니다.

- **근거:** [TimelineClip](../src/components/TimelineClip.tsx) `TimelineClip`의 `widthPx`·손잡이 렌더, [TimelineClip CSS](../src/components/TimelineClip.css), [기본 스타일](../src/styles.css)의 `.clip-resize`·`.clip-resize-left`.
- **재현 조건:** 1/64 길이 리전을 낮은 줌과 최소 트랙 높이에서 선택·이동·좌우 트림합니다.
- **사용자 영향:** 움직이려다 길이를 바꾸거나, 길이를 바꾸려다 루프를 켤 수 있습니다.
- **완료 기준:** 좁은 폭에서도 우선순위와 최소 조작 영역을 정하고, 커서가 실행될 동작과 일치해야 합니다.
- **추가 확인:** 페이드 삼각형은 `pointer-events:none`인 표시이며, 리전 가장자리 직접 페이드 편집은 추가 구현입니다.

확대 수준과 트랙 높이별로 body·왼쪽·오른쪽 위·오른쪽 아래 영역을 실제 포인터로 확인해야 합니다.

## 09. 취소 후 선택 상태와 자동 스크롤 — P2

**판정: 코드 확인 / 브라우저 검증 필요.** 공통 제스처 수명 주기는 여러 취소 경로에서 콘텐츠 draft를 폐기합니다.
반면 pointer-down에 바뀐 선택은 취소 전 선택으로 복원하지 않습니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `trackPointer`, `edgeScroller`, `beginClipGesture`.
- **재현 조건:** 다른 리전을 선택해 이동하다 Escape·blur·pointercancel로 취소하고, 화면 가장자리에서 같은 동작을 반복합니다.
- **사용자 영향:** 콘텐츠는 복원되어도 선택 대상은 달라져 다음 명령의 대상이 바뀔 수 있습니다.
- **완료 기준:** 취소 시 콘텐츠·선택·포커스의 정책을 정하고, capture와 RAF가 남지 않아야 합니다.
- **추가 확인:** 자동 스크롤 속도는 가장자리 24px에서 프레임마다 10px입니다. 줌·프레임률별 조작감은 미측정입니다.

반복 블록이 이동 중 사라질 때 원본 element로 capture를 유지하는 기존 처리는 보존합니다.

## 10. No Overlap의 대상 보존 규칙과 프리뷰 — P1

**판정: 코드 확인 / 공식 대조 필요.** `applyDragMode`는 moved ID를 무조건 보존하고, 그 리전이 덮은 나머지를 자르거나 나누거나 삭제합니다.
따라서 시간상 앞 리전이 이동 대상이면, 앞 리전 길이를 줄이는 규칙과 다른 결과가 생길 후보입니다.

- **근거:** [project](../src/core/project.ts) `applyDragMode`, `cutAround`; [App](../src/App.tsx) `withDragMode`; [Timeline](../src/components/Timeline.tsx) `previewFor`·`previewRegionTracks` 호출.
- **재현 조건:** 기존 `[4,8]` 리전 앞에 다른 리전을 `[2,6]`으로 이동합니다. 현재는 이동 대상을 보존하고 기존 시작을 6으로 자릅니다.
- **사용자 영향:** 어느 리전을 움직였는지에 따라 남는 리전이 달라지고, 드롭 전 주변 리전의 절단 결과는 보이지 않습니다.
- **완료 기준:** 앞·뒤·완전 포함·다중 이동의 결과를 공식 규칙과 맞추고, 프리뷰와 commit이 같은 결과를 설명해야 합니다.
- **추가 확인:** 선택된 리전끼리의 겹침은 moved ID 보존으로 그대로 남으므로 별도 정책이 필요합니다.

**오디오 겹침 재생은 미구현이 아닙니다.** [playback](../src/core/playback.ts) `audioWindows`가 뒤에 시작한 리전을 우선해 앞 리전의 재생 끝을 자릅니다. 편집 데이터 변경과 재생 window 계산을 구분합니다.

## 11. 다중 트랙 붙여넣기의 누락·fallback — P1

**판정: 코드 확인 / 브라우저 재현 후보.** 붙여넣기는 포커스 트랙부터 상대 트랙 오프셋을 유지하려고 합니다.
목적 트랙이 없거나 종류가 다르면 포커스 트랙으로 바꾸고, 그것도 종류가 다르면 해당 리전만 생략합니다.

- **근거:** [App](../src/App.tsx) `copySelection`, `paste`.
- **재현 조건:** MIDI·오디오 혼합 선택을 복사하고, 필요한 오디오 목적 트랙이 없는 MIDI 트랙에 붙여넣습니다.
- **사용자 영향:** 일부만 붙거나 여러 리전이 같은 트랙에 모일 수 있으며, 일부 성공 시 생략 안내는 없습니다.
- **완료 기준:** 전체 적용·명시적 일부 적용·필요 트랙 생성 중 정책을 정하고, 누락과 목적 트랙 변경을 알 수 있어야 합니다.
- **추가 확인:** 상대 시각, 새 ID, 새 선택, No Overlap, 한 번의 Undo, 잘라내기 후 복원을 함께 검증합니다.

일반적인 같은 종류 트랙 간 붙여넣기와 재생 위치 기준 배치는 이미 연결돼 있습니다.

## 12. 편집 수치 피드백과 Undo 후 선택 복원 — P2

**판정: 코드 확인 / 추가 구현 검토.** 드래그 중 위치·길이·이동량을 bar/beat/tick으로 보여 주는 help tag는 현재 렌더 경로에 없습니다.
선택은 편집 이력과 별도 상태이며, Undo로 사라진 ID를 정리하지만 이전 선택을 이력에서 복원하지는 않습니다.

- **근거:** [Timeline](../src/components/Timeline.tsx) `previewFor`·렌더, [App](../src/App.tsx) `commit`, `selectClips`, `deleteClips`, 선택 정리 `useEffect`.
- **재현 조건:** 정밀 트림 중 결과 길이를 확인하고, 선택 삭제→Undo 및 분할→Undo→Redo를 수행합니다.
- **사용자 영향:** 정확한 수치를 확인하기 어렵고, 복원된 리전에 다음 명령을 적용하려면 다시 선택해야 할 수 있습니다.
- **완료 기준:** 조작 중 실제 적용될 수치를 표시하고, Undo/Redo 후 선택·포커스 정책을 일관되게 적용해야 합니다.
- **추가 확인:** 리전 이동·배치 트림은 이미 한 번 commit합니다. 다른 연속 입력은 450ms 병합과 실제 제스처 경계의 차이를 확인합니다.

내용 복원과 선택 복원을 서로 다른 항목으로 검사하며, 기존 한 제스처 한 Undo 동작을 회귀시키지 않습니다.

## 검증 범위와 다음 확인

기준 버전의 [구현 상태](IMPLEMENTATION_STATUS.md)에는 15개 파일·306개 단위 테스트 및 빌드 통과가 기록돼 있습니다. 이번 감사에서는 다시 실행하지 않았습니다.

| 기존 검사 | 확인하는 범위 | 이 감사에서 추가로 필요한 확인 |
|---|---|---|
| [input 테스트](../src/core/input.test.ts) | 수정키·단축키·4px 임계값·`snapDragDelta` | Timeline의 로컬 `deltaFor`, DOM 입력 순서, 정지 중 수정키 변경 |
| [project 테스트](../src/core/project.test.ts) | 트림·분할·합치기·No Overlap·배치 편집 | 공식 기대 결과와의 일치, 화면 프리뷰, 비파괴 트림 복원 |
| [regionDisplay 테스트](../src/core/regionDisplay.test.ts) | 이동·복사·트림 중 반복 배치 계산 | 반복 고스트 hit test, 실제 포커스, 짧은 리전 커서 |
| [playback 테스트](../src/core/playback.test.ts) | 재생 이벤트·반복·겹침 window 계산 | 파형과 청음의 시간 대응, 편집 후 실시간·출력 일치 |

`src`의 현재 테스트는 core/audio 단위 검사이며, Timeline·TimelineClip의 실제 DOM pointer workflow 검사는 없습니다.
함수 계산 통과만으로 선택·포인터 capture·스크롤·키보드 포커스가 함께 올바르다고 판정하지 않습니다.

1. 내용 보존과 표시 정확성: 01·02를 먼저 확인합니다.
2. 포인터 편집 규칙: 03·05·06·08의 입력과 결과를 공식 기준에 맞춥니다.
3. 결과 예측과 복구: 07·09·10·11·12의 프리뷰·취소·Undo를 확인합니다.
4. 시간 범위 편집: 04의 도구·명령·상태를 독립적인 구현 범위로 정합니다.

각 확인에는 초기 프로젝트, OS·브라우저, 줌, 트랙 높이, Snap·Drag 설정, 수정키 입력 순서, 화면·재생 결과를 기록해야 합니다.
완료 판정은 입력 → 프리뷰 → 확정 → 취소/Undo → 재열기·재생의 흐름으로 수행합니다.
