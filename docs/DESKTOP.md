# 가락이음 Windows 데스크톱

2026-11-03 · Electron 기반 Windows x64 개발 프리뷰

가락이음의 편집기와 오디오 엔진을 독립된 데스크톱 창에서 실행합니다. 설치 파일에는 앱 화면, 내장 악기 샘플, 피치 편집에 필요한 파일을 함께 넣습니다. 설치한 앱을 실행할 때 Node.js나 pnpm을 별도로 설치할 필요는 없습니다.

현재 빌드 대상은 **Windows x64**입니다. 아래 CI는 설치 파일 생성과 패키징된 앱의 기본 동작을 검증하도록 구성되어 있습니다. 실제 성공 여부는 해당 커밋의 Actions 실행 결과에서 확인합니다.

## 1. 설치 파일 받기

1. GitHub 저장소의 [Actions → Windows desktop](https://github.com/songchez/garak-ieum/actions/workflows/desktop.yml)을 엽니다.
2. 원하는 커밋의 **성공한 실행**을 선택합니다. PR 빌드라면 사용하려는 변경이 포함된 PR인지 확인합니다.
3. **Artifacts**에서 `garak-ieum-windows-x64-<커밋 SHA>`를 내려받아 압축을 풉니다.
4. 들어 있는 `.exe` 설치 파일을 실행하고 설치 안내를 따릅니다.
5. 설치된 **가락이음**을 열고 샘플 프로젝트나 빈 프로젝트를 선택합니다.

Artifacts에는 설치 파일과 `SHA256SUMS.txt`가 들어 있습니다. 파일 무결성을 확인하려면 PowerShell에서 설치 파일의 해시를 구해 기록된 값과 비교합니다.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\내려받은-설치파일.exe'
```

빌드 및 앱 실행 검증이 모두 성공한 경우에만 설치 파일을 업로드합니다. Artifact 보관 기간은 14일이며, 만료되면 해당 코드를 다시 빌드해야 합니다. GitHub Releases에 자동 공개하는 흐름은 포함하지 않습니다.

현재 설치 파일은 코드 서명 없는 내부 테스트용입니다. Windows에서 게시자 또는 SmartScreen 안내가 나타날 수 있습니다. 외부 정식 배포에는 서명 설정과 별도 배포 검증이 필요합니다. [Windows 서명 안내](https://www.electron.build/docs/features/code-signing/)

## 2. 작업 저장과 브라우저 프로젝트 이동

### 앱 안에서 자동 저장

프로젝트와 원본 오디오는 앱의 IndexedDB에 자동 저장됩니다. Electron의 영구 사용자 프로필인 `userData`를 사용하므로 앱을 닫고 다시 열어도 저장된 프로젝트를 불러올 수 있습니다. Windows에서는 기본적으로 `%APPDATA%` 아래에 앱별 프로필이 만들어집니다. [Electron 저장 경로](https://www.electronjs.org/docs/latest/api/app/#appgetpathname)

프로필 데이터와 설치된 프로그램 파일은 별개의 위치입니다. 프로필을 직접 지우거나 초기화하면 자동 저장된 작업도 사라질 수 있으므로, 계속 보관할 곡은 원본 오디오가 포함된 `.garak` 파일로 내보냅니다.

### 파일로 보관하기

- **프로젝트 내보내기:** 계속 편집할 수 있는 `.garak` 파일을 Windows 저장 창에서 원하는 위치에 저장합니다.
- **WAV 내보내기:** 완성한 편곡을 Windows 저장 창에서 오디오 파일로 저장합니다.
- **프로젝트 가져오기:** Windows 파일 열기 창에서 `.garak` 파일을 선택합니다.

파일로 내보낸 뒤에도 앱의 자동 저장본은 유지됩니다. 파일을 다른 PC로 복사해 가져오면 그 PC에서 독립된 작업으로 이어서 편집할 수 있습니다.

### 탐색기에서 `.garak` 파일 열기

Windows 설치 파일은 `.garak`를 **가락이음 음악 프로젝트**로 등록하고, 파일 아이콘에 설치된 가락이음 실행 파일의 브랜드 아이콘을 사용합니다. `.garak` 파일을 더블클릭하면 가락이음에서 가져오며, 앱이 실행 중이면 기존 창으로 전달합니다. Windows에서 이 확장자에 다른 기본 앱을 이미 지정했다면 **연결 프로그램**에서 가락이음을 선택합니다.

파일 연결은 설치 범위에 맞게 등록됩니다. 아래 CI는 관리자 권한을 요청하지 않는 현재 사용자 설치를 검사합니다. 설치 제거 시 앱의 ProgID와 해당 `OpenWithProgids` 항목은 제거하지만, 이전 기본 앱 연결을 자동 복원한다고 보장하지 않습니다.

### 기존 웹 버전에서 옮기기

브라우저와 데스크톱 앱은 서로 다른 저장 공간을 사용합니다. Cloudflare 주소나 `localhost`에서 만든 프로젝트가 앱에 자동으로 나타나지는 않습니다.

1. 기존 곡이 보이는 브라우저 주소에서 프로젝트를 엽니다.
2. 프로젝트를 `.garak` 파일로 내보냅니다.
3. 데스크톱 앱의 프로젝트 가져오기에서 그 파일을 선택합니다.

프로젝트 URL을 복사하는 방식으로는 음원과 프로젝트가 옮겨지지 않습니다. [프로젝트 저장 구조](ARCHITECTURE.md) · [프로젝트 사용법](GETTING_STARTED.md)

## 3. 오프라인 사용과 장치

설치 파일은 앱과 내장 샘플을 포함한 **전체 NSIS 설치 파일**입니다. 설치 후 내장 샘플을 불러오고 편집·재생·저장하는 작업에는 Cloudflare 사이트나 Vite 개발 서버가 필요하지 않습니다. 소스에서 처음 의존성·Electron·설치 도구를 받는 빌드 과정에는 인터넷 연결이 필요합니다. [NSIS 패키징](https://www.electron.build/nsis/)

마이크나 오디오 인터페이스를 사용할 때는 Windows의 입력 장치와 마이크 권한을 확인하고, 앱의 **오디오 설정**에서 입력을 선택합니다. 오디오 처리 기반은 기존 Web Audio 엔진이며 실제 장치·드라이버의 동작과 지연은 별도로 확인해야 합니다.

VST3와 ASIO 지원은 요청된 다음 작업이며, **현재 데스크톱 앱의 사용 가능한 기능으로 제공하지 않습니다.** Electron 패키징은 기존 Web Audio 엔진을 유지합니다. VST3 플러그인의 오디오와 내장 악기·이펙트·녹음을 같은 네이티브 장치 callback에서 처리하도록 엔진을 옮겨야 합니다.

[네이티브 오디오 구현 계획](NATIVE_AUDIO.md)은 자체 MIT C++ 엔진, MIT VST3 SDK, WASAPI 기본 출력, 선택적 ASIO adapter의 단계와 검증 조건을 정리합니다. ASIO를 포함해 외부에 배포하려면 GPLv3 결합물 배포 또는 로열티 없는 Steinberg proprietary 계약 중 사용자의 선택이 필요합니다. 현재 ASIO SDK를 내려받거나 해당 계약에 동의하지 않았고, 저장소의 MIT 라이선스는 유지합니다. [Steinberg 공식 ASIO 안내](https://forums.steinberg.net/t/asio-sdk-proprietary-licensing-faq/1044024)

외부 USB MIDI 입력·MIDI 녹음과 VST2/AU/CLAP 호스트도 현재 패키징에서 추가하지 않습니다. 전체 지원 범위는 [구현 상태](IMPLEMENTATION_STATUS.md)를 따릅니다.

## 4. 소스에서 실행하고 빌드하기

개발·빌드에는 **Node.js 24.x**와 **pnpm 11.25.0**을 사용합니다. 프로젝트 루트에서 실행합니다.

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
```

`desktop:dev`는 웹앱·MCP·Electron 코드를 빌드한 뒤 Electron 창을 엽니다. 실행 파일로 사용할 코드를 확인하는 흐름이며, 소스를 수정한 후 다시 실행해 반영합니다.

| 명령 | 역할 |
|---|---|
| `pnpm desktop:compile` | Electron main·preload TypeScript를 `dist-desktop`으로 빌드 |
| `pnpm desktop:dev` | 웹앱·MCP·Electron 코드를 빌드하고 로컬 Electron 실행 |
| `pnpm desktop:pack` | 현재 OS용 압축되지 않은 앱 디렉터리 생성; 공개 배포 안 함 |
| `pnpm desktop:build` | Windows x64 NSIS 설치 파일 생성; 공개 배포 안 함 |
| `pnpm desktop:test` | 패키징된 앱을 Playwright로 실행해 기본 동작 확인 |

Windows 설치 파일을 직접 만들 때는 다음 순서로 실행합니다.

```powershell
pnpm test
pnpm desktop:build
pnpm desktop:test
```

Windows 빌드 결과는 `release/*.exe`이고, 압축되지 않은 앱은 `release/win-unpacked/가락이음.exe`입니다. 로컬 `desktop:test`는 기본적으로 이 앱을 검사합니다. 아래 Windows CI는 실제 설치 파일로 설치한 실행 파일을 검사하도록 경로를 지정합니다. `desktop:pack`은 실행 중인 OS에 맞게 출력하므로 Linux에서 실행한 결과를 Windows 설치 파일로 취급하지 않습니다.

## 5. Windows CI의 검증 범위

[desktop.yml](../.github/workflows/desktop.yml)은 수동 실행, 관련 파일을 바꾸는 PR, `main`의 관련 변경에 대해 Windows 작업을 실행합니다.

1. 커밋 SHA로 고정한 공식 Actions로 Node.js와 pnpm을 준비합니다.
2. `pnpm install --frozen-lockfile`로 잠긴 의존성을 설치합니다.
3. `pnpm test`를 통과한 뒤 `pnpm desktop:build`로 설치 파일을 만듭니다.
4. [desktop-install-smoke.ps1](../scripts/desktop-install-smoke.ps1)이 실제 NSIS 설치 파일을 공백이 포함된 임시 경로에 현재 사용자용으로 자동 설치합니다. 설치된 실행 파일, HKCU의 `.garak` 연결, 실행 파일 아이콘을 가리키는 `DefaultIcon`, 실행 파일과 프로젝트 경로를 모두 따옴표로 감싼 열기 명령을 확인합니다.
5. `GARAK_ELECTRON_EXECUTABLE`로 설치된 실행 파일을 지정한 뒤 `pnpm desktop:test`가 앱 로딩, 프로젝트 생성, 저장과 재실행 후 복원을 확인합니다.
6. 성공한 설치 파일의 SHA-256 체크섬을 만들고 Artifact로 업로드합니다.

실행 검사가 남긴 `release/desktop-smoke/` 자료는 별도 Artifact인 `garak-ieum-desktop-smoke-<커밋 SHA>`에 보관합니다. 이 업로드 단계는 앞선 단계의 성공 여부와 관계없이 실행되므로 실패 원인을 조사할 수 있습니다. 실행 검사에 도달하지 못했거나 자료가 만들어지지 않았다면 해당 Artifact는 없을 수 있습니다. 진단 자료가 업로드되었다는 사실은 설치 파일 검증 성공을 뜻하지 않으며, 설치 파일은 모든 앞선 단계가 성공해야 업로드합니다. 진단 자료의 보관 기간도 14일입니다.

설치 검사는 GitHub가 제공하는 일회성 Windows runner에서만 실행하도록 제한되어 있으며, 결과는 `release/desktop-smoke/installer-association.json`에 기록합니다. 앱 실행 검증에는 별도의 임시 사용자 프로필을 사용합니다. 개발자의 평소 작업 프로필을 테스트 데이터로 덮어쓰지 않습니다. 별도 실행 파일을 검사할 때는 `GARAK_ELECTRON_EXECUTABLE`로 경로를 지정할 수 있습니다.

이 검증은 자동 설치와 레지스트리 등록, 설치된 앱의 실행 및 프로젝트 저장을 확인합니다. 탐색기 화면에서 아이콘이 그려지는 모습이나 실제 마우스 더블클릭, 설치 제거, NSIS 설치 마법사의 수동 조작, 실제 오디오 인터페이스 녹음과 오디오 청취 품질은 별도 확인 항목입니다. 워크플로는 저장소 읽기 권한만 사용하며 인증서·배포 토큰이나 자동 Releases 게시를 요구하지 않습니다.

## 6. 구성과 AI 연결

Electron main은 `dist-desktop/main.js`, preload는 `dist-desktop/preload.cjs`, 화면은 `dist`에서 실행됩니다. 화면에서 사용할 수 있는 데스크톱 기능은 프로젝트 열기·내보내기 등 좁은 API로 연결하며 일반 파일시스템 접근을 직접 노출하지 않습니다.

MCP 코드는 `dist-mcp`에 함께 빌드됩니다. 데스크톱 실행 파일의 `--mcp` 모드는 외부 MCP 클라이언트가 실행하는 stdio 서버이고, `--mcp-token`은 연결 키를 만드는 용도입니다. GUI를 여는 것만으로 MCP 브리지가 자동 시작되지는 않습니다. 연결 키는 MCP 클라이언트의 `GARAK_MCP_TOKEN` 환경 변수로 전달합니다. [AI·MCP 연결 안내](MCP.md)

데스크톱 앱의 패키징·자동 저장과 AI 서버 연결은 각각의 실행 경로를 가집니다. 새 기능의 구현·검증 상태는 [구현 상태](IMPLEMENTATION_STATUS.md)에 기록합니다.
