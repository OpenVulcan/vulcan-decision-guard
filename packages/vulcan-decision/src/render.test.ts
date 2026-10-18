import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DecisionError } from './protocol.js'
import { renderCall } from './render.js'

test('renders project, tool and compact arguments in their original key order', () => {
  const rendered = renderCall({ project: 'D:\\work\\demo', tool: 'shell_command', arguments: { shell: 'powershell', command: 'dir', cwd: 'D:\\work\\demo' } })
  assert.equal(rendered, 'Project: D:\\work\\demo\nTool: shell_command\nArguments: {"shell":"powershell","command":"dir","cwd":"D:\\\\work\\\\demo"}')
})

test('omits the project line when the root is unknown', () => {
  assert.equal(renderCall({ tool: 'bash', arguments: { command: 'ls' } }), 'Tool: bash\nArguments: {"command":"ls"}')
  assert.equal(renderCall({ project: '', tool: 'bash', arguments: {} }), 'Tool: bash\nArguments: {}')
})

test('keeps non-ASCII text unescaped', () => {
  assert.equal(renderCall({ tool: 'bash', arguments: { command: 'echo 你好' } }), 'Tool: bash\nArguments: {"command":"echo 你好"}')
})

test('refuses arguments the reference serializer cannot write', () => {
  for (const args of [[], null, 'text'] as unknown[]) {
    assert.throws(() => renderCall({ tool: 'bash', arguments: args as Record<string, unknown> }), isInvalid)
  }
  assert.throws(() => renderCall({ tool: 'bash', arguments: { limit: Number.NaN } }), isInvalid)
  assert.throws(() => renderCall({ tool: '', arguments: {} }), isInvalid)
})

function isInvalid(error: unknown): boolean {
  return error instanceof DecisionError && error.code === 'invalid_request'
}
