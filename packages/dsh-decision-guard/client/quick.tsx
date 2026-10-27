/**
 * The composer's quick setting, left of the model selector: a pill with the guard's state that
 * opens a card after VulcanCode's auto approval menu. It holds the category grants, this
 * session's additional review prompt and unattended mode, each edited in its own dialog, and the
 * settings changed most often. Everything else stays in Settings › Auto approval, one click away.
 */

import { useCallback, useRef, useState } from 'react'

import { fill, type Key, type Translate } from './i18n'
import { lockEndpoint } from './cloud'
import { decisionStatus } from './settings'
import { AUTO_PRESET, DEFAULT_ASK_TIMEOUT, MAX_PROMPT_CHARS, messageOf, type GuardSettings, type Services } from './shared'
import { Dialog, ErrorLine, Popover, Segments, useAction, useSettings, useWatch } from './ui'
import type { SessionSlotProps } from './dsh-client'

/** Mirrors `PROJECTION_KEY` and `GuardSessionView` in `src/session-state.ts`. */
export const PROJECTION_KEY = 'vulcanDecision'
interface GuardSessionView {
  readonly unattended: boolean
  readonly denyPolicy: string
  /** null: the session follows the system default. */
  readonly reviewPrompt: string | null
}

/** Countdowns offered in the card; a saved value outside them is listed as well. */
const TIMEOUTS = [0, 30, DEFAULT_ASK_TIMEOUT, 120, 300] as const

/** The category grants a checkbox can express: checked lets the decision model allow the category. */
const CATEGORIES: readonly { field: 'crossProjectWrites' | 'databaseReset' | 'projectReset'; withheld: string; label: Key }[] = [
  { field: 'crossProjectWrites', withheld: 'review', label: 'quick.category.crossProjectWrites' },
  { field: 'databaseReset', withheld: 'confirm', label: 'quick.category.databaseReset' },
  { field: 'projectReset', withheld: 'confirm', label: 'quick.category.projectReset' },
]

export interface QuickInjected {
  readonly services: Services
  /** Turn unattended mode on with a deny policy, or off with null; rejects when the Host does not accept it. */
  readonly setUnattended: (policy: string | null) => Promise<void>
  /** Give the session its own review prompt, or follow the system default with null. */
  readonly setReviewPrompt: (prompt: string | null) => Promise<void>
}

export function QuickSetting({ useProjection, t: translate, services, setUnattended, setReviewPrompt }: SessionSlotProps & QuickInjected) {
  const t = translate as Translate
  const view = useProjection(PROJECTION_KEY) as GuardSessionView | undefined
  const permissions = useProjection('permissions') as { readonly currentValue?: string } | undefined
  const settings = useSettings(services.form, t)
  const live = useWatch(services.panel)
  const models = useWatch(services.cloudModels)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => { setOpen(false) }, [])
  const value = settings.value
  if (value === undefined) return null
  const governed = value.mode === 'standalone' || permissions?.currentValue === AUTO_PRESET
  const unattended = view?.unattended === true
  const decision = decisionStatus(t, value, live, models?.kind === 'ready' ? models.models : undefined)
  const dot = !governed ? 'off' : decision.tone === 'ok' ? 'ok' : 'warn'
  return (
    <span className="vdg">
      <button
        ref={anchor}
        type="button"
        className="vdg-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={decision.text}
        onClick={() => {
          if (!open) {
            services.panel.refresh()
            services.cloudModels.refresh()
            services.endpoints.refresh()
          }
          setOpen(!open)
        }}
      >
        <span className={`vdg-dot ${dot}`} />
        {!governed ? `${t('quick.label')} · ${t('quick.off')}` : unattended ? t('quick.unattended') : t('quick.label')}
      </button>
      {open
        ? (
          <Popover anchor={anchor} label={t('quick.title')} onClose={close}>
            <QuickCard
              t={t}
              services={services}
              governed={governed}
              view={view}
              setUnattended={setUnattended}
              setReviewPrompt={setReviewPrompt}
              decision={decision.text}
              onMore={() => {
                close()
                services.openSettings()
              }}
            />
          </Popover>
        )
        : null}
    </span>
  )
}

function QuickCard({ t, services, governed, view, setUnattended, setReviewPrompt, decision, onMore }: {
  t: Translate
  services: Services
  governed: boolean
  /** undefined: the session publishes no guard view (not materialized yet). */
  view: GuardSessionView | undefined
  setUnattended: QuickInjected['setUnattended']
  setReviewPrompt: QuickInjected['setReviewPrompt']
  decision: string
  onMore: () => void
}) {
  const settings = useSettings(services.form, t)
  const live = useWatch(services.panel)
  const endpoints = useWatch(services.endpoints)
  const { busy, error, act } = useAction(() => { services.endpoints.refresh() })
  const [editing, setEditing] = useState<'review-prompt' | 'unattended' | undefined>(undefined)
  const value = settings.value
  if (value === undefined) return null
  const { disabled, save } = settings
  const signedIn = live?.account.signedIn === true
  const timeouts: number[] = TIMEOUTS.includes(value.askTimeout as typeof TIMEOUTS[number]) ? [...TIMEOUTS] : [...TIMEOUTS, value.askTimeout].sort((a, b) => a - b)
  const locked = endpoints?.lockedEndpointId
  const rows = endpoints?.endpoints ?? []
  const unattended = view?.unattended === true
  return (
    <>
      <div className="vdg-popover-head">
        <strong>{t('quick.title')}</strong>
      </div>
      <div className="vdg-popover-body">
        <p className="vdg-hint">{governed ? t('quick.governed') : t('quick.notGoverned')}</p>
        <div className="vdg-group-label">
          <strong>{t('quick.categories')}</strong>
          <span className="vdg-hint">{t('quick.categoriesHint')}</span>
        </div>
        {CATEGORIES.map(category => (
          <label key={category.field} className="vdg-check" data-category={category.field}>
            <input
              type="checkbox"
              checked={value[category.field] === 'allow'}
              disabled={disabled}
              onChange={(event) => { save({ [category.field]: event.target.checked ? 'allow' : category.withheld }) }}
            />
            <span>{t(category.label)}</span>
          </label>
        ))}
        {governed
          ? (
            <>
              <div className="vdg-separator" />
              <button
                type="button"
                className="vdg-entry"
                data-review-prompt-entry=""
                disabled={view === undefined}
                onClick={() => { setEditing('review-prompt') }}
              >
                <span className="vdg-entry-title">{t('quick.reviewPrompt')}</span>
                <span className="vdg-entry-hint">{t(view === undefined ? 'quick.draftHint' : 'quick.reviewPrompt.hint')}</span>
              </button>
              <button
                type="button"
                className="vdg-entry"
                data-unattended-entry={unattended ? 'on' : 'off'}
                disabled={view === undefined}
                onClick={() => { setEditing('unattended') }}
              >
                <span className="vdg-entry-title">{t(unattended ? 'quick.unattendedOn' : 'quick.unattendedOff')}</span>
                <span className="vdg-entry-hint">{t(view === undefined ? 'quick.draftHint' : 'quick.unattendedHint')}</span>
              </button>
            </>
          )
          : null}
        <div className="vdg-separator" />
        <div className="vdg-popover-row">
          <span>{t('quick.backend')}</span>
          <Segments
            label={t('quick.backend')}
            value={value.backend}
            options={[{ value: 'cloud', title: t('backend.cloud') }, { value: 'local', title: t('backend.local') }]}
            disabled={disabled}
            onChoose={(next) => { save({ backend: next }) }}
          />
        </div>
        {value.backend === 'cloud' && live != null && !signedIn
          ? <button type="button" className="vdg-link" style={{ alignSelf: 'flex-start' }} onClick={onMore}>{t('quick.signIn')}</button>
          : null}
        {value.backend === 'cloud' && signedIn
          ? (
            <div className="vdg-popover-row">
              <span>{t('quick.endpoint')}</span>
              <select
                className="vdg-select"
                style={{ minWidth: 0, width: 190 }}
                aria-label={t('quick.endpoint')}
                value={locked ?? ''}
                disabled={disabled || busy !== undefined || rows.length === 0}
                onChange={(event) => {
                  const next = event.target.value === '' ? undefined : event.target.value
                  act('lock', () => lockEndpoint(settings.saveAsync, value.cloudModel, next, t('readOnly')))
                }}
              >
                <option value="">{t('endpoints.auto')}</option>
                {locked !== undefined && !rows.some(row => row.endpointId === locked) ? <option value={locked}>{fill(t('endpoints.always'), { id: locked })}</option> : null}
                {rows.map(row => <option key={row.endpointId} value={row.endpointId}>{fill(t('endpoints.always'), { id: row.endpointId })}</option>)}
              </select>
            </div>
          )
          : null}
        <div className="vdg-popover-row">
          <span>{t('quick.review')}</span>
          <Segments
            label={t('quick.review')}
            value={value.review}
            options={(['session', 'custom', 'off'] as const).map(item => ({ value: item, title: t(`review.${item}`) }))}
            disabled={disabled}
            onChoose={(next) => { save({ review: next }) }}
          />
        </div>
        {value.review === 'off'
          ? null
          : (
            <label className="vdg-check">
              <input type="checkbox" checked={value.llmOverridesBlock} disabled={disabled} onChange={(event) => { save({ llmOverridesBlock: event.target.checked }) }} />
              <span>{t('quick.override')}</span>
            </label>
          )}
        <div className="vdg-popover-row">
          <span>{t('quick.timeout')}</span>
          <select
            className="vdg-select"
            style={{ minWidth: 0, width: 120 }}
            aria-label={t('quick.timeout')}
            value={value.askTimeout}
            disabled={disabled}
            onChange={(event) => { save({ askTimeout: Number(event.target.value) }) }}
          >
            {timeouts.map(seconds => (
              <option key={seconds} value={seconds}>{seconds === 0 ? t('quick.timeout.off') : `${seconds} ${t('ask.seconds')}`}</option>
            ))}
          </select>
        </div>
        <ErrorLine text={error ?? settings.error} />
      </div>
      <div className="vdg-popover-foot">
        <span className="vdg-hint" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={decision}>{decision}</span>
        <button type="button" className="vdg-link" onClick={onMore}>{t('quick.more')} →</button>
      </div>
      {editing === 'review-prompt' && view !== undefined
        ? <ReviewPromptDialog t={t} view={view} value={value} onSave={setReviewPrompt} onClose={() => { setEditing(undefined) }} />
        : null}
      {editing === 'unattended' && view !== undefined
        ? <UnattendedDialog t={t} view={view} value={value} onApply={setUnattended} onClose={() => { setEditing(undefined) }} />
        : null}
    </>
  )
}

/** A textarea with its label, where its text comes from, and a counter against the Host's limit. */
function PromptField({ t, label, source, placeholder, text, onChange }: {
  t: Translate
  label: string
  source: string | undefined
  placeholder: string
  text: string
  onChange: (text: string) => void
}) {
  return (
    <div className="vdg-field">
      <div className="vdg-between">
        <span className="vdg-label">{label}</span>
        {source === undefined ? null : <span className="vdg-hint">{source}</span>}
      </div>
      <textarea
        className="vdg-textarea"
        aria-label={label}
        rows={4}
        maxLength={MAX_PROMPT_CHARS}
        placeholder={placeholder}
        value={text}
        onChange={(event) => { onChange(event.target.value) }}
      />
      <span className="vdg-hint" style={{ alignSelf: 'flex-end', fontVariantNumeric: 'tabular-nums' }}>
        {fill(t('dialog.counter'), { count: text.length, max: MAX_PROMPT_CHARS })}
      </span>
    </div>
  )
}

/**
 * This session's additional review prompt: the text the reviewer reads while the user is present.
 * The session follows the system default until it saves its own text, and can return to it.
 */
function ReviewPromptDialog({ t, view, value, onSave, onClose }: {
  t: Translate
  view: GuardSessionView
  value: GuardSettings
  onSave: QuickInjected['setReviewPrompt']
  onClose: () => void
}) {
  const saved = view.reviewPrompt ?? value.reviewPrompt
  const custom = view.reviewPrompt !== null
  const [text, setText] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const save = (prompt: string | null): void => {
    setSaving(true)
    setFailure(undefined)
    onSave(prompt).then(onClose, (error: unknown) => {
      setFailure(fill(t('reviewPrompt.saveFailed'), { error: messageOf(error) }))
    }).finally(() => { setSaving(false) })
  }
  return (
    <Dialog
      title={t('reviewPrompt.title')}
      size="md"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="vdg-btn" onClick={onClose}>{t('dialog.cancel')}</button>
          {custom ? <button type="button" className="vdg-btn" disabled={saving} onClick={() => { save(null) }}>{t('reviewPrompt.followSystem')}</button> : null}
          <button
            type="button"
            className="vdg-btn primary"
            disabled={saving || text.length > MAX_PROMPT_CHARS || text.trim() === saved}
            onClick={() => { save(text.trim()) }}
          >
            {t('reviewPrompt.save')}
          </button>
        </>
      )}
    >
      <p className="vdg-hint">{t('reviewPrompt.body')}</p>
      {value.review === 'off' ? <div className="vdg-alert warn">{t('quick.reviewOff')}</div> : null}
      <PromptField
        t={t}
        label={t('reviewPrompt.label')}
        source={t(custom ? 'reviewPrompt.sourceSession' : 'reviewPrompt.sourceSystem')}
        placeholder={t('reviewPrompt.placeholder')}
        text={text}
        onChange={setText}
      />
      <ErrorLine text={failure} />
    </Dialog>
  )
}

/**
 * Turn unattended mode on with a deny policy the user confirms, edit the policy, or turn it off.
 * The policy is prefilled from the system default; nothing applies until the user confirms.
 */
function UnattendedDialog({ t, view, value, onApply, onClose }: {
  t: Translate
  view: GuardSessionView
  value: GuardSettings
  onApply: QuickInjected['setUnattended']
  onClose: () => void
}) {
  const enabled = view.unattended
  const [text, setText] = useState(enabled ? view.denyPolicy : value.unattendedPolicy)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const apply = (policy: string | null): void => {
    setSaving(true)
    setFailure(undefined)
    onApply(policy).then(onClose, (error: unknown) => {
      setFailure(fill(t('unattended.failed'), { error: messageOf(error) }))
    }).finally(() => { setSaving(false) })
  }
  return (
    <Dialog
      title={t(enabled ? 'unattended.editTitle' : 'unattended.enableTitle')}
      size="md"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="vdg-btn" onClick={onClose}>{t('dialog.cancel')}</button>
          {enabled ? <button type="button" className="vdg-btn" disabled={saving} onClick={() => { apply(null) }}>{t('unattended.disable')}</button> : null}
          <button
            type="button"
            className="vdg-btn primary"
            disabled={saving || text.length > MAX_PROMPT_CHARS}
            onClick={() => { apply(text.trim()) }}
          >
            {t(enabled ? 'unattended.update' : 'unattended.enable')}
          </button>
        </>
      )}
    >
      <p className="vdg-hint">{t('unattended.body')}</p>
      <PromptField
        t={t}
        label={t('unattended.policyLabel')}
        source={!enabled && value.unattendedPolicy !== '' ? t('unattended.sourceSystem') : undefined}
        placeholder={t('unattended.placeholder')}
        text={text}
        onChange={setText}
      />
      <ErrorLine text={failure} />
    </Dialog>
  )
}
