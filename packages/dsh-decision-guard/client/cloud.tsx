/**
 * The cloud part of the settings page, as VulcanCode shows it: the OpenVulcan account, the
 * official model OpenVulcan lists for it, the endpoint table with its lock, and the request test.
 */

import { useCallback, useEffect, useState } from 'react'

import { fill, type Key, type Translate } from './i18n'
import { callPanel, messageOf, type Change, type EndpointSnapshot, type PanelState, type Services, type TestResult } from './shared'
import { Badge, Dialog, ErrorLine, Section, ms, useAction, usePolling, useWatch, when, type Tone } from './ui'

const SITES = [
  { site: 'global', domain: 'openvulcan.com' },
  { site: 'cn', domain: 'openvulcan.cn' },
] as const

export function AccountSection({ services, t, live }: { services: Services; t: Translate; live: PanelState }) {
  const { busy, error, act } = useAction(() => {
    services.panel.refresh()
    services.cloudModels.refresh()
    services.endpoints.refresh()
  })
  const account = live.account
  const signIn = (site: 'cn' | 'global'): void => {
    // Opened during the click, so no popup blocker stops it, and pointed at the page once known.
    const popup = window.open('about:blank', '_blank')
    act('signin', async () => {
      try {
        const { approvalUrl } = await callPanel<{ approvalUrl: string }>('POST', `signin?site=${site}`)
        if (popup !== null) {
          popup.opener = null
          popup.location.href = approvalUrl
        }
      } catch (failure) {
        popup?.close()
        throw failure
      }
    })
  }
  return (
    <Section title={t('account.title')} lead={account.signedIn ? undefined : t('account.lead')}>
      {account.signedIn
        ? (
          <div className="vdg-between">
            <div>
              <div className="vdg-inline">
                <Badge tone="ok">{t('account.signedIn')}</Badge>
                <strong>{t(`account.site.${account.site ?? 'global'}` as Key)}</strong>
                <span className="vdg-hint vdg-mono">{SITES.find(item => item.site === account.site)?.domain}</span>
              </div>
              {account.expiresAt === undefined ? null : <p className="vdg-hint">{fill(t('account.expires'), { expires: when(account.expiresAt) })}</p>}
            </div>
            <button type="button" className="vdg-btn" disabled={busy !== undefined} onClick={() => { act('signout', () => callPanel('POST', 'signout')) }}>
              {t('account.signOut')}
            </button>
          </div>
        )
        : live.signIn !== null
          ? (
            <div className="vdg-between">
              <span>{t('account.waiting')}</span>
              <span className="vdg-inline">
                <a className="vdg-link" href={live.signIn.approvalUrl} target="_blank" rel="noopener noreferrer">{t('account.openAgain')}</a>
                <button type="button" className="vdg-btn sm" disabled={busy !== undefined} onClick={() => { act('cancel', () => callPanel('POST', 'signin/cancel')) }}>
                  {t('account.cancel')}
                </button>
              </span>
            </div>
          )
          : (
            <>
              {account.reauthRequired === true ? <div className="vdg-alert warn">{t('account.reauth')}</div> : null}
              <div className="vdg-sites">
                {SITES.map(item => (
                  <button key={item.site} type="button" className="vdg-site" disabled={busy !== undefined} onClick={() => { signIn(item.site) }}>
                    <strong>{t(`account.site.${item.site}` as Key)}</strong>
                    <span>{item.domain}</span>
                    <span style={{ fontFamily: 'inherit', color: 'var(--vk-signal)' }}>{t('account.signIn')} →</span>
                  </button>
                ))}
              </div>
            </>
          )}
      <ErrorLine text={live.signInError === undefined ? undefined : fill(t('account.failed'), { error: live.signInError })} />
      <ErrorLine text={error} />
    </Section>
  )
}

export function ModelSection({ services, t, saved, disabled, onChoose }: {
  services: Services
  t: Translate
  /** The saved model id; empty uses the first listed one. */
  saved: string
  disabled: boolean
  onChoose: (model: string) => void
}) {
  const list = useWatch(services.cloudModels)
  usePolling(services.cloudModels, undefined)
  let body
  if (list === undefined) {
    body = <p className="vdg-hint">{t('model.loading')}</p>
  } else if (list.kind === 'failed') {
    body = <div className="vdg-alert bad">{fill(t('model.failed'), { error: list.error })}</div>
  } else if (list.models.length === 0) {
    body = <div className="vdg-alert warn">{t('model.none')}</div>
  } else {
    const missing = saved !== '' && !list.models.includes(saved)
    body = (
      <>
        <select className="vdg-select" aria-label={t('model.title')} value={saved} disabled={disabled} onChange={(event) => { onChoose(event.target.value) }}>
          <option value="">{fill(t('model.default'), { model: list.models[0]! })}</option>
          {missing ? <option value={saved} disabled>{fill(t('model.disabled'), { model: saved })}</option> : null}
          {list.models.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
        {missing ? <div className="vdg-alert warn">{fill(t('model.disabledWarn'), { model: saved })}</div> : null}
      </>
    )
  }
  return <Section title={t('model.title')} lead={t('model.lead')}>{body}</Section>
}

/**
 * Save an endpoint lock, after the Host checked that the endpoint serves the saved model;
 * undefined returns to automatic choice.
 */
export async function lockEndpoint(
  saveAsync: (changes: Change) => Promise<boolean>,
  model: string,
  endpoint: string | undefined,
  readOnly: string,
): Promise<void> {
  if (endpoint !== undefined) await callPanel('POST', 'cloud/check-lock', { model, endpoint })
  if (!(await saveAsync({ cloudEndpoint: endpoint }))) throw new Error(readOnly)
}

/** The status pill of one endpoint row, in VulcanCode's order of precedence. */
function endpointStatus(row: EndpointSnapshot['endpoints'][number]): { tone: Tone; key: Key } {
  if (row.error !== undefined) return { tone: 'bad', key: 'endpoints.status.error' }
  if (row.rttMs === undefined) return { tone: 'outline', key: 'endpoints.status.untested' }
  if (row.acceptsSite === false) return { tone: 'warn', key: 'endpoints.status.site' }
  if (row.ready === false) return { tone: 'warn', key: 'endpoints.status.notReady' }
  return { tone: 'ok', key: 'endpoints.status.ready' }
}

export function EndpointsSection({ services, t, disabled, onLock }: {
  services: Services
  t: Translate
  disabled: boolean
  /** Save the endpoint lock; undefined returns to automatic. */
  onLock: (endpoint: string | undefined) => Promise<void>
}) {
  const snapshot = useWatch(services.endpoints)
  usePolling(services.endpoints, 2000)
  const { busy, error, act } = useAction(() => { services.endpoints.refresh() })
  const [testing, setTesting] = useState<string | undefined>(undefined)
  const close = useCallback(() => { setTesting(undefined) }, [])
  const rows = snapshot?.endpoints ?? []
  const locked = snapshot?.lockedEndpointId
  return (
    <Section
      title={t('endpoints.title')}
      lead={t('endpoints.lead')}
      flush
      actions={(
        <button type="button" className="vdg-btn" disabled={busy !== undefined || snapshot?.modelId === undefined} onClick={() => { act('probe', () => callPanel('POST', 'cloud/probe')) }}>
          {t(busy === 'probe' ? 'endpoints.testing' : 'endpoints.retest')}
        </button>
      )}
    >
      <div className="vdg-between" style={{ padding: '0 16px 12px' }}>
        <div>
          <div className="vdg-label">{t('endpoints.choice')}</div>
          <p className="vdg-hint">
            {fill(t('endpoints.times'), {
              probed: snapshot?.probedAtMs === undefined ? t('endpoints.never') : when(snapshot.probedAtMs),
              next: snapshot?.nextProbeAtMs === undefined ? t('endpoints.never') : when(snapshot.nextProbeAtMs),
            })}
          </p>
        </div>
        <select
          className="vdg-select"
          aria-label={t('endpoints.choice')}
          value={locked ?? ''}
          disabled={disabled || busy !== undefined || rows.length === 0}
          onChange={(event) => {
            const next = event.target.value === '' ? undefined : event.target.value
            act('lock', () => onLock(next))
          }}
        >
          <option value="">{t('endpoints.auto')}</option>
          {locked !== undefined && !rows.some(row => row.endpointId === locked) ? <option value={locked}>{fill(t('endpoints.always'), { id: locked })}</option> : null}
          {rows.map(row => <option key={row.endpointId} value={row.endpointId}>{fill(t('endpoints.always'), { id: row.endpointId })}</option>)}
        </select>
      </div>
      {snapshot?.error === undefined ? null : <div className="vdg-alert bad" style={{ margin: '0 16px 12px' }}>{snapshot.error}</div>}
      {error === undefined ? null : <div style={{ padding: '0 16px 12px' }}><ErrorLine text={error} /></div>}
      {rows.length === 0
        ? <p className="vdg-hint" style={{ padding: '0 16px 16px' }}>{t('endpoints.empty')}</p>
        : (
          <div className="vdg-table-wrap">
            <table className="vdg-table">
              <thead>
                <tr>
                  <th>{t('endpoints.col.endpoint')}</th>
                  <th>{t('endpoints.col.region')}</th>
                  <th className="num">{t('endpoints.col.network')}</th>
                  <th className="num">{t('endpoints.col.compute')}</th>
                  <th className="num">{t('endpoints.col.total')}</th>
                  <th>{t('endpoints.col.status')}</th>
                  <th>{t('endpoints.col.test')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = endpointStatus(row)
                  const inUse = locked === undefined ? snapshot?.selectedEndpointId === row.endpointId : locked === row.endpointId
                  return (
                    <tr key={row.endpointId} aria-selected={inUse}>
                      <td>
                        <span className="vdg-inline">
                          <span className="vdg-mono">{row.endpointId}</span>
                          {locked === row.endpointId ? <Badge tone="outline">{t('endpoints.locked')}</Badge> : inUse ? <Badge tone="outline">{t('endpoints.inUse')}</Badge> : null}
                        </span>
                      </td>
                      <td>{row.region ?? '—'}</td>
                      <td className="num">{ms(t, row.rttMs)}</td>
                      <td className="num">{ms(t, row.computeP50Ms)}</td>
                      <td className="num">{ms(t, row.scoreMs)}</td>
                      <td><span title={row.error}><Badge tone={status.tone}>{t(status.key)}</Badge></span></td>
                      <td>
                        <button type="button" className="vdg-btn ghost sm" onClick={() => { setTesting(row.endpointId) }}>
                          ↗ {t('endpoints.requestTest')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      {testing === undefined ? null : <RequestTestDialog t={t} endpoint={testing} onClose={close} />}
    </Section>
  )
}

const PRESETS = ['ordinary', 'destructive', 'database_reset', 'oversized'] as const
type Choice = typeof PRESETS[number] | 'custom'

function RequestTestDialog({ t, endpoint, onClose }: { t: Translate; endpoint: string; onClose: () => void }) {
  const [choice, setChoice] = useState<Choice>('ordinary')
  const [command, setCommand] = useState('')
  const [result, setResult] = useState<TestResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const send = (): void => {
    setSending(true)
    setError(undefined)
    const input = choice === 'custom' ? { kind: 'custom', command } : { kind: 'preset', preset: choice }
    callPanel<TestResult>('POST', 'cloud/test', { endpoint, input }).then(setResult, (failure: unknown) => { setError(messageOf(failure)) }).finally(() => { setSending(false) })
  }
  useEffect(() => { setResult(undefined) }, [choice])
  const answered = result?.attempts.filter(attempt => attempt.answer !== undefined).at(-1)?.answer
  const scores = answered?.results[0]?.logits
  const failures = result?.attempts.filter(attempt => attempt.error !== undefined) ?? []
  return (
    <Dialog
      title={fill(t('test.title'), { id: endpoint })}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="vdg-btn primary" disabled={sending || (choice === 'custom' && command.trim() === '')} onClick={send}>
            {t(sending ? 'test.sending' : 'test.send')}
          </button>
          <button type="button" className="vdg-btn" onClick={onClose}>{t('test.close')}</button>
        </>
      )}
    >
      <p className="vdg-hint">{t('test.lead')}</p>
      <div className="vdg-between">
        <span className="vdg-label">{t('test.input')}</span>
        <select className="vdg-select" aria-label={t('test.input')} value={choice} disabled={sending} onChange={(event) => { setChoice(event.target.value as Choice) }}>
          {PRESETS.map(preset => <option key={preset} value={preset}>{t(`test.preset.${preset}` as Key)}</option>)}
          <option value="custom">{t('test.custom')}</option>
        </select>
      </div>
      {choice === 'custom'
        ? <textarea className="vdg-textarea vdg-mono" rows={2} value={command} placeholder={t('test.custom.placeholder')} onChange={(event) => { setCommand(event.target.value) }} />
        : null}
      <ErrorLine text={error} />
      {result === undefined
        ? null
        : (
          <>
            <p className="vdg-hint">
              {fill(t('test.summary'), {
                total: result.attempts.length, succeeded: result.succeeded,
                min: ms(t, result.minMs), median: ms(t, result.medianMs), max: ms(t, result.maxMs),
              })}
            </p>
            <p className="vdg-hint">{fill(t('test.target'), { endpoint: result.endpoint, site: result.site, chars: result.renderedChars })}</p>
            <div className="vdg-table-wrap" style={{ border: '1px solid var(--vk-line)' }}>
              <table className="vdg-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th className="num">{t('test.col.total')}</th>
                    <th className="num">{t('test.col.network')}</th>
                    <th className="num">{t('test.col.endpoint')}</th>
                    <th className="num">{t('test.col.node')}</th>
                    <th className="num">{t('test.col.queue')}</th>
                    <th className="num">{t('test.col.compute')}</th>
                    <th>{t('test.col.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.attempts.map((attempt, index) => {
                    const first = attempt.answer?.results[0]
                    const tone: Tone = first?.decision === 'allow' ? 'ok' : first?.decision === 'review' ? 'warn' : 'bad'
                    return (
                      <tr key={attempt.requestId}>
                        <td>{index + 1}</td>
                        <td className="num">{ms(t, attempt.totalMs)}</td>
                        <td className="num">{ms(t, attempt.networkMs)}</td>
                        <td className="num">{ms(t, attempt.endpointMs)}</td>
                        <td className="num">{ms(t, attempt.nodeMs)}</td>
                        <td className="num">{ms(t, attempt.queueMs)}</td>
                        <td className="num">{ms(t, attempt.computeMs)}</td>
                        <td>
                          <span className="vdg-inline" style={{ flexWrap: 'nowrap' }}>
                            {first === undefined ? null : <Badge tone={tone}>{t(`decision.${first.decision}` as Key)}</Badge>}
                            <span>{attempt.httpStatus === undefined ? t('test.unreached') : `HTTP ${attempt.httpStatus}`}</span>
                            {first?.input_tokens === undefined ? null : <span>{fill(t('test.tokens'), { count: first.input_tokens })}</span>}
                            {first?.reason_code === undefined ? null : <span>{fill(t('test.unscored'), { reason: first.reason_code })}</span>}
                            {attempt.errorCode === undefined ? null : <code className="vdg-mono">{attempt.errorCode}</code>}
                            {attempt.tokenRenewed ? <Badge tone="info">{t('test.renewed')}</Badge> : null}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {answered === undefined
              ? null
              : (
                <dl className="vdg-facts">
                  <div><dt>{t('test.facts.region')}</dt><dd>{answered.region ?? '—'}</dd></div>
                  <div><dt>{t('test.facts.model')}</dt><dd className="vdg-mono">{answered.model ?? result.modelId}</dd></div>
                  <div><dt>{t('test.facts.policy')}</dt><dd className="vdg-mono">{answered.policyVersion}</dd></div>
                  <div>
                    <dt>{t('test.facts.scores')}</dt>
                    <dd>{scores === undefined ? '—' : fill(t('test.scores'), { allow: scores[0]!.toFixed(3), review: scores[1]!.toFixed(3), block: scores[2]!.toFixed(3) })}</dd>
                  </div>
                </dl>
              )}
            <details className="vdg-details">
              <summary>{t('test.details')}</summary>
              <dl className="vdg-facts" style={{ marginTop: 8 }}>
                <div><dt>{t('test.checkpoint')}</dt><dd className="vdg-mono">{answered?.checkpointSha256 ?? '—'}</dd></div>
                <div><dt>{t('test.requestIds')}</dt><dd className="vdg-mono">{result.attempts.map(attempt => attempt.requestId).join('\n')}</dd></div>
              </dl>
            </details>
            {failures.length === 0
              ? null
              : (
                <div className="vdg-alert bad">
                  {fill(t('test.failures'), { count: failures.length })}
                  {failures.map(attempt => <div key={attempt.requestId}>{attempt.error}</div>)}
                </div>
              )}
          </>
        )}
    </Dialog>
  )
}
