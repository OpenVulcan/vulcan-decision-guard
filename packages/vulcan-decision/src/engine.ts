/**
 * One entry point for hosts: judge a call with the cloud or the local backend, as selected.
 */

import { OpenVulcanAccount, type CredentialStore, type DeviceInfo } from './cloud/account.js'
import { EdgeClient } from './cloud/edge.js'
import type { DecisionHome } from './home.js'
import { LocalEngine, type LocalSelection } from './local/engine.js'
import { DecisionError, type BackendKind, type DecisionOptions, type JudgeCall, type Verdict } from './protocol.js'
import { renderCall } from './render.js'

/** How the host wants calls judged. */
export interface EngineSettings {
  readonly backend: BackendKind
  /** Cloud model id. */
  readonly cloudModel: string
  /** Endpoint id the user locked; absent means the measured best. */
  readonly cloudEndpoint?: string
  /** Installed pack and model for the local backend. */
  readonly local?: LocalSelection
  readonly options: DecisionOptions
}

export interface EngineOptions {
  readonly home: DecisionHome
  readonly credentials: CredentialStore
  readonly device: DeviceInfo
  /** Overrides the OpenVulcan auth origin; tests point it at a local authority. */
  readonly authOrigin?: string
}

export class DecisionEngine {
  readonly home: DecisionHome
  readonly account: OpenVulcanAccount
  readonly cloud: EdgeClient
  readonly local: LocalEngine

  constructor(options: EngineOptions) {
    this.home = options.home
    this.account = new OpenVulcanAccount(options.credentials, options.device, options.authOrigin)
    this.cloud = new EdgeClient(this.account)
    this.local = new LocalEngine(options.home)
  }

  /**
   * Judge one call.
   * @throws DecisionError for every failure; hosts must treat it as "not allowed".
   */
  async judge(call: JudgeCall, settings: EngineSettings): Promise<Verdict> {
    const input = { settings: settings.options, rendered: renderCall(call) }
    const started = performance.now()
    if (settings.backend === 'cloud') {
      const { results, endpoint } = await this.cloud.judge(settings.cloudModel, [input], settings.cloudEndpoint)
      return { ...results[0]!, backend: 'cloud', model: settings.cloudModel, via: endpoint, elapsed_ms: Math.round(performance.now() - started) }
    }
    if (settings.local === undefined) throw new DecisionError('not_installed', 'no local runtime pack and model are selected')
    const [result] = await this.local.judge(settings.local, [input])
    return { ...result!, backend: 'local', model: settings.local.model, via: settings.local.pack, elapsed_ms: Math.round(performance.now() - started) }
  }

  stop(): void {
    this.local.stop()
  }
}
