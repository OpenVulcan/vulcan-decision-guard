import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { insideProject, translateCall } from './calls.js'

const project = path.join(os.tmpdir(), 'vulcan-guard-project')
const outside = path.join(os.tmpdir(), 'elsewhere', 'notes.txt')

test('renders shell tools as shell_command with only the facts the call carries', () => {
  assert.deepEqual(translateCall('bash', { command: 'ls', timeout: 5000 }, project), {
    kind: 'judge', tool: 'shell_command', arguments: { command: 'ls', shell: 'bash' },
  })
  assert.deepEqual(translateCall('pwsh', { command: 'dir', workdir: 'src' }, project), {
    kind: 'judge', tool: 'shell_command', arguments: { command: 'dir', cwd: path.join(project, 'src'), shell: 'powershell' },
  })
  assert.deepEqual(translateCall('bash', { command: 'ls', workdir: 'src' }, undefined), {
    kind: 'judge', tool: 'shell_command', arguments: { command: 'ls', shell: 'bash' },
  })
  assert.deepEqual(translateCall('terminal_send', { sessionId: 't1', text: 'rm -rf build' }, project), {
    kind: 'judge', tool: 'shell_command', arguments: { command: 'rm -rf build' },
  })
})

test('allows file edits inside the project and judges only the path outside it', () => {
  assert.deepEqual(translateCall('write', { file_path: 'src/a.ts', content: 'x' }, project), { kind: 'allow', reason: 'project-edit' })
  assert.deepEqual(translateCall('edit', { file_path: outside, old_string: 'secret', new_string: 'y' }, project), {
    kind: 'judge', tool: 'edit_file', arguments: { path: outside },
  })
  assert.deepEqual(translateCall('str_replace_editor', { command: 'create', path: outside, file_text: 'body' }, project), {
    kind: 'judge', tool: 'create_file', arguments: { path: outside },
  })
  assert.deepEqual(translateCall('str_replace_editor', { command: 'view', path: outside }, project), {
    kind: 'judge', tool: 'read_file', arguments: { path: outside },
  })
})

test('never counts repository metadata as an ordinary project edit', () => {
  assert.deepEqual(translateCall('write', { file_path: '.git/hooks/pre-commit', content: 'x' }, project), {
    kind: 'judge', tool: 'write_file', arguments: { path: '.git/hooks/pre-commit' },
  })
})

test('allows in-project reads and searches and judges outside reads', () => {
  assert.deepEqual(translateCall('grep', { pattern: 'TODO' }, project), { kind: 'allow', reason: 'project-read' })
  assert.deepEqual(translateCall('read', { file_path: outside }, project), { kind: 'judge', tool: 'read_file', arguments: { path: outside } })
})

test('allows internal tools and passes unknown tools through unchanged', () => {
  assert.deepEqual(translateCall('todo_write', { todos: [] }, project), { kind: 'allow', reason: 'internal' })
  const args = { query: 'drop table', database: 'prod' }
  assert.deepEqual(translateCall('mcp__db__execute', args, project), { kind: 'judge', tool: 'mcp__db__execute', arguments: args })
  assert.deepEqual(translateCall('weird', 'text', project), { kind: 'judge', tool: 'weird', arguments: { arguments: 'text' } })
})

test('a project at a filesystem root or the home directory covers no path', () => {
  assert.equal(insideProject(path.parse(project).root, 'a.txt'), false)
  assert.equal(insideProject(os.homedir(), 'a.txt'), false)
  assert.equal(insideProject(undefined, 'a.txt'), false)
  assert.equal(insideProject(project, path.join(project, 'a', 'b.txt')), true)
  assert.equal(insideProject(project, '../other/b.txt'), false)
  assert.equal(insideProject(project, '..notes/b.txt'), true)
})
