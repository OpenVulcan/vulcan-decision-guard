/**
 * What the plugin shows outside Settings: the approval card that replaces the composer while one
 * of its prompts waits, the Auto review conflict notice on both plugins' pages, and the short
 * summary on its own Plugins page that points to Settings › Auto approval.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { fill, type Key, type Translate } from './i18n'
import { AUTO_REVIEW_PACKAGE, PACKAGE_NAME, type Services } from './shared'
import { Badge, useWatch } from './ui'
import type { ChangeResult, ComposerProps, DetailProps, PendingApprovalFace, RemoteResult } from './dsh-client'

/** Mirrors `PROMPT_KEY` and `PromptPayload` in `src/index.ts`. */
const PROMPT_KEY = 'x-vulcan-decision'
interface PromptPayload {
  readonly v: 1
  readonly stage: 'review' | 'block' | 'unjudged'
  readonly review?: 'review' | 'deny' | 'error'
  readonly reviewReason?: string
  readonly focus: 'allow' | 'reject'
  readonly intent?: string
  readonly preview: string
  readonly timeoutMs?: number
}

/** One of this plugin's approval prompts, as offered to the composer chain. */
export interface GuardApproval {
  readonly pending: PendingApprovalFace
  readonly payload: PromptPayload
}

/** Recognize this plugin's prompts by their payload; other approvals stay with dsh's own card. */
export function guardApprovalOf(interaction: unknown): GuardApproval | null {
  if (typeof interaction !== 'object' || interaction === null) return null
  const pending = interaction as Partial<PendingApprovalFace>
  if (pending.kind !== 'approval' || typeof pending.answer !== 'function') return null
  const raw = pending.displayReason?.[PROMPT_KEY]
  if (typeof raw !== 'string') return null
  try {
    const payload = JSON.parse(raw) as PromptPayload
    return payload.v === 1 ? { pending: pending as PendingApprovalFace, payload } : null
  } catch {
    return null
  }
}

/** Seconds left until the Host rejects an unanswered prompt, counted from when it appeared. */
function useCountdown(timeoutMs: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  const [start] = useState(() => Date.now())
  useEffect(() => {
    if (timeoutMs === undefined) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 250)
    return () => { clearInterval(timer) }
  }, [timeoutMs])
  return timeoutMs === undefined ? undefined : Math.max(0, Math.ceil((start + timeoutMs - now) / 1000))
}

export function ApprovalCard({ matched, t, resolveText }: ComposerProps<GuardApproval>) {
  return <ApprovalFlow key={matched.pending.key} approval={matched} t={t as Translate} resolveText={resolveText} />
}

function ApprovalFlow({ approval, t, resolveText }: {
  approval: GuardApproval
  t: Translate
  resolveText: ComposerProps<GuardApproval>['resolveText']
}) {
  const { pending, payload } = approval
  const [answered, setAnswered] = useState(false)
  const allowRef = useRef<HTMLButtonElement>(null)
  const rejectRef = useRef<HTMLButtonElement>(null)
  const left = useCountdown(payload.timeoutMs)
  useEffect(() => {
    (payload.focus === 'allow' ? allowRef : rejectRef).current?.focus()
  }, [payload.focus])
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    if (answered || !pending.answerable) return
    setAnswered(true)
    pending.answer(outcome).catch(() => {
      if (pending.answerable) setAnswered(false)
    })
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    answer('rejected')
  }
  const headline = pending.displayReason === undefined ? pending.reason ?? '' : resolveText(pending.displayReason)
  return (
    <div className="vdg vdg-prompt" aria-busy={answered} onKeyDown={keydown}>
      <div className="vdg-prompt-card">
        <div className="vdg-prompt-strip">
          <span>{t('prompt.strip')}</span>
          <span className="vdg-inline">
            <Badge tone={payload.stage === 'review' ? 'warn' : 'bad'}>{t(`prompt.stage.${payload.stage}` as Key)}</Badge>
            {payload.review === undefined ? null : <Badge tone="outline">{t(`prompt.review.${payload.review}` as Key)}</Badge>}
          </span>
        </div>
        <div className="vdg-prompt-body" role="group" aria-label={t('prompt.strip')}>
          <strong style={{ fontWeight: 500 }}>{headline}</strong>
          <span className="vdg-hint">{fill(t('prompt.call'), { tool: pending.toolName })}</span>
          <code className="vdg-code">{payload.preview}</code>
          {payload.reviewReason === undefined
            ? null
            : <p className="vdg-hint"><strong style={{ display: 'block', fontWeight: 500, color: 'var(--vk-ink-2)' }}>{t('prompt.reason')}</strong>{payload.reviewReason}</p>}
          {payload.intent === undefined
            ? null
            : <p className="vdg-hint"><strong style={{ display: 'block', fontWeight: 500, color: 'var(--vk-ink-2)' }}>{t('prompt.intent')}</strong>{payload.intent}</p>}
        </div>
        <div className="vdg-prompt-actions">
          {left === undefined
            ? <span />
            : <span role="timer" className="vdg-warn">{left > 0 ? fill(t('prompt.countdown'), { seconds: left }) : t('prompt.expired')}</span>}
          <span className="vdg-inline">
            <button ref={rejectRef} type="button" className={payload.focus === 'reject' ? 'vdg-btn primary' : 'vdg-btn'} disabled={answered} onClick={() => { answer('rejected') }}>
              {t('prompt.reject')}
            </button>
            <button ref={allowRef} type="button" className={payload.focus === 'allow' ? 'vdg-btn primary' : 'vdg-btn'} disabled={answered} onClick={() => { answer('allowed-once') }}>
              {t('prompt.allow')}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/** Which side of the conflict an open page shows, or null when it is about another plugin. */
function pageSide(subject: DetailProps['subject']): 'guard' | 'review' | null {
  if (subject.kind !== 'bundle') return null
  if (subject.pkg.name === PACKAGE_NAME) return 'guard'
  if (subject.pkg.name === AUTO_REVIEW_PACKAGE) return 'review'
  return null
}

function useConflict(services: Services, subject: DetailProps['subject']): 'guard' | 'review' | null {
  const enabled = useWatch(services.autoReview)
  const side = pageSide(subject)
  return side !== null && enabled === true ? side : null
}

export function ConflictBadge({ subject, t, services }: DetailProps & { services: Services }) {
  return useConflict(services, subject) === null ? null : <span className="vdg"><Badge tone="warn">{t('conflict.tag')}</Badge></span>
}

export function ConflictSection({ subject, t, services, disableAutoReview }: DetailProps & {
  services: Services
  disableAutoReview: () => Promise<RemoteResult<ChangeResult>>
}) {
  const side = useConflict(services, subject)
  const [phase, setPhase] = useState<{ readonly kind: 'idle' | 'busy' | 'restart' } | { readonly kind: 'failed'; readonly reason: string }>({ kind: 'idle' })
  if (side === null) return null
  const disable = (): void => {
    setPhase({ kind: 'busy' })
    disableAutoReview().then((result) => {
      if (!result.ok) {
        setPhase({ kind: 'failed', reason: result.error.message })
      } else if (result.value.error !== undefined || result.value.application === 'failed') {
        setPhase({ kind: 'failed', reason: result.value.error?.message ?? result.value.error?.code ?? result.value.application })
      } else {
        setPhase(result.value.application === 'restart-required' ? { kind: 'restart' } : { kind: 'idle' })
      }
      services.autoReview.refresh()
    }, (error: unknown) => {
      setPhase({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
    })
  }
  return (
    <section className="vdg vdg-alert warn" role="status" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <strong style={{ color: 'var(--vk-warn)', fontSize: 13 }}>{t(side === 'guard' ? 'conflict.title.guard' : 'conflict.title.review')}</strong>
      <span style={{ fontSize: 13 }}>{t(side === 'guard' ? 'conflict.body.guard' : 'conflict.body.review')}</span>
      <div className="vdg-inline">
        <button type="button" className="vdg-btn" disabled={phase.kind === 'busy'} onClick={disable}>
          {t(phase.kind === 'busy' ? 'conflict.disabling' : 'conflict.disable')}
        </button>
        {phase.kind === 'restart' ? <span className="vdg-hint">{t('conflict.restart')}</span> : null}
        {phase.kind === 'failed' ? <span className="vdg-error">{t('conflict.failed')}{phase.reason}</span> : null}
      </div>
    </section>
  )
}

/** The plugin's own Plugins page: no settings, only where they are. */
export function PluginPageSummary({ view, t, services }: { view: 'summary' | 'page'; t: (key: string) => string; services: Services }) {
  if (view === 'summary') return t('summary')
  return (
    <div className="vdg" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
      <p className="vdg-lead" style={{ margin: 0 }}>{t('summary')}</p>
      <button type="button" className="vdg-btn primary" onClick={() => { services.openSettings() }}>{t('openSettings')}</button>
    </div>
  )
}

