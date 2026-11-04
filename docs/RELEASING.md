# 공개 설치 파일 릴리스

설치 파일은 이 저장소의 [GitHub Releases](https://github.com/songchez/garak-ieum/releases)에 공개합니다. **Windows x64 설치 EXE와 Apple Silicon Mac DMG를 같은 커밋에서 만들고, 두 플랫폼의 설치·실행 검사가 모두 성공한 뒤 한 릴리스로 공개**합니다. 랜딩 페이지는 공개된 릴리스와 첨부 파일을 읽어 최신 다운로드 및 버전별 다운로드를 표시합니다.

공개 여부는 `release.config.json`의 버전·채널·`publish` 설정으로 결정합니다. 일반 코드 push는 테스트용 빌드를 만들고, 발행을 요청한 릴리스 설정 변경이 `main`에 반영되면 검증 후 GitHub Releases에 게시합니다. 같은 설정을 유지한 후속 커밋은 이미 공개한 버전을 다시 게시하지 않습니다. CI의 임시 artifact는 GitHub 로그인과 보관 기간이 필요하므로 랜딩의 공개 다운로드로 사용하지 않습니다.

## 1. 커밋에서 버전과 발행 여부 설정

Node.js 24와 프로젝트의 pnpm 버전을 준비하고 앱 저장소에서 실행합니다.

```bash
pnpm release:prepare --version 0.1.2-rc.1 --channel preview --publish
```

이 명령은 다음 파일만 준비합니다.

- `package.json`: 앱과 설치 파일의 버전
- `release.config.json`: 공개할 버전, 채널, 발행 여부, 노트 경로
- `releases/0.1.2-rc.1.md`: 새 릴리스 노트 초안. 이미 있는 노트는 덮어쓰지 않습니다.

명령 자체는 커밋, 태그, 업로드 또는 공개를 수행하지 않습니다. 릴리스 노트를 작성하고 아래 검사를 통과시킨 뒤 세 파일을 함께 커밋하여 `main`에 반영합니다. PR만 열거나 기능 브랜치에 푸시하면 공개하지 않습니다.

```bash
pnpm release:check
pnpm release:test
```

생성되는 설정 예시입니다.

```json
{
  "schemaVersion": 1,
  "version": "0.1.2-rc.1",
  "channel": "preview",
  "publish": true,
  "notes": "releases/0.1.2-rc.1.md"
}
```

| 설정 | 동작 |
| --- | --- |
| `version` | `package.json`과 정확히 일치하는 SemVer. 태그는 `v<version>`으로 생성합니다. `+build` 메타데이터는 사용하지 않습니다. |
| `channel: "preview"` | GitHub prerelease로 공개합니다. 최신 정식 버전을 덮어쓰지 않습니다. |
| `channel: "stable"` | 정식 릴리스로 공개합니다. 버전에 `-rc.1` 등의 prerelease 접미사를 사용할 수 없습니다. |
| `publish: false` | 검증만 수행하고 공개 빌드와 발행을 시작하지 않습니다. |
| `publish: true` | `main` push에서 직전 커밋 상태와 설정 내용이 달라졌을 때 발행을 요청합니다. |
| `notes` | `releases/` 바로 아래에 있는 Markdown 파일. 공개 릴리스 본문에 사용합니다. |

발행 없이 버전만 준비하려면 `--publish`를 생략합니다. 기본 채널은 `preview`입니다. 다른 노트 파일을 쓰려면 `--notes releases/0.1.2.md`처럼 ASCII 파일명으로 경로를 지정합니다.

```bash
# 아직 공개하지 않을 작업 버전
pnpm release:prepare --version 0.1.2-rc.2 --channel preview

# 검토를 마친 정식 버전
pnpm release:prepare --version 0.1.2 --channel stable --publish
```

**발행 여부는 커밋 메시지가 아니라 커밋에 들어 있는 설정으로 결정합니다.** `publish: true`를 유지한 상태에서 일반 앱 코드를 커밋하거나 릴리스 노트만 수정해도 다시 발행하지 않습니다. JSON의 공백과 키 순서만 바꾸는 경우에도 발행하지 않습니다. 한 push에 여러 커밋이 포함되면 push 직전 상태와 마지막 커밋의 최종 설정을 비교하고, 마지막 커밋 한 개를 릴리스합니다.

이미 쓴 버전은 다시 사용할 수 없습니다. 예를 들어 `0.1.2-rc.1` 프리뷰 다음에 `0.1.2` 정식을 발행합니다. 동일 `0.1.2`를 프리뷰로 공개한 뒤 같은 태그를 정식으로 덮어쓰는 흐름은 지원하지 않습니다.

## 2. 자동 검증과 공개 순서

`.github/workflows/release.yml`의 **Public desktop release**가 다음 순서로 실행됩니다.

1. 설정과 릴리스 보호 로직을 검사하고 `main`의 정확한 push 전후 커밋을 확인합니다.
2. 기존 Windows/macOS 워크플로를 재사용해 잠긴 의존성을 설치하고 앱 테스트, 설치본 빌드, 실제 설치 검사, 설치한 앱의 스모크 테스트를 실행합니다. Windows 파일 연결과 macOS 번들 확인도 그대로 포함됩니다.
3. 두 플랫폼에서 설치 파일과 동일 커밋의 프로젝트 소스 ZIP 및 SHA-256 체크섬을 만듭니다.
4. 같은 워크플로 실행에서 성공한 Windows/Mac artifact만 가져옵니다. 파일 목록, 버전, 해시, 소스 ZIP의 전체 커밋 SHA, `SOURCE_VERSION.json`, 라이선스 문서를 검증합니다.
5. 기존 버전 태그나 공개/비공개 draft가 없는지 확인한 다음 비공개 draft를 만들고 모든 파일을 업로드합니다.
6. GitHub가 계산한 각 첨부 파일의 SHA-256, 크기, 이름, 업로드 상태 및 전체 목록을 다시 검증합니다. 완료된 시점에 새 태그를 검사한 커밋에 원자적으로 생성하고 draft를 공개합니다.

**검증 빌드와 릴리스 빌드의 차이:** PR과 일반 `main` push의 검증 빌드는 네이티브 오디오 호스트의 입력(`native/**`, 네이티브 빌드 스크립트, CMake 버전)이 이전 빌드와 같으면 캐시한 호스트를 재사용하고(`GARAK_NATIVE_REUSE=1`), Windows 설치 파일을 무압축(`compression=store`)으로 만들어 시간을 줄입니다. 설치·실행 검사와 smoke는 그대로 실행합니다. 공개 릴리스 빌드(`release_build`)는 캐시를 쓰지 않고 네이티브 호스트와 ctest를 처음부터 다시 실행하며, 설정된 압축으로 설치 파일을 만듭니다.

어느 플랫폼이든 테스트에 실패하거나 파일이 빠졌거나 해시가 다르면 공개하지 않습니다. Windows/Mac 소스 ZIP은 바이트 단위로 같아야 합니다. Git의 자동 줄바꿈 변환, ZIP 압축 구현 및 시간대에 의한 차이를 막기 위해 소스 묶음은 LF/UTC와 무압축 ZIP으로 생성합니다. 라이선스 안내 텍스트는 플랫폼별 CRLF/LF 차이만 정규화하여 비교합니다.

각 릴리스 커밋의 빌드는 후속 일반 커밋 때문에 취소하지 않으며, 같은 버전의 공개 작업은 직렬화합니다. 새 태그 생성은 기존 태그가 생겨 있으면 실패하고 태그 갱신 API를 호출하지 않습니다. 정식 릴리스의 최신 표시에는 GitHub의 `make_latest: legacy` 정책을 사용합니다.

## 3. 공개 다운로드 주소와 파일 계약

예를 들어 버전 `0.1.2`, 소스 커밋이 `abcdef123456…`인 경우:

| 용도 | 첨부 파일명 |
| --- | --- |
| Windows 64비트 설치 | `Garak-Ieum-Setup-0.1.2-x64.exe` |
| Apple Silicon Mac 설치 | `Garak-Ieum-Setup-0.1.2-arm64.dmg` |
| 동일 커밋 프로젝트 소스 | `Garak-Ieum-Source-0.1.2-abcdef123456.zip` |
| 모든 공개 파일의 체크섬 | `SHA256SUMS.txt` (자기 자신 제외) |
| Windows 설치본과 소스 체크섬 | `SHA256SUMS-windows-x64.txt` |
| Mac 설치본과 소스 체크섬 | `SHA256SUMS-macos-arm64.txt` |
| 소스·코드·외부 자산 고지 | `SOURCE.txt`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` |

고정 버전 페이지와 다운로드 주소의 형식은 다음과 같습니다. 예시 버전이 실제 공개되어 있어야 파일이 내려받아집니다.

```text
https://github.com/songchez/garak-ieum/releases/tag/v0.1.2
https://github.com/songchez/garak-ieum/releases/download/v0.1.2/Garak-Ieum-Setup-0.1.2-x64.exe
https://github.com/songchez/garak-ieum/releases/download/v0.1.2/Garak-Ieum-Setup-0.1.2-arm64.dmg
```

랜딩은 공개 Releases의 `tag_name`, `draft`, `prerelease`, `published_at`, `html_url`과 첨부 파일의 `name`, `browser_download_url`, `size`, `state`를 검사합니다. 설치 파일의 SHA-256은 위 게시 단계에서 검증하고 랜딩에는 사용자가 확인할 체크섬 파일 링크를 제공합니다. 프리뷰도 표시하려면 `/releases/latest`만 사용하지 말고 릴리스 목록을 조회해야 합니다. 파일 이름을 유지하면 버전을 올릴 때 랜딩 코드를 수정할 필요가 없습니다. draft는 공개 목록에 나타나지 않습니다.

## 4. 실패 및 재실행

**draft가 만들어지기 전** 실패했다면 오류를 고친 뒤 새 릴리스 커밋을 만들거나, 외부 일시 장애인 경우 같은 Actions 실행의 실패한 작업을 재실행할 수 있습니다. 단순 재시도용 일반 커밋은 설정이 같으므로 새 발행 요청이 되지 않습니다.

**draft 또는 태그를 만든 뒤** 실패했다면 Releases와 Tags를 먼저 확인합니다. 불완전한 draft는 공개하지 않습니다. 파이프라인은 기존 파일·draft·태그를 자동으로 삭제하거나 덮어쓰지 않으며, 재실행에서도 해당 버전을 거부합니다. 검토 후 실패한 draft와 그 실행에서만 생성된 미공개 버전 태그를 관리자가 정리하거나, 새로운 버전을 준비하세요. 이미 공개한 버전은 새 버전으로 수정합니다. 공개 API 응답을 받는 도중 연결이 끊긴 경우에는 실제 공개가 완료됐을 수 있으므로 특히 먼저 확인해야 합니다.

권한은 기본 `contents: read`, 최종 게시 작업만 `contents: write`입니다. 별도 PAT나 저장소 간 write 토큰이 필요하지 않습니다. 저장소 규칙이 태그/릴리스 생성을 막거나, 빌드 중 `main`의 워크플로가 바뀌어 GitHub가 추가 권한을 요구하면 안전하게 중단합니다. 이 경우 최신 소스로 새로운 릴리스 커밋을 준비하거나 저장소 규칙을 확인하며, 권한 오류를 우회하기 위한 토큰을 자동으로 추가하지 않습니다.

## 5. 배포 범위와 현재 제한

- Windows는 x64 설치 EXE, Mac은 Apple Silicon arm64 DMG만 배포합니다.
- 현재 Windows 설치 파일에는 신뢰된 배포자 서명이 없고, Mac은 ad-hoc 서명으로 Developer ID 서명·공증이 적용되어 있지 않습니다. 공개 여부와 코드 서명 여부는 별도이며, 이 상태는 릴리스 본문에도 표시합니다.
- 릴리스 파이프라인은 현재 앱을 검증하여 배포합니다. 새 ASIO/VST 오디오 기능이나 자동 업데이트 엔진을 추가하지 않습니다.
- 소스 ZIP은 앱 설치용이 아니라 GPL 소스 제공 및 개발·수정용입니다. 설치는 EXE/DMG를 사용합니다.

## 구현과 검증

새 릴리스 검사기는 Node.js 표준 모듈만 사용하며 별도 의존성이 없습니다.

```bash
node --test scripts/release-tests.mjs
node scripts/release-config.mjs check
```

테스트는 임시 Git 저장소와 가상 GitHub 응답으로 설정 변경 판정, 실제 Git ZIP 메타데이터, 누락·변조·다른 커밋 거부, 기존 릴리스 보호, 비공개 업로드 후 공개 순서를 검사합니다. 이 테스트 자체는 GitHub를 호출하거나 실제 태그/릴리스를 만들지 않습니다. 실제 Windows/Mac 설치·스모크 검사는 각각의 OS 워크플로에서 수행합니다.

공식 동작 참고: [재사용 워크플로](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [워크플로 동시 실행](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [Releases API](https://docs.github.com/en/rest/releases/releases), [태그 참조 생성 API](https://docs.github.com/en/rest/git/refs#create-a-reference), [Release asset SHA-256](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/).
