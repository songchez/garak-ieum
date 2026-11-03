import { McpServer, fromJsonSchema, type CallToolResult, type JSONValue } from '@modelcontextprotocol/server'
import { COMMAND_REQUEST_SCHEMA, HISTORY_REQUEST_SCHEMA } from '../src/core/commands.js'
import { BridgeError, errorData, isBridgeId, type BridgeParams, type DawMethod } from '../src/automation/protocol.js'
import type { DawBridge } from './bridgeServer.js'

const id = { type: 'string', minLength: 1, maxLength: 200 }
const instanceId = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$', description: 'list_instances에서 받은 탭 ID. apply_edits/history에서는 필수입니다. 조회·미리 보기는 연결된 탭이 하나일 때만 생략할 수 있습니다.' }
const empty = { type: 'object', properties: {}, additionalProperties: false }
const stateSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    projectId: id, trackId: id, clipId: id,
    trackOffset: { type: 'integer', minimum: 0 }, trackLimit: { type: 'integer', minimum: 1, maximum: 100 },
    clipOffset: { type: 'integer', minimum: 0 }, clipLimit: { type: 'integer', minimum: 1, maximum: 100 },
    noteOffset: { type: 'integer', minimum: 0 }, noteLimit: { type: 'integer', minimum: 1, maximum: 512 },
  },
  not: { required: ['trackId', 'clipId'] },
}
const catalogSchema = { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['all', 'instruments', 'effects'] } } }

function withInstance(schema: Record<string, unknown>, requireInstance: boolean) {
  return {
    ...schema,
    properties: { ...(schema.properties as Record<string, unknown>), instanceId },
    ...(requireInstance ? { required: [...(schema.required as string[] ?? []), 'instanceId'] } : {}),
  }
}
function success(result: unknown): CallToolResult {
  const text = JSON.stringify(result ?? null)
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as JSONValue }
}
function failure(error: unknown): CallToolResult {
  const text = JSON.stringify({ error: errorData(error) })
  return { isError: true, content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as JSONValue }
}

export function createGarakMcpServer(bridge: DawBridge): McpServer {
  const server = new McpServer({ name: 'garak-ieum', version: '0.1.1' })
  server.registerTool('list_instances', {
    description: '명시적으로 연결된 가락이음 탭을 조회합니다. apply_edits/history는 여기서 받은 instanceId를 반드시 지정해야 합니다. 새로고침한 탭에는 새 ID가 부여됩니다.',
    inputSchema: fromJsonSchema<BridgeParams>(empty),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, () => success({ instances: bridge.listInstances() }))

  const definitions: { method: DawMethod; description: string; schema: Record<string, unknown>; readOnly: boolean }[] = [
    { method: 'get_state', schema: stateSchema, readOnly: true,
      description: '현재 projectId/revision/선택/재생 상태와 트랙 요약을 읽습니다. trackId로 리전, clipId로 원본 MIDI 음표를 페이지 조회합니다. 트랙 기본 50/max100, 리전 기본50/max100, 음표 기본128/max512. trackId와 clipId는 동시에 지정할 수 없습니다. 재생 변환된 음표 조회는 지원하지 않습니다.' },
    { method: 'get_catalog', schema: catalogSchema, readOnly: true,
      description: '현재 내장 악기와 이펙트의 실제 ID·파라미터·단위·범위를 조회합니다. 임의 플러그인 ID나 파라미터를 추정하지 마세요.' },
    { method: 'get_capabilities', schema: empty, readOnly: true,
      description: '명령 지원 범위·제한·시간/음높이/볼륨 단위·미지원 기능을 조회합니다. 브라우저 권한, 녹음, 재생 제어, 외부 플러그인과 미구현 기능을 성공으로 가정하지 마세요.' },
    { method: 'preview_edits', schema: COMMAND_REQUEST_SCHEMA, readOnly: true,
      description: 'projectId/expectedRevision/operationId와 명시적 명령 목록을 검증하고 변경을 미리 봅니다. 실제 프로젝트와 Undo 이력은 바꾸지 않습니다. 시간은 0부터 시작하는 beat, MIDI60=C3, volumeDb는 dB이며 null은 무음입니다.' },
    { method: 'apply_edits', schema: COMMAND_REQUEST_SCHEMA, readOnly: false,
      description: '검증된 명령 묶음을 원자적으로 적용하고 Undo 하나로 기록합니다. list_instances의 instanceId, get_state의 projectId/revision과 새로운 operationId가 필요합니다. 재시도는 동일한 instanceId/operationId와 동일한 인자를 사용하세요. 새로고침 후 새 탭 ID로 과거 작업을 재전송하지 마세요. 응답 대기 실패·취소는 이미 완료된 편집을 되돌리지 않습니다. 임의 코드 실행은 지원하지 않습니다.' },
    { method: 'history', schema: HISTORY_REQUEST_SCHEMA, readOnly: false,
      description: '명시한 instanceId의 현재 revision을 확인해 Undo 또는 Redo 한 단계를 적용합니다. 별도 operationId가 필요하고 동일한 요청 재시도는 한 번만 적용합니다. 변경된 탭 ID나 revision이면 먼저 상태를 다시 조회하세요.' },
  ]
  for (const definition of definitions) {
    server.registerTool(definition.method, {
      description: definition.description,
      inputSchema: fromJsonSchema<BridgeParams>(withInstance(definition.schema, !definition.readOnly)),
      annotations: { readOnlyHint: definition.readOnly, destructiveHint: !definition.readOnly, idempotentHint: true, openWorldHint: false },
    }, async (args, context) => {
      const { instanceId: target, ...params } = args
      try {
        if (!definition.readOnly && !isBridgeId(target)) {
          throw new BridgeError('INSTANCE_REQUIRED', '편집과 이력 요청에는 list_instances로 확인한 instanceId가 필요합니다.')
        }
        return success(await bridge.request(definition.method, params, target as string | undefined, context.mcpReq.signal))
      }
      catch (error) { return failure(error) }
    })
  }
  return server
}
