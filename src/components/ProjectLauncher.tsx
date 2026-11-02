import { useMemo, useState } from 'react'
import type { ProjectTemplate } from '../core/projectTemplates'
import type { ProjectSummary } from '../core/storage'
import { Brand } from './Brand'
import { Icon } from './Icon'
import './ProjectLauncher.css'

export interface ProjectLauncherProps {
  projects: readonly ProjectSummary[]
  templates: readonly ProjectTemplate[]
  loading: boolean
  busy: boolean
  error?: string
  notice?: string
  onOpen(id: string): void
  onTemplate(id: string): void
  onNew(): void
  onImport(): void
  onRetry(): void
}

type Category = 'projects' | 'templates'
type ChooserItem = {
  key: string
  name: string
  bpm: number
  trackCount: number
  lengthBeats: number
} & ({ kind: 'project'; project: ProjectSummary } | { kind: 'template'; template: ProjectTemplate })

const normalizeSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim()
const compactDate = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const fullDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeStyle: 'short' })
const barCount = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const barsText = (beats: number) => `${barCount.format(beats / 4)}마디`

function durationText(beats: number, bpm: number): string {
  const seconds = Math.max(0, Math.round(beats * 60 / Math.max(1, bpm)))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function ProjectTime({ value, full = false }: { value: number; full?: boolean }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <span>저장일 정보 없음</span>
  return <time dateTime={date.toISOString()} title={fullDate.format(date)}>{(full ? fullDate : compactDate).format(date)}</time>
}

/** Both sources use the same metadata-only tile; saved summaries have no artwork. */
function ProjectTile({ item, selected, disabled, onSelect, onOpen }: {
  item: ChooserItem
  selected: boolean
  disabled: boolean
  onSelect(key: string): void
  onOpen(item: ChooserItem): void
}) {
  return <li className="pl-project-cell">
    <button type="button" className={`pl-project-tile${selected ? ' is-selected' : ''}`} disabled={disabled}
      aria-pressed={selected} aria-label={`${item.name}, ${item.bpm} BPM, ${item.trackCount}트랙, ${barsText(item.lengthBeats)}, ${durationText(item.lengthBeats, item.bpm)}`}
      title={`${item.name} — 더블 클릭하거나 Enter를 눌러 열기`}
      onFocus={() => onSelect(item.key)} onClick={() => onSelect(item.key)} onDoubleClick={() => onOpen(item)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault()
          if (!event.repeat) onOpen(item)
        }
      }}>
      <span className="pl-tile-cover" aria-hidden="true"><span className="pl-document-mark"><Icon name="track" size={29}/></span>{selected && <span className="pl-tile-check"><Icon name="check" size={11}/></span>}</span>
      <strong className="pl-tile-name">{item.name}</strong>
      <span className="pl-tile-subtitle">{item.kind === 'template' ? item.template.genre : <><ProjectTime value={item.project.updatedAt}/> 수정</>}</span>
      <span className="pl-tile-meta"><span>{item.bpm} <small>BPM</small></span><span>{item.trackCount}트랙</span></span>
      <span className="pl-tile-meta pl-tile-length"><span>{barsText(item.lengthBeats)}</span><span>{durationText(item.lengthBeats, item.bpm)}</span></span>
    </button>
  </li>
}

export function ProjectLauncher({ projects, templates, loading, busy, error, notice, onOpen, onTemplate, onNew, onImport, onRetry }: ProjectLauncherProps) {
  const [category, setCategory] = useState<Category>('projects')
  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const locked = loading || busy
  const projectItems = useMemo<ChooserItem[]>(() => [...projects].sort((a, b) => b.updatedAt - a.updatedAt).map(project => ({
    key: `project:${project.id}`, kind: 'project', name: project.name, bpm: project.bpm,
    trackCount: project.trackCount, lengthBeats: project.lengthBeats, project,
  })), [projects])
  const templateItems = useMemo<ChooserItem[]>(() => templates.map(template => ({
    key: `template:${template.id}`, kind: 'template', name: template.name, bpm: template.bpm,
    // Factories only build MIDI data. Opening still creates its own fresh project.
    trackCount: template.create().tracks.length, lengthBeats: template.bars * 4, template,
  })), [templates])
  const items = category === 'projects' ? projectItems : templateItems
  const query = normalizeSearch(search)
  const filtered = useMemo(() => items.filter(item => !query || normalizeSearch(item.name).includes(query)), [items, query])
  // Derive selection from visible data so removed or filtered items cannot be opened.
  const selected = filtered.find(item => item.key === selectedKey)
  const categoryName = category === 'projects' ? '내 프로젝트' : '샘플 프로젝트'

  function changeCategory(next: Category) {
    if (busy || next === category) return
    setCategory(next)
    setSearch('')
    setSelectedKey(null)
  }

  function changeSearch(value: string) {
    setSearch(value)
    setSelectedKey(null)
  }

  function openItem(item: ChooserItem | undefined) {
    if (locked || !item || !filtered.some(visible => visible.key === item.key)) return
    if (item.kind === 'project') onOpen(item.project.id)
    else onTemplate(item.template.id)
  }

  return <div className="project-launcher">
    <header className="pl-topbar"><div className="pl-topbar-inner"><div className="pl-brand"><Brand/><span className="pl-nav-label">프로젝트</span></div><span className="pl-local-badge"><Icon name="folder" size={13}/>이 브라우저의 작업실</span></div></header>
    <main className="pl-main" aria-labelledby="pl-title">
      <section className="pl-chooser" aria-label="프로젝트 선택">
        <aside className="pl-sidebar">
          <h1 id="pl-title" tabIndex={-1}>프로젝트 선택</h1>
          <nav className="pl-categories" aria-label="프로젝트 분류">
            <button type="button" className="pl-category" aria-pressed={category === 'projects'} disabled={busy} onClick={() => changeCategory('projects')}><Icon name="folder" size={16}/><span>내 프로젝트</span><small>{projects.length}</small></button>
            <button type="button" className="pl-category" aria-pressed={category === 'templates'} disabled={busy} onClick={() => changeCategory('templates')}><Icon name="library" size={16}/><span>샘플 프로젝트</span><small>{templates.length}</small></button>
          </nav>
          <p className="pl-keyboard-hint"><Icon name="keyboard" size={15}/><span>클릭하여 선택<br/>더블 클릭 또는 Enter로 열기</span></p>
        </aside>
        <div className="pl-browser">
          <header className="pl-browser-header">
            <div className="pl-browser-heading"><h2 id="pl-category-title">{categoryName}<span>{query ? `${filtered.length} / ${items.length}` : items.length}</span></h2><p>{category === 'projects' ? '최근 수정한 순서로 표시합니다.' : '선택한 편곡으로 새 프로젝트를 만듭니다.'}</p></div>
            <div className="pl-search"><Icon name="search" size={14}/><input type="search" aria-label={`${categoryName} 이름 검색`} value={search} onChange={event => changeSearch(event.target.value)} placeholder="프로젝트 이름 검색" disabled={busy} autoComplete="off"/>{search && <button type="button" onClick={() => changeSearch('')} aria-label="검색어 지우기" disabled={busy}><Icon name="close" size={13}/></button>}</div>
          </header>
          <div className="pl-browser-content" aria-busy={loading || busy}>
            {busy && <div className="pl-notice" role="status"><span className="pl-spinner" aria-hidden="true"/><span>프로젝트를 준비하고 있습니다.</span></div>}
            {notice && <div className="pl-notice" role="status"><Icon name="info" size={15}/><p data-selectable-text="">{notice}</p></div>}
            {error && <div className="pl-error" role="alert"><Icon name="info" size={16}/><div><strong>작업을 완료하지 못했습니다</strong><p data-selectable-text="" tabIndex={0}>{error}</p><small>저장된 작업을 보존한 상태로 다시 확인할 수 있습니다.</small></div><button type="button" className="pl-button" onClick={onRetry} disabled={locked}><Icon name="refresh" size={13}/>다시 시도</button></div>}
            {category === 'projects' && loading && !projects.length ? <div className="pl-empty" role="status"><span className="pl-spinner" aria-hidden="true"/><strong>저장한 프로젝트를 불러오고 있습니다</strong><p>이 브라우저에 보관된 작업을 확인합니다.</p></div>
              : category === 'projects' && error && !projects.length ? <div className="pl-empty"><Icon name="folder" size={26}/><strong>프로젝트 목록을 확인할 수 없습니다</strong><p>위의 안내를 확인한 뒤 다시 시도해 주세요.</p></div>
              : !items.length ? <div className="pl-empty"><Icon name={category === 'projects' ? 'file-plus' : 'library'} size={28}/><strong>{category === 'projects' ? '저장한 프로젝트가 없습니다' : '준비된 샘플이 없습니다'}</strong><p>{category === 'projects' ? '샘플 편곡이나 빈 프로젝트로 첫 곡을 시작해 보세요.' : '빈 프로젝트에서 새로운 곡을 시작해 보세요.'}</p>{category === 'projects' && templates.length > 0 && <button type="button" className="pl-button" disabled={busy} onClick={() => changeCategory('templates')}>샘플 프로젝트 보기<Icon name="right" size={14}/></button>}</div>
              : !filtered.length ? <div className="pl-empty"><Icon name="search" size={25}/><strong>찾는 프로젝트가 없습니다</strong><p>다른 이름으로 검색해 보세요.</p><button type="button" className="pl-button" onClick={() => changeSearch('')} disabled={busy}>전체 {categoryName} 보기</button></div>
              : <ul className="pl-project-grid" aria-labelledby="pl-category-title">{filtered.map(item => <ProjectTile key={item.key} item={item} selected={item.key === selected?.key} disabled={locked} onSelect={setSelectedKey} onOpen={openItem}/>)}</ul>}
          </div>
          <section className="pl-selection" aria-label="선택한 프로젝트 정보">
            <div className="pl-selection-summary">
              <div className="pl-selection-caption" aria-live="polite" aria-atomic="true"><strong title={selected?.name}>{selected?.name ?? '프로젝트를 선택하세요'}</strong><span>{selected ? selected.kind === 'template' ? '새 복사본을 만들어 편집합니다.' : '저장한 작업을 이어서 편집합니다.' : '목록에서 선택한 뒤 아래 열기 버튼을 누르세요.'}</span></div>
              <button type="button" className="pl-details-toggle" aria-expanded={Boolean(selected && detailsOpen)} aria-controls="pl-selection-details" disabled={!selected || busy} onClick={() => setDetailsOpen(value => !value)}>상세 정보<Icon name="chevron" size={14}/></button>
            </div>
            <div id="pl-selection-details" className="pl-selection-details" hidden={!selected || !detailsOpen} data-selectable-text="" tabIndex={selected && detailsOpen ? 0 : -1}>
              {selected && <><dl className="pl-detail-values"><div><dt>템포</dt><dd>{selected.bpm} BPM</dd></div><div><dt>트랙</dt><dd>{selected.trackCount}트랙</dd></div><div><dt>마디</dt><dd>{barsText(selected.lengthBeats)}</dd></div><div><dt>길이</dt><dd>{durationText(selected.lengthBeats, selected.bpm)}</dd></div></dl>
                {selected.kind === 'template' ? <><p className="pl-detail-description">{selected.template.description}</p><dl className="pl-detail-notes"><div><dt>조성</dt><dd>{selected.template.keyLabel}</dd></div><div><dt>주요 악기</dt><dd>{selected.template.instruments.join(' · ')}</dd></div></dl></> : <dl className="pl-detail-notes"><div><dt>만든 날짜</dt><dd><ProjectTime value={selected.project.createdAt} full/></dd></div><div><dt>최근 수정</dt><dd><ProjectTime value={selected.project.updatedAt} full/></dd></div></dl>}
              </>}
            </div>
          </section>
        </div>
        <footer className="pl-actions"><div className="pl-secondary-actions"><button type="button" className="pl-button" disabled={locked} onClick={onImport}><Icon name="folder" size={15}/><span>.garak 불러오기</span></button><button type="button" className="pl-button" disabled={locked} onClick={onNew}><Icon name="plus" size={16}/><span>새 빈 프로젝트</span></button></div><button type="button" className="pl-button pl-button--primary pl-open-button" disabled={locked || !selected} onClick={() => openItem(selected)} aria-label={selected ? `${selected.name}, ${selected.kind === 'template' ? '새 프로젝트로 열기' : '열기'}` : '선택한 프로젝트 열기'}>{selected?.kind === 'template' ? '새 프로젝트로 열기' : '열기'}<Icon name="right" size={15}/></button></footer>
      </section>
      <p className="pl-local-note"><Icon name="info" size={12}/><span>프로젝트 주소는 이 브라우저에 저장된 작업을 엽니다. 다른 기기로 옮길 때는 .garak 파일을 사용하세요.</span></p>
    </main>
  </div>
}

export default ProjectLauncher
