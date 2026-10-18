/**
 * Translate dsh tool calls into what the decision model reads.
 *
 * The model was trained on a fixed set of tool shapes (`shell_command`, `write_file`, `edit_file`,
 * `create_file`, `read_file`, ...). dsh's own tools are translated into those shapes using only
 * facts the call carries; nothing is guessed. Other tools, including MCP tools, are passed with
 * their own name and arguments.
 */

import os from 'node:os'
import path from 'node:path'

/** What to do with one call before the model sees it. */
export type Translation =
  /** Judge the call with the model, rendered as this tool and arguments. */
  | { readonly kind: 'judge'; readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> }
  /** Run it without asking the model; see {@link AllowReason}. */
  | { readonly kind: 'allow'; readonly reason: AllowReason }

/**
 * - `internal`: a dsh tool whose only effect stays inside the harness (todos, goals, questions,
 *   agent messages, job and terminal reads).
 * - `project-edit`: a file edit inside the project, which the model's release notes let hosts
 *   allow directly.
 * - `project-read`: a read or search inside the project.
 */
export type AllowReason = 'internal' | 'project-edit' | 'project-read'

/** dsh tools whose effects stay inside the harness; every other tool is judged. */
const INTERNAL_TOOLS = new Set([
  'ask_user_question',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'create_goal',
  'get_goal',
  'update_goal',
  'job_list',
  'job_output',
  'list_agents',
  'list_subagent_models',
  'present',
  'send_message',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
  'skill',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'terminal_list',
  'terminal_read',
  'todo_write',
  'wait_agent',
  'web_search',
  'working_directory',
])

/**
 * @param name - tool name as dsh reports it.
 * @param args - tool arguments as dsh reports them.
 * @param project - the session's working directory, when known.
 */
export function translateCall(name: string, args: unknown, project: string | undefined): Translation {
  if (INTERNAL_TOOLS.has(name)) return { kind: 'allow', reason: 'internal' }
  const record = isRecord(args) ? args : undefined
  if (record === undefined) return { kind: 'judge', tool: name, arguments: { arguments: args } }
  const text = (key: string): string | undefined => typeof record[key] === 'string' ? record[key] : undefined

  switch (name) {
    case 'bash':
    case 'pwsh':
      return shell(text('command'), text('workdir'), name === 'bash' ? 'bash' : 'powershell', project, name, record)
    case 'terminal_send': {
      // Text typed into a terminal session runs like a command in that terminal's shell.
      const command = text('text')
      return command === undefined ? passThrough(name, record) : judge('shell_command', { command })
    }
    case 'write':
      return fileChange('write_file', text('file_path'), project, name, record)
    case 'edit':
      return fileChange('edit_file', text('file_path'), project, name, record)
    case 'str_replace_editor': {
      const command = text('command')
      if (command === 'view') return fileRead(text('path'), project, name, record)
      if (command === 'create') return fileChange('create_file', text('path'), project, name, record)
      if (command === 'str_replace' || command === 'insert') return fileChange('edit_file', text('path'), project, name, record)
      return passThrough(name, record)
    }
    case 'read':
    case 'read_image':
      return fileRead(text('file_path'), project, name, record)
    case 'glob':
    case 'grep':
    case 'lsp':
      // Searches default to the session workspace.
      return fileRead(text('path') ?? '.', project, name, record)
    default:
      return passThrough(name, record)
  }
}

function shell(
  command: string | undefined,
  workdir: string | undefined,
  shellName: 'bash' | 'powershell',
  project: string | undefined,
  name: string,
  record: Readonly<Record<string, unknown>>,
): Translation {
  if (command === undefined) return passThrough(name, record)
  // A working directory is stated only when the call names one; a persistent shell's current
  // directory is shell state the call does not carry.
  const cwd = workdir === undefined ? undefined : resolveIn(project, workdir)
  return judge('shell_command', { command, ...cwd === undefined ? {} : { cwd }, shell: shellName })
}

function fileChange(tool: string, file: string | undefined, project: string | undefined, name: string, record: Readonly<Record<string, unknown>>): Translation {
  if (file === undefined) return passThrough(name, record)
  if (insideProject(project, file)) return { kind: 'allow', reason: 'project-edit' }
  // Only the target path is judged; file bodies are never sent to the model.
  return judge(tool, { path: file })
}

function fileRead(file: string | undefined, project: string | undefined, name: string, record: Readonly<Record<string, unknown>>): Translation {
  if (file === undefined) return passThrough(name, record)
  if (insideProject(project, file)) return { kind: 'allow', reason: 'project-read' }
  return judge('read_file', { path: file })
}

function judge(tool: string, args: Readonly<Record<string, unknown>>): Translation {
  return { kind: 'judge', tool, arguments: args }
}

function passThrough(name: string, record: Readonly<Record<string, unknown>>): Translation {
  return judge(name, record)
}

/** Absolute form of a path the tool resolves against the session workspace. */
function resolveIn(project: string | undefined, target: string): string | undefined {
  if (path.isAbsolute(target)) return target
  return project === undefined ? undefined : path.resolve(project, target)
}

/**
 * Whether `target` lies inside the project. A project at a filesystem root or the home directory
 * covers too much to count, and repository metadata (`.git`, where hooks live) never counts.
 */
export function insideProject(project: string | undefined, target: string): boolean {
  if (project === undefined || project === '') return false
  const root = path.resolve(project)
  if (path.parse(root).root === root || sameDir(root, os.homedir())) return false
  const relative = path.relative(root, path.resolve(root, target))
  if (relative === '') return true
  const segments = relative.split(/[\\/]/)
  if (segments[0] === '..' || path.isAbsolute(relative)) return false
  return !segments.some(segment => segment.toLowerCase() === '.git')
}

function sameDir(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === ''
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
