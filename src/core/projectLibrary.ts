import { createEmptyProject, uid } from './project'
import { createTemplateProject } from './projectTemplates'
import { importProjectBundle, saveStoredProject } from './storage'
import type { Project } from './types'

/** The launcher navigates only after the new project has committed to local storage. */
export async function createLocalProject(templateId?: string): Promise<Project> {
  const project = templateId === undefined ? createEmptyProject() : createTemplateProject(templateId)
  await saveStoredProject({ project, assets: [] })
  return project
}

/** Import is always a new local project; original audio stays encoded until the editor needs it. */
export async function importAsNewLocalProject(file: Blob): Promise<Project> {
  const imported = await importProjectBundle(file)
  const project = { ...imported.project, id: uid() }
  await saveStoredProject({ project, assets: imported.assets })
  return project
}
