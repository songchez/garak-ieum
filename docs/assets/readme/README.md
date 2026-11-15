# 제품 소개 이미지

[제품 README](../../../README.md)에 사용하는 브랜드·기능 설명 자료입니다.

| 파일 | 용도 | 사용처 | 실제 앱 캡처 여부 |
| --- | --- | --- | --- |
| [hero.svg](hero.svg) | 가락이음 브랜드 배너, 1200 × 340 | README(ko/en/ja) 상단 | 브랜드 일러스트 |
| [pitch-workflow.svg](pitch-workflow.svg) | 음표 분석 → 음표 편집 → 적용 흐름, 1200 × 360 | 현재 README에서는 쓰지 않음(보관) | 설명용 개념도 |

현재 README는 **배너(hero.svg) 하나만** 사용합니다. 예전에 README에 실었던 피치 개념도(pitch-workflow.svg)와 테마 색 배치 자료([korean-theme-presets.png](../korean-theme-presets.png), [테마 안내](../../THEMES.md)에서 사용)는 README에서 빠졌습니다. **위 이미지는 실제 앱 스크린샷이 아닙니다.** 실행 화면 캡처가 준비되면 별도 파일로 추가하고, 설계 자료의 설명을 실행 화면으로 바꾸지 않습니다.

## 브랜드와 글꼴

- 배너의 로고는 [`public/brand/favicon.svg`](../../../public/brand/favicon.svg)의 기존 경로와 색을 재사용합니다.
- 워드마크는 [`public/brand/garak-ieum-wordmark.svg`](../../../public/brand/garak-ieum-wordmark.svg)의 기존 덕온공주체 윤곽을 재사용합니다. [기존 글꼴 이용 조건](../../../public/fonts/DeogonPrincess-LICENSE.txt)을 따릅니다.
- 새 문구는 **Noto Sans KR 500/700**으로 조판한 뒤 글자 윤곽을 SVG 경로로 저장했습니다. [공식 소스](https://github.com/google/fonts/tree/main/ofl/notosanskr) · [SIL Open Font License 1.1](https://github.com/google/fonts/blob/main/ofl/notosanskr/OFL.txt).
- 최종 SVG에는 외부 글꼴·이미지·스크립트 참조가 없습니다. 한국어 표시가 열람 기기에 설치된 글꼴에 의존하지 않습니다.
- 두 SVG는 `title`·`desc`에 이미지의 목적을 기록합니다. README에 싣는 이미지에는 대체 텍스트를 제공합니다.

## 실제 화면을 추가할 때

같은 앱 버전과 브라우저에서 아래 장면을 캡처하면 README의 흐름을 이어갈 수 있습니다. 새 캡처는 원본 화면을 보존하고, 캡션에 프로젝트·테마·앱 버전을 기록하세요.

| 권장 파일명 | 준비할 장면 | 보여줄 내용 |
| --- | --- | --- |
| `studio-overview.png` | **마당의 결**을 열고 타임라인과 피아노롤 표시 | 국악 악기, 리전 구성, 실제 MIDI 음표 편집 |
| `pitch-editor.png` | 사용 권한이 있는 60초 이하 단선율 오디오를 분석하고 **피치 편집** 창 표시 | 분석 음표·피치 곡선·보정 도구 |
| `mixer-sigimsae.png` | 트랙과 믹서·시김새 체인 표시 | 볼륨·팬·시김새와 모듈 구성 |
| `project-chooser.png` | **샘플 프로젝트** 분류에서 항목을 선택하고 상세 정보 표시 | 공통 타일과 편곡의 시작점 |

- 긴 파일명·개인 경로·연결 토큰·개인 음악의 비공개 정보가 화면에 들어가지 않도록 준비합니다.
- 이미지를 먼저 시각적으로 확인한 뒤 README에 연결합니다. 아직 없는 파일을 이미지 링크로 추가하지 않습니다.
- 피치 도구의 개념도와 실제 화면은 별개입니다. 실제 캡처에도 실험적 포먼트 기능을 검증 완료로 설명하지 않습니다.
