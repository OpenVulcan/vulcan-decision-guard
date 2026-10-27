/**
 * The decision log: every call the decision model or the review LLM took part in, kept in one
 * JSON Lines file in this plugin's data directory with a rolling limit. It is written only while
 * the user's `recordDecisions` switch is on.
 *
 * A record keeps the call's arguments as the agent sent them, so the user can look back at what
 * was judged and export the records they marked as training samples; clearing the log is the only
 * way to remove it.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

import { DECISIONS, writeFileAtomic, type Decision, type DecisionHome, type DecisionOptions } from '@openvulcan/vulcan-decision'

/** Most records the log keeps; older ones are dropped when the log is compacted. */
export const RETENTION_RECORDS = 5000

/** Most days the log keeps a record. */
export const RETENTION_DAYS = 30

/** Records appended past the limit before the file is rewritten, so a full log is not rewritten on every call. */
const COMPACTION_SLACK = RETENTION_RECORDS / 10

/** Most records one page returns. */
export const PAGE_LIMIT_MAX = 200

/** Log file name; the version changes whenever the line format changes, and other versions are not read. */
export const RECORDS_FILE = 'records.v1.jsonl'

/** Result filter that keeps records whose decision model could not answer. */
const FAILED = 'failed'

/**
 * How a recorded call ended.
 *
 * - `judge_allowed` / `review_allowed`: the decision model or the review LLM let it run.
 * - `review_denied`: the review LLM refused it without asking anyone (a forbid rule, or an
 *   unattended session).
 * - `unattended_denied`: nobody could be asked and no review allowed it.
 * - `user_allowed` / `user_denied`: the user answered the approval prompt.
 * - `approval_expired`: the approval countdown ran out.
 * - `not_asked`: the user could not be asked, so the call was refused.
 * - `host_denied`: another dsh integration refused the call before the user was asked.
 */
export type RecordOutcome =
  | 'judge_allowed' | 'review_allowed' | 'review_denied' | 'unattended_denied'
  | 'user_allowed' | 'user_denied' | 'approval_expired' | 'not_asked' | 'host_denied'

/** What the decision model read and produced, when the call could be rendered. */
export interface RecordTrace {
  readonly backend: 'cloud' | 'local'
  /** Cloud model id or installed local model id; empty when the default cloud model did not resolve. */
  readonly model: string
  /** Cloud endpoint id or local runtime pack, when the model answered. */
  readonly via?: string
  readonly policyVersion: string
  readonly settings: DecisionOptions
  /** The call text the model read. */
  readonly rendered: string
  /** Raw allow/review/block scores. */
  readonly logits?: readonly number[]
  readonly inputTokens?: number
}

/** The decision model's part of one recorded call. */
export interface RecordJudge {
  /** Absent when the model could not answer. */
  readonly label?: Decision
  /** Why the model could not answer. */
  readonly error?: string
  /** Set when a rule decided without evaluating the model. */
  readonly reasonCode?: string
  readonly elapsedMs: number
  readonly trace?: RecordTrace
}

/** The review LLM's part of one recorded call. */
export interface RecordReview {
  /** Absent when the review failed. */
  readonly verdict?: 'allow' | 'review' | 'deny' | 'forbid'
  readonly reason?: string
  readonly error?: string
  readonly elapsedMs: number
}

/** One recorded call. */
export interface DecisionRecord {
  readonly id: string
  /** When the call reached the gate, in Unix milliseconds. */
  readonly judgedAtMs: number
  readonly sessionId: string
  readonly workspaceRoot?: string
  readonly toolName: string
  /** The arguments as the agent sent them, as JSON. */
  readonly arguments: string
  /** Whether someone could be asked. */
  readonly attended: boolean
  readonly judge: RecordJudge
  readonly review?: RecordReview
  readonly outcome: RecordOutcome
  /** The label the user says the decision model should have given. */
  readonly correction?: Decision
}

/** A finished call before it is given its identity. */
export type NewRecord = Omit<DecisionRecord, 'id' | 'correction'>

/** One page request, newest first. */
export interface PageRequest {
  /** Model result to keep: a decision or `failed`. */
  readonly label?: string
  readonly workspace?: string
  readonly markedOnly?: boolean
  /** Return records older than this record. */
  readonly before?: string
  readonly limit: number
}

export interface RecordPage {
  readonly records: readonly DecisionRecord[]
  readonly hasMore: boolean
  readonly total: number
  readonly marked: number
  /** Workspaces of every kept record, for the filter. */
  readonly workspaces: readonly string[]
  readonly retentionRecords: number
  readonly retentionDays: number
}

export interface RecordExport {
  readonly fileName: string
  /** JSON Lines training samples. */
  readonly content: string
  readonly count: number
}

/** The log; loaded on first use and kept in memory with the file as its authority. */
export class RecordStore {
  private loaded: { readonly records: DecisionRecord[] } | { readonly error: string } | undefined

  constructor(private readonly home: DecisionHome, private readonly now: () => number = Date.now) {}

  /** Keep one finished call. */
  append(record: NewRecord): DecisionRecord {
    const kept: DecisionRecord = { id: randomUUID(), ...record }
    const records = this.records()
    records.push(kept)
    if (records.length > RETENTION_RECORDS + COMPACTION_SLACK) {
      prune(records, this.now())
      this.rewrite(records)
    } else {
      fs.appendFileSync(this.path(), `${JSON.stringify(kept)}\n`, { mode: 0o600 })
    }
    return kept
  }

  /** One page of matching records, newest first. */
  page(request: PageRequest): RecordPage {
    if (request.label !== undefined && ![...DECISIONS, FAILED].includes(request.label)) {
      throw new RangeError(`unknown result filter "${request.label}"`)
    }
    const limit = Math.min(Math.max(Math.trunc(request.limit), 1), PAGE_LIMIT_MAX)
    const records = this.records()
    const matching = records.filter(record => matches(record, request)).sort((a, b) => b.judgedAtMs - a.judgedAtMs)
    let start = 0
    if (request.before !== undefined) {
      const index = matching.findIndex(record => record.id === request.before)
      if (index < 0) throw new RangeError(`record "${request.before}" is not in the decision log`)
      start = index + 1
    }
    const rest = matching.slice(start)
    return {
      records: rest.slice(0, limit),
      hasMore: rest.length > limit,
      total: records.length,
      marked: records.filter(record => record.correction !== undefined).length,
      workspaces: [...new Set(records.flatMap(record => record.workspaceRoot === undefined ? [] : [record.workspaceRoot]))].sort(),
      retentionRecords: RETENTION_RECORDS,
      retentionDays: RETENTION_DAYS,
    }
  }

  /** Mark the label the model should have given a record, or clear the mark with null. */
  mark(id: string, correction: Decision | null): DecisionRecord {
    const records = this.records()
    const index = records.findIndex(record => record.id === id)
    if (index < 0) throw new RangeError(`record "${id}" is not in the decision log`)
    const record = records[index]!
    if (correction !== null && record.judge.trace === undefined) {
      throw new RangeError(`record "${id}" has no model input, so it cannot become a training sample`)
    }
    const { correction: _previous, ...rest } = record
    const marked: DecisionRecord = correction === null ? rest : { ...rest, correction }
    records[index] = marked
    this.rewrite(records)
    return marked
  }

  /** Export the marked records that carry model input as training samples. */
  export(): RecordExport {
    let content = ''
    let count = 0
    for (const record of this.records()) {
      const trace = record.judge.trace
      if (record.correction === undefined || trace === undefined) continue
      content += `${JSON.stringify({
        id: record.id,
        policy_version: trace.policyVersion,
        settings: trace.settings,
        rendered: trace.rendered,
        label: record.correction,
        metadata: {
          source: 'vulcan_decision_guard_record',
          judge_label: record.judge.label ?? null,
          backend: trace.backend,
          model: trace.model,
          outcome: record.outcome,
          judged_at_ms: record.judgedAtMs,
        },
      })}\n`
      count += 1
    }
    return { fileName: `decision-samples-${this.now()}.jsonl`, content, count }
  }

  /** Remove every record and the file; this also recovers from an unreadable file. */
  clear(): void {
    fs.rmSync(this.path(), { force: true })
    this.loaded = { records: [] }
  }

  private path(): string {
    return this.home.file(RECORDS_FILE)
  }

  private records(): DecisionRecord[] {
    this.loaded ??= this.load()
    if ('error' in this.loaded) throw new Error(this.loaded.error)
    return this.loaded.records
  }

  /** Read the file, dropping records past retention; a line that is not a record makes the whole file unreadable until it is cleared. */
  private load(): { records: DecisionRecord[] } | { error: string } {
    let text: string
    try {
      text = fs.readFileSync(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] }
      return { error: `cannot read the decision log: ${(error as Error).message}` }
    }
    const records: DecisionRecord[] = []
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        value = undefined
      }
      if (!isRecord(value)) return { error: `line ${index + 1} of the decision log is not a decision record` }
      records.push(value)
    }
    prune(records, this.now())
    return { records }
  }

  private rewrite(records: readonly DecisionRecord[]): void {
    writeFileAtomic(this.path(), records.map(record => `${JSON.stringify(record)}\n`).join(''))
  }
}

/** Drop records older than the retention days, then the oldest beyond the retention count. */
function prune(records: DecisionRecord[], now: number): void {
  const horizon = now - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const kept = records.filter(record => record.judgedAtMs >= horizon).sort((a, b) => a.judgedAtMs - b.judgedAtMs)
  records.splice(0, records.length, ...kept.slice(Math.max(0, kept.length - RETENTION_RECORDS)))
}

function matches(record: DecisionRecord, request: PageRequest): boolean {
  const result = record.judge.label ?? FAILED
  return (request.label === undefined || result === request.label)
    && (request.workspace === undefined || record.workspaceRoot === request.workspace)
    && (request.markedOnly !== true || record.correction !== undefined)
}

/** The shape check a stored line must pass. */
function isRecord(value: unknown): value is DecisionRecord {
  const record = value as Partial<DecisionRecord> | null
  return typeof record === 'object' && record !== null
    && typeof record.id === 'string' && typeof record.judgedAtMs === 'number' && typeof record.sessionId === 'string'
    && typeof record.toolName === 'string' && typeof record.arguments === 'string' && typeof record.attended === 'boolean'
    && typeof record.outcome === 'string' && typeof record.judge === 'object' && record.judge !== null
    && typeof record.judge.elapsedMs === 'number'
    && (record.correction === undefined || (DECISIONS as readonly unknown[]).includes(record.correction))
}
