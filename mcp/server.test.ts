import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { WebSocket } from 'ws'
import { ProjectSession } from '../src/core/ProjectSession'
import { createEmptyProject } from '../src/core/project'
import { createDawRequestHandler } from '../src/automation/host'
import { errorData, isDawMethod } from '../src/automation/protocol'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const TOKEN = 'integration_pairing_0123456789abcdefghijk'
let client: Client | undefined
let socket: WebSocket | undefined
const lifecycleChildren = new Set<ChildProcess>()

beforeAll(() => {
  // The integration exercises the emitted Node entry point, not a mocked MCP handler.
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.mcp.json'], { cwd, stdio: 'pipe' })
}, 20_000)
afterEach(async () => {
  socket?.terminate()
  socket = undefined
  await client?.close()
  client = undefined
  for (const child of lifecycleChildren) {
    child.stdin?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  lifecycleChildren.clear()
})

async function availablePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No loopback port')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  return address.port
}

async function connectDaw(port: number, instanceId: string, handle: ReturnType<typeof createDawRequestHandler>): Promise<WebSocket> {
  const connected = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'http://127.0.0.1:5173' })
  connected.on('error', () => {})
  await new Promise<void>((resolve, reject) => { connected.once('open', resolve); connected.once('error', reject) })
  const ready = new Promise<Record<string, unknown>>(resolve => connected.once('message', data => resolve(JSON.parse(data.toString()))))
  connected.send(JSON.stringify({ type: 'auth', protocol: 1, token: TOKEN, instanceId }))
  expect(await ready).toEqual({ type: 'ready', protocol: 1 })
  connected.on('message', data => {
    const request = JSON.parse(data.toString())
    if (request.type !== 'request') return
    try {
      if (!isDawMethod(request.method)) throw new Error('Unexpected method')
      const result = handle(request.method, request.params)
      connected.send(JSON.stringify({ type: 'response', id: request.id, result }))
    } catch (error) {
      connected.send(JSON.stringify({ type: 'response', id: request.id, error: errorData(error) }))
    }
  })
  return connected
}

describe('MCP process lifecycle for Node and a desktop host', () => {
  it('keeps imports inert and preserves the standalone token and server commands', () => {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
      await import('./dist-mcp/mcp/server.js');
      await import('./dist-mcp/mcp/token.js');
      process.stdout.write('imports-inert\\n');
    `], { cwd, env: { ...process.env, GARAK_MCP_TOKEN: '' }, encoding: 'utf8', timeout: 5000 })
    expect(imported.error).toBeUndefined()
    expect(imported.status).toBe(0)
    expect(imported.stdout).toBe('imports-inert\n')
    expect(imported.stderr).toBe('')

    const token = spawnSync(process.execPath, ['dist-mcp/mcp/token.js'], { cwd, encoding: 'utf8', timeout: 5000 })
    expect(token.status).toBe(0)
    expect(token.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/)
    expect(token.stderr).toBe('')

    const invalid = spawnSync(process.execPath, ['dist-mcp/mcp/server.js'], {
      cwd, env: { ...process.env, GARAK_MCP_TOKEN: '' }, encoding: 'utf8', timeout: 5000,
    })
    expect(invalid.status).toBe(1)
    expect(invalid.stdout).toBe('')
    expect(invalid.stderr).toContain('GARAK_MCP_TOKEN')
  })

  it('lets the desktop host close its imported server more than once and await full release', async () => {
    const port = await availablePort()
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createServer } from 'node:net';
      import { startMcpServer } from './dist-mcp/mcp/server.js';
      const server = await startMcpServer();
      await Promise.all([server.close(), server.close(), server.closed]);
      const probe = createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(server.port, '127.0.0.1', resolve); });
      await new Promise(resolve => probe.close(resolve));
      process.stdout.write('lifecycle-closed\\n');
    `], { cwd, env: { ...process.env, GARAK_MCP_TOKEN: TOKEN, GARAK_MCP_PORT: String(port) }, encoding: 'utf8', timeout: 5000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('lifecycle-closed\n')
    expect(result.stderr).toContain('MCP 준비 완료')
    expect(result.stderr).not.toContain(TOKEN)
  })

  // Windows host termination is tested through stdin EOF; POSIX signals are not portable to Windows children.
  it.each(process.platform === 'win32' ? ['stdin EOF'] as const : ['stdin EOF', 'SIGINT', 'SIGTERM'] as const)(
    'settles the imported lifecycle and releases the bridge after %s', async reason => {
      const port = await availablePort()
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { createServer } from 'node:net';
        import { startMcpServer } from './dist-mcp/mcp/server.js';
        const server = await startMcpServer();
        await server.closed;
        const probe = createServer();
        await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(server.port, '127.0.0.1', resolve); });
        await new Promise(resolve => probe.close(resolve));
        process.stdout.write('lifecycle-closed\\n');
      `], { cwd, env: { ...process.env, GARAK_MCP_TOKEN: TOKEN, GARAK_MCP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] })
      lifecycleChildren.add(child)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        // close follows exit after the stdout/stderr pipes have drained.
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP readiness timeout: ${stderr}`)), 3000)
        child.stderr.on('data', chunk => {
          stderr += String(chunk)
          if (stderr.includes('MCP 준비 완료')) { clearTimeout(timer); resolve() }
        })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`MCP exited before readiness: ${stderr}`)) })
      })
      if (reason === 'stdin EOF') child.stdin.end()
      else child.kill(reason)
      await expect(exited).resolves.toEqual({ code: 0, signal: null })
      expect(stdout).toBe('lifecycle-closed\n')
      expect(stderr).not.toContain(TOKEN)
    },
  )
})

describe('MCP stdio → loopback → DAW integration', () => {
  it('discovers real schemas and applies, deduplicates, previews and undoes a real ProjectSession edit', async () => {
    const port = await availablePort()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist-mcp/mcp/server.js'], cwd, stderr: 'pipe',
      env: { GARAK_MCP_TOKEN: TOKEN, GARAK_MCP_PORT: String(port) },
    })
    let stderr = ''
    transport.stderr?.on('data', chunk => { stderr += String(chunk) })
    client = new Client({ name: 'garak-integration', version: '1.0.0' })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['apply_edits', 'get_capabilities', 'get_catalog', 'get_state', 'history', 'list_instances', 'preview_edits'])
    const applySchema = tools.tools.find(tool => tool.name === 'apply_edits')!.inputSchema
    expect(applySchema.required).toContain('expectedRevision')
    expect(applySchema.required).toContain('instanceId')
    expect(applySchema.properties).toHaveProperty('commands')
    expect(tools.tools.find(tool => tool.name === 'history')!.inputSchema.required).toContain('instanceId')
    expect(tools.tools.find(tool => tool.name === 'preview_edits')!.inputSchema.required).not.toContain('instanceId')

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client!.callTool({ name, arguments: args })
      if (!('structuredContent' in response)) throw new Error('Expected structured MCP result')
      return { isError: response.isError === true, value: response.structuredContent as Record<string, any> }
    }
    expect((await call('list_instances')).value.instances).toEqual([])
    expect((await call('get_state')).value.error.code).toBe('DAW_NOT_CONNECTED')

    const session = new ProjectSession(createEmptyProject())
    let editsAllowed = false
    let mutations = 0
    const handle = createDawRequestHandler({
      session,
      getSelection: () => ({ focusedTrackId: null, trackIds: [], clipIds: [] }),
      getTransport: () => ({ playing: false, beat: 0, ready: false, sampleRate: 48000 }),
      getRuntime: () => ({ ready: true, editsAllowed, blockedReason: null, persistence: 'saved' }),
      onMutation: () => { mutations++ },
    })
    socket = await connectDaw(port, 'integration-tab', handle)

    expect((await call('list_instances')).value.instances[0].instanceId).toBe('integration-tab')
    expect((await call('get_state', { instanceId: 'not-this-tab' })).value.error.code).toBe('INSTANCE_NOT_FOUND')
    const initial = (await call('get_state')).value
    const edit = {
      projectId: initial.projectId, expectedRevision: initial.revision, operationId: 'create-draft',
      commands: [{ type: 'track.create', kind: 'instrument', instrument: 'keys', name: 'AI Keys', initialClip: {
        name: 'Opening', startBeat: 0, lengthBeats: 4,
        notes: [{ pitch: 60, start: 0, duration: 1, velocity: 0.7 }],
      } }],
    }
    const targetedEdit = { ...edit, instanceId: 'integration-tab' }
    for (const name of ['apply_edits', 'history']) {
      const args = name === 'apply_edits' ? edit : {
        projectId: initial.projectId, expectedRevision: initial.revision, operationId: 'missing-target-undo', action: 'undo',
      }
      for (const invalidArgs of [args, { ...args, instanceId: '' }]) {
        const rejected = await client.callTool({ name, arguments: invalidArgs })
        expect(rejected.isError).toBe(true)
        expect(JSON.stringify(rejected.content)).toContain('instanceId')
      }
    }
    expect(mutations).toBe(0)
    const preview = await call('preview_edits', edit)
    expect(preview.isError).toBe(false)
    expect(session.getSnapshot().history.present.tracks).toHaveLength(0)
    const blocked = await call('apply_edits', targetedEdit)
    expect(blocked.value.error.code).toBe('READ_ONLY')
    expect(session.getSnapshot().history.present.tracks).toHaveLength(0)
    editsAllowed = true
    const applied = await call('apply_edits', targetedEdit)
    expect(applied.isError).toBe(false)
    expect(applied.value.changed).toBe(true)
    expect(session.getSnapshot().history.present.tracks).toHaveLength(1)
    expect(session.getSnapshot().history.present.tracks[0].clips[0]).toMatchObject({ kind: 'midi', notes: [{ pitch: 60 }] })
    const clipId = session.getSnapshot().history.present.tracks[0].clips[0].id
    const notePage = await call('get_state', { instanceId: 'integration-tab', clipId, noteLimit: 1 })
    expect(notePage.value).toMatchObject({ noteView: 'source', noteCount: 1, nextNoteOffset: null, notes: [{ pitch: 60 }] })
    expect((await call('get_state', { clipId, trackLimit: 1 })).value.error.code).toBe('INVALID_REQUEST')
    const retry = await call('apply_edits', targetedEdit)
    expect(retry.value).toMatchObject({ revision: applied.value.revision, operationId: applied.value.operationId, results: applied.value.results, currentRevision: applied.value.currentRevision })
    expect(mutations).toBe(1)
    expect(session.getSnapshot().history.present.tracks).toHaveLength(1)
    const conflict = await call('apply_edits', { ...targetedEdit, operationId: 'stale-edit' })
    expect(conflict.isError).toBe(true)
    expect(conflict.value.error.code).toBe('REVISION_CONFLICT')
    const undoArgs = { instanceId: 'integration-tab', projectId: initial.projectId, expectedRevision: applied.value.revision, operationId: 'undo-draft', action: 'undo' }
    const undo = await call('history', undoArgs)
    expect(undo.isError).toBe(false)
    expect(session.getSnapshot().history.present.tracks).toHaveLength(0)
    const catalog = (await call('get_catalog', { kind: 'effects' })).value
    expect(catalog.effects.map((effect: { id: string }) => effect.id).sort()).toEqual(['compressor', 'delay', 'drive', 'eq', 'filter', 'reverb'])
    expect(catalog).not.toHaveProperty('instruments')
    expect((await call('get_capabilities')).value.unsupported).toContain('transport control')

    // Refresh can reopen the same project at the same revision with an empty operation cache.
    // The old explicit instanceId must never be routed to this new sole connection.
    const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()))
    socket.close()
    await closed
    const refreshedSession = new ProjectSession(session.getSnapshot().history.present)
    expect(refreshedSession.getSnapshot().revision).toBe(edit.expectedRevision)
    const refreshedHandle = createDawRequestHandler({
      session: refreshedSession,
      getSelection: () => ({ focusedTrackId: null, trackIds: [], clipIds: [] }),
      getTransport: () => ({ playing: false, beat: 0, ready: false, sampleRate: 48000 }),
      getRuntime: () => ({ ready: true, editsAllowed: true, blockedReason: null, persistence: 'saved' }),
    })
    socket = await connectDaw(port, 'refreshed-tab', refreshedHandle)
    expect((await call('list_instances')).value.instances.map((item: { instanceId: string }) => item.instanceId)).toEqual(['refreshed-tab'])
    expect((await call('get_state')).value).toMatchObject({ projectId: edit.projectId, revision: edit.expectedRevision })
    expect((await call('apply_edits', targetedEdit)).value.error.code).toBe('INSTANCE_NOT_FOUND')
    expect((await call('history', undoArgs)).value.error.code).toBe('INSTANCE_NOT_FOUND')
    expect(refreshedSession.getSnapshot().history.present.tracks).toHaveLength(0)
    expect(refreshedSession.getSnapshot().revision).toBe(edit.expectedRevision)
    const newEdit = await call('apply_edits', { ...edit, instanceId: 'refreshed-tab', operationId: 'new-session-draft' })
    expect(newEdit.isError).toBe(false)
    expect(refreshedSession.getSnapshot().history.present.tracks).toHaveLength(1)
    expect(stderr).toContain('MCP 준비 완료')
    expect(stderr).not.toContain(TOKEN)
  }, 20_000)
})
