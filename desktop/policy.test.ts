import { describe, expect, it } from 'vitest'
import { assetRelativePath, desktopMcpStartupErrorMessage, isAppUrl, isBundledLicenseUrl, isExternalUrl, safeSuggestedName, validateSaveRequest } from './policy'

describe('packaged asset boundary', () => {
  it('accepts only the local app authority', () => {
    expect(isAppUrl('garak://app/projects/a')).toBe(true)
    for (const url of ['https://app/', 'file:///index.html', 'garak://app.evil/', 'garak://user@app/', 'garak://app:80/']) expect(isAppUrl(url)).toBe(false)
  })
  it('maps immutable asset paths without queries or double decoding', () => {
    expect(assetRelativePath('garak://app/')).toBe('index.html')
    expect(assetRelativePath('garak://app/fonts/font.woff2?v=1')).toBe('fonts/font.woff2')
    expect(assetRelativePath('garak://app/%25encoded')).toBe('%encoded')
  })
  it('rejects escaped path separators, drive paths, NUL and malformed encoding', () => {
    for (const path of ['/%5c..%5csecret', '/C%3a/secret', '/%00secret', '/bad%xy', '/a/%2e%2e%2fsecret']) expect(assetRelativePath(`garak://app${path}`)).toBe(null)
  })
  it('permits only web external links without embedded credentials', () => {
    expect(isExternalUrl('https://example.com/docs')).toBe(true)
    for (const url of ['file:///secret', 'javascript:alert(1)', 'https://u:p@example.com', 'garak://app/']) expect(isExternalUrl(url)).toBe(false)
  })
  it.each([
    'lucide-LICENSE.txt', 'GPL-3.0-only.txt', 'garak-ieum-MIT-notice.txt', 'THIRD_PARTY_NOTICES.txt', 'SOURCE.txt',
  ])('opens bundled notice %s only at its exact path without query or fragment', filename => {
    const url = `garak://app/licenses/${filename}`
    expect(isBundledLicenseUrl(url)).toBe(true)
    for (const suffix of ['?download=1', '#section', '.html', '/', '/index.html', '%00']) expect(isBundledLicenseUrl(`${url}${suffix}`)).toBe(false)
    expect(isBundledLicenseUrl(`garak://app/licenses%2f${filename}`)).toBe(false)
  })
  it('rejects other documents, encoded filenames and foreign authorities', () => {
    for (const url of [
      'garak://app/', 'garak://app/projects/song', 'garak://app/index.html',
      'garak://app/licenses/unknown.txt', 'garak://app/licenses/GPL-3.0-or-later.txt',
      'garak://app/licenses/source.txt', 'garak://app/licenses/%53OURCE.txt',
      'garak://user@app/licenses/GPL-3.0-only.txt', 'garak://app.evil/licenses/GPL-3.0-only.txt',
      'garak://app:80/licenses/THIRD_PARTY_NOTICES.txt', 'https://app/licenses/garak-ieum-MIT-notice.txt',
      'file:///licenses/SOURCE.txt', 'not a URL',
    ]) expect(isBundledLicenseUrl(url)).toBe(false)
  })
})

describe('desktop MCP startup diagnostics', () => {
  it('preserves only the known token and port configuration guidance', () => {
    for (const message of [
      'GARAK_MCP_TOKEN에 32~256자의 무작위 토큰을 설정해주세요. pnpm mcp:token으로 생성할 수 있습니다.',
      'GARAK_MCP_PORT는 1024~65535 범위의 정수여야 합니다.',
    ]) expect(desktopMcpStartupErrorMessage(new Error(message))).toBe(message)
  })
  it('uses a fixed failure message for failed imports and unrecognized diagnostic text', () => {
    const fallback = '가락이음 MCP를 시작하지 못했습니다. 포트 사용 여부와 설치 상태를 확인해주세요.'
    for (const error of [
      new Error('Cannot find module /private/install/dist-mcp/mcp/server.js'),
      new Error('GARAK_MCP_TOKEN=do-not-print-this-value'),
      new Error('GARAK_MCP_PORT는 1024~65535 범위의 정수여야 합니다.\nprivate details'),
      'GARAK_MCP_TOKEN=do-not-print-this-value', null,
    ]) expect(desktopMcpStartupErrorMessage(error)).toBe(fallback)
  })
})

describe('native save boundary', () => {
  it('keeps a safe leaf filename and forces the selected export type', () => {
    expect(safeSuggestedName('../../노래?.json', 'project')).toBe('노래_.garak')
    expect(safeSuggestedName('C:\\temp\\곡.wav', 'audio')).toBe('곡.wav')
    expect(safeSuggestedName('CON.wav', 'audio')).toBe('가락이음.wav')
  })
  it('retains exactly the supplied byte view', () => {
    const bytes = new Uint8Array([9, 1, 2, 9]).subarray(1, 3)
    const request = validateSaveRequest({ kind: 'project', name: '곡.garak', data: bytes })
    expect([...request.data]).toEqual([1, 2])
  })
  it('rejects unrecognized kinds, paths without bytes, and empty data', () => {
    for (const request of [null, { kind: 'script', name: 'x', data: new Uint8Array([1]) }, { kind: 'project', name: 'x', data: '/etc/passwd' }, { kind: 'audio', name: 'x', data: new Uint8Array() }]) expect(() => validateSaveRequest(request)).toThrow()
  })
})
