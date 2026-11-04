# 가락이음 Windows 데스크톱

2026-11-04 · Electron + C++ 네이티브 오디오, Windows x64 개발 프리뷰

편집기는 Electron 창에서, 실시간 오디오는 별도 C++ `garak-audio-host` 프로세스에서 실행합니다. 설치 파일에는 네이티브 엔진과 고지, 앱 화면, 내장 악기 샘플과 피치 편집 파일을 함께 넣습니다. 설치한 앱을 실행할 때 Node.js나 pnpm을 별도로 설치할 필요는 없습니다.

이 문서는 **Windows x64** 설치를 설명합니다. **macOS Apple Silicon DMG**의 설치·빌드·서명 상태는 [macOS 안내](MACOS.md)를 확인하세요. 아래 CI는 Windows 설치 파일 생성과 패키징된 앱의 기본 동작을 검증하도록 구성되어 있습니다. 실제 성공 여부는 해당 커밋의 Actions 실행 결과에서 확인합니다.

## 1. 설치 파일 받기

1. GitHub 저장소의 [Actions → Windows desktop](https://github.com/songchez/garak-ieum/actions/workflows/desktop.yml)을 엽니다.
2. 원하는 커밋의 **성공한 실행**을 선택합니다. PR 빌드라면 사용하려는 변경이 포함된 PR인지 확인합니다.
3. **Artifacts**에서 `garak-ieum-windows-x64-<커밋 SHA>`를 내려받아 압축을 풉니다.
4. 들어 있는 `.exe` 설치 파일을 실행하고 설치 안내를 따릅니다.
5. 설치된 **가락이음**을 열고 샘플 프로젝트나 빈 프로젝트를 선택합니다.

Artifacts에는 다음 파일이 들어 있습니다. **앱을 설치할 때는 `.exe`를 실행합니다.** 별도의 소스 ZIP은 코드를 확인·수정하거나 직접 빌드할 때 사용합니다.

| 파일 | 용도 |
| --- | --- |
| `.exe` 설치 파일 | Windows에 가락이음 설치 |
| `Garak-Ieum-Source-<버전>-<커밋 앞 12자리>.zip` | 같은 빌드의 대응 소스와 빌드 스크립트 |
| `SHA256SUMS.txt` | 설치 파일과 대응 소스 ZIP의 무결성 확인 |

파일 무결성을 확인하려면 PowerShell에서 설치 파일의 해시를 구해 기록된 값과 비교합니다.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\내려받은-설치파일.exe'
```

빌드 및 앱 실행 검증이 모두 성공한 경우에만 설치 파일과 대응 소스를 함께 업로드합니다. 개발 검사 Artifact 보관 기간은 14일입니다. 공개 버전은 [Releases](https://github.com/songchez/garak-ieum/releases)에서 받으며, `release.config.json`과 릴리즈 노트를 커밋해 요청하는 별도 [공개 배포 workflow](../.github/workflows/release.yml)가 Windows/macOS 검사 완료 후 게시합니다. 일반 PR 검사나 로컬 빌드만으로 공개하지 않습니다.

앱 코드의 배포 라이선스는 **GPL-3.0-only**입니다. 외부에 설치 파일을 재배포할 때는 해당 실행 파일의 정확한 소스·빌드 스크립트와 고지를 제공하고, 선택한 GPL 소스 제공 방식에 맞게 접근을 유지해야 합니다. 만료되는 CI Artifact를 장기 공개 배포 주소로 취급하지 않습니다. 이전 MIT 고지의 보존, 제3자 라이선스와 대응 소스의 범위는 [GPL 배포 안내](LICENSING.md)를 따릅니다.

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

앱의 **오디오 설정**에서 WASAPI 또는 설치된 ASIO 드라이버, 입력·출력 장치, 레이트·버퍼와 입력 채널을 선택합니다. ASIO 입력과 출력은 같은 드라이버를 사용합니다. 선택한 장치를 열 수 없으면 오류를 보여 주며 다른 장치나 Web Audio로 자동 대체하지 않습니다. 보고된 입력·출력 지연과 실제 블록은 물리 루프백으로 측정한 왕복 지연과 구분합니다.

내장 악기·오디오 리전·기타 앰프·이펙트·VST3와 모니터링은 같은 네이티브 callback에서 처리합니다. 녹음은 네이티브 입력 PCM, WAV 출력은 같은 C++ 그래프의 오프라인 렌더를 사용합니다. Windows x64 VST3는 사용자가 선택한 플러그인을 별도 프로세스에서 탐색하고 악기/인서트에 연결합니다. 파라미터, 자체 창, component/controller 상태 저장을 지원하며 설치물에 타사 플러그인을 재배포하지 않습니다.

[네이티브 오디오 안내](NATIVE_AUDIO.md)에 처리 구조·한도·고정 SDK와 검증 결과를 정리했습니다. ASIO SDK 2.3.4의 GPLv3 경로와 앱 코드의 GPL-3.0-only를 유지합니다. Linux에서 실제 SDK/테스트 플러그인 회귀를 통과했으며, 새 Windows MSVC CI와 실제 ASIO 인터페이스의 청감·왕복 지연·장치 복구는 별도 확인 대상입니다. Web Audio는 브라우저 데모와 데스크톱의 일회성 압축 파일 디코딩·비실시간 피치 작업에 남습니다.

외부 USB MIDI 입력·MIDI 녹음과 VST2/AU/CLAP 호스트도 현재 패키징에서 추가하지 않습니다. 전체 지원 범위는 [구현 상태](IMPLEMENTATION_STATUS.md)를 따릅니다.

## 4. 소스에서 실행하고 빌드하기

개발·빌드에는 **Node.js 24.x**와 **pnpm 11.25.0**을 사용합니다. 프로젝트 루트에서 실행합니다.

```powershell
pnpm install --frozen-lockfile
pnpm desktop:dev
```

`desktop:dev`는 네이티브 엔진·웹앱·MCP·Electron 코드를 빌드한 뒤 Electron 창을 엽니다. 실행 파일로 사용할 코드를 확인하는 흐름이며, 소스를 수정한 후 다시 실행해 반영합니다.

Windows 설치물은 **Visual Studio 2022 또는 Build Tools 2022의 C++ 데스크톱 개발 도구와 Windows SDK**를 준비한 Windows에서 빌드합니다. **CMake 3.25 이상**도 필요합니다. 네이티브 오디오와 MCP 실행 파일을 컴파일하고 ASIO·VST3·miniaudio·JSON 소스는 [고정 manifest](../native/dependencies.lock.json)의 SHA-256을 검사합니다. 대응 소스 ZIP의 `native/dependency-sources/` archive를 우선 사용합니다. 설치 파일을 받아 사용하는 사람에게는 이 개발 도구가 필요하지 않습니다.

| 명령 | 역할 |
|---|---|
| `pnpm native:build` | 고정 SDK로 C++ 엔진·테스트 VST3 빌드, CTest 실행, 배포용 helper·고지 설치 |
| `pnpm native:test` | 실제 helper와 VST3 fixture의 IPC·자산·상태·녹음·WAV 스모크 |
| `pnpm desktop:compile` | Electron main·preload TypeScript를 `dist-desktop`으로 빌드 |
| `pnpm desktop:launcher` | Windows에서 MCP 콘솔 실행 파일 `garak-mcp.exe` 빌드; 다른 OS에서는 이 Windows 단계 건너뜀 |
| `pnpm desktop:dev` | 네이티브 엔진·웹앱·MCP·Electron 코드를 빌드하고 로컬 Electron 실행 |
| `pnpm desktop:pack` | 현재 OS용 압축되지 않은 앱 디렉터리 생성; Windows에서는 MCP 콘솔 실행 파일 포함 |
| `pnpm desktop:build` | MCP 콘솔 실행 파일을 포함한 Windows x64 NSIS 설치 파일 생성; 공개 배포 안 함 |
| `pnpm desktop:test` | 패키징된 앱을 Playwright로 실행해 기본 동작 확인 |
| `pnpm desktop:source` | 깨끗한 빌드 커밋의 프로젝트 소스 ZIP과 배포 고지 생성 |

Windows 설치 파일을 직접 만들 때는 다음 순서로 실행합니다.

```powershell
pnpm test
pnpm desktop:build
pnpm native:test
pnpm desktop:test
```

Windows 빌드 결과는 `release/*.exe`이고, 압축되지 않은 앱은 `release/win-unpacked/가락이음.exe`입니다. 같은 디렉터리에 MCP용 `garak-mcp.exe`가 들어갑니다. 로컬 `desktop:test`는 기본적으로 이 설치 전 앱 디렉터리를 검사합니다. 아래 Windows CI는 실제 설치 파일로 설치한 실행 파일을 검사하도록 경로를 지정합니다. `desktop:pack`은 실행 중인 OS에 맞게 출력하므로 Linux에서 실행한 결과를 Windows 설치 파일로 취급하지 않습니다.

설치 파일을 다른 사람에게 배포하려면 먼저 변경 사항을 커밋하고 깨끗한 체크아웃에서 위 빌드·검증을 수행한 뒤 `pnpm desktop:source`를 실행합니다. 이 명령은 빌드에 기록된 커밋과 현재 소스가 다르면 소스 ZIP 생성을 거부합니다. 소스 ZIP에서 직접 개발하는 경우에도 `pnpm desktop:dev`와 `pnpm desktop:build`를 사용할 수 있습니다. 수정본을 다시 배포할 때의 소스 제공 범위는 [라이선스 안내](LICENSING.md)를 따릅니다.

## 5. Windows CI의 검증 범위

[desktop.yml](../.github/workflows/desktop.yml)은 수동 실행, 데스크톱·네이티브·패키징 파일을 바꾸는 PR, 공개 릴리스에서 Windows 작업을 실행합니다. 앱 코드(`src/**` 등)만 바꾼 PR은 [checks.yml](../.github/workflows/checks.yml)의 빠른 검사만 실행하므로, 그 커밋의 설치 파일이 필요하면 Actions에서 **Run workflow**로 수동 실행합니다.

1. 커밋 SHA로 고정한 공식 Actions로 Node.js와 pnpm을 준비합니다.
2. `pnpm install --frozen-lockfile`로 잠긴 의존성을 설치합니다.
3. `pnpm test`를 통과한 뒤 `pnpm desktop:build`로 실제 SDK/C++ 엔진과 설치 파일을 만듭니다. 네이티브 CTest에 이어 `pnpm native:test`로 실제 helper/VST3 fixture를 검사합니다.
4. [desktop-install-smoke.ps1](../scripts/desktop-install-smoke.ps1)이 실제 NSIS 설치 파일을 공백이 포함된 임시 경로에 현재 사용자용으로 자동 설치합니다. 설치된 실행 파일, HKCU의 `.garak` 연결, 실행 파일 아이콘을 가리키는 `DefaultIcon`, 실행 파일과 프로젝트 경로를 모두 따옴표로 감싼 열기 명령을 확인합니다.
5. `GARAK_ELECTRON_EXECUTABLE`로 설치된 편집기 실행 파일을 지정한 뒤 `pnpm desktop:test`가 앱 로딩, 프로젝트 생성, 저장과 재실행 후 복원을 확인합니다. MCP 검사는 같은 설치 폴더의 `garak-mcp.exe`를 통해 키 생성·stdio 종료·편집기와의 loopback 연결을 확인하는 별도 경로입니다.
6. 같은 커밋의 대응 소스 ZIP을 준비하고, 설치 파일·소스 ZIP의 SHA-256 체크섬과 함께 Artifact로 업로드합니다.

실행 검사가 남긴 `release/desktop-smoke/` 자료는 별도 Artifact인 `garak-ieum-desktop-smoke-<커밋 SHA>`에 보관합니다. 이 업로드 단계는 앞선 단계의 성공 여부와 관계없이 실행되므로 실패 원인을 조사할 수 있습니다. 실행 검사에 도달하지 못했거나 자료가 만들어지지 않았다면 해당 Artifact는 없을 수 있습니다. 진단 자료가 업로드되었다는 사실은 설치 파일 검증 성공을 뜻하지 않으며, 설치 파일은 모든 앞선 단계가 성공해야 업로드합니다. 진단 자료의 보관 기간도 14일입니다.

설치 검사는 GitHub가 제공하는 일회성 Windows runner에서만 실행하도록 제한되어 있으며, 결과는 `release/desktop-smoke/installer-association.json`에 기록합니다. 앱 실행 검증에는 별도의 임시 사용자 프로필을 사용합니다. 개발자의 평소 작업 프로필을 테스트 데이터로 덮어쓰지 않습니다. 별도 실행 파일을 검사할 때는 `GARAK_ELECTRON_EXECUTABLE`로 경로를 지정할 수 있습니다.

이 검증은 자동 설치와 레지스트리 등록, 설치된 앱의 실행 및 프로젝트 저장을 확인합니다. 탐색기 화면에서 아이콘이 그려지는 모습이나 실제 마우스 더블클릭, 설치 제거, NSIS 설치 마법사의 수동 조작, 실제 오디오 인터페이스 녹음과 오디오 청취 품질은 별도 확인 항목입니다. 워크플로는 저장소 읽기 권한만 사용하며 인증서·배포 토큰이나 자동 Releases 게시를 요구하지 않습니다.

## 6. 구성과 AI 연결

Electron main은 `dist-desktop/main.js`, preload는 `dist-desktop/preload.cjs`, 화면은 `dist`에서 실행됩니다. 화면에서 사용할 수 있는 데스크톱 기능은 프로젝트 열기·내보내기 등 좁은 API로 연결하며 일반 파일시스템 접근을 직접 노출하지 않습니다.

네이티브 helper는 `resources/native/garak-audio-host.exe`, 의존성 고지는 `resources/native/licenses/`에 포함합니다. [native-audio 서비스](../desktop/native-audio.ts)는 명령·파일 권한·승인한 플러그인 카탈로그를 검증합니다. 오디오 샘플마다 renderer/IPC를 왕복하지 않으며 플러그인 진단 stdout은 제어 프로토콜과 분리합니다. 플러그인 crash는 오디오 호스트를 종료할 수 있지만 편집 화면은 별도 프로세스입니다.

MCP 코드는 `dist-mcp`에 함께 빌드됩니다. Windows 설치 폴더에는 **편집기 `가락이음.exe`**와 **MCP 콘솔 실행 파일 `garak-mcp.exe`**가 함께 들어 있습니다. AI 클라이언트의 MCP `command`에는 `garak-mcp.exe`의 절대 경로를 지정하고 `args`에 `["--mcp"]`를 넣습니다. `garak-mcp.exe --mcp-token`은 연결 키를 만드는 명령입니다. 연결 키는 MCP 클라이언트의 `GARAK_MCP_TOKEN` 환경 변수로 전달합니다. [설정 예제와 연결 순서](MCP.md#설치형-앱에서-연결)

콘솔 실행 파일은 같은 폴더의 Electron 런타임을 Node 모드로 실행하고 `resources/app.asar/dist-mcp/mcp/server.js` 또는 `token.js`를 사용합니다. 표준 입출력은 AI 호스트와 서버 사이에 유지하고 안내는 stderr로 보냅니다. `ELECTRON_RUN_AS_NODE`는 자식 프로세스에만 적용하며 사용자가 전역 환경 변수로 설정할 필요는 없습니다. helper와 편집기 실행 파일·`resources` 폴더를 함께 유지합니다. 이 구성은 Electron의 [Node 모드와 ASAR 지원](https://www.electronjs.org/docs/latest/api/environment-variables)에 의존하므로 패키징에서 `RunAsNode` fuse를 유지해야 합니다. [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)

일반 편집기를 여는 것만으로 MCP 브리지가 자동 시작되지는 않습니다. MCP 서버는 GUI 프로필이나 IndexedDB를 직접 열지 않고, 사용자가 연결한 편집기의 로컬 브리지를 통해 현재 프로젝트에 접근합니다. 소스에서 MCP를 실행할 때는 기존 `node dist-mcp/mcp/server.js` 경로를 사용합니다.

데스크톱 앱의 패키징·자동 저장과 AI 서버 연결은 각각의 실행 경로를 가집니다. 새 기능의 구현·검증 상태는 [구현 상태](IMPLEMENTATION_STATUS.md)에 기록합니다.
