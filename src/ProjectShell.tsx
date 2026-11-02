import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import App from './App'
import { BRAND } from './brand'
import { ProjectLauncher } from './components/ProjectLauncher'
import { createLocalProject, importAsNewLocalProject } from './core/projectLibrary'
import { browserNavigationHost, ProjectNavigation, type ProjectRoute } from './core/projectNavigation'
import { PROJECT_TEMPLATES } from './core/projectTemplates'
import { listProjects, type ProjectSummary } from './core/storage'
import './ProjectShell.css'

/** Routes identify browser-local projects; creating/importing persists before navigation. */
export default function ProjectShell() {
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null)
  const [navigation] = useState(() => new ProjectNavigation(browserNavigationHost(), () => leaveGuard.current?.() ?? Promise.resolve(true)))
  const { route, pending } = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const importInput = useRef<HTMLInputElement>(null)
  const progress = useRef<HTMLElement>(null)
  const launcherVisible = route.kind !== 'project'

  useEffect(() => navigation.start(), [navigation])
  const registerNavigationGuard = useCallback((guard: () => Promise<boolean>) => {
    leaveGuard.current = guard
    return () => { if (leaveGuard.current === guard) leaveGuard.current = null }
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
    if (!pending) return
    // Keep Tab and Space inside the progress dialog while the old project saves.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    progress.current?.focus({ preventScroll: true })
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Tab') { event.preventDefault(); progress.current?.focus({ preventScroll: true }) }
    }
    window.addEventListener('keydown', trap, true)
    return () => {
      window.removeEventListener('keydown', trap, true)
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [pending])

  const go = useCallback((destination: ProjectRoute | (() => Promise<ProjectRoute>)) => {
    if (navigation.getSnapshot().pending) return
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

  return <div className="project-shell">
    <div className="project-shell-content" inert={pending || undefined}>
      {route.kind === 'project' ? <App key={route.id} projectId={route.id} navigating={pending} navigationError={navigationError}
        onHome={() => go({ kind: 'home' })} onNew={() => create()} onImport={importFile} registerNavigationGuard={registerNavigationGuard}/>
        : <ProjectLauncher projects={projects} templates={PROJECT_TEMPLATES} loading={loading} busy={pending}
          error={navigationError || listError} notice={route.kind === 'not-found' ? '이 주소의 화면을 찾지 못했습니다. 아래에서 프로젝트를 선택해 주세요.' : undefined}
          onOpen={open} onTemplate={create} onNew={() => create()} onImport={() => importInput.current?.click()}
          onRetry={() => { setNavigationError(''); setRefresh(value => value + 1) }}/>
      }
      <input ref={importInput} type="file" accept=".garak,.noct,.json,application/json" hidden onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) importFile(file)
      }}/>
    </div>
    {pending && <div className="project-navigation-backdrop"><section ref={progress} className="project-navigation-status" role="dialog" aria-modal="true" aria-labelledby="project-navigation-title" tabIndex={-1}>
      <span className="spinner" aria-hidden="true"/><h2 id="project-navigation-title">프로젝트를 준비합니다</h2><p role="status">현재 작업을 저장하고 선택한 화면을 열고 있습니다.</p>
    </section></div>}
  </div>
}
