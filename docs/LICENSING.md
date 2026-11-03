# 코드 라이선스와 소스 배포

2026-11-03 · 가락이음 0.1.1부터 적용

## 코드에 적용하는 라이선스

가락이음 프로그램의 코드 배포 라이선스는 **GNU General Public License version 3 only (`GPL-3.0-only`)**입니다. 저작권은 `Copyright (c) 2026 가락이음 contributors`로 표시합니다. [LICENSE](../LICENSE)에 전문을 포함합니다. GNU GPL v3의 조건에 따라 사용·수정·재배포할 수 있으며, 관련 법률이 허용하는 범위에서 보증 없이 제공합니다.

사용자가 2026-11-03에 ASIO 지원을 위한 GPL 경로를 선택했습니다. ASIO SDK는 GPL v3와 Steinberg proprietary 라이선스 중 하나를 선택할 수 있으므로, 이 프로젝트는 앞으로 SDK를 도입할 때 **GPL v3 경로**를 사용합니다. 별도의 proprietary 계약을 체결하는 경로는 사용하지 않습니다. 라이선스 전환 자체가 ASIO 또는 VST3 기능의 구현을 뜻하지는 않습니다. 실제 엔진 진행 상태는 [네이티브 오디오 계획](NATIVE_AUDIO.md)을 따릅니다. [ASIO SDK 라이선스 원문](https://github.com/audiosdk/asio/blob/main/LICENSE.txt)

## 기존 MIT 코드와 외부 자산

전환 전 MIT 허가로 제공한 코드의 저작권·허가 고지는 [이전 MIT 고지](../public/licenses/garak-ieum-MIT-notice.txt)에 그대로 보존합니다. 이전에 MIT로 받은 코드에 대한 권리를 소급하여 취소하지 않습니다. 현재 프로그램을 배포할 때에는 GPL v3의 조건과 기존 코드의 보존 고지를 함께 따릅니다. [GNU 라이선스 호환성 설명](https://www.gnu.org/licenses/license-compatibility.html)

외부 라이브러리·아이콘·글꼴·샘플 음원은 각각의 원래 라이선스를 유지합니다. 앱 라이선스 전환으로 이들 자산에 다른 권리를 부여하지 않습니다. [제3자 고지](../THIRD_PARTY_NOTICES.md), 각 자산 디렉터리의 라이선스와 출처를 확인하세요. 빌드 시 설치된 JavaScript 실행 의존성의 실제 LICENSE·NOTICE도 모아 앱에 포함합니다. Electron 배포물의 `LICENSE.electron.txt`와 `LICENSES.chromium.html`도 유지합니다.

프로그램의 GPL 라이선스만을 이유로 사용자가 새로 만든 곡·녹음·프로젝트 결과물에 GPL이 적용되지는 않습니다. 제공된 샘플이나 다른 저작물을 결과물에 사용하는 경우에는 그 자산의 별도 조건을 확인해야 합니다. [GNU 프로그램 출력물 FAQ](https://www.gnu.org/licenses/gpl-faq.html#GPLOutput)

## 설치 파일과 소스를 함께 제공하기

GPL은 유료 배포를 허용합니다. 배포하지 않고 개인적으로 사용하는 수정본을 공개해야 하는 것도 아닙니다. 다만 다른 사람에게 실행 파일을 전달할 때에는 해당 실행 파일에 대응하는 소스와 GPL의 고지를 제공해야 합니다. 공개 GitHub 저장소가 있다는 사실만으로 설치 파일 버전과의 대응 관계가 설명되지는 않습니다. [GNU 배포 FAQ](https://www.gnu.org/licenses/gpl-faq.html#DistributeExtendedBinary) · [GPL v3 제1·5·6조](https://www.gnu.org/licenses/gpl-3.0.html)

Windows CI는 깨끗한 Git 체크아웃에서 다음 파일을 같은 Artifact에 묶습니다.

| 파일 | 목적 |
|---|---|
| `Garak-Ieum-Setup-<버전>-x64.exe` | 사용자가 실행하는 Windows 설치 파일 |
| `Garak-Ieum-Source-<버전>-<커밋 앞 12자리>.zip` | 해당 커밋의 프로젝트 소스 전체, 자산, 잠금 파일, 빌드·설치 스크립트 |
| `SOURCE.txt` | 빌드 버전·전체 커밋·소스 위치와 빌드 안내 |
| `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` | GPL 전문과 외부 의존성·자산 고지 |
| `SHA256SUMS.txt` | 설치 파일과 소스 묶음의 SHA-256 |

소스 ZIP에는 `.git`, `node_modules`, 비밀 설정, 빌드 캐시를 넣지 않습니다. 이 ZIP은 개발·수정용이며 설치에는 `.exe`만 필요합니다. 소스를 다운로드한 사람도 빌드할 수 있도록 `SOURCE_VERSION.json`을 넣습니다. `pnpm install --frozen-lockfile` 이후 [데스크톱 빌드 절차](DESKTOP.md#4-소스에서-실행하고-빌드하기)를 따릅니다. 설치된 일반 Windows PC에서 수정본을 빌드·설치하는 데 프로젝트 전용 서명 키나 라이선스 키는 필요하지 않습니다.

직접 만든 설치 파일을 배포할 때에는 소스 변경을 먼저 커밋하고 같은 체크아웃에서 `pnpm desktop:build`, 검증, `pnpm desktop:source`를 차례로 실행합니다. 소스 생성 명령은 변경 중인 체크아웃이나 다른 커밋에서 만든 `dist`를 거부합니다. 소스 묶음에는 빌드에 쓴 전체 커밋을 기록하고, 설치된 앱의 **정보 → 배포본 소스 안내**에서도 확인할 수 있습니다.

이 프로젝트 소스 묶음은 의존성 전체의 소스 보관을 대신하지 않습니다. `pnpm-lock.yaml`의 의존성 버전, 기존 Signalsmith WASM의 [원본 커밋과 추출 안내](../src/devices/pitch-editor/vendor/README.md), 사용한 런타임의 소스 제공 경로도 해당 배포 버전에 맞춰 유지해야 합니다. 네이티브 엔진과 ASIO SDK를 추가할 때에는 실제로 결합한 SDK·라이브러리의 소스, 패치, 인터페이스 정의, 빌드·설치 스크립트와 고지를 대응 소스에 포함해야 합니다. 잠금 파일이나 상위 저장소 링크만으로 필요한 소스가 모두 제공되었다고 간주하지 않습니다.

## 공개 다운로드에 적용할 조건

GitHub Releases와 랜딩 페이지에서 설치 파일을 제공할 때에는 **같은 버전의 소스 다운로드 링크**를 설치 파일 옆에 함께 제공합니다. 소스는 추가 비용 없이 동등하게 접근할 수 있어야 하며, 바이너리만 남기고 대응 소스가 만료되도록 해서는 안 됩니다. GitHub Actions Artifact는 현재 14일 보관이므로 지속적인 공개 다운로드에는 별도 Releases 자산으로 함께 옮겨야 합니다. [GNU 소스 접근 FAQ](https://www.gnu.org/licenses/gpl-faq.html#SourceAndBinaryOnDifferentSites)

이 변경에는 공개 Release 게시나 ASIO 드라이버·SDK 바이너리 재배포를 포함하지 않습니다. 실제 ASIO 장치 지원과 배포 검증의 완료 조건은 [네이티브 오디오 계획](NATIVE_AUDIO.md)에 기록합니다.
