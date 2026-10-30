# 가락이음 브랜드

2026-10-30 사용자 확정 사항입니다.

- 제품명: **가락이음**
- 영문 식별 표기: Garak Ieum / `garak-ieum`
- 로고: 삼태극 북과 세 줄의 멀티트랙. 북채 없는 1:1 이미지.
- 로고 파일: `public/brand/garak-ieum-mark.png`
- 이름 글꼴: 국립한글박물관 **덕온공주체**, 가로쓰기용 원본.
- 이름 표시 파일: `public/brand/garak-ieum-wordmark.svg`. 고정된 네 글자만 원래 획과 배치 폭으로 조판한 SVG입니다. 약 7.9MB의 원본 폰트를 웹에서 내려받거나 설치하지 않습니다.
- 이미지와 이름은 별도 요소로 배치합니다. 이름을 로고 이미지 안에 합성하지 않습니다.
- 글자색: 따뜻한 미색 `#f0e2be`. 기존 다크 테마에서 사용합니다.
- 앱 상단과 소개 창에서 동일한 `Brand` 컴포넌트를 사용합니다.
- 새 명칭을 적용해도 기존 IndexedDB 이름, 프로젝트 포맷과 `.noct` 확장자는 호환성을 위해 유지합니다.

글꼴의 출처와 이용 조건은 [제3자 자산 안내](../THIRD_PARTY_NOTICES.md)에 명시합니다. 이 글꼴에는 애플리케이션 코드의 MIT 라이선스가 적용되지 않습니다.

## 워드마크 재생성

공식 TTF ZIP에서 `DeogonPrincess.ttf`를 꺼낸 뒤 fonttools 4.61.1이 있는 Python 환경에서 실행합니다.

```sh
python3 scripts/build-brand-wordmark.py --font /path/to/DeogonPrincess.ttf
```

이 과정은 글꼴 파일을 수정하는 서브셋 생성이 아니라 제품명의 고정된 네 글자를 그래픽으로 조판합니다. 글꼴 전체와 변환된 글꼴 파일은 GitHub·웹 빌드에 포함하지 않습니다.
