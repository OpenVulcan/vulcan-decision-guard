import { DecisionError, type JudgeCall } from './protocol.js'

/**
 * Render a call in the text format the model was trained on:
 *
 * ```text
 * Project: <project root>      (omitted when unknown)
 * Tool: <tool name>
 * Arguments: <compact JSON of the actual arguments, keys in their original order>
 * ```
 *
 * Nothing is invented: no task description, previous message, working directory or file state.
 * `JSON.stringify` matches the reference `json.dumps(..., ensure_ascii=False,
 * separators=(',', ':'))` for JSON-shaped values.
 */
export function renderCall(call: Pick<JudgeCall, 'project' | 'tool' | 'arguments'>): string {
  if (typeof call.tool !== 'string' || call.tool === '') throw new DecisionError('invalid_request', 'the call has no tool name')
  if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) {
    throw new DecisionError('invalid_request', 'the call arguments must be an object')
  }
  if (call.project !== undefined && typeof call.project !== 'string') {
    throw new DecisionError('invalid_request', 'the project root must be a string')
  }
  const prefix = call.project === undefined || call.project === '' ? '' : `Project: ${call.project}\n`
  return `${prefix}Tool: ${call.tool}\nArguments: ${JSON.stringify(call.arguments, finiteOnly)}`
}

function finiteOnly(_key: string, value: unknown): unknown {
  // The reference serializer refuses NaN and infinities instead of writing null for them.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new DecisionError('invalid_request', 'the call arguments contain a non-finite number')
  }
  return value
}
