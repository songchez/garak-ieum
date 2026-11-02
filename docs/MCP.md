# AI 연결: 로컬 MCP 사용 안내

가락이음의 MCP 서버는 **현재 열린 작업실의 구성을 읽고, 지원되는 트랙·리전·믹싱 편집을 실행**합니다. AI가 만든 MIDI 초안도 일반 트랙과 리전으로 남아 피아노롤에서 계속 수정할 수 있습니다.

현재 제공하는 연결은 **같은 컴퓨터에서 실행되는 stdio MCP 서버와 브라우저 앱 사이의 로컬 브리지**입니다. 외부 AI 서비스가 접속하는 공개 HTTP MCP 서버는 아직 없습니다. 아래 설정은 로컬 stdio MCP를 지원하는 호스트용 일반 예시이며, 특정 AI 제품의 설정 화면이나 연결 절차를 실측한 안내는 아닙니다.

## 1. 준비와 설치

- Node.js **24.x 권장** — 이 문서와 연결 테스트의 검증 환경입니다.
- pnpm **11.25.0**
- 이 기능이 포함된 가락이음 소스
- 로컬 stdio MCP 서버를 실행할 수 있는 AI 호스트
- 가락이음을 열 데스크톱 브라우저

저장소의 `package.json`과 `pnpm-lock.yaml`을 함께 사용합니다. 명령은 반드시 저장소 루트에서 실행합니다.

### Windows

PowerShell에서 pnpm을 찾지 못하거나 스크립트 실행 정책 때문에 실행이 막히면, 아래처럼 `npx.cmd`로 고정 버전을 실행할 수 있습니다. 예시 체크아웃 경로가 실제 설치 위치와 다르면 바꿉니다.

```powershell
cd C:\Users\SeongChaeNa\Garakeum
npx.cmd --yes pnpm@11.25.0 install --frozen-lockfile
npx.cmd --yes pnpm@11.25.0 mcp:build
node .\dist-mcp\mcp\token.js
```

### macOS / Linux

```bash
pnpm install --frozen-lockfile
pnpm mcp:build
node dist-mcp/mcp/token.js
```

마지막 명령이 출력하는 값을 **연결 키**로 보관합니다. 생성기는 32바이트 무작위 값을 base64url 문자열로 출력합니다. 이 키는 로컬 브리지 인증용이며 AI 서비스의 API 키와 다릅니다. 소스·프로젝트 파일·공개 이슈에 키를 넣지 않습니다.

`mcp:build`가 만드는 진입점은 `dist-mcp/mcp/server.js`입니다. MCP 관련 코드를 갱신한 뒤에는 다시 빌드하고 AI 호스트의 MCP 서버를 재시작합니다.

## 2. AI 호스트에 서버 등록

다음은 `mcpServers` 형태를 사용하는 호스트의 일반적인 설정 예시입니다. 호스트마다 설정 파일 위치·재시작 방법·지원 형식이 다를 수 있습니다.

```json
{
  "mcpServers": {
    "garak-ieum": {
      "command": "node",
      "args": [
        "C:\\Users\\SeongChaeNa\\Garakeum\\dist-mcp\\mcp\\server.js"
      ],
      "env": {
        "GARAK_MCP_TOKEN": "PASTE_THE_GENERATED_CONNECTION_KEY_HERE"
      }
    }
  }
}
```

`args`에는 실제 빌드 파일의 **절대 경로**, `GARAK_MCP_TOKEN`에는 앞서 생성한 키를 넣습니다. 호스트가 `node`를 찾지 못하면 `command`에 Node 실행 파일의 실제 절대 경로를 지정합니다. macOS/Linux도 같은 구조로 `/실제/저장소/경로/dist-mcp/mcp/server.js`를 사용합니다.

**MCP 호스트가 서버 프로세스를 시작합니다.** 위 설정으로 연결할 때 터미널에서 `pnpm mcp:start`를 별도로 실행하지 않습니다. 두 프로세스가 같은 47831 포트를 사용하면 충돌합니다. 여러 AI 호스트를 동시에 같은 기본 포트로 켜는 경우도 같습니다.

| 환경 변수 | 의미 |
|---|---|
| `GARAK_MCP_TOKEN` | 필수. 영문·숫자·`_`·`-`로 구성된 32~256자 연결 키. 생성기 사용을 권장합니다. |
| `GARAK_MCP_PORT` | 선택. 기본 `47831`, 허용 범위 `1024~65535`. 바꾸면 앱의 브리지 주소도 같은 포트로 변경합니다. |

MCP 설정에서는 `node`로 빌드 파일을 직접 실행합니다. 서버의 stdout은 JSON-RPC 프로토콜 전용이고 준비·오류 안내는 stderr로 나갑니다. `mcp:token`은 키 생성 전용 명령이므로 MCP 서버 명령으로 등록하지 않습니다.

## 3. 가락이음에서 연결

다른 터미널에서 앱을 실행합니다. 포트가 자동으로 바뀌지 않도록 `--strictPort`를 권장합니다.

Windows:

```powershell
npx.cmd --yes pnpm@11.25.0 dev --host 127.0.0.1 --port 5173 --strictPort
```

macOS/Linux:

```bash
pnpm dev --host 127.0.0.1 --port 5173 --strictPort
```

1. **`http://127.0.0.1:5173`** 또는 **`http://localhost:5173`**에서 앱을 엽니다.
2. 프로젝트 불러오기가 끝나면 **왼쪽 위 로고 메뉴 → AI 연결**을 엽니다.
3. 브리지 주소 **`ws://127.0.0.1:47831/bridge`**와 서버에 설정한 연결 키를 입력합니다.
4. **연결**을 누르고 상태가 **연결됨**으로 바뀌는지 확인합니다. 서버의 인증 응답 전에는 연결 완료로 표시하지 않습니다.
5. 처음에는 **AI 편집 허용**을 끈 상태로 조회·미리 보기를 확인합니다. 실제 적용과 Undo/Redo를 허용하려면 이 항목을 켭니다.

AI 연결 창의 **닫기**는 창만 닫습니다. 접속을 끝내려면 **연결 해제**를 누릅니다. 키는 브라우저 저장소에 보관하지 않으며, 앱을 새로고침한 뒤에는 다시 입력해 연결해야 합니다.

현재 허용하는 앱 origin은 아래 네 가지뿐입니다.

| 실행 형태 | 허용 주소 |
|---|---|
| 개발 서버 | `http://localhost:5173`, `http://127.0.0.1:5173` |
| 프로덕션 빌드 미리 보기 | `http://localhost:4173`, `http://127.0.0.1:4173` |

미리 보기 서버를 쓰려면 `pnpm build` 후 `pnpm preview --host 127.0.0.1 --port 4173 --strictPort`를 실행합니다. Windows에서는 동일하게 `npx.cmd --yes pnpm@11.25.0` 뒤에 각 스크립트를 붙입니다. 다른 포트, LAN 주소, `file://`, 배포된 HTTPS 사이트의 origin은 현재 브리지에서 거절합니다.

## 4. 도구와 지원 명령

### MCP 도구 7개

| 도구 | 역할 |
|---|---|
| `list_instances` | 인증되어 연결된 작업실 탭의 `instanceId` 목록 조회 |
| `get_state` | 현재 프로젝트·revision·선택·재생 상태·저장 상태와 범위별 데이터 조회 |
| `get_catalog` | 실제 내장 악기·이펙트 ID와 파라미터·단위·범위 조회 |
| `get_capabilities` | 명령 schema·제한·단위·현재 편집 허용 상태·미지원 기능 조회 |
| `preview_edits` | 명령을 검증하고 변경 내역 계산. 프로젝트와 Undo 이력은 변경하지 않음 |
| `apply_edits` | 명령 묶음을 원자적으로 적용하고 Undo 하나로 기록 |
| `history` | 현재 프로젝트 이력의 Undo 또는 Redo 한 단계 적용 |

**`apply_edits`와 `history`에는 `instanceId`가 필수입니다.** 먼저 `list_instances`로 연결된 탭의 실제 ID를 확인하고, 그 ID로 `get_state`를 조회한 뒤 편집에 같은 ID를 전달합니다. 조회 도구와 `preview_edits`만 연결된 탭이 정확히 하나일 때 `instanceId`를 생략할 수 있습니다. 두 개 이상이면 모든 후속 요청에 대상을 명시합니다. 트랙 이름·번호로 대상을 추정하지 말고 조회 결과의 ID를 사용합니다.

앱을 새로고침하면 새로운 `instanceId`가 생깁니다. 이전 ID로 재시도한 편집은 `INSTANCE_NOT_FOUND`로 거절되어 새 탭에 자동 적용되지 않습니다. `projectId`와 revision 숫자가 우연히 같아도 새 탭은 이전 작업의 중복 방지 캐시를 이어받지 않으므로, **과거 요청의 `instanceId`만 새 값으로 바꿔 재전송하지 않습니다.**

### 현재 적용 가능한 명령 19개

| 그룹 | 명령 |
|---|---|
| 트랙 생성·이름·삭제 | `track.create`, `track.rename`, `track.delete` |
| 트랙 믹싱·상태 | `track.setVolumeDb`, `track.adjustVolumeDb`, `track.setPan`, `track.setMute`, `track.setSolo` |
| MIDI 생성 | `clip.addMidi` |
| 리전 편집·상태 | `clip.rename`, `clip.move`, `clip.delete`, `clip.repeat`, `clip.setMute`, `clip.setTranspose` |
| 내장 인서트 이펙트 | `effect.add`, `effect.setParam`, `effect.remove`, `effect.setEnabled` |

`track.create`의 악기 트랙에는 `initialClip`으로 첫 MIDI 리전을 함께 만들 수 있습니다. 새 트랙과 음표를 한 번의 적용·Undo로 처리할 때 유용합니다. 같은 revision과 요청에서는 미리 보기·적용의 생성 ID가 일치합니다. 다만 미리 보기는 객체를 만들지 않으므로, 다음 편집은 실제 적용이 성공한 응답의 `createdIds`를 사용합니다.

`clip.move`는 같은 종류의 리전을 받을 수 있는 트랙 사이에서 동작하며 겹침을 유지합니다. `clip.repeat.count`는 원본 외에 만드는 **추가 사본 수**이고, `startBeat`를 생략하면 원본 리전 끝부터 길이만큼 간격을 두고 배치합니다. `clip.setTranspose`는 MIDI 리전의 비파괴 이조이며 오디오 피치 변환은 지원하지 않습니다.

## 5. 상태 조회와 단위

### 필요한 범위만 읽기

아래 JSON은 MCP `tools/call`의 `params`에 해당합니다.

```json
{
  "name": "get_state",
  "arguments": { "instanceId": "TAB_ID", "trackOffset": 0, "trackLimit": 50 }
}
```

| 조회 범위 | 지정 인자 | 페이지 기본값 / 최대 | 다음 페이지 |
|---|---|---|---|
| 프로젝트의 트랙 요약 | `trackId`, `clipId` 생략 | `trackOffset: 0`, `trackLimit: 50` / 100 | `nextTrackOffset` |
| 한 트랙의 리전과 설정 | `trackId` | `clipOffset: 0`, `clipLimit: 50` / 100 | `nextClipOffset` |
| 한 MIDI 리전의 원본 음표 | `clipId` | `noteOffset: 0`, `noteLimit: 128` / 512 | `nextNoteOffset` |

다음 offset이 `null`이면 마지막 페이지입니다. `trackId`와 `clipId`를 동시에 지정할 수 없고, 해당 범위와 맞지 않는 페이지 인자도 거절합니다. 오디오 리전에는 음표 페이지가 없습니다. `projectId`를 조회 인자로 주면 현재 열린 프로젝트와 일치하는지도 검사합니다.

각 `get_state` 응답에는 `projectId`, `revision`, 프로젝트 요약, 선택, 재생 상태, 이력, `persistence`, `editAccess`가 포함됩니다. 페이지를 넘기는 사이 revision이 바뀌면 여러 시점의 데이터를 섞지 않도록 다시 조회합니다. 음표 응답의 `noteView: "source"`는 원본 음표를 뜻합니다. 리전의 이조·퀀타이즈·루프를 반영한 실제 재생 이벤트 조회는 아직 없습니다.

`get_catalog`의 `kind`는 `all`(기본), `instruments`, `effects`입니다. 악기와 이펙트 ID·파라미터를 추측하지 말고 먼저 이 목록을 읽습니다. `get_capabilities`의 `protocol: 1`은 가락이음 브리지 버전이며 MCP 규격 날짜와 별개입니다.

### 음악 데이터 단위

| 값 | 의미 |
|---|---|
| `pitch` | MIDI 정수 0~127. 가락이음 표시 기준은 **60=C3** |
| `startBeat` | 프로젝트 시작부터의 절대 위치. **0부터 시작하는 4분음표 beat** |
| 음표 `start` | 해당 리전 시작부터의 상대 beat |
| `lengthBeats`, `duration` | beat 단위 길이. 현재 4/4이므로 **8마디=32 beat**, 화면의 1마디 시작은 beat 0 |
| 음표 `velocity` | 정규화된 **0~1**. MIDI 1~127 값이나 리전의 벨로시티 오프셋과 다름 |
| 트랙 `volume` | 선형 gain 0~2. 1은 0dB, 2는 약 +6.0206dB |
| `volumeDb` | 절대 페이더 값. -120~약 +6.0206dB, **`null`은 gain 0인 무음**. 뮤트 플래그와 별도 |
| `deltaDb` | 상대 dB 변경. -2는 현재 gain에 약 0.7943을 곱함. 이미 무음인 페이더는 상대 변경 후에도 무음 |
| `pan` | -1 왼쪽, 0 중앙, +1 오른쪽 |
| 이펙트 `value` | 카탈로그가 안내하는 **실제 파라미터 단위**. 모든 노브를 0~1로 가정하지 않음 |

범위를 벗어나는 결과는 자동으로 잘라 적용하지 않고 오류로 반환합니다. 예를 들어 볼륨 증가 결과가 허용 gain을 넘으면 해당 명령 묶음을 적용하지 않습니다.

## 6. 편집·Undo·재시도의 계약

적용 요청에는 다음 값이 필요합니다.

- `instanceId`: `list_instances`에서 확인한 현재 브라우저 탭 ID. 적용과 Undo/Redo에 필수입니다.
- `projectId`: 현재 열린 프로젝트 ID.
- `expectedRevision`: 마지막으로 조회하고 편집 계획에 사용한 revision.
- `operationId`: 이번 논리적 작업의 고유 ID. 같은 작업의 재시도에만 같은 값을 사용합니다.
- `commands`: 순서대로 검증·실행할 명령 목록. 하나라도 실패하면 프로젝트 상태 전체를 미적용합니다.

성공한 변경 묶음은 프로젝트 revision을 한 번 올리고 Undo 이력 한 칸을 만듭니다. 값이 이미 같아 변경이 없는 성공은 revision과 Undo를 늘리지 않습니다. 미리 보기는 상태를 잠그거나 적용을 예약하지 않으므로, 그 뒤 사용자가 편집했다면 적용 때 `REVISION_CONFLICT`가 발생할 수 있습니다.

### 재시도와 세션 범위

동일한 브라우저 세션에서 동일 `operationId`와 동일 인자의 적용·이력 재시도는 캐시된 원래 결과를 반환합니다. 예를 들어 응답을 받지 못했다고 새 operation ID로 “-2dB”를 다시 실행하면 실제로 두 번 낮아질 수 있으므로, 먼저 **원래 `instanceId`·`operationId`와 원래 인자 그대로** 재시도합니다. 같은 operation ID를 다른 인자에 사용하면 `OPERATION_ID_REUSED`입니다.

성공 캐시는 브라우저의 `ProjectSession` 메모리에 있으며 새 operation ID로 완료된 적용·이력 요청을 **최대 256개** 보관합니다. 오래된 항목은 제거됩니다. 미리 보기와 실패한 요청은 성공 캐시에 넣지 않습니다. 이 캐시는 영구적인 중복 실행 방지 저장소가 아닙니다.

앱 새로고침·새 브라우저 세션에서는 revision과 캐시가 다시 시작하고, 프로젝트를 새로 열거나 초기화할 때도 캐시를 비웁니다. MCP 서버나 AI 호스트만 재시작해도 연결은 끊깁니다. 브라우저의 기존 `ProjectSession`이 살아 있다면 그 캐시는 유지될 수 있지만, 재연결 후에는 항상 `list_instances`와 `get_state`로 대상·현재 상태를 다시 확인합니다. 재시작이나 오래된 캐시의 범위를 넘어서는 작업을 무조건 재전송하지 않습니다.

캐시된 적용 응답의 **`revision`은 그 작업이 원래 완료됐을 때의 revision**입니다. **`currentRevision`은 지금의 실제 revision**입니다. 두 값이 다르면 최신 상태를 다시 읽고 다음 작업을 계획합니다. 다른 UI 편집이 들어온 뒤 과거 결과를 재조회했다고 현재 상태가 과거로 돌아가지는 않습니다.

### 적용 ACK와 저장은 별개

성공 ACK는 브라우저의 공유 프로젝트 상태와 이력에 명령이 적용됐다는 뜻입니다. 디스크 파일 저장·IndexedDB 자동 저장 완료·재생·청음을 뜻하지 않습니다. 새 변경은 `persistence: "pending"`으로 반환하며, 이후 `get_state`에서 `saved` 또는 `error`를 확인합니다. `warnings`가 있으면 적용은 완료됐지만 후속 화면·오디오 갱신 등에 문제가 있을 수 있으므로 상태를 다시 확인합니다.

UI와 MCP는 같은 프로젝트·Undo store를 사용합니다. `history`의 Undo는 **현재 가장 최근 프로젝트 편집**을 되돌립니다. 임의의 과거 AI 작업만 골라 되돌리는 기능은 없습니다. 다른 UI 편집 후에는 revision 충돌을 해결하려고 무조건 최신 revision으로 Undo를 재발행하지 말고, 마지막 변경이 의도한 대상인지 확인합니다.

### 대기 시간과 취소

CLI 서버의 기본 응답 대기 시간은 **10초**이며, 브리지 구현이 허용하는 요청 대기 시간 상한은 **30초**입니다. 현재 CLI에는 이 시간을 바꾸는 환경 변수가 없습니다. 대기 중 취소·timeout·연결 종료 시 성공으로 보고하지 않습니다.

취소되었거나 deadline이 지난 대기 요청은 편집 handler에 들어가지 않습니다. 이미 동기 commit이 완료된 편집은 취소가 자동으로 Undo하지 않습니다. timeout 이후에는 `operationId` 재확인과 최신 상태 조회로 적용 여부를 확인합니다.

## 7. 실제 호출 예시

아래 ID 문자열과 revision 숫자는 예시입니다. **`TAB_ID`, `PROJECT_ID`, `BASS_TRACK_ID`를 실제 조회 결과로 바꾸고, `expectedRevision`도 현재 값으로 바꿉니다.** 새 작업마다 새 operation ID를 사용합니다. 이 JSON은 AI 호스트가 MCP 도구에 보내는 인자이며, 앱에서 실행하는 JavaScript가 아닙니다.

### 베이스를 현재보다 2dB 낮추기

먼저 `list_instances`로 탭 ID를 얻고, 그 `instanceId`로 `get_state`를 호출해 이름이 베이스인 실제 트랙을 확인합니다. 같은 이름이 여러 개면 ID로 구분합니다. 여기서는 계획에 사용한 revision을 12로 가정합니다.

변경 내역 확인:

```json
{
  "name": "preview_edits",
  "arguments": {
    "instanceId": "TAB_ID",
    "projectId": "PROJECT_ID",
    "expectedRevision": 12,
    "operationId": "mix-bass-minus-2db-001",
    "label": "베이스 2dB 낮추기",
    "commands": [
      { "type": "track.adjustVolumeDb", "trackId": "BASS_TRACK_ID", "deltaDb": -2 }
    ]
  }
}
```

적용할 때는 도구 이름만 바꾸고 같은 인자를 전달합니다.

```json
{
  "name": "apply_edits",
  "arguments": {
    "instanceId": "TAB_ID",
    "projectId": "PROJECT_ID",
    "expectedRevision": 12,
    "operationId": "mix-bass-minus-2db-001",
    "label": "베이스 2dB 낮추기",
    "commands": [
      { "type": "track.adjustVolumeDb", "trackId": "BASS_TRACK_ID", "deltaDb": -2 }
    ]
  }
}
```

실제 변경이 일어났다면 응답은 새 revision을 알려줍니다. 다음 요청은 그 후의 현재 revision을 기준으로 만듭니다.

### 편집 가능한 8마디 MIDI 초안 만들기

다음 예시는 4/4의 **32 beat 리전**에 건반 진행과 베이스를 새 트랙으로 함께 만듭니다. 악기 ID `keys`와 `bass`는 현재 내장 카탈로그의 값입니다. 코드 언어를 평가하는 기능이 아니라, 명시된 음표 데이터를 생성하는 예시입니다. 프로젝트의 BPM은 바꾸지 않습니다.

아래 요청을 먼저 `preview_edits`라는 도구 이름으로 보내 변경 수와 프로젝트 길이를 확인할 수 있습니다. 적용할 때에는 아래의 `apply_edits`와 **동일한 arguments**를 사용합니다. 예시 revision 13은 앞선 작업 이후의 실제 값으로 교체합니다.

```json
{
  "name": "apply_edits",
  "arguments": {
    "instanceId": "TAB_ID",
    "projectId": "PROJECT_ID",
    "expectedRevision": 13,
    "operationId": "draft-eight-bars-001",
    "label": "건반과 베이스 8마디 초안",
    "commands": [
      {
        "type": "track.create",
        "kind": "instrument",
        "instrument": "keys",
        "name": "초안 · 건반",
        "initialClip": {
          "name": "8마디 코드 진행",
          "startBeat": 0,
          "lengthBeats": 32,
          "notes": [
            { "pitch": 60, "start": 0, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 64, "start": 0, "duration": 3.75, "velocity": 0.60 },
            { "pitch": 67, "start": 0, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 57, "start": 4, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 60, "start": 4, "duration": 3.75, "velocity": 0.60 },
            { "pitch": 64, "start": 4, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 53, "start": 8, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 57, "start": 8, "duration": 3.75, "velocity": 0.60 },
            { "pitch": 60, "start": 8, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 55, "start": 12, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 59, "start": 12, "duration": 3.75, "velocity": 0.60 },
            { "pitch": 62, "start": 12, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 60, "start": 16, "duration": 3.75, "velocity": 0.68 },
            { "pitch": 64, "start": 16, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 67, "start": 16, "duration": 3.75, "velocity": 0.66 },
            { "pitch": 57, "start": 20, "duration": 3.75, "velocity": 0.66 },
            { "pitch": 60, "start": 20, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 64, "start": 20, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 53, "start": 24, "duration": 3.75, "velocity": 0.64 },
            { "pitch": 57, "start": 24, "duration": 3.75, "velocity": 0.60 },
            { "pitch": 60, "start": 24, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 55, "start": 28, "duration": 3.75, "velocity": 0.62 },
            { "pitch": 59, "start": 28, "duration": 3.75, "velocity": 0.58 },
            { "pitch": 62, "start": 28, "duration": 3.75, "velocity": 0.60 }
          ]
        }
      },
      {
        "type": "track.create",
        "kind": "instrument",
        "instrument": "bass",
        "name": "초안 · 베이스",
        "initialClip": {
          "name": "8마디 베이스",
          "startBeat": 0,
          "lengthBeats": 32,
          "notes": [
            { "pitch": 36, "start": 0, "duration": 3.5, "velocity": 0.72 },
            { "pitch": 33, "start": 4, "duration": 3.5, "velocity": 0.70 },
            { "pitch": 29, "start": 8, "duration": 3.5, "velocity": 0.72 },
            { "pitch": 31, "start": 12, "duration": 3.5, "velocity": 0.70 },
            { "pitch": 36, "start": 16, "duration": 3.5, "velocity": 0.76 },
            { "pitch": 33, "start": 20, "duration": 3.5, "velocity": 0.74 },
            { "pitch": 29, "start": 24, "duration": 3.5, "velocity": 0.72 },
            { "pitch": 31, "start": 28, "duration": 3.5, "velocity": 0.68 }
          ]
        }
      }
    ]
  }
}
```

성공하면 2개 트랙·2개 리전·32개 음표가 하나의 편집으로 생성됩니다.

생성 결과의 실제 트랙·리전 ID는 응답의 `results[].createdIds`에서 확인합니다. 이후 각 리전을 피아노롤에서 열어 수정하거나 다른 위치로 옮길 수 있습니다. 이 요청은 음표 데이터를 생성하며 재생을 자동으로 시작하지 않습니다.

### 방금 만든 초안 되돌리기

먼저 `get_state`에서 가장 최근 편집과 현재 revision을 확인합니다. 아래는 초안 생성 후 revision이 14이고, 그 이후 다른 편집이 없다는 가정입니다.

```json
{
  "name": "history",
  "arguments": {
    "instanceId": "TAB_ID",
    "projectId": "PROJECT_ID",
    "expectedRevision": 14,
    "operationId": "undo-eight-bars-001",
    "action": "undo"
  }
}
```

두 트랙과 두 리전이 함께 되돌아갑니다. Redo는 새 상태의 revision과 새 operation ID로 `action: "redo"`를 요청합니다.

## 8. 제한과 오류 처리

| 제한 | 현재 값 |
|---|---|
| 명령 묶음 | 최대 100개 |
| 새 트랙 | 한 묶음에서 최대 32개 |
| 새 리전 | 한 묶음에서 최대 512개 |
| 리전당 입력 음표 | 최대 8,192개 |
| 한 묶음의 새 음표 | 최대 16,384개 |
| 리전 반복 | 한 명령에서 추가 사본 최대 64개 |
| 트랙당 인서트 효과 | 최대 64개 |
| 브리지 메시지 | UTF-8 기준 최대 512KiB. 음표 개수 제한보다 먼저 걸릴 수 있음 |
| 연결·요청 | 최대 16개 WebSocket, 최대 64개 대기 요청 |

실행 오류는 MCP의 `isError`와 `structuredContent.error`에 `code`, `message`, 필요 시 `details`로 반환합니다. 도구 schema 자체를 어긴 요청은 SDK의 입력 검증 오류로 반환될 수 있습니다.

| 현상·오류 | 확인할 내용 |
|---|---|
| `pnpm`을 찾을 수 없음·PowerShell 실행 제한 | Windows 설치 명령의 `npx.cmd --yes pnpm@11.25.0` 사용 |
| `lucide-react` 등 패키지를 찾지 못함 | 올바른 저장소에서 고정된 잠금 파일로 설치를 완료했는지 확인 |
| `dist-mcp/mcp/server.js`를 찾지 못함 | `mcp:build` 실행과 호스트 설정의 절대 경로 확인 |
| 서버 시작 실패·포트 충돌 | 같은 포트를 쓰는 수동 서버나 두 번째 AI 호스트를 종료하고 하나만 시작 |
| 연결 실패·`AUTH_FAILED` | 호스트와 앱의 연결 키, 앱 origin, 브리지 포트 확인. 키 자체를 오류 보고에 첨부하지 않음 |
| `DAW_NOT_CONNECTED`, `INSTANCE_NOT_FOUND` | 앱의 연결 상태와 `list_instances` 결과를 다시 확인 |
| `AMBIGUOUS_INSTANCE` | 요청에 정확한 `instanceId` 지정 |
| `instanceId` 입력 검증 오류·`INSTANCE_REQUIRED` | 적용·Undo/Redo에는 `list_instances`에서 확인한 실제 탭 ID가 필수. 새 탭 ID로 과거 요청을 자동 재시도하지 않음 |
| `READ_ONLY` | AI 연결 창에서 편집 허용 상태 확인 |
| `DAW_BUSY` | 녹음·파일/오디오 설정 처리·입력/드래그·다른 대화상자 작업이 끝난 뒤 재시도 |
| `REVISION_CONFLICT`, `PROJECT_MISMATCH` | 최신 프로젝트·선택·revision을 다시 읽고 변경 계획을 새로 구성 |
| `OPERATION_ID_REUSED` | 같은 ID로 다른 요청을 보내지 않았는지 확인. 새로운 작업에는 새 ID 사용 |
| `UNKNOWN_INSTRUMENT`, `UNKNOWN_PARAMETER` | `get_catalog`의 실제 ID·파라미터 이름·범위 사용 |
| `REQUEST_TIMEOUT`, `DAW_DISCONNECTED` | 성공·미적용으로 단정하지 말고 원래 operation ID와 최신 상태로 확인 |
| `REQUEST_TOO_LARGE`, `RESPONSE_TOO_LARGE` | 조회 페이지나 편집 묶음을 줄임. 여러 묶음으로 나누면 각각 별도의 Undo가 됨 |

## 9. 현재 지원 경계와 검증

UI 편집과 MCP 편집은 같은 `ProjectSession`을 사용하지만, **기존 UI의 모든 기능이 MCP에 노출된 것은 아닙니다.** 이 문서의 7개 도구·19개 명령이 첫 연결 범위입니다.

현재 MCP에서 지원하지 않는 항목:

- 재생·정지·녹음 시작, 마이크 권한 요청, 입력·출력 장치와 오디오 환경 변경
- 오디오 파일 전송, 구간 청음·렌더 job, 오디오 분석·음악 이해
- UI에 추가된 피치 편집기의 분석·음표 이동·재합성 명령
- 재생 변환을 적용한 음표 조회, 피아노롤의 세부 음표 선택·기존 개별 음표 수정
- 오토메이션, 템포 맵, 4/4 외 박자, send/return·sidechain
- 외부 VST/AU/CLAP 실행, MIDI 파일 입출력
- 작곡 언어·임의 JavaScript 실행, 코드 원본과 GUI의 왕복 편집
- 특정 과거 AI 작업만 선택해 되돌리기, 원격 HTTP MCP 서비스

피치 편집 초안 또는 분석·렌더가 진행 중이면 기존 MCP 변경 명령도 `DAW_BUSY`로 차단합니다. 피치 편집기에서 적용하거나 변경을 취소한 뒤 다시 요청하세요. 기존 조회 기능과 여섯 이펙트 카탈로그는 유지됩니다.

작곡 언어 검토는 [작곡 언어 POC](COMPOSITION_LANGUAGE_POC.md)에서 별도로 다룹니다. 음표 JSON으로 초안을 만드는 기능과 코드 언어 실행 기능은 구현 범위가 다릅니다.

이번 구현에서는 공식 SDK 클라이언트가 별도 Node stdio 프로세스를 시작하고, 실제 loopback WebSocket을 통해 mock browser의 **실제 `createDawRequestHandler`와 `ProjectSession`**을 호출하는 통합 테스트를 실행했습니다. 도구 schema, 읽기 전용 차단, 페이지 조회, 미리 보기·적용·중복 방지·revision 충돌·Undo와 카탈로그를 검증했습니다. 편집·이력의 `instanceId` 필수 검증과 같은 프로젝트·revision으로 다시 연결된 새 세션에 이전 탭의 요청이 적용되지 않는 회귀도 포함합니다. 별도 테스트는 Origin/Host·인증·다중 탭·ACK·취소·timeout·연결 종료·크기 제한을 다룹니다.

**실제 브라우저 UI 조작, 특정 외부 AI 제품의 설정 화면과 연결, 오디오 장치를 연결한 청음은 아직 검증하지 않았습니다.** 이 문서의 테스트 통과를 그 환경의 동작 확인으로 해석하지 않습니다. 전체 실행 결과는 [구현 상태](IMPLEMENTATION_STATUS.md)를 따릅니다.

## 구현 위치와 공식 참고 자료

- [공통 명령·schema](../src/core/commands.ts), [프로젝트·Undo·중복 방지](../src/core/ProjectSession.ts)
- [브라우저 조회·편집 handler](../src/automation/host.ts), [브라우저 연결](../src/automation/bridgeClient.ts)
- [로컬 브리지](../mcp/bridgeServer.ts), [MCP 도구](../mcp/tools.ts), [stdio 진입점](../mcp/server.ts)
- [공식 TypeScript SDK의 stdio 서버](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [공식 TypeScript SDK의 패키지 구조](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages)
- [MCP 도구와 구조화 결과](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
