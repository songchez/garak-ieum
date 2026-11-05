# 오디오 코어 개선 계획과 작업 계약 (2026-11-05)

> **상태:** 17개 항목 모두 구현해 `feat/audio-core`에 합쳤습니다. 계약과 실제 구현의 차이는 아래 각 절의 "구현 메모"와 [NATIVE_AUDIO](NATIVE_AUDIO.md)를 따릅니다. 실제 ASIO·Core Audio 장치 검증은 남아 있습니다.

Logic Pro·Ableton Live·Cubase의 장치 처리와 비교해 정한 17개 항목을 구현합니다. 이 문서는 병렬 작업자(WP) 사이의 **공통 계약**입니다. 계약을 바꿔야 하면 작업자가 혼자 바꾸지 말고 보고서에 "계약 변경 제안"으로 적습니다.

## 항목과 작업 묶음

| # | 항목 | WP |
|---|---|---|
| 1 | 드라이버를 열어 채널 이름·개수, 버퍼 범위, 레이트, 클럭, 지연 읽기 (`devices.probe`) | WP1 (네이티브), WP3 (UI) |
| 2 | 버퍼를 드라이버 기준으로 (권장값 기본, 허용값만, 고정이면 제어판 안내) | WP1, WP3 |
| 3 | 드라이버 재설정 요청 시 자동 재시작 | WP1 |
| 4 | 채널 구성 화면 (켜기, 모노/스테레오 쌍, 장치별 이름) | WP3 |
| 5 | 실패 원인을 코드로 구분하고 해결 동작 제공 | WP1 (코드), WP3 (UI) |
| 6 | 분리·재연결 감지와 자동 복구 | WP1 |
| 7 | 트랙별 입력 선택 + 동시 다중 녹음 | WP2 (엔진·호스트·데스크톱), WP4 (프로젝트·UI·App) |
| 8 | 다른 장비에서 연 프로젝트의 입력 재연결 | WP4 |
| 9 | 샘플레이트 불일치 처리 (거절 대신 선택지) | WP3 |
| 10 | 루프백 지연 측정 + 샘플 단위 보정 | WP2 (측정), WP3 (마법사 UI) |
| 11 | 트랙 모니터 In/Auto/Off | WP4 (엔진 쪽은 기존 `monitor.set` 사용) |
| 12 | 클럭 소스 선택, 직접 모니터링 제어 | WP1, WP3 |
| 13 | 백그라운드 시 드라이버 해제 옵션 | WP1 (`device.suspend/resume`), WP3 (설정·창 포커스 연결) |
| 14 | 과부하(언더런·콜백 지연) 즉시 알림 | WP2 (측정), WP3 (알림) |
| 15 | 멀티코어 트랙 처리 | WP5 (2단계) |
| 16 | 실시간이 아닌 트랙 미리 처리 (ASIO-Guard 방식) | WP5 (2단계) |
| 17 | WASAPI 실시간 스레드 우선순위(MMCSS) 확인·적용 | WP1 |

## 파일 소유 범위

동시에 같은 파일을 크게 고치지 않습니다. 아래에 없는 파일은 꼭 필요한 최소 수정만 하고 보고서에 적습니다.

- **WP1 네이티브 장치:** `native/include/garak/device.hpp`, `native/src/device.cpp`, `native/src/host.cpp`의 장치 관련 처리(`devices.*`, `device.*`, `engine.configure`의 장치 부분, `snapshot`의 `device` 부분, `service()`의 장치 복구), 새 `native/tests/device_logic_test.cpp`, `native/CMakeLists.txt`의 테스트 추가.
- **WP2 네이티브 엔진:** `native/include/garak/engine.hpp`, `native/src/engine.cpp`, `native/src/host.cpp`의 `timeline()` 파싱·`monitor.set`·`record.*`·`latency.measure`·과부하 집계, `native/tests/engine_test.cpp`, `desktop/native-audio.ts`, `src/audio/native/timeline.ts`, `src/audio/native/NativeRecording.ts`, `src/audio/native/NativeAudioEngine.ts`의 녹음·모니터·측정 메서드.
- **WP3 설정 UI:** `src/components/NativeAudioSettingsDialog.tsx`와 새 하위 컴포넌트, `src/components/AudioSettingsDialog.css`, `src/core/audioSettings.ts`, `src/audio/native/NativeAudioEngine.ts`의 장치 메서드(`probeDevice`, `configure`, 클럭, 직접 모니터링, `suspend/resume`, 과부하 구독), `src/audio/native/contracts.ts`의 장치 타입, `App.tsx`의 과부하 알림·레이트 불일치·백그라운드 해제 연결(작은 범위).
- **WP4 프로젝트·트랙:** `src/core/types.ts`, `src/core/project.ts`(스키마 8), 트랙 입력·모니터 UI(`TrackHeader`, `TrackInspector`, `Inspector`), `src/core/trackActions.ts`, `App.tsx`의 녹음 흐름(다중 트랙), `src/audio/WebAudioEngine.ts`의 입력 채널 선택, `src/core/ProjectSession.ts`·`src/automation/*`·`mcp/tools.ts`의 트랙 필드 반영.
- `src/audio/native/NativeAudioEngine.ts`는 WP2와 WP3가 **서로 다른 메서드만** 고칩니다. `contracts.ts`는 WP3가 장치 타입, WP2가 녹음·측정 타입을 추가합니다.

## 프로토콜 계약 (호스트 JSON)

기존 요청·응답 형식(`{id, method, params}` → `{id, result}` 또는 `{id, error}`)은 유지합니다.

### 오류 코드 (WP1 정의, 모든 WP 사용)

호스트 오류 응답에 `code`를 더합니다. `{ "id": 7, "error": "사람이 읽는 메시지", "code": "DEVICE_IN_USE" }`. 코드가 없는 기존 오류는 그대로 둡니다. TS는 `Error`에 `code` 속성을 붙여 던집니다.

| 코드 | 뜻 |
|---|---|
| `DEVICE_NOT_FOUND` | 드라이버·장치가 없거나 64비트로 설치되지 않음 |
| `DEVICE_IN_USE` | 다른 앱이 사용 중이라 열 수 없음(ASIO 단일 클라이언트, WASAPI 배타 모드 등) |
| `DRIVER_INIT_FAILED` | 드라이버 초기화 실패(원인 불명) |
| `SAMPLE_RATE_UNSUPPORTED` | 요청한 레이트를 쓸 수 없음. `details.supported`에 가능한 값 |
| `BUFFER_UNSUPPORTED` | 요청한 버퍼를 쓸 수 없음. `details.buffer`에 범위 |
| `CHANNELS_UNAVAILABLE` | 요청한 물리 채널이 없음 |
| `DEVICE_LOST` | 실행 중 장치가 사라짐(복구 시도 중이거나 실패) |

오류 응답은 `details` 객체를 함께 보낼 수 있습니다.

### `devices.probe` (WP1)

`{ backend, deviceId }` → 장치를 **잠깐 열어** 읽고 닫습니다. 현재 실행 중인 장치와 같으면 열지 않고 현재 값을 반환합니다.

```json
{
  "id": "...", "name": "...", "backend": "asio",
  "inputs": [{ "index": 0, "name": "Mic/Inst 1" }],
  "outputs": [{ "index": 0, "name": "Monitor L" }, { "index": 1, "name": "Monitor R" }],
  "sampleRates": [44100, 48000],
  "currentSampleRate": 48000,
  "buffer": { "min": 64, "max": 1024, "preferred": 256, "granularity": -1, "sizes": [64, 128, 256, 512, 1024], "fixed": false },
  "clockSources": [{ "index": 0, "name": "Internal", "current": true }],
  "canDirectMonitor": true,
  "inputLatencyFrames": 312, "outputLatencyFrames": 288
}
```

- `buffer.sizes`는 허용되는 값 목록입니다(권장값 포함, 최대 32개). `fixed`는 min = max일 때 true입니다.
- WASAPI·Core Audio는 알 수 있는 범위만 채우고 나머지는 빈 배열·`null`로 둡니다. 채널 이름이 없으면 `"Input 1"`처럼 번호 이름을 씁니다.
- 테스트 클록은 입력 2, 출력 2와 고정 값을 반환합니다.

### `engine.configure` (WP1)

기존 필드에 더합니다.

- `inputChannelList: number[]` — 열 물리 입력 채널(0부터, 오름차순, 최대 32). 비어 있으면 입력 없음. **기존 `inputChannels`(개수)와 `inputChannelOffset`도 계속 받습니다.** `inputChannelList`가 있으면 그것이 우선합니다.
- `bufferFrames: number | "driver"` — `"driver"`면 드라이버 권장값을 씁니다. 숫자가 허용값이 아니면 ASIO는 **가장 가까운 허용값으로 맞추고** 응답의 `device.bufferFrames`와 `device.bufferAdjusted: true`로 알립니다. 거절하지 않습니다.
- `clockSource?: number`, `directMonitoring?: boolean`.

장치 콜백은 `inputChannelList` 순서대로 **K개 채널을 인터리브**해서 넘깁니다(K = 목록 길이). 엔진은 물리 채널 번호가 아니라 이 순서 인덱스로 받습니다. 호스트가 물리 번호와 인덱스의 대응을 관리합니다.

### `engine.snapshot().device` 추가 필드 (WP1·WP2)

`inputChannelList`, `inputNames`, `outputNames`, `bufferAdjusted`, `recovering`(복구 시도 중), `recoveries`(복구 성공 횟수), `suspended`, `clockSource`, `directMonitoring`, `overloads`(WP2, 누적), `lastCallbackLoad`(WP2, 0~1 이상).

### 장치 복구·해제 (WP1)

- ASIO 재설정·버퍼 변경 요청, WASAPI·Core Audio 중지·경로 변경이 오면 `service()`가 **같은 설정으로 자동 재구성**합니다. 0.25초, 0.5초, 1초, 2초, 이후 2초 간격으로 최대 30초 시도합니다. 그동안 `recovering: true`이고, 성공하면 `recoveries`가 1 늘고 `error`가 비워집니다. 장치가 아예 사라지면 다시 나타날 때까지 같은 간격으로 확인합니다(`DEVICE_LOST`).
- 복구하는 동안 엔진 상태(재생 위치, 녹음)는 유지합니다. 녹음 중이던 테이크는 끊긴 구간을 `discontinuities`로 기록합니다.
- `device.suspend` → 장치를 닫되 설정을 기억합니다(`suspended: true`). `device.resume` → 같은 설정으로 다시 엽니다. 둘 다 녹음 중에는 `DEVICE_IN_USE`가 아닌 일반 오류로 거절합니다.
- `device.clockSource { index }`, `device.directMonitor { enabled }` — 지원하지 않는 장치는 오류를 냅니다.

### 트랙 입력과 다중 녹음 (WP2)

- 타임라인 트랙에 `input: { channels: [p] | [p, p+?] } | null`을 더합니다. `p`는 **물리 입력 채널 번호**입니다. 열려 있지 않은 채널을 가리키면 그 트랙은 무음 입력으로 처리하고 `snapshot().tracksMissingInput`에 트랙 ID를 넣습니다. `null`이면 열린 입력의 첫 채널(1채널) 또는 첫 쌍(2채널 이상)입니다.
- `monitor.set { trackIds, enabled }`는 그대로입니다. 각 트랙은 자기 입력을 모니터링합니다.
- `record.start { takes: [{ trackId }] }` → `{ takes: [{ trackId, takeId, path, channels, startFrame, rawStartFrame, compensationFrames, compensationKnown }], sampleRate }`. 최대 64개, 같은 트랙 중복 불가. 기존 `{ trackId }` 한 개 형식도 계속 받습니다.
- `record.stop` → `{ takes: [ ...기존 단일 응답 필드 + trackId, takeId ] }`. 단일 형식으로 시작한 경우 기존 단일 응답도 함께 넣습니다.
- 데스크톱(`desktop/native-audio.ts`)은 테이크 경로를 테이크별로 만들고 관리합니다(`activeTakes`).

### 지연 측정 (WP2)

`latency.measure { outputChannelOffset?, inputChannel, sampleRate? }` → 재생이 멈춘 상태에서만. 짧은 임펄스를 여러 번 내보내고 입력에서 찾습니다. `{ roundTripFrames, reportedFrames, extraFrames, confidence: 0..1, attempts }`. 신호를 못 찾으면 `confidence: 0`과 안내 메시지.

### 과부하 (WP2)

콜백 처리 시간이 버퍼 길이의 90%를 넘거나 드라이버가 overload/xrun을 알리면 `overloads`를 1 올립니다. `lastCallbackLoad`는 최근 콜백의 처리 시간 / 버퍼 시간입니다. 실시간 스레드에서는 원자 변수만 씁니다.

## TS 계약

- **오류:** `NativeAudioEngine.request`가 던지는 `Error`에 `code?: NativeErrorCode`와 `details?: unknown`(WP3가 `contracts.ts`에 타입 정의).
- **장치 프로필(WP3):** `AudioSettings.nativeDeviceProfiles: Record<string, { inputs: number[]; stereoPairs: number[]; inputNames: Record<number, string>; outputNames: Record<number, string> }>`. 키는 `${backend}:${deviceId}`입니다. `nativeBufferFrames: number | 'driver'`, `releaseInBackground: boolean`, `clockSource?: number`, `directMonitoring: boolean`, `recordingOffsetFrames`(샘플 단위, 기존 ms 값은 변환해서 읽음).
- **입력 목록 제공(WP3 → WP4):** `NativeAudioEngine.getInputChoices(): Array<{ channels: number[]; label: string }>` — 켜 둔 채널로 만든 모노·스테레오 선택지(이름 포함). 웹 엔진도 같은 메서드를 제공합니다(스트림의 채널 수 기준). WP4는 이 메서드만 씁니다.
- **다중 녹음(WP2 → WP4):** `engine.createRecordings(trackIds: string[], callbacks): RecordingSession` — `NativeRecording`과 같은 수명(준비 → 시작 → 중지·확정)을 여러 테이크에 적용하고, 결과를 `{ trackId, ...기존 결과 }[]`로 돌려줍니다. 웹 엔진은 `maxSimultaneousRecordings = 1`, 네이티브는 64를 `engine.capabilities`에 둡니다.
- **프로젝트 스키마 8(WP4):** `Track.input?: { channels: [number] | [number, number]; label?: string }`, `Track.monitorMode?: 'off' | 'auto' | 'in'`. `label`은 다른 장비에서 열 때 같은 이름의 채널을 찾는 데 씁니다.

## 검증

- TS: `npx vitest run`, `npx tsc -b`.
- 네이티브(로컬 MinGW): `node <scratchpad>/toolchain/native-local.mjs <worktree> <build-dir> --asio --no-vst3 --test`. MSVC 배포 빌드와 VST3, 실제 장치는 CI·실기에서만 확인됩니다.
- 실제 ASIO·WASAPI 장치 동작은 이 환경에서 확인할 수 없습니다. 장치 API 호출이 필요한 로직은 순수 함수로 분리해 단위 테스트합니다(버퍼 맞춤, 오류 분류, 복구 백오프, 채널 대응).

## 구현 메모 (계약과 다른 점)

- **오류 형식:** 호스트는 원래 `error`를 `{ code: "NATIVE_AUDIO_ERROR", message }` 객체로 보냈습니다. 이를 유지하면서 장치 오류의 `code`·`details`를 최상위와 `error` 안에 함께 둡니다. Electron IPC는 `message`만 전달하므로 데스크톱이 `\n[garak-native-error]{json}` 꼬리표로 코드를 실어 보내고 렌더러가 되살립니다.
- **`buffer.fixed`:** 허용 크기가 하나뿐일 때 true입니다(granularity 0 포함).
- **`engine.configure`의 관대한 처리:** 알 수 없는 `clockSource`는 현재 클럭을 유지하고, 지원하지 않는 장치의 `directMonitoring: true`는 무시합니다. `device.clockSource`·`device.directMonitor`는 오류를 냅니다.
- **`inputNames`:** 열린 채널 순서입니다. 렌더러가 `inputChannelList`로 물리 채널 번호에 다시 매핑합니다.
- **`device.controlPanel {backend, deviceId}`:** 설정이 거절된 ASIO 드라이버도 제어판만을 위해 열고, 다음 설정·probe·close까지 유지합니다.
- **녹음 시작:** 열리지 않은 트랙 입력은 무음 녹음 대신 `CHANNELS_UNAVAILABLE`로 거절합니다. `tracksMissingInput`은 명시적 입력이 있는 오디오 트랙만, 입력이 열려 있을 때만 나열합니다.
- **`latency.measure`:** `outputChannelOffset`·`sampleRate`는 현재 장치 설정과 같아야 합니다. 응답에 `detected`, `sampleRate`, `message`가 더 있습니다.
- **다중 녹음 한도:** `maxSimultaneousRecordings`는 엔진 객체에 둡니다(네이티브 64, 브라우저 1). 데스크톱은 테이크당 512 MiB, 정지 한 번에 2 GiB까지 전달하고 넘는 테이크는 복구 폴더에 남깁니다.
- **모니터 모드:** `monitorMode`는 프로젝트에 저장하지만 실행 취소 단계를 만들지 않습니다. 형식 7 이하 프로젝트에서 I가 꺼져 있던 트랙은 `auto`가 됩니다.
- **녹음 위치 보정:** `recordingOffsetFrames`(프레임)로 바뀌었습니다. 예전 ms 값은 48 kHz 기준으로 변환합니다.
- **미리 처리 기본값:** 실기 검증 전이므로 `off`입니다. VST3가 있는 트랙은 미리 처리하지 않습니다.
