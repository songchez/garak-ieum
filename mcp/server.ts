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

async function main(): Promise<void> {
  const token = process.env.GARAK_MCP_TOKEN
  if (!isBridgeToken(token)) throw new Error('GARAK_MCP_TOKEN에 32~256자의 무작위 토큰을 설정해주세요. pnpm mcp:token으로 생성할 수 있습니다.')
  const bridge = await startDawBridge({ token, port: portFromEnvironment() })
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_BRIDGE_MESSAGE_BYTES * 2 })
  const handle = serveStdio(() => createGarakMcpServer(bridge), {
    transport, legacy: 'serve',
    onerror: () => { process.stderr.write('가락이음 MCP 프로토콜 요청을 처리하지 못했습니다.\n') },
  })
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await Promise.allSettled([handle.close(), bridge.close()])
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  process.stdin.once('end', () => { void shutdown() })
  process.stdin.once('close', () => { void shutdown() })
  process.stdout.once('error', () => { void shutdown() })
  process.stderr.write(`가락이음 MCP 준비 완료 · loopback bridge 127.0.0.1:${bridge.port}\n`)
}

main().catch(error => {
  // Error messages are fixed configuration guidance, never a token or submitted tool body.
  const message = error instanceof Error && (error.message.startsWith('GARAK_MCP_'))
    ? error.message : '가락이음 MCP를 시작하지 못했습니다. 포트 사용 여부와 설치 상태를 확인해주세요.'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
