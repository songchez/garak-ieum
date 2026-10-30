# 제3자 자산 안내

## 덕온공주체

- 저작권자: 문화체육관광부 국립한글박물관 · ㈜윤디자인그룹
- 공식 출처: <https://hanfont.hangeul.go.kr/relaxfont/font/deokon.do>
- 원본 배포: <https://hanfont.hangeul.go.kr/fonts/DeogonPrincess_TTF.zip>
- 이용 조건: 공공누리 제3유형 — 출처표시·변경금지. 공식 페이지의 추가 사용 조건을 함께 따릅니다.
- 사용 결과물: `public/brand/garak-ieum-wordmark.svg`
- 안내 파일: [DeogonPrincess-LICENSE.txt](public/fonts/DeogonPrincess-LICENSE.txt)

이름은 2026-10-30에 공식 ZIP에서 받은 가로쓰기용 `DeogonPrincess.ttf`로 조판했습니다. 글꼴 파일은 수정하거나 서브셋하지 않았고, 저장소와 웹 배포물에도 포함하지 않습니다. 고정된 네 글자의 원래 획과 가로 배치 폭을 사용해 만든 SVG 워드마크만 제공합니다. 일반 편집 UI는 기존 본문 글꼴을 사용합니다.

재생성 도구는 `scripts/build-brand-wordmark.py`입니다. 공식 원본 TTF와 fonttools 4.61.1을 준비한 뒤 `python3 scripts/build-brand-wordmark.py --font /path/to/DeogonPrincess.ttf`로 실행합니다. 앱 실행과 일반 빌드에는 이 도구나 전체 폰트가 필요하지 않습니다.

애플리케이션 코드는 MIT로 제공하지만 이 글꼴은 MIT나 OFL로 다시 허가하지 않습니다. 상업적 이용 허용과 수정 가능한 오픈소스 글꼴이라는 뜻은 서로 다릅니다. 자세한 허용 범위는 공식 안내를 확인합니다.
