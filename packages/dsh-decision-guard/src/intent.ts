/**
 * The intent tool: the agent states the purpose of its next call of a tool, and that statement
 * goes to the LLM review and the approval prompt with the call. It does not go to the decision
 * model, and it never authorizes anything by itself; the reviewer is told so.
 *
 * Statements are kept in memory per session until the next judged call of the named tool takes
 * them. One per tool: a newer statement replaces an older one.
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'

import { INTENT_TOOL } from './decide.js'

const MAX_PURPOSE_CHARS = 2000

/** Pending statements by session, then by tool name. */
export class IntentStore {
  readonly #pending = new Map<SessionId, Map<string, string>>()

  put(session: SessionId, tool: string, purpose: string): void {
    let tools = this.#pending.get(session)
    if (tools === undefined) {
      tools = new Map()
      this.#pending.set(session, tools)
    }
    tools.set(tool, purpose)
  }

  /** Remove and return the statement for this session's next call of `tool`. */
  take(session: SessionId, tool: string): string | undefined {
    const tools = this.#pending.get(session)
    const purpose = tools?.get(tool)
    if (purpose === undefined) return undefined
    tools!.delete(tool)
    if (tools!.size === 0) this.#pending.delete(session)
    return purpose
  }

  clear(): void {
    this.#pending.clear()
  }
}

/** Whether the guard reviews this execution's calls with an LLM right now. */
export type ReviewsWithLlm = (exec: ToolExecution) => boolean

/** The tool definition; `reviews` decides whether a statement is kept or not needed. */
export function intentTool(store: IntentStore, reviews: ReviewsWithLlm) {
  return defineTool({
    name: INTENT_TOOL,
    description: 'Explain to the permission reviewer (Vulcan Decision) why your next call of a tool is needed and what it will do. '
      + 'Use it before a call the reviewer may question, or after the review denied a call you still need, then make the call. '
      + 'The explanation goes to the reviewer and is shown to the user with that call; it does not grant permission by itself, '
      + 'so describe the real purpose and effect.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Exact name of the tool you will call next, for example "bash".' },
      purpose: { type: 'string', required: true, description: 'Why the call is needed and what it will change, in one or two sentences.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.recorded
          ? `Recorded. The reviewer will see this purpose with your next "${args.tool}" call; make that call now.`
          : 'This session\'s calls are not reviewed by an LLM, so no explanation is needed; make the call directly.',
      }],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || !reviews(exec)) return Promise.resolve({ recorded: false })
      const purpose = args.purpose.trim()
      if (purpose === '') throw new Error('purpose must not be empty')
      store.put(agent.session.id, args.tool.trim(), purpose.length <= MAX_PURPOSE_CHARS ? purpose : purpose.slice(0, MAX_PURPOSE_CHARS))
      return Promise.resolve({ recorded: true })
    },
    presentCall: args => ({ card: 'generic', title: `Explain the next ${args.tool} call`, kind: 'other', rawInput: args.purpose }),
  })
}
