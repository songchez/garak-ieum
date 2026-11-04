# 가락이음 macOS 데스크톱

2026-11-04 · Electron 기반 Apple Silicon 개발 프리뷰

macOS용 가락이음은 **DMG 안의 `가락이음.app`을 응용 프로그램 폴더에 복사하는 방식**으로 설치합니다. 앱을 실행할 때 Node.js나 pnpm을 따로 설치할 필요는 없습니다. Windows의 NSIS `.exe` 배포는 그대로 유지합니다.

## 설치 파일과 지원 범위

macOS는 **Apple Silicon(M 시리즈, arm64) Mac만 지원**합니다. 설치 파일은 `Garak-Ieum-Setup-<버전>-arm64.dmg`입니다.

**Apple 메뉴 → 이 Mac에 관하여**에서 칩을 확인합니다. 자동 검증은 `macos-15` ARM64 runner에서 수행하며, 더 오래된 macOS에서의 실행·장치 호환성을 검증했다는 뜻은 아닙니다. 패키지의 실제 최소 OS 값은 CI 진단 `macos-install.json`의 `minimumSystemVersion`에 기록합니다. [GitHub runner 환경](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

[Actions → macOS desktop](https://github.com/songchez/garak-ieum/actions/workflows/macos.yml)에서 사용할 커밋의 **성공한 실행**을 열고 `garak-ieum-macos-arm64-<SHA>` Artifact를 받습니다. GitHub Artifact 운반용 압축을 풀면 실제 설치용 DMG가 들어 있습니다. DMG를 열어 앱을 응용 프로그램 폴더에 드래그한 다음 디스크 이미지를 추출합니다.

현재 CI는 **ad-hoc 서명 프리뷰**를 만듭니다. 이 서명은 패키지 무결성 검사에 사용하며, **Apple Developer ID 서명이나 Apple 공증(notarization)을 받은 배포본이 아닙니다.** CI가 실행에 성공하더라도 인터넷에서 받은 파일에 대한 Gatekeeper 승인을 증명하지 않습니다. 일반 사용자에게 공개할 정식 다운로드는 아래 배포 서명·공증 절차와 별도 실기 검증을 마친 빌드로 준비합니다. 이 저장소는 보안 기능이나 격리를 해제하는 설치 스크립트를 제공하지 않습니다. [Electron 코드 서명](https://www.electronjs.org/docs/latest/tutorial/code-signing)

Artifact에는 DMG, 같은 버전·커밋의 `Garak-Ieum-Source-<버전>-<커밋 앞 12자리>.zip`, `SOURCE.txt`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt`, `SHA256SUMS-macos-arm64.txt`가 함께 들어갑니다. DMG와 소스 ZIP의 SHA-256을 비교하려면 해당 폴더에서 다음 명령을 사용합니다.

```sh
shasum -a 256 -c SHA256SUMS-macos-arm64.txt
```

대응 소스 ZIP은 개발·수정·재빌드용입니다. 앱 설치에는 DMG를 사용합니다. Artifact 보관 기간은 14일이며 GitHub Releases에 자동 공개하지 않습니다. 외부 재배포 시 정확히 일치하는 대응 소스와 라이선스 고지를 함께 제공하는 방법은 [GPL 배포 안내](LICENSING.md)를 따릅니다.

## 프로젝트, 파일 아이콘과 마이크

`.garak`은 `com.garakieum.project` UTI로 등록되며 앱과 프로젝트 파일에 가락이음 브랜드 아이콘을 사용합니다. Finder에서 파일을 열면 앱으로 전달하고, 실행 중인 앱이 있으면 기존 창에서 가져옵니다. 이미 다른 기본 앱이 연결되어 있다면 Finder의 **다음으로 열기**에서 가락이음을 선택할 수 있습니다. 설치 과정에서 사용자의 기본 앱 선택을 강제로 바꾸지 않습니다.

프로젝트와 원본 오디오는 앱의 사용자 프로필에 자동 저장됩니다. macOS에서는 일반적으로 `~/Library/Application Support/GarakIeum`을 사용합니다. 앱 번들과 프로필은 별개이므로 중요한 작업은 원본 오디오가 포함된 `.garak` 파일로 내보내 보관하세요. Windows와 macOS는 같은 프로젝트 파일 형식을 사용합니다.

녹음할 때 앱 안의 확인과 macOS 마이크 권한 요청을 거칩니다. 앱 패키지에는 한국어 권한 설명과 오디오 입력 entitlement를 넣습니다. 실제 마이크·오디오 인터페이스의 녹음, 재생 지연, 권한 거절과 재허용은 장치가 있는 Mac에서 별도로 검증해야 합니다. CI는 물리 장치 녹음이나 권한 승인을 대신하지 않습니다. [Electron 마이크 권한](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos)

현재 음원 재생·녹음 엔진은 기존 **Web Audio**입니다. macOS 설치 파일 추가가 네이티브 ASIO·VST3·Audio Unit 호스트 구현을 뜻하지 않습니다. ASIO는 Windows 네이티브 오디오 계획에서 다루며, macOS 네이티브 엔진은 별도 Core Audio 설계·검증 대상입니다. [네이티브 오디오 계획](NATIVE_AUDIO.md)

## 소스에서 빌드하기

Apple Silicon Mac에 arm64 Node.js 24와 pnpm 11.25.0을 준비합니다. 현재 빌드 스크립트는 Linux/Windows의 macOS 크로스 빌드와 Rosetta 빌드를 허용하지 않습니다.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm desktop:build:mac --arm64
pnpm desktop:test
pnpm desktop:source
```

`desktop:build:mac`은 웹 에셋·MCP·Electron 코드를 빌드한 뒤 arm64 DMG를 생성합니다. `--arm64` 인수는 생략할 수 있으며 다른 아키텍처는 허용하지 않습니다. 기본 모드는 ad-hoc 서명입니다. 이 모드에서는 서명·공증 자격 증명 환경 변수를 자식 빌드에 전달하지 않고, 인증서가 필요 없는 ad-hoc 서명을 PR에서도 수행한 다음 실제 번들 서명을 검증합니다. `desktop:source`는 빌드와 소스가 같은 **깨끗한 Git 커밋**일 때만 소스 ZIP을 생성합니다.

`desktop:install:mac:test`는 일회성 **GitHub-hosted macOS runner에서만** 실행됩니다. DMG를 읽기 전용으로 연결하고, 공백이 있는 임시 경로로 앱을 복사한 뒤 이미지를 해제합니다. 실제 `/Applications`와 사용자 프로젝트는 수정하지 않습니다. 번들 ID·버전·아이콘·UTI·CPU·서명·entitlement를 검증하고 설치한 실행 파일을 후속 스모크 검사에 전달합니다.

고정된 electron-builder 26.18은 한글 실행 파일과 Helper 이름을 NFD로 작성하므로, macOS `CFBundleName`·`CFBundleDisplayName`에도 같은 표현을 명시합니다. 표시되는 앱 이름은 **가락이음**으로 유지합니다. 설치 검사는 문자열 정규화로 차이를 숨기지 않고 실제 Helper 디렉터리·실행 파일·plist 이름이 정확히 일치하는지 비교합니다. 향후 빌더를 올릴 때에는 이 검사를 유지하면서 [상위 프로젝트의 이름 일치 수정](https://github.com/electron-userland/electron-builder/pull/9962)에 맞춰 설정을 다시 확인합니다.

기존 패키지 스모크는 격리한 임시 프로필에서 MCP 토큰·오류·표준 입출력·EOF 종료·JSON-RPC·실제 GUI 인증 연결, 렌더러 보안, GPL/소스 고지, BPM 숫자 편집·박자표, 프로젝트와 WAV 내보내기, 메뉴·파일 전달, 정상 종료·재시작 저장 복원을 검사합니다. macOS CI에는 실제 클립보드로 프로젝트 이름·MCP 키 붙여넣기, MIDI 클립의 선택·복사·붙여넣기·잘라내기·Undo/Redo와 파일 열기·저장 단축키, Launch Services를 통한 `.garak` 열기를 추가합니다. 텍스트 포커스 여부만 격리된 preload에서 전달하여 네이티브 텍스트 편집과 DAW 편집 단축키를 구분합니다. 검증 결과와 화면은 `garak-ieum-macos-smoke-arm64-<SHA>` Artifact에 저장합니다. **성공 여부는 해당 커밋의 CI 결과로 확인합니다.**

키보드 검사는 앱 활성화와 포커스 전달을 기다린 다음, [Electron의 공식 메뉴 검사](https://github.com/electron/electron/blob/v45.2.1/spec/api-web-contents.spec.ts)와 같은 CDP 네이티브 키 이벤트로 `⌘C/V/X/Z`, `⇧⌘Z`, `⌘O/S`를 보냅니다. Mac의 A 키코드 0은 이 CDP 경로가 네이티브 메뉴로 전달하지 못하므로 텍스트 전체 선택은 Playwright 편집 명령으로 준비하고, DAW의 `⌘A`는 렌더러 단축키 동작을 검사합니다. 텍스트 `⌘A`를 물리 키보드와 같은 AppKit 경로로 검증한 것으로 해석하지 않습니다.

## 정식 배포 서명과 공증 준비

현재 빌드는 `electron-builder 26.18.0`을 고정해서 사용합니다. 설정 키는 이 버전의 `mac.identity`, `mac.entitlements`, `mac.hardenedRuntime`, `mac.notarize` 구조를 따릅니다. [v26 macOS 설정](https://www.electron.build/v26/docs/mac/) · [v26 공증 절차](https://www.electron.build/v26/docs/features/code-signing/notarization/)

정식 배포 담당자는 Apple Developer ID Application 인증서와 공증 권한을 준비한 뒤, 신뢰할 수 있는 배포 환경에서만 다음 명령을 실행합니다.

```sh
pnpm desktop:build:mac --arm64 --signed
```

인증서는 배포용 키체인 또는 `CSC_LINK`·`CSC_KEY_PASSWORD` 환경 변수로 전달합니다. 자동 검색을 사용할 때는 CI 프리뷰용 `CSC_IDENTITY_AUTO_DISCOVERY=false` 설정을 해제해야 합니다. 공증에는 `APPLE_ID`·`APPLE_APP_SPECIFIC_PASSWORD`·`APPLE_TEAM_ID`의 완전한 조합 또는 미리 설정한 `APPLE_KEYCHAIN_PROFILE`(필요 시 `APPLE_KEYCHAIN`)을 사용합니다. 자격 증명 값은 저장소, 로그, PR에 넣지 않습니다. 현재 PR 검사 workflow에는 이 자격 증명을 연결하지 않습니다.

`--signed`는 공증 설정 누락을 빌드 전에 거부하고 `forceCodeSigning`과 공증을 활성화합니다. 빌드 후 앱에 대해 `codesign --verify --deep --strict`, `xcrun stapler validate`, `spctl --assess --type execute`가 모두 성공해야 완료됩니다. 기본 ad-hoc 모드는 이 정식 배포 검증을 통과한 것으로 표시하지 않습니다. 정식 파일을 공개하기 전에는 인터넷에서 내려받은 DMG로 새 Mac 사용자 환경의 설치·실행과 물리 오디오 장치를 확인합니다.

## macOS MCP 연결

macOS에서는 Windows 전용 `garak-mcp.exe` 대신 앱 번들 내부 실행 파일을 직접 사용합니다.

```sh
"/Applications/가락이음.app/Contents/MacOS/가락이음" --mcp-token
```

AI 클라이언트의 MCP `command`에는 같은 실행 파일의 절대 경로를, `args`에는 `["--mcp"]`를 지정합니다. 생성한 연결 키는 `GARAK_MCP_TOKEN` 환경 변수로 전달하며 공개 설정이나 로그에 붙이지 않습니다. 앱의 **AI 연결**에서 같은 로컬 브리지에 연결합니다. [MCP 연결 안내](MCP.md)
