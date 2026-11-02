import { useMemo, useState, type CSSProperties } from 'react'
import type { ProjectTemplate } from '../core/projectTemplates'
import type { ProjectSummary } from '../core/storage'
import type { Project } from '../core/types'
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

const normalizeSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim()
const compactDate = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const fullDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeStyle: 'short' })

function durationText(beats: number, bpm: number): string {
  const seconds = Math.max(0, Math.round(beats * 60 / Math.max(1, bpm)))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function ProjectTime({ value }: { value: number }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <span>저장일 정보 없음</span>
  return <time dateTime={date.toISOString()} title={fullDate.format(date)}>{compactDate.format(date)}</time>
}

/** A small view of the actual MIDI arrangement; no playback or audio loading. */
function ArrangementPreview({ project }: { project: Project }) {
  const tracks = project.tracks.filter(track => track.clips.length).slice(0, 7)
  const span = Math.max(1, project.lengthBeats), left = 24, width = 488, row = 18
  return <svg className="pl-arrangement" viewBox="0 0 536 164" aria-hidden="true" focusable="false">
    <rect x="0.5" y="0.5" width="535" height="163" rx="6" className="pl-arrangement-surface"/>
    {Array.from({ length: 5 }, (_, index) => <g key={index}>
      <line x1={left + index * width / 4} x2={left + index * width / 4} y1="24" y2="153" className="pl-arrangement-grid"/>
      <text x={left + index * width / 4} y="15" textAnchor={index === 4 ? 'end' : 'start'}>{index === 4 ? project.lengthBeats / 4 : Math.floor(index * project.lengthBeats / 16) + 1}</text>
    </g>)}
    {tracks.map((track, trackIndex) => {
      const y = 27 + trackIndex * row
      const notes = track.clips.flatMap(clip => clip.kind === 'midi' ? clip.notes.map(note => ({ ...note, start: clip.startBeat + note.start, end: Math.min(clip.startBeat + clip.lengthBeats, clip.startBeat + note.start + note.duration) })) : [])
      const low = notes.length ? Math.min(...notes.map(note => note.pitch)) : 0
      const high = notes.length ? Math.max(...notes.map(note => note.pitch)) : 1
      const stride = Math.max(1, Math.ceil(notes.length / 56))
      return <g key={track.id}>
        <rect x="11" y={y + 2} width="4" height="12" rx="1" fill={track.color}/>
        {track.clips.map(clip => <rect key={clip.id} x={left + clip.startBeat / span * width} y={y} width={Math.max(1, clip.lengthBeats / span * width - 1.5)} height="15" rx="2" fill={track.color} fillOpacity=".17" stroke={track.color} strokeOpacity=".5" strokeWidth=".6"/>)}
        {notes.filter((_, index) => index % stride === 0).map(note => <rect key={note.id} x={left + note.start / span * width} y={y + 3 + (1 - (note.pitch - low) / Math.max(1, high - low)) * 7} width={Math.max(.8, (note.end - note.start) / span * width)} height="1.6" rx=".5" fill={track.color} fillOpacity=".9"/>)}
      </g>
    })}
  </svg>
}

function TemplateCard({ template, index, disabled, onOpen }: { template: ProjectTemplate; index: number; disabled: boolean; onOpen(id: string): void }) {
  // The factory only builds MIDI data. Opening still creates a separate new project.
  const preview = useMemo(() => template.create(), [template])
  return <article className="pl-template" style={{ '--template-accent': template.accent } as CSSProperties} aria-labelledby={`pl-template-${template.id}`}>
    <div className="pl-template-art">
      <div className="pl-template-kicker"><span className="pl-template-number">{String(index + 1).padStart(2, '0')}</span><span>{template.genre}</span><span className="pl-template-track-count"><Icon name="track" size={12}/>{preview.tracks.length}트랙</span></div>
      <ArrangementPreview project={preview}/>
    </div>
    <div className="pl-template-body">
      <div className="pl-template-title"><h3 id={`pl-template-${template.id}`}>{template.name}</h3><span>{durationText(template.bars * 4, template.bpm)}</span></div>
      <p className="pl-template-description">{template.description}</p>
      <dl className="pl-template-meta">
        <div><dt>템포</dt><dd>{template.bpm}<small>BPM</small></dd></div>
        <div><dt>편곡</dt><dd>{template.bars}<small>마디</small></dd></div>
        <div className="pl-template-key"><dt>조성</dt><dd>{template.keyLabel}</dd></div>
      </dl>
      <ul className="pl-instruments" aria-label="주요 악기">{template.instruments.map(instrument => <li key={instrument}>{instrument}</li>)}</ul>
      <button type="button" className="pl-template-open" disabled={disabled} onClick={() => onOpen(template.id)} aria-label={`${template.name}, 새 프로젝트로 열기`}><span>새 프로젝트로 열기</span><Icon name="right" size={17}/></button>
    </div>
  </article>
}

export function ProjectLauncher({ projects, templates, loading, busy, error, notice, onOpen, onTemplate, onNew, onImport, onRetry }: ProjectLauncherProps) {
  const [search, setSearch] = useState('')
  const query = normalizeSearch(search)
  const filtered = useMemo(() => [...projects].sort((a, b) => b.updatedAt - a.updatedAt).filter(project => !query || normalizeSearch(project.name).includes(query)), [projects, query])
  const locked = loading || busy

  return <div className="project-launcher">
    <header className="pl-topbar">
      <div className="pl-topbar-inner"><div className="pl-brand"><Brand/><span className="pl-nav-label">프로젝트</span></div><span className="pl-local-badge"><Icon name="folder" size={13}/>이 브라우저의 작업실</span></div>
    </header>
    <main className="pl-main" aria-labelledby="pl-title">
      <div className="pl-heading">
        <div><span className="pl-eyebrow">나의 작업실</span><h1 id="pl-title" tabIndex={-1}>가락을 이어가는 곳</h1><p>저장한 작업을 이어가거나, 새로운 곡을 시작하세요.</p></div>
        <div className="pl-main-actions"><button type="button" className="pl-button" disabled={locked} onClick={onImport}><Icon name="folder" size={16}/><span>.garak 불러오기</span></button><button type="button" className="pl-button pl-button--primary" disabled={locked} onClick={onNew}><Icon name="plus" size={17}/><span>새 빈 프로젝트</span></button></div>
      </div>

      {busy && <div className="pl-notice" role="status"><span className="pl-spinner" aria-hidden="true"/><span>프로젝트를 준비하고 있습니다.</span></div>}
      {notice && <div className="pl-notice" role="status"><Icon name="info" size={16}/><p data-selectable-text="">{notice}</p></div>}
      {error && <div className="pl-error" role="alert"><Icon name="info" size={18}/><div><strong>작업을 완료하지 못했습니다</strong><p data-selectable-text="" tabIndex={0}>{error}</p><small>저장된 작업을 보존한 상태로 다시 확인할 수 있습니다.</small></div><button type="button" className="pl-button" onClick={onRetry} disabled={locked}><Icon name="refresh" size={14}/>다시 시도</button></div>}

      <section className="pl-template-section" aria-labelledby="pl-templates-title">
        <div className="pl-section-heading"><div><h2 id="pl-templates-title">샘플 프로젝트 <span>{templates.length}</span></h2><p>국악기의 결에 서로 다른 리듬을 얹었습니다. 악기별 리전부터 자유롭게 바꿔보세요.</p></div><span className="pl-section-note"><Icon name="note" size={14}/>편집 가능한 MIDI 편곡</span></div>
        <div className="pl-templates">{templates.map((template, index) => <TemplateCard key={template.id} template={template} index={index} disabled={locked} onOpen={onTemplate}/>)}</div>
        <p className="pl-template-footnote"><Icon name="copy" size={13}/>샘플을 열 때마다 새로운 프로젝트가 만들어집니다.</p>
      </section>

      <section className="pl-project-section" aria-labelledby="pl-projects-title" aria-busy={loading}>
        <div className="pl-section-heading pl-project-heading"><div><h2 id="pl-projects-title">내 프로젝트 <span>{projects.length}</span></h2><p>최근 수정한 순서로 표시합니다.</p></div><div className="pl-search"><Icon name="search" size={15}/><input type="search" aria-label="프로젝트 이름 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="프로젝트 이름 검색" disabled={busy} autoComplete="off"/>{search && <button type="button" onClick={() => setSearch('')} aria-label="검색어 지우기" disabled={busy}><Icon name="close" size={13}/></button>}</div></div>
        {loading && !projects.length ? <div className="pl-empty" role="status"><span className="pl-spinner" aria-hidden="true"/><strong>저장한 프로젝트를 불러오고 있습니다</strong><p>이 브라우저에 보관된 작업을 확인합니다.</p></div>
          : error && !projects.length ? <div className="pl-empty"><Icon name="folder" size={28}/><strong>프로젝트 목록을 확인할 수 없습니다</strong><p>위의 안내를 확인한 뒤 다시 시도해 주세요.</p></div>
          : !projects.length ? <div className="pl-empty"><span className="pl-empty-icon"><Icon name="file-plus" size={25}/></span><strong>첫 가락을 남겨보세요</strong><p>샘플이나 빈 프로젝트로 시작하면 작업이 여기에 모입니다.</p></div>
          : !filtered.length ? <div className="pl-empty"><Icon name="search" size={25}/><strong>찾는 프로젝트가 없습니다</strong><p>다른 이름으로 검색해 보세요.</p><button type="button" className="pl-reset-search" onClick={() => setSearch('')} disabled={busy}>전체 프로젝트 보기</button></div>
          : <div className="pl-project-table"><div className="pl-project-columns" aria-hidden="true"><span>프로젝트</span><span>템포 · 트랙</span><span>길이</span><span>최근 수정</span><span/></div><ul className="pl-project-list" aria-label="저장한 프로젝트">{filtered.map(project => <li key={project.id}><button type="button" className="pl-project-row" onClick={() => onOpen(project.id)} disabled={locked} title={`${project.name} 프로젝트 열기`}>
            <span className="pl-project-name"><span className="pl-project-icon"><Icon name="track" size={18}/></span><span><strong title={project.name}>{project.name}</strong><small>{project.lengthBeats / 4}마디<span className="pl-project-duration-compact"> · {durationText(project.lengthBeats, project.bpm)}</span></small></span></span>
            <span className="pl-project-spec"><b>{project.bpm}<small>BPM</small></b><span>{project.trackCount}트랙</span></span>
            <span className="pl-project-duration">{durationText(project.lengthBeats, project.bpm)}</span>
            <span className="pl-project-updated"><ProjectTime value={project.updatedAt}/></span>
            <span className="pl-project-arrow"><Icon name="right" size={17}/></span>
          </button></li>)}</ul></div>}
      </section>

      <footer className="pl-footer"><Icon name="info" size={14}/><p>프로젝트 주소는 이 브라우저에 저장된 작업을 엽니다. 다른 기기로 옮길 때는 <span>.garak</span> 파일을 사용하세요.</p></footer>
    </main>
  </div>
}

export default ProjectLauncher
