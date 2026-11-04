import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import App, { type SaveFailedChoice } from './App'
import { BRAND } from './brand'
import { ProjectLauncher } from './components/ProjectLauncher'
import { createLocalProject, importAsNewLocalProject } from './core/projectLibrary'
import { browserNavigationHost, ProjectNavigation, type ProjectRoute } from './core/projectNavigation'
import { PROJECT_TEMPLATES } from './core/projectTemplates'
import { listProjects, type ProjectSummary } from './core/storage'
import { bindDesktopProjectEvents, chooseProjectFile, type DesktopProjectHandlers } from './platform/desktop'
import './ProjectShell.css'

/** Routes identify locally saved projects; creating/importing persists before navigation. */
export default function ProjectShell() {
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null)
  const projectSave = useRef<(() => Promise<void>) | null>(null)
  const desktopHandlers = useRef<DesktopProjectHandlers | null>(null)
  const opening = useRef(false), closing = useRef(false)
  const [openingFile, setOpeningFile] = useState(false)
  const [closingApp, setClosingApp] = useState(false)
  const [navigation] = useState(() => new ProjectNavigation(browserNavigationHost(), () => leaveGuard.current?.() ?? Promise.resolve(true)))
  const { route, pending } = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const importInput = useRef<HTMLInputElement>(null)
  const progress = useRef<HTMLElement>(null)
  const [savePrompt, setSavePrompt] = useState<{ message: string; resolve: (choice: SaveFailedChoice) => void } | null>(null)
  const savePromptOpen = useRef(false)
  savePromptOpen.current = !!savePrompt
  const closeControl = useRef<{ awaitingUser(): void } | null>(null)
  const askSaveFailed = useCallback((message: string) => {
    closeControl.current?.awaitingUser()
    return new Promise<SaveFailedChoice>(resolve => setSavePrompt({ message, resolve }))
  }, [])
  const answerSave = (choice: SaveFailedChoice) => { savePrompt?.resolve(choice); setSavePrompt(null) }
  const firstChoice = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (savePrompt) firstChoice.current?.focus({ preventScroll: true }) }, [savePrompt])
  const launcherVisible = route.kind !== 'project'
  const blocked = pending || openingFile || closingApp

  useEffect(() => navigation.start(), [navigation])
  const registerNavigationGuard = useCallback((guard: () => Promise<boolean>) => {
    leaveGuard.current = guard
    return () => { if (leaveGuard.current === guard) leaveGuard.current = null }
  }, [])
  const registerProjectSave = useCallback((save: () => Promise<void>) => {
    projectSave.current = save
    return () => { if (projectSave.current === save) projectSave.current = null }
  }, [])

  useEffect(() => {
    if (!launcherVisible) return
    let cancelled = false
    setLoading(true)
    setListError('')
    void listProjects().then(items => {
      if (!cancelled) setProjects(items)
    }).catch(error => {
      if (!cancelled) setListError(error instanceof Error ? error.message : '프로젝트 목록을 불러오지 못했습니다.')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [launcherVisible, refresh])

  useEffect(() => {
    if (!launcherVisible) return
    document.title = `프로젝트 · ${BRAND.name}`
    const reload = () => setRefresh(value => value + 1)
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [launcherVisible])

  useEffect(() => {
    if (!blocked) return
    // Keep Tab and Space inside the progress dialog while the old project saves.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    progress.current?.focus({ preventScroll: true })
    const trap = (event: KeyboardEvent) => {
      // The save-failed choice keeps normal Tab order between its own buttons.
      if (event.key === 'Tab' && !savePromptOpen.current) { event.preventDefault(); progress.current?.focus({ preventScroll: true }) }
    }
    window.addEventListener('keydown', trap, true)
    return () => {
      window.removeEventListener('keydown', trap, true)
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [blocked])

  const go = useCallback((destination: ProjectRoute | (() => Promise<ProjectRoute>)) => {
    if (navigation.getSnapshot().pending || closing.current) return
    setNavigationError('')
    // Commit any inline draft before pending makes the editor inert. This also
    // runs synchronously for a menu command, before its source is unmounted.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    void navigation.navigate(destination).catch(error => {
      setNavigationError(error instanceof Error ? error.message : '프로젝트를 열지 못했습니다.')
    })
  }, [navigation])
  const open = (id: string) => go({ kind: 'project', id })
  const create = (templateId?: string) => go(async () => ({ kind: 'project', id: (await createLocalProject(templateId)).id }))
  const importFile = (file: File) => go(async () => ({ kind: 'project', id: (await importAsNewLocalProject(file)).id }))
  const openProjectFile = async () => {
    if (navigation.getSnapshot().pending || opening.current || closing.current) return
    opening.current = true
    setOpeningFile(true)
    setNavigationError('')
    try {
      const file = await chooseProjectFile(() => importInput.current?.click())
      if (file) importFile(file)
    } catch (error) {
      setNavigationError(`프로젝트 파일을 열지 못했습니다: ${error instanceof Error ? error.message : '파일을 확인해 주세요.'}`)
    } finally {
      opening.current = false
      setOpeningFile(false)
    }
  }

  desktopHandlers.current = {
    open: file => { if (!opening.current && !closing.current) importFile(file) },
    save: async () => {
      if (navigation.getSnapshot().pending || opening.current || closing.current) return
      if (projectSave.current) await projectSave.current()
      else setNavigationError('저장할 프로젝트를 먼저 열어 주세요.')
    },
    create: () => { if (!opening.current && !closing.current) create() },
    beforeClose: async control => {
      if (closing.current) return false
      if (navigation.getSnapshot().pending || opening.current) {
        setNavigationError('프로젝트 파일 작업이 끝난 뒤 앱을 닫아 주세요.')
        return false
      }
      if (navigation.getSnapshot().route.kind === 'project' && !leaveGuard.current) return false
      // Stop edits while the existing guard flushes the final autosave snapshot.
      closing.current = true
      setClosingApp(true)
      let accepted = false
      try {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        closeControl.current = control ?? null
        accepted = await (leaveGuard.current?.() ?? Promise.resolve(true))
        return accepted
      } finally {
        // Once accepted, stay inert until the main process closes the window.
        closeControl.current = null
        if (!accepted) { closing.current = false; setClosingApp(false) }
      }
    },
    error: error => setNavigationError(error instanceof Error ? error.message : '데스크톱 작업을 완료하지 못했습니다.'),
  }
  useEffect(() => {
    try {
      return bindDesktopProjectEvents({
        open: file => desktopHandlers.current?.open(file),
        save: () => desktopHandlers.current?.save(),
        create: () => desktopHandlers.current?.create(),
        beforeClose: control => desktopHandlers.current?.beforeClose(control) ?? Promise.resolve(false),
        error: error => desktopHandlers.current?.error(error),
      })
    } catch (error) {
      setNavigationError(`데스크톱 연결을 준비하지 못했습니다: ${error instanceof Error ? error.message : '앱을 다시 열어 주세요.'}`)
    }
  }, [])

  return <div className="project-shell">
    <div className="project-shell-content" inert={blocked || undefined}>
      {route.kind === 'project' ? <App key={route.id} projectId={route.id} navigating={blocked} navigationError={navigationError}
        onHome={() => go({ kind: 'home' })} onNew={() => create()} onOpenProject={() => void openProjectFile()} registerNavigationGuard={registerNavigationGuard} registerProjectSave={registerProjectSave} onSaveFailed={askSaveFailed}/>
        : <ProjectLauncher projects={projects} templates={PROJECT_TEMPLATES} loading={loading} busy={blocked}
          error={navigationError || listError} notice={route.kind === 'not-found' ? '이 주소의 화면을 찾지 못했습니다. 아래에서 프로젝트를 선택해 주세요.' : undefined}
          onOpen={open} onTemplate={create} onNew={() => create()} onImport={() => void openProjectFile()}
          onRetry={() => { setNavigationError(''); setRefresh(value => value + 1) }}/>
      }
      <input ref={importInput} type="file" accept=".garak,.noct,.json,application/json" hidden onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) importFile(file)
      }}/>
    </div>
    {savePrompt && <div className="project-navigation-backdrop"><section className="project-navigation-status project-save-failed" role="alertdialog" aria-modal="true" aria-labelledby="project-save-failed-title" aria-describedby="project-save-failed-message"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); answerSave('cancel') } }}>
      <h2 id="project-save-failed-title">프로젝트를 저장하지 못했습니다</h2>
      <p id="project-save-failed-message">{closingApp ? '닫기 전에' : '이동하기 전에'} 마지막 변경을 저장하지 못했습니다. 저장하지 않으면 마지막으로 자동 저장된 상태로 남습니다.</p>
      <p className="project-save-failed-detail" data-selectable-text="" tabIndex={0}>{savePrompt.message}</p>
      <div className="project-save-failed-actions">
        <button ref={firstChoice} className="primary" onClick={() => answerSave('file')}>파일로 저장하고 {closingApp ? '닫기' : '이동'}</button>
        <button className="danger" onClick={() => answerSave('discard')}>저장하지 않고 {closingApp ? '닫기' : '이동'}</button>
        <button onClick={() => answerSave('cancel')}>취소</button>
      </div>
    </section></div>}
    {blocked && !savePrompt && <div className="project-navigation-backdrop"><section ref={progress} className="project-navigation-status" role="dialog" aria-modal="true" aria-labelledby="project-navigation-title" tabIndex={-1}>
      <span className="spinner" aria-hidden="true"/><h2 id="project-navigation-title">{closingApp ? '작업을 저장합니다' : openingFile ? '프로젝트 파일을 선택합니다' : '프로젝트를 준비합니다'}</h2><p role="status">{closingApp ? '현재 작업을 저장한 뒤 앱을 닫습니다.' : openingFile ? '파일 선택 창에서 열 프로젝트를 골라 주세요.' : '현재 작업을 저장하고 선택한 화면을 열고 있습니다.'}</p>
    </section></div>}
  </div>
}
