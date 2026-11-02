import { useState, useSyncExternalStore } from 'react'
import { DawBridgeClient } from '../automation/bridgeClient'
import { DEFAULT_BRIDGE_URL } from '../automation/protocol'
import { Icon } from './Icon'
import './McpConnectionDialog.css'

interface Props {
  client: DawBridgeClient
  instanceId: string
  projectName: string
  editsAllowed: boolean
  onEditsAllowed: (allowed: boolean) => void
  onClose: () => void
}
const STATUS = { disconnected: '연결 안 됨', connecting: '연결 중', connected: '연결됨', error: '연결 확인 필요' }

export default function McpConnectionDialog({ client, instanceId, projectName, editsAllowed, onEditsAllowed, onClose }: Props) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  const [url, setUrl] = useState(() => state.url ?? DEFAULT_BRIDGE_URL)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const active = state.status === 'connected' || state.status === 'connecting'
  function connect() {
    setError('')
    try { client.connect({ url, token: token.trim(), instanceId }); setToken('') }
    catch (value) { setError(value instanceof Error ? value.message : '연결을 시작하지 못했습니다.') }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal mcp-connection" role="dialog" aria-modal="true" aria-labelledby="mcp-connection-title"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
      <header className="mcp-connection-heading"><span className="mcp-symbol"><Icon name="plug" size={22}/></span><div><h2 id="mcp-connection-title">AI 연결</h2><p>MCP를 통해 이 작업실을 AI와 연결합니다.</p></div><button className="icon-button" type="button" aria-label="AI 연결 창 닫기" onClick={onClose}><Icon name="close" size={17}/></button></header>
      <div className={`mcp-connection-state mcp-connection-state--${state.status}`} role="status"><i/><strong>{STATUS[state.status]}</strong><span>{projectName || '이름 없는 프로젝트'}</span></div>
      <p className="mcp-connection-intro">같은 컴퓨터에서 가락이음 MCP 서버를 실행한 뒤 주소와 연결 키를 입력하세요. 연결된 AI는 곡 구성을 읽고 지원되는 편집을 수행할 수 있습니다.</p>
      <form onSubmit={event => { event.preventDefault(); if (!active) connect() }}>
        <label className="mcp-field"><span>브리지 주소</span><input type="url" value={url} onChange={event => setUrl(event.target.value)} disabled={active} spellCheck={false} autoComplete="off" required/></label>
        <label className="mcp-field"><span>연결 키</span><input type="password" value={token} onChange={event => setToken(event.target.value)} disabled={active} autoComplete="off" minLength={32} maxLength={256} placeholder={state.status === 'connected' ? '인증된 연결' : state.status === 'connecting' ? '연결 확인 중' : 'MCP 서버에 설정한 연결 키'} required={!active}/></label>
        <label className="mcp-edit-access"><input type="checkbox" checked={editsAllowed} onChange={event => onEditsAllowed(event.target.checked)}/><span><strong>AI 편집 허용</strong><small>끄면 곡 조회와 변경 미리 보기만 허용합니다. 편집은 기존 실행 취소로 되돌릴 수 있습니다.</small></span></label>
        {(error || state.message) && <p className="mcp-connection-error" role="alert" data-selectable-text="" tabIndex={0}>{error || state.message}</p>}
        <div className="mcp-connection-actions">{active ? <button type="button" onClick={() => { client.disconnect(); setError('') }}>{state.status === 'connecting' ? '연결 취소' : '연결 해제'}</button> : <button className="primary" type="submit"><Icon name="plug" size={15}/> 연결</button>}<button type="button" onClick={onClose}>닫기</button></div>
      </form>
      <div className="mcp-connection-help"><p>창을 닫아도 연결은 유지됩니다. 연결 키는 저장하지 않으며, 새로고침 뒤에는 다시 연결해야 합니다.</p><p>녹음·파일 처리·드래그·다른 대화상자 작업 중에는 AI 편집을 잠시 막습니다. 현재는 트랙·리전·기본 믹싱 편집을 지원합니다.</p><a href="https://github.com/songchez/garak-ieum/blob/main/docs/MCP.md" target="_blank" rel="noreferrer">설치·연결 안내 <Icon name="external" size={12}/></a><details><summary>작업실 식별자</summary><code data-selectable-text="" tabIndex={0}>{instanceId}</code></details></div>
    </section>
  </div>
}
