/**
 * The local part of the settings page: this machine's hardware with the recommendation, the
 * runtime packs, the installed and downloadable models, and which pack runs which model.
 */

import { useState } from 'react'

import { fill, type Key, type Translate } from './i18n'
import { callPanel, mebibytes, running, type Change, type GuardSettings, type Job, type PanelState } from './shared'
import { Badge, ErrorLine, Section, useAction } from './ui'

/** Download points of the published models, as `MODEL_SOURCES` in the core package lists them. */
const MODEL_SOURCES = ['modelscope-cn', 'modelscope-intl', 'huggingface'] as const

/** The listed values, plus a saved one the list no longer has, so a saved choice never silently changes. */
function withSaved(values: readonly string[], saved: string | undefined): string[] {
  return saved === undefined || saved === '' || values.includes(saved) ? [...values] : [saved, ...values]
}

function JobLine({ t, job, onCancel }: { t: Translate; job: Job; onCancel: () => void }) {
  const percent = job.total === undefined || job.total === 0 ? 0 : Math.floor(((job.done ?? 0) / job.total) * 100)
  return (
    <div className="vdg-inline" style={{ flexWrap: 'nowrap' }}>
      {job.phase === 'download' || job.phase === 'verify'
        ? <div className="vdg-progress"><div style={{ width: `${percent}%` }} /></div>
        : null}
      <span className={job.phase === 'failed' ? 'vdg-error' : 'vdg-hint'}>
        {fill(t(`job.${job.phase}` as Key), { percent, error: job.error ?? '' })}
      </span>
      {running(job) ? <button type="button" className="vdg-btn sm" onClick={onCancel}>{t('job.cancel')}</button> : null}
    </div>
  )
}

export function LocalSections({ t, live, value, disabled, save, refresh }: {
  t: Translate
  live: PanelState
  value: GuardSettings
  disabled: boolean
  save: (changes: Change) => void
  refresh: () => void
}) {
  const { busy, error, act } = useAction(refresh)
  const [dir, setDir] = useState('')
  const [modelSource, setModelSource] = useState<typeof MODEL_SOURCES[number]>(MODEL_SOURCES[0])
  const job = live.job
  const idle = !running(job) && busy === undefined
  const source = value.downloadSource
  const recommendation = live.recommendation
  const cards = live.hardware.gpus.filter(gpu => gpu.generation !== undefined)
  const chosenPack = live.packs.find(item => item.id === value.localPack)
  const chosenModel = live.models.find(item => item.id === value.localModel)
  const needed = chosenModel === undefined ? undefined : chosenModel.format === 'onnx-delivery' ? 'onnx' : 'torch'
  const cancel = (): void => { act('cancel', () => callPanel('POST', 'job/cancel')) }
  const jobOf = (kind: Job['kind'], target?: string) => (
    job === null || job.kind !== kind || (target !== undefined && job.target !== target) ? null : <JobLine t={t} job={job} onCancel={cancel} />
  )
  return (
    <>
      <Section title={t('hw.title')}>
        <div className="vdg-alert">
          {cards.length === 0
            ? <div>{t('hw.noGpu')}</div>
            : cards.map(gpu => (
              <div key={gpu.name}>
                {fill(t('hw.gpu'), { name: gpu.name, arch: gpu.generation!.architecture, cc: gpu.computeCapability ?? '?', driver: gpu.driver ?? '?' })}
                {' · '}
                {t(`hw.fp16.${gpu.generation!.fp16}` as Key)}
              </div>
            ))}
          {live.hardware.npus.map(npu => <div key={npu.name}>{fill(t('hw.npu'), { name: npu.name })}</div>)}
        </div>
        <strong>{fill(t(`hw.rec.${recommendation.reason}` as Key), { torch: recommendation.torchPack, onnx: recommendation.onnxPack })}</strong>
      </Section>

      <Section
        title={t('packs.title')}
        lead={fill(t('packs.lead'), { home: live.home })}
        flush
        actions={(
          <select className="vdg-select" aria-label={t('packs.source')} style={{ minWidth: 0 }} value={source} disabled={disabled} onChange={(event) => { save({ downloadSource: event.target.value }) }}>
            <option value="official">{t('packs.source.official')}</option>
            <option value="cn">{t('packs.source.cn')}</option>
          </select>
        )}
      >
        <div className="vdg-table-wrap">
          <table className="vdg-table">
            <thead>
              <tr>
                <th>{t('packs.col.pack')}</th>
                <th className="num">{t('packs.col.size')}</th>
                <th>{t('packs.col.state')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {live.packs.map(pack => (
                <tr key={pack.id}>
                  <td>
                    <div className="vdg-mono">{pack.id}</div>
                    {jobOf('pack', pack.id)}
                  </td>
                  <td className="num">{pack.bytes === undefined ? '—' : mebibytes(pack.bytes)}</td>
                  <td>
                    <span className="vdg-inline">
                      {pack.fit === 'ok' ? null : <Badge tone="warn">{fill(t(`packs.fit.${pack.fit}` as Key), { driver: pack.needsDriver ?? '' })}</Badge>}
                      {pack.installed === null
                        ? <Badge tone="outline">{t('packs.notInstalled')}</Badge>
                        : <Badge tone={pack.installed.outdated ? 'warn' : 'ok'}>{t(pack.installed.outdated ? 'packs.outdated' : 'packs.installed')}</Badge>}
                    </span>
                  </td>
                  <td className="num">
                    <span className="vdg-inline" style={{ justifyContent: 'flex-end' }}>
                      {pack.installed === null || pack.installed.outdated
                        ? (
                          <button
                            type="button"
                            className="vdg-btn sm"
                            disabled={pack.fit !== 'ok' || !idle}
                            onClick={() => { act('install', () => callPanel('POST', `packs/install?pack=${pack.id}&source=${source}`)) }}
                          >
                            {t(pack.installed === null ? 'packs.install' : 'packs.update')}
                          </button>
                        )
                        : null}
                      {pack.installed === null
                        ? null
                        : (
                          <button type="button" className="vdg-btn sm ghost" disabled={!idle} onClick={() => { act('remove', () => callPanel('POST', `packs/remove?pack=${pack.id}`)) }}>
                            {t('packs.remove')}
                          </button>
                        )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {live.planned.length === 0
          ? null
          : (
            <div style={{ padding: '8px 16px 12px' }}>
              {live.planned.map(pack => <p key={pack.id} className="vdg-hint">{fill(t('packs.planned'), { id: pack.id, accelerator: pack.accelerator })}</p>)}
            </div>
          )}
      </Section>

      <Section
        title={t('models.title')}
        flush
        actions={(
          <select
            className="vdg-select"
            aria-label={t('models.source')}
            style={{ minWidth: 0 }}
            value={modelSource}
            onChange={(event) => { setModelSource(MODEL_SOURCES.find(item => item === event.target.value) ?? MODEL_SOURCES[0]) }}
          >
            {MODEL_SOURCES.map(item => <option key={item} value={item}>{t(`models.source.${item}` as Key)}</option>)}
          </select>
        )}
      >
        <div className="vdg-rows">
          {live.models.length === 0
            ? <div className="vdg-row"><span className="vdg-hint">{t('models.none')}</span></div>
            : live.models.map(model => (
              <div key={model.id} className="vdg-row">
                <span className="vdg-row-label" style={{ flexShrink: 1, overflowWrap: 'anywhere' }}>{model.name}</span>
                <span className="vdg-row-value">
                  <span className="vdg-mono">{model.id}</span>
                  <Badge tone="outline">{model.format === 'onnx-delivery' ? 'ONNX' : 'PyTorch'}</Badge>
                  <span>{mebibytes(model.bytes)}</span>
                  <button type="button" className="vdg-btn sm ghost" disabled={!idle} onClick={() => { act('remove', () => callPanel('POST', `models/remove?id=${encodeURIComponent(model.id)}`)) }}>
                    {t('models.remove')}
                  </button>
                </span>
              </div>
            ))}
          {live.catalog.map(model => (
            <div key={model.family} className="vdg-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="vdg-between">
                <span>{model.name} · {model.parameters}</span>
                {model.sources.includes(modelSource)
                  ? (
                    <button
                      type="button"
                      className="vdg-btn sm"
                      disabled={!idle}
                      onClick={() => { act('download', () => callPanel('POST', `models/download?family=${model.family}&source=${modelSource}`)) }}
                    >
                      {t('models.download')}
                    </button>
                  )
                  : <Badge tone="outline">{t('models.notPublished')}</Badge>}
              </div>
              {jobOf('model-download', model.family)}
            </div>
          ))}
          <div className="vdg-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <span className="vdg-label">{t('models.dir')}</span>
            <div className="vdg-inline" style={{ flexWrap: 'nowrap' }}>
              <input
                className="vdg-input"
                style={{ flex: 1, minWidth: 0 }}
                aria-label={t('models.dir')}
                value={dir}
                placeholder={t('models.dir.placeholder')}
                onChange={(event) => { setDir(event.target.value) }}
              />
              <button type="button" className="vdg-btn" disabled={dir.trim() === '' || !idle} onClick={() => { act('dir', () => callPanel('POST', 'models/install-dir', { dir })) }}>
                {t('models.dir.install')}
              </button>
            </div>
            {jobOf('model-directory')}
          </div>
        </div>
      </Section>

      <Section title={t('local.title')}>
        <div className="vdg-inline" style={{ alignItems: 'flex-start' }}>
          <div className="vdg-field">
            <span className="vdg-label">{t('local.pack')}</span>
            <select
              className="vdg-select"
              aria-label={t('local.pack')}
              value={value.localPack ?? ''}
              disabled={disabled}
              onChange={(event) => { save({ localPack: event.target.value === '' ? undefined : event.target.value }) }}
            >
              <option value="">{t('local.pick')}</option>
              {withSaved(live.packs.filter(pack => pack.installed !== null).map(pack => pack.id), value.localPack).map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className="vdg-field">
            <span className="vdg-label">{t('local.model')}</span>
            <select
              className="vdg-select"
              aria-label={t('local.model')}
              value={value.localModel ?? ''}
              disabled={disabled}
              onChange={(event) => { save({ localModel: event.target.value === '' ? undefined : event.target.value }) }}
            >
              <option value="">{t('local.pick')}</option>
              {withSaved(live.models.map(model => model.id), value.localModel).map(id => (
                <option key={id} value={id}>{live.models.find(model => model.id === id)?.name ?? id}</option>
              ))}
            </select>
          </div>
        </div>
        {needed !== undefined && chosenPack !== undefined && chosenPack.backend !== needed
          ? <p className="vdg-warn">{fill(t('local.mismatch'), { backend: needed === 'onnx' ? 'ONNX' : 'PyTorch' })}</p>
          : null}
        <ErrorLine text={error} />
      </Section>
    </>
  )
}
