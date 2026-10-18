/**
 * Local tool-call decision model for coding agents: a resident service judging calls with the
 * `vulcan-decision-shell` ONNX models, its client and model management.
 */

export { DecisionClient, exchange, ping, spawnService } from './client.js'
export { dataDir, endpointPath, HOME_ENV, modelsDir } from './paths.js'
export * from './protocol.js'
export { renderCall } from './render.js'
export { VERSION } from './version.js'
