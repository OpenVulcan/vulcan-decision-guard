/**
 * Settings › Auto approval › Decision log, after VulcanCode's records page: every decision the
 * decision model or the review LLM took part in, newest first, with filters, marks that say what
 * the model should have answered, export of marked records as training samples, and clearing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { fill, type Key, type Translate } from './i18n'
import { callPanel, DECISIONS, messageOf, type Decision, type DecisionRecord, type RecordExport, type RecordPage } from './shared'
import { Badge, Dialog, ErrorLine, Section, when, type Tone } from './ui'

const PAGE_SIZE = 50

type Result = Decision | 'failed'
const RESULTS: readonly Result[] = [...DECISIONS, 'failed']
const RESULT_TONES: Readonly<Record<Result, Tone>> = { allow: 'ok', review: 'warn', block: 'bad', failed: 'outline' }

interface Filters {
  readonly label: Result | undefined
  readonly workspace: string | undefined
  readonly markedOnly: boolean
}

/** The part of a call a person recognizes it by. */
function callSummary(record: DecisionRecord): string {
  try {
    const parsed: unknown = JSON.parse(record.arguments)
    if (typeof parsed === 'object' && parsed !== null) {
      const fields = parsed as Record<string, unknown>
      for (const key of ['command', 'path', 'file_path', 'destination', 'url']) {
        const value = fields[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
  } catch {
    // Arguments that are not JSON are summarized by the tool name.
  }
  return record.toolName
}

function resultOf(record: DecisionRecord): Result {
  return record.judge.label ?? 'failed'
}

function pageQuery(filters: Filters, before: string | undefined): string {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (filters.label !== undefined) query.set('label', filters.label)
  if (filters.workspace !== undefined) query.set('workspace', filters.workspace)
  if (filters.markedOnly) query.set('marked', '1')
  if (before !== undefined) query.set('before', before)
  return `records?${query.toString()}`
}

export function RecordsPage({ t, recording, onBack }: { t: Translate; recording: boolean; onBack: () => void }) {
  const [filters, setFilters] = useState<Filters>({ label: undefined, workspace: undefined, markedOnly: false })
  const [page, setPage] = useState<RecordPage | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [clearing, setClearing] = useState(false)
  const sequence = useRef(0)

  const load = useCallback(async (next: Filters, previous: RecordPage | undefined) => {
    const current = ++sequence.current
    try {
      const last = previous?.records[previous.records.length - 1]?.id
      const result = await callPanel<RecordPage>('GET', pageQuery(next, last))
      if (sequence.current !== current) return
      setPage(previous === undefined ? result : { ...result, records: [...previous.records, ...result.records] })
      setLoadError(undefined)
    } catch (error) {
      if (sequence.current === current) setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => { void load(filters, undefined) }, [filters, load])
  useEffect(() => () => { sequence.current += 1 }, [])

  const run = (name: string, work: () => Promise<void>, failed: Key): void => {
    setBusy(name)
    setActionError(undefined)
    setNotice(undefined)
    work().catch((error: unknown) => {
      setActionError(fill(t(failed), { error: messageOf(error) }))
    }).finally(() => { setBusy(undefined) })
  }

  const mark = (record: DecisionRecord, correction: Decision | null): void => {
    run(`mark-${record.id}`, async () => {
      const updated = await callPanel<DecisionRecord>('POST', 'records/mark', { id: record.id, correction })
      setPage(current => current && {
        ...current,
        marked: current.marked + (updated.correction === undefined ? 0 : 1) - (record.correction === undefined ? 0 : 1),
        records: current.records.map(item => item.id === updated.id ? updated : item),
      })
    }, 'records.markFailed')
  }

  const exportSamples = (): void => {
    run('export', async () => {
      const exported = await callPanel<RecordExport>('POST', 'records/export')
      const url = URL.createObjectURL(new Blob([exported.content], { type: 'application/jsonl' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exported.fileName
      anchor.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
      setNotice(fill(t('records.exported'), { count: exported.count }))
    }, 'records.exportFailed')
  }

  const clear = (): void => {
    run('clear', async () => {
      await callPanel('POST', 'records/clear')
      setClearing(false)
      await load(filters, undefined)
    }, 'records.clearFailed')
  }

  const clearButton = (
    <button type="button" className="vdg-btn ghost sm" disabled={busy !== undefined} onClick={() => { setClearing(true) }}>
      {t('records.clear')}
    </button>
  )

  return (
    <div className="vdg vdg-page">
      <div className="vdg-page-head">
        <button type="button" className="vdg-link" onClick={onBack}>← {t('records.back')}</button>
        <h2 style={{ marginTop: 8 }}>{t('records.title')}</h2>
        <p className="vdg-lead">{t('records.entryHint')}</p>
      </div>
      {recording ? null : <div className="vdg-alert warn">{t('records.paused')}</div>}
      {page === undefined
        ? (
          loadError === undefined
            ? <p className="vdg-hint">{t('loading')}</p>
            : (
              <div className="vdg-alert bad">
                <div className="vdg-between">
                  <span>{fill(t('records.loadFailed'), { error: loadError })}</span>
                  {clearButton}
                </div>
              </div>
            )
        )
        : (
          <Section
            title={fill(t('records.count'), { count: page.total })}
            lead={fill(t('records.hint'), { records: page.retentionRecords, days: page.retentionDays })}
            flush
            actions={(
              <>
                <button type="button" className="vdg-btn sm" disabled={busy !== undefined || page.marked === 0} onClick={exportSamples}>
                  {fill(t('records.export'), { count: page.marked })}
                </button>
                {clearButton}
              </>
            )}
          >
            <div className="vdg-record-filters">
              <div className="vdg-inline" role="group" aria-label={t('records.filterResult')}>
                <span className="vdg-hint">{t('records.filterResult')}</span>
                <button type="button" className="vdg-chip" aria-pressed={filters.label === undefined} onClick={() => { setFilters({ ...filters, label: undefined }) }}>
                  {t('records.all')}
                </button>
                {RESULTS.map(result => (
                  <button key={result} type="button" className="vdg-chip" aria-pressed={filters.label === result} onClick={() => { setFilters({ ...filters, label: result }) }}>
                    {t(`records.label.${result}`)}
                  </button>
                ))}
              </div>
              <div className="vdg-inline">
                <button type="button" className="vdg-chip" aria-pressed={filters.markedOnly} onClick={() => { setFilters({ ...filters, markedOnly: !filters.markedOnly }) }}>
                  {t('records.markedOnly')}
                </button>
                {page.workspaces.length > 0
                  ? (
                    <select
                      className="vdg-select"
                      style={{ minWidth: 0, maxWidth: 320 }}
                      aria-label={t('records.detail.workspace')}
                      value={filters.workspace ?? ''}
                      onChange={(event) => { setFilters({ ...filters, workspace: event.target.value === '' ? undefined : event.target.value }) }}
                    >
                      <option value="">{t('records.allWorkspaces')}</option>
                      {page.workspaces.map(workspace => <option key={workspace} value={workspace}>{workspace}</option>)}
                    </select>
                  )
                  : null}
              </div>
              <ErrorLine text={loadError === undefined ? undefined : fill(t('records.loadFailed'), { error: loadError })} />
              <ErrorLine text={actionError} />
              {notice === undefined ? null : <p className="vdg-hint" role="status">{notice}</p>}
            </div>
            {page.records.length === 0
              ? <p className="vdg-hint" style={{ padding: 16 }}>{t('records.empty')}</p>
              : page.records.map(record => (
                <RecordItem key={record.id} t={t} record={record} busy={busy !== undefined} onMark={(correction) => { mark(record, correction) }} />
              ))}
            {page.hasMore
              ? (
                <div className="vdg-record-more">
                  <button type="button" className="vdg-btn sm" onClick={() => { void load(filters, page) }}>{t('records.loadMore')}</button>
                </div>
              )
              : null}
          </Section>
        )}
      {clearing
        ? (
          <Dialog
            title={t('records.clearTitle')}
            size="md"
            onClose={() => { if (busy === undefined) setClearing(false) }}
            footer={(
              <>
                <button type="button" className="vdg-btn" disabled={busy !== undefined} onClick={() => { setClearing(false) }}>{t('dialog.cancel')}</button>
                <button type="button" className="vdg-btn primary" disabled={busy !== undefined} onClick={clear}>{t('records.clear')}</button>
              </>
            )}
          >
            <p style={{ margin: 0 }}>{fill(t('records.clearDescription'), { count: page?.total ?? 0 })}</p>
            <ErrorLine text={actionError} />
          </Dialog>
        )
        : null}
    </div>
  )
}

function RecordItem({ t, record, busy, onMark }: {
  t: Translate
  record: DecisionRecord
  busy: boolean
  onMark: (correction: Decision | null) => void
}) {
  const result = resultOf(record)
  const trace = record.judge.trace
  const review = record.review
  const facts: { label: string; value: string }[] = [
    { label: t('records.detail.tool'), value: record.toolName },
    ...record.workspaceRoot === undefined ? [] : [{ label: t('records.detail.workspace'), value: record.workspaceRoot }],
    { label: t('records.detail.attendance'), value: t(record.attended ? 'records.attended' : 'records.unattended') },
    ...trace === undefined ? [] : [{ label: t('records.detail.model'), value: [trace.model, trace.via, trace.policyVersion].filter(Boolean).join(' · ') }],
    ...trace?.logits === undefined
      ? []
      : [{ label: t('records.detail.scores'), value: DECISIONS.map((name, index) => `${t(`records.label.${name}`)} ${trace.logits![index]?.toFixed(2) ?? '—'}`).join(' · ') }],
    ...record.judge.reasonCode === undefined ? [] : [{ label: t('records.detail.rule'), value: record.judge.reasonCode }],
    { label: t('records.detail.judgeTime'), value: fill(t('ms'), { value: record.judge.elapsedMs }) },
    ...record.judge.error === undefined ? [] : [{ label: t('records.detail.error'), value: record.judge.error }],
    ...review === undefined
      ? []
      : [
        {
          label: t('records.detail.review'),
          value: [review.verdict === undefined ? undefined : t(`records.verdict.${review.verdict}`), review.reason ?? review.error].filter(Boolean).join(' · ') || '—',
        },
        { label: t('records.detail.reviewTime'), value: fill(t('ms'), { value: review.elapsedMs }) },
      ],
  ]
  const outcome = `records.outcome.${record.outcome}`
  return (
    <div className={`vdg-record ${RESULT_TONES[result]}`} data-record-id={record.id}>
      <span className="vdg-record-title">{callSummary(record)}</span>
      <div className="vdg-inline">
        <Badge tone={RESULT_TONES[result]}>{t(`records.label.${result}`)}</Badge>
        <Badge tone="outline">{OUTCOME_KEYS.has(outcome) ? t(outcome as Key) : record.outcome}</Badge>
        {record.correction === undefined ? null : <Badge tone="info">{fill(t('records.marked'), { label: t(`records.label.${record.correction}`) })}</Badge>}
        <span className="vdg-hint">{[when(record.judgedAtMs), record.workspaceRoot].filter(Boolean).join(' · ')}</span>
      </div>
      <details className="vdg-details">
        <summary>{t('records.details')}</summary>
        <dl className="vdg-facts" style={{ marginTop: 8 }}>
          {facts.map(fact => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <pre className="vdg-code" style={{ marginTop: 8 }}>{record.arguments}</pre>
      </details>
      {trace === undefined
        ? <p className="vdg-hint">{t('records.noTrace')}</p>
        : (
          <div className="vdg-inline">
            <span className="vdg-hint">{t('records.markAs')}</span>
            {DECISIONS.map(name => (
              <button
                key={name}
                type="button"
                className="vdg-chip"
                aria-pressed={record.correction === name}
                disabled={busy}
                onClick={() => { onMark(record.correction === name ? null : name) }}
              >
                {t(`records.label.${name}`)}
              </button>
            ))}
          </div>
        )}
    </div>
  )
}

/** Outcomes this client has words for; a newer Host's outcome is shown as its code. */
const OUTCOME_KEYS = new Set([
  'records.outcome.judge_allowed', 'records.outcome.review_allowed', 'records.outcome.review_denied', 'records.outcome.unattended_denied',
  'records.outcome.user_allowed', 'records.outcome.user_denied', 'records.outcome.approval_expired', 'records.outcome.not_asked',
  'records.outcome.host_denied',
])
