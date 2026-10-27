/**
 * The composer's quick setting, left of the model selector: a pill with the guard's state that
 * opens a card for the settings changed most often, and this session's unattended switch.
 * Everything else stays in Settings › Auto approval, one click away.
 */

import { useCallback, useRef, useState } from 'react'

import { fill, type Translate } from './i18n'
import { lockEndpoint } from './cloud'
import { decisionStatus } from './settings'
import { AUTO_PRESET, DEFAULT_ASK_TIMEOUT, type Services } from './shared'
import { ErrorLine, Popover, Segments, useAction, useSettings, useWatch } from './ui'
import type { SessionSlotProps } from './dsh-client'

/** Mirrors `PROJECTION_KEY` and `GuardSessionView` in `src/unattended.ts`. */
export const PROJECTION_KEY = 'vulcanDecision'
interface GuardSessionView {
  readonly unattended: boolean
}

/** Countdowns offered in the card; a saved value outside them is listed as well. */
const TIMEOUTS = [0, 30, DEFAULT_ASK_TIMEOUT, 120, 300] as const

export interface QuickInjected {
  readonly services: Services
  /** Switch the session through the Host command; rejects when the Host does not accept it. */
  readonly toggleUnattended: (unattended: boolean) => Promise<void>
}

export function QuickSetting({ useProjection, t: translate, services, toggleUnattended }: SessionSlotProps & QuickInjected) {
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
              unattended={view === undefined ? undefined : unattended}
              toggleUnattended={toggleUnattended}
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

function QuickCard({ t, services, governed, unattended, toggleUnattended, decision, onMore }: {
  t: Translate
  services: Services
  governed: boolean
  /** undefined: the session publishes no guard view (not materialized yet). */
  unattended: boolean | undefined
  toggleUnattended: (unattended: boolean) => Promise<void>
  decision: string
  onMore: () => void
}) {
  const settings = useSettings(services.form, t)
  const live = useWatch(services.panel)
  const endpoints = useWatch(services.endpoints)
  const { busy, error, act } = useAction(() => { services.endpoints.refresh() })
  const [switching, setSwitching] = useState<boolean | undefined>(undefined)
  const [switchFailed, setSwitchFailed] = useState(false)
  const value = settings.value
  if (value === undefined) return null
  const { disabled, save } = settings
  const signedIn = live?.account.signedIn === true
  const timeouts: number[] = TIMEOUTS.includes(value.askTimeout as typeof TIMEOUTS[number]) ? [...TIMEOUTS] : [...TIMEOUTS, value.askTimeout].sort((a, b) => a - b)
  const locked = endpoints?.lockedEndpointId
  const rows = endpoints?.endpoints ?? []
  const checked = switching ?? unattended === true
  return (
    <>
      <div className="vdg-popover-head">
        <strong>{t('quick.title')}</strong>
      </div>
      <div className="vdg-popover-body">
        <p className="vdg-hint">{governed ? t('quick.governed') : t('quick.notGoverned')}</p>
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
        {governed && unattended !== undefined
          ? (
            <label className="vdg-check">
              <input
                type="checkbox"
                checked={checked}
                disabled={switching !== undefined}
                onChange={(event) => {
                  const next = event.target.checked
                  setSwitching(next)
                  setSwitchFailed(false)
                  toggleUnattended(next).then(() => { setSwitching(undefined) }, () => {
                    setSwitching(undefined)
                    setSwitchFailed(true)
                  })
                }}
              />
              <span>
                <span className="vdg-choice-title">{t('quick.unattended')}</span>
                <span className="vdg-choice-hint">{t('quick.unattendedHint')}</span>
              </span>
            </label>
          )
          : null}
        <ErrorLine text={switchFailed ? t('unattended.failed') : undefined} />
        <ErrorLine text={error ?? settings.error} />
      </div>
      <div className="vdg-popover-foot">
        <span className="vdg-hint" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={decision}>{decision}</span>
        <button type="button" className="vdg-link" onClick={onMore}>{t('quick.more')} →</button>
      </div>
    </>
  )
}
