import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { DEFAULT_BRIDGE_PORT, MAX_BRIDGE_MESSAGE_BYTES, isBridgeToken } from '../src/automation/protocol.js'
import { startDawBridge } from './bridgeServer.js'
import { createGarakMcpServer } from './tools.js'

function portFromEnvironment(): number {
  const raw = process.env.GARAK_MCP_PORT
  if (raw === undefined) return DEFAULT_BRIDGE_PORT
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GARAK_MCP_PORT는 1024~65535 범위의 정수여야 합니다.')
  return port
}

export interface McpServerHandle {
  readonly port: number
  /** Resolves only after the stdio transport and loopback listener have closed. */
  readonly closed: Promise<void>
  close(): Promise<void>
}

/** Imports are inert so an installed desktop entry point can own process startup and exit. */
export async function startMcpServer(): Promise<McpServerHandle> {
  const token = process.env.GARAK_MCP_TOKEN
  if (!isBridgeToken(token)) throw new Error('GARAK_MCP_TOKEN에 32~256자의 무작위 토큰을 설정해주세요. pnpm mcp:token으로 생성할 수 있습니다.')
  const bridge = await startDawBridge({ token, port: portFromEnvironment() })
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_BRIDGE_MESSAGE_BYTES * 2 })
  let handle: ReturnType<typeof serveStdio>
  try {
    handle = serveStdio(() => createGarakMcpServer(bridge), {
      transport, legacy: 'serve',
      onerror: () => { process.stderr.write('가락이음 MCP 프로토콜 요청을 처리하지 못했습니다.\n') },
    })
  } catch (error) {
    await Promise.allSettled([transport.close(), bridge.close()])
    throw error
  }
  let closing = false
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const shutdown = (): Promise<void> => {
    if (closing) return closed
    closing = true
    process.off('SIGINT', requestShutdown)
    process.off('SIGTERM', requestShutdown)
    process.stdin.off('end', requestShutdown)
    process.stdin.off('close', requestShutdown)
    process.stdin.off('error', requestShutdown)
    process.stdout.off('error', requestShutdown)
    void Promise.allSettled([handle.close(), bridge.close()]).then(() => resolveClosed())
    return closed
  }
  const requestShutdown = () => { void shutdown() }
  // The SDK also closes its transport on EOF, malformed oversized input, or a broken stdout pipe.
  // Preserve its own cleanup while making that closure observable by the Electron host.
  const transportClosed = transport.onclose
  transport.onclose = () => { transportClosed?.(); requestShutdown() }
  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)
  process.stdin.once('end', requestShutdown)
  process.stdin.once('close', requestShutdown)
  process.stdin.once('error', requestShutdown)
  process.stdout.once('error', requestShutdown)
  if (process.stdin.readableEnded || process.stdin.destroyed) requestShutdown()
  process.stderr.write(`가락이음 MCP 준비 완료 · loopback bridge 127.0.0.1:${bridge.port}\n`)
  return { port: bridge.port, closed, close: shutdown }
}

export function mcpStartupErrorMessage(error: unknown): string {
  // Error messages are fixed configuration guidance, never a token or submitted tool body.
  return error instanceof Error && (error.message.startsWith('GARAK_MCP_'))
    ? error.message : '가락이음 MCP를 시작하지 못했습니다. 포트 사용 여부와 설치 상태를 확인해주세요.'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMcpServer().catch(error => {
    process.stderr.write(`${mcpStartupErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
