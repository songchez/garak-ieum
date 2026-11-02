# 가락이음 배포 준비 안내

2026-11-02 · Cloudflare Pages의 GitHub 연동을 사용하는 정적 Vite 배포

## 현재 상태

이 문서는 배포에 사용할 설정을 정리한 것입니다. **GitHub 저장소와 `main` 브랜치는 확인했으며, Cloudflare 연결과 공개 배포 성공은 아직 검증하지 않았습니다.** 배포 주소와 Pages 설정은 확인 전 계획값입니다.

| 항목 | 계획 또는 확인 상태 |
|---|---|
| 제품 이름 | 가락이음 — 사용자 확정 |
| GitHub 소유자 / 저장소 | `songchez/garak-ieum` — 저장소 확인, Cloudflare 연결 미검증 |
| 저장소 URL | [songchez/garak-ieum](https://github.com/songchez/garak-ieum) |
| 프로덕션 브랜치 | `main` |
| 배포 대상 | Cloudflare Pages, Git integration |
| Pages 프로젝트 이름 | `garak-ieum` 예정 — 생성·사용 가능 여부 검증 전 |
| 실제 배포 URL | 미정; Cloudflare가 발급한 주소를 검증한 뒤 기록 |

## Pages 빌드 설정

`package.json`, `pnpm-lock.yaml`, `index.html`, `src/`가 GitHub 저장소 루트에 있는 구조를 기준으로 합니다.

| Pages 설정 | 입력할 값 |
|---|---|
| Repository | `songchez/garak-ieum` |
| Production branch | `main` |
| Framework preset | React (Vite) |
| Root directory | 비워 둠 — 저장소 루트 사용 |
| Build command | `pnpm test && pnpm build` |
| Build output directory | `dist` |
| `NODE_VERSION` | `24` |
| `PNPM_VERSION` | `11.25.0` |

환경 변수 `NODE_VERSION`과 `PNPM_VERSION`은 **Production과 Preview 양쪽**에 같은 값으로 설정합니다. 저장소 루트의 `.node-version`에도 `24`를 기록했습니다. 환경 변수와 파일의 Node 버전을 서로 다르게 설정하지 않습니다.

Cloudflare Pages 공식 빌드 이미지 문서는 `NODE_VERSION` 및 `.node-version`에 의한 Node 버전 지정과 `PNPM_VERSION`에 의한 pnpm 버전 지정을 지원한다고 안내합니다. 두 도구의 지원 범위는 기본 설치 버전보다 새로운 버전도 포함합니다. 따라서 Pages의 기본 pnpm 버전에 의존하지 않고 프로젝트의 `packageManager`와 맞는 버전을 지정합니다. [빌드 이미지와 버전 지정](https://developers.cloudflare.com/pages/configuration/build-image/)

Pages의 기본 의존성 설치 단계는 유지하고 `pnpm-lock.yaml`을 커밋합니다. 빌드 명령은 테스트가 성공한 경우에만 TypeScript 검사와 Vite 빌드로 진행합니다. 테스트 또는 빌드가 실패하면 명령이 실패 상태로 종료되어야 합니다. Cloudflare는 명령의 종료 코드로 빌드 성공을 판정하며, Vite의 정적 출력 디렉터리는 `dist`입니다. [빌드 설정](https://developers.cloudflare.com/pages/configuration/build-configuration/)

## GitHub 연결과 자동 배포

1. 배포할 변경을 검토해 GitHub 저장소 `songchez/garak-ieum`의 `main`에 반영합니다.
2. Cloudflare의 **Workers & Pages**에서 Pages 프로젝트를 만들고 Git 저장소 가져오기를 선택합니다.
3. 연결할 GitHub 계정과 `songchez/garak-ieum` 저장소를 확인합니다. Cloudflare가 이 저장소를 읽을 수 있도록 필요한 연결을 완료합니다.
4. 위 표의 빌드 설정과 환경 변수를 입력하고 첫 배포를 실행합니다.
5. 첫 빌드 로그에서 Node·pnpm 버전, 테스트 결과, `dist` 산출과 배포 완료를 확인합니다.
6. Cloudflare가 실제 발급한 HTTPS 주소에서 앱이 열리는지 확인하고, 배포 URL과 연결된 커밋을 기록합니다.

Git 연동이 완료되고 자동 배포가 활성화되면 `main`에 새 커밋을 push할 때 프로덕션 빌드·배포가 실행됩니다. 다른 브랜치의 미리보기 배포는 Pages의 브랜치 설정을 따릅니다. 연결 화면을 설정한 것만으로 자동 배포 검증을 완료 처리하지 않고, 실제 push의 커밋과 Pages 배포의 커밋이 같은지 확인합니다. [Git 연동 안내](https://developers.cloudflare.com/pages/get-started/git-integration/)

이 구성은 Pages의 Git 연동으로 배포하므로 별도 GitHub Actions 배포 워크플로, Wrangler 의존성, Worker 서버 코드를 요구하지 않습니다.

## 프로젝트 URL과 직접 접속

`/`는 프로젝트 선택 화면이고, `/projects/:id`는 현재 브라우저에 저장된 프로젝트 편집기입니다. 선택 화면에서 새 샘플·빈 프로젝트·가져온 파일을 저장한 후 고유 주소를 엽니다. 없는 ID는 자동으로 다른 프로젝트를 열지 않고 복구 안내와 목록 버튼을 표시합니다.

`public/_redirects`의 다음 규칙은 Vite 빌드 때 `dist/_redirects`로 복사됩니다.

```text
/projects/* /index.html 200
```

Cloudflare Pages의 같은 사이트 내 200 프록시 규칙을 사용해 주소를 유지한 채 앱 진입 파일을 제공합니다. Pages는 루트 `404.html`이 없을 때 정적 파일이 없는 경로를 SPA로 처리하지만, 프로젝트 경로는 별도 규칙으로 명시합니다. `/assets/`, `/samples/`, 글꼴 경로는 이 규칙 대상이 아닙니다. 다른 호스팅을 쓰면 `/projects/*` 요청을 `index.html`로 처리하는 동등한 설정이 필요합니다. [리다이렉트와 200 프록시](https://developers.cloudflare.com/pages/configuration/redirects/#proxying) · [SPA 경로 처리](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering)

배포 확인에는 기본 주소에서 목록 열기, 샘플 만들기, 생성된 프로젝트 주소로 새로고침, 뒤로/앞으로 이동, 존재하지 않는 ID로 접속, 악기 샘플 파일 로딩을 포함합니다. 프로젝트 URL은 서버 공유 링크가 아니므로 같은 URL을 다른 기기에서 열면 그 기기의 저장소에서 찾습니다. 기기를 옮길 때는 `.garak` 파일을 사용합니다.

## 주소 변경과 로컬 음악 프로젝트

현재 음악 프로젝트와 원본 오디오는 사용자의 브라우저 IndexedDB에 저장합니다. 이 저장소는 **origin(프로토콜·호스트·포트)별**로 분리됩니다. 개발 미리보기, 첫 Pages 주소, 나중의 사용자 도메인은 같은 음악 저장 공간을 자동 공유하지 않습니다. 주소를 옮기기 전에 기존 주소에서 프로젝트 파일을 내보내고 새 주소에서 가져와야 합니다. 초기 프로토타입의 `.noct` 파일 호환성은 저장 형식의 이행 정책에 따릅니다. [IndexedDB의 동일 출처 정책](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

## 저장소에서 제외하는 파일

의존성·빌드 결과(`node_modules/`, `dist/`), 기존 Sites 설정(`.openai/`, `.sites-runtime/`), Cloudflare 로컬 상태(`.wrangler/`), 로컬 환경·비밀 파일(`.env*`, `.dev.vars*`)은 `.gitignore`로 제외합니다. 인증 토큰과 계정 비밀값을 소스나 배포 문서에 넣지 않습니다.

## 배포 완료 후 갱신할 기록

| 검증 항목 | 현재 상태 |
|---|---|
| GitHub 저장소가 생성되고 `main` 커밋이 올라감 | 확인 (`588fc5533e47c7474751f25dce876be3bb97cd30`) |
| Pages가 의도한 GitHub 저장소와 연결됨 | 미검증 |
| Node 24 / pnpm 11.25.0으로 원격 빌드됨 | 미검증 |
| 원격 테스트·빌드가 성공함 | 미검증 |
| 실제 HTTPS 주소에서 앱이 열림 | 미검증 |
| 새 push의 커밋으로 자동 배포됨 | 미검증 |

실제 작업 결과를 확인한 뒤 이 표와 첫 번째 상태 표를 함께 갱신합니다.
