import { posix } from 'node:path'
import type { DesktopExportKind, DesktopSaveRequest } from './contracts.js'

export const APP_URL = 'garak://app/'
export const MAX_PROJECT_BYTES = 512 * 1024 * 1024
export const MAX_EXPORT_BYTES = 2_000_000_000
export const PROJECT_EXTENSIONS = ['garak', 'noct', 'json']

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'garak:' && url.hostname === 'app' && !url.username && !url.password && !url.port
  } catch { return false }
}

/** URL paths are decoded once and must stay relative to the immutable packaged assets. */
export function assetRelativePath(value: string): string | null {
  if (!isAppUrl(value)) return null
  try {
    const path = decodeURIComponent(new URL(value).pathname)
    if (!path.startsWith('/') || /[\u0000-\u001f\\:]/.test(path)) return null
    if (path.split('/').some(segment => segment === '..' || segment === '.')) return null
    return path.slice(1) || 'index.html'
  } catch { return null }
}

export function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}

/** Only this existing About link may open a document window; never a general app URL. */
export function isBundledLicenseUrl(value: string): boolean {
  if (!isAppUrl(value)) return false
  const url = new URL(value)
  return url.pathname === '/licenses/lucide-LICENSE.txt' && !url.search && !url.hash
}

/** Formatting a failed MCP import must not depend on importing that module again. */
export function desktopMcpStartupErrorMessage(error: unknown): string {
  const knownMessages = [
    'GARAK_MCP_TOKEN에 32~256자의 무작위 토큰을 설정해주세요. pnpm mcp:token으로 생성할 수 있습니다.',
    'GARAK_MCP_PORT는 1024~65535 범위의 정수여야 합니다.',
  ]
  return error instanceof Error && knownMessages.includes(error.message)
    ? error.message : '가락이음 MCP를 시작하지 못했습니다. 포트 사용 여부와 설치 상태를 확인해주세요.'
}

export function exportExtension(kind: DesktopExportKind): string {
  return { project: 'garak', audio: 'wav', json: 'json' }[kind]
}

export function safeSuggestedName(name: string, kind: DesktopExportKind): string {
  let stem = posix.basename(name.replaceAll('\\', '/')).replace(/\.[^.]*$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 150)
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '가락이음'
  return `${stem}.${exportExtension(kind)}`
}

export function validateSaveRequest(value: unknown): DesktopSaveRequest {
  if (!value || typeof value !== 'object') throw new Error('저장할 파일이 올바르지 않습니다.')
  const request = value as Partial<DesktopSaveRequest>
  if (!['project', 'audio', 'json'].includes(request.kind ?? '') || typeof request.name !== 'string' || request.name.length > 1000 || !(request.data instanceof Uint8Array)) {
    throw new Error('저장할 파일이 올바르지 않습니다.')
  }
  const limit = request.kind === 'project' ? MAX_PROJECT_BYTES : MAX_EXPORT_BYTES
  if (request.data.byteLength === 0 || request.data.byteLength > limit) throw new Error('저장할 파일 크기가 지원 범위를 벗어났습니다.')
  return { kind: request.kind as DesktopExportKind, name: safeSuggestedName(request.name, request.kind as DesktopExportKind), data: request.data }
}
