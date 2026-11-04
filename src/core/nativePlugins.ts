import { MAX_PLUGIN_STATE_BYTES, type NativePluginInstance, type NativePluginState } from '../audio/native/contracts'

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`)
  return value as Record<string, unknown>
}
const string = (value: unknown, path: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${path} must be a nonempty string of at most ${maximum} characters.`)
  return value
}
const base64 = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PLUGIN_STATE_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${path} must be a bounded base64 plugin state.`)
  const bytes = value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  if (bytes > MAX_PLUGIN_STATE_BYTES) throw new Error(`${path} exceeds the plugin state limit.`)
  return value
}

export function validateNativePluginState(input: unknown): NativePluginState {
  const raw = record(input, 'VST3 state')
  if (Object.keys(raw).some(key => key !== 'component' && key !== 'controller')) throw new Error('Unknown VST3 state field.')
  return { component: base64(raw.component, 'VST3 component state'), ...(raw.controller === undefined ? {} : { controller: base64(raw.controller, 'VST3 controller state') }) }
}

/** Executable paths and unknown plugin fields are rejected, not forwarded to native code. */
export function validateNativePlugin(input: unknown, path: string, editingId: (value: unknown, path: string) => string): NativePluginInstance {
  const raw = record(input, path)
  const allowed = new Set(['id', 'pluginId', 'classId', 'name', 'enabled', 'parameters', 'state'])
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new Error(`${path} has an unsupported plugin field. Executable paths are not project data.`)
  const pluginId = string(raw.pluginId, `${path} catalog ID`, 200)
  if (!/^[\w.:-]+$/.test(pluginId)) throw new Error(`${path} has an invalid plugin catalog ID.`)
  const classId = string(raw.classId, `${path} class ID`, 32)
  if (!/^[a-fA-F0-9]{32}$/.test(classId)) throw new Error(`${path} has an invalid VST3 class ID.`)
  if (typeof raw.enabled !== 'boolean') throw new Error(`${path} enabled must be a boolean.`)
  const source = record(raw.parameters ?? {}, `${path} parameters`)
  if (Object.keys(source).length > 4096) throw new Error(`${path} has too many parameters.`)
  const parameters: Record<string, number> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!/^\d{1,10}$/.test(key) || Number(key) > 0xffffffff || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${path} has an invalid normalized plugin parameter.`)
    parameters[String(Number(key))] = value
  }
  return {
    id: editingId(raw.id, `${path} ID`), pluginId, classId: classId.toUpperCase(),
    name: string(raw.name, `${path} name`, 256), enabled: raw.enabled, parameters,
    ...(raw.state === undefined ? {} : { state: validateNativePluginState(raw.state) }),
  }
}

export function cloneNativePlugin<T extends NativePluginInstance>(plugin: T, newId: string): T {
  return { ...plugin, id: newId, parameters: { ...plugin.parameters }, ...(plugin.state ? { state: { ...plugin.state } } : {}) }
}
