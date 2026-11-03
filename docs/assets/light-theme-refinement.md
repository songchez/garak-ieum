# 밝은 테마 색 배치 목업

[PNG 보기](light-theme-refinement.png) · [SVG 원본](light-theme-refinement.svg)

이 이미지는 **실제 앱 스크린샷이 아닌 색 배치 목업**입니다. 세 가지 밝은 테마의 한지 바탕, 패널 경계, 선택색과 기와를 같은 배치에서 비교하기 위해 제작했습니다. 화면 안의 프로젝트, 리전 배치와 피치 곡선은 설명용 예시입니다.

기와 형태는 사용자가 첨부한 한옥 사진의 반복되는 기와골·둥근 막새·들린 처마선을 참고했습니다. 사진 자체는 결과물이나 저장소에 포함하지 않았습니다.

| 안 | 실제 테마 ID | 비교 의도 |
| --- | --- | --- |
| A · 백자·한지 | `porcelain` | 회백색 기와, 따뜻한 목재 경계, 농묵 글자와 청화색 선택. 화이트 테마 개선의 추천 방향 |
| B · 비색·상감 | `celadon` | 밝은 백상감 작업면과 비색 기와, 진한 상감선 |
| C · 염색·한복 | `natural-dyes` | 비단빛 작업면, 회청색 기와, 쪽빛 선택과 소목 강조 |

## 실제 코드와의 관계

- 색은 [`src/core/theme.ts`](../../src/core/theme.ts)의 실제 레지스트리에서 읽습니다.
- 기와는 [`GiwaEave.tsx`](../../src/components/GiwaEave.tsx)를 React 서버 렌더링으로 SVG로 만든 뒤, [`GiwaEave.css`](../../src/components/GiwaEave.css)의 테마 변수와 색 혼합을 해석하여 넣습니다. 28px 반복폭과 12px 높이를 그대로 사용하고, 하단에는 같은 기와의 2배 확대 그림을 배치했습니다.
- 상단은 36px 컨트롤 영역과 12px 기와를 합친 48px 높이입니다. 나머지 화면 배치는 비교를 위한 단순화입니다.
- 북 로고는 기존 `public/brand/favicon.svg`, 이름은 기존 `public/brand/garak-ieum-wordmark.svg`의 원래 경로를 사용합니다. 북 로고의 삼색을 유지하고 이름에는 실제 밝은 테마의 글자색을 적용했습니다.
- 실행 취소·다시 실행·사이클·펼치기 아이콘은 실제 `Icon.tsx`의 Lucide 아이콘으로 렌더링합니다.

## 글꼴과 재생성

설명 글자는 [Noto Sans KR](https://github.com/google/fonts/tree/main/ofl/notosanskr)의 500/700 굵기를 경로화했습니다. 글꼴은 [SIL Open Font License 1.1](https://github.com/google/fonts/blob/main/ofl/notosanskr/OFL.txt)이며 글꼴 파일은 저장소에 포함하지 않습니다. 브랜드 이름 글꼴은 기존 덕온공주체 워드마크를 유지합니다.

Node 24, 프로젝트 의존성, Python `fontTools`, Inkscape와 로컬 Noto Sans KR 가변 TTF가 필요합니다.

```sh
python scripts/build-light-theme-preview.py --font /path/to/NotoSansKR.ttf
```

생성기는 브라우저를 열지 않습니다. SVG와 PNG 렌더링 결과는 실제 앱의 클릭, 반응형 배치, 브라우저별 표시 확인을 대신하지 않습니다.
