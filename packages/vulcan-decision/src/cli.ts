/**
 * The `vulcan-decision` command line: runs the resident service and manages installed models.
 */

import fs from 'node:fs'
import { parseArgs } from 'node:util'

import { DecisionClient, exchange, ping } from './client.js'
import { chooseDownload, downloadModel } from './model/download.js'
import { detectHardware, recommendedPrecision, recommendedProvider, recommendedSizeFor, type ProviderState } from './model/hardware.js'
import { listInstalled, installFromDirectory, removeInstalled, selectModel, type Precision } from './model/package.js'
import { DEVICE_ENV, LoadedModel, requestedProvider, type ModelInput } from './model/runtime.js'
import { messageOf } from './models.js'
import { dataDir, endpointPath } from './paths.js'
import { CONTRACT_VERSION, DecisionError, MODEL_SIZES, type DecisionOptions, type JudgeCall, type ModelSize } from './protocol.js'
import { serve } from './service.js'
import { VERSION } from './version.js'

const USAGE = `vulcan-decision ${VERSION}

Usage:
  vulcan-decision serve                       Run the resident service in the foreground
  vulcan-decision start                       Start the service unless it is running
  vulcan-decision status                      Show the running service and installed models
  vulcan-decision stop                        Stop the running service
  vulcan-decision hardware                    Show graphics cards, usable devices and the recommended model
  vulcan-decision model list                  List installed models
  vulcan-decision model download [--size <size>] [--precision <fp16-mixed|fp32>]
                                              Download a published model; defaults to the recommendation
  vulcan-decision model install <dir> --size <0.2b|0.4b|0.6b> [--id <id>]
                                              Install a model package from a local directory
  vulcan-decision model remove <id|size>      Remove an installed model
  vulcan-decision judge --input <file>        Judge calls through the service (debugging)
  vulcan-decision eval --input <file> [--size <size>]
                                              Score rendered calls in this process (debugging)

The data directory is ${dataDir()}; set VULCAN_DECISION_HOME to use another one.
${DEVICE_ENV}=auto|cpu|dml|cuda chooses the device; auto takes the recommended one.`

/** Default authorization options, matching the model's policy defaults. */
const DEFAULT_OPTIONS: DecisionOptions = { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' }

/** Run one command. @returns the process exit code. */
export async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args
  try {
    switch (command) {
      case 'serve':
        return await runServe()
      case 'start':
        return await runStart()
      case 'status':
        return await runStatus()
      case 'stop':
        return await runStop()
      case 'hardware':
        return runHardware()
      case 'model':
        return await runModel(rest)
      case 'judge':
        return await runJudge(rest)
      case 'eval':
        return await runEval(rest)
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE)
        return command === undefined ? 1 : 0
      case '--version':
        console.log(VERSION)
        return 0
      default:
        console.error(`unknown command ${command}\n\n${USAGE}`)
        return 1
    }
  } catch (error) {
    console.error(error instanceof DecisionError ? `${error.code}: ${error.message}` : messageOf(error))
    return 1
  }
}

async function runServe(): Promise<number> {
  const handle = await serve()
  if (handle === undefined) {
    console.error(`another service already listens on ${endpointPath()}`)
    return 1
  }
  const stop = (): void => { void handle.stop() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // The server keeps the event loop alive; `stop` exits the process.
  await new Promise<never>(() => {})
  return 0
}

async function runStart(): Promise<number> {
  const client = new DecisionClient()
  try {
    console.log(`service listening on ${await client.start()}`)
  } finally {
    client.close()
  }
  return 0
}

async function runStatus(): Promise<number> {
  const endpoint = endpointPath()
  const signal = AbortSignal.timeout(5_000)
  const pong = await ping(endpoint, signal).catch(() => undefined)
  if (pong === undefined) {
    console.log('service: not running')
  } else if (pong.type === 'contract_mismatch') {
    console.log(`service: running with contract ${pong.contract}; this command speaks ${CONTRACT_VERSION}`)
  } else {
    const answer = await exchange(endpoint, { type: 'status', contract: CONTRACT_VERSION }, signal)
    if (answer.type !== 'status') throw new Error(`unexpected answer ${answer.type}`)
    const { status } = answer
    console.log(`service: running (version ${status.version}, pid ${status.pid}, up ${Math.round(status.uptime_ms / 1000)} s, judged ${status.judged})`)
    for (const model of status.models.filter(item => item.loaded)) console.log(`loaded: ${model.id} on ${model.device ?? 'unknown device'}`)
  }
  printInstalled()
  return 0
}

async function runStop(): Promise<number> {
  console.log(await stopService() ? 'service stopped' : 'service: not running')
  return 0
}

/** Stop a running service and wait until its endpoint is free. @returns whether one was running. */
async function stopService(): Promise<boolean> {
  const endpoint = endpointPath()
  const signal = AbortSignal.timeout(15_000)
  if (await ping(endpoint, signal).then(() => false, () => true)) return false
  await exchange(endpoint, { type: 'shutdown' }, signal).catch(() => {})
  while (await ping(endpoint, signal).then(() => true, () => false)) {
    if (signal.aborted) throw new Error('the service did not stop in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return true
}

async function runModel(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args
  switch (action) {
    case 'list':
      printInstalled()
      return 0
    case 'download': {
      const { values } = parseArgs({ args: [...rest], options: { size: { type: 'string' }, precision: { type: 'string' } } })
      const provider = requestedProvider()
      const hardware = detectHardware()
      const size = parseSize(values.size) ?? recommendedSizeFor(hardware, provider)
      const precision = parsePrecision(values.precision) ?? recommendedPrecision(provider, hardware)
      // An explicit choice is downloaded as asked; the recommendation settles for what is published.
      const chosen = values.size !== undefined && values.precision !== undefined ? { size, precision } : chooseDownload(size, precision)
      if (chosen === undefined) throw new Error(`no published model fits ${size}`)
      console.log(`downloading the ${chosen.size} ${chosen.precision} model for ${provider}`)
      const model = await downloadModel({
        size: chosen.size,
        precision: chosen.precision,
        log: line => console.log(line),
        // A running service holds the graphs open; it restarts on the next call.
        beforeInstall: async () => { if (await stopService()) console.log('stopped the running service') },
      })
      console.log(`installed ${model.manifest.id} at ${model.root}`)
      return 0
    }
    case 'install': {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { size: { type: 'string' }, id: { type: 'string' } },
        allowPositionals: true,
      })
      const [source] = positionals
      if (source === undefined || positionals.length !== 1) throw new Error('model install needs exactly one source directory')
      const size = parseSize(values.size)
      if (size === undefined) throw new Error('model install needs --size')
      // A running service holds the graphs open; it restarts on the next call.
      if (await stopService()) console.log('stopped the running service')
      const model = await installFromDirectory(source, { size, ...values.id === undefined ? {} : { id: values.id }, log: line => console.log(line) })
      console.log(`installed ${model.manifest.id} at ${model.root}`)
      return 0
    }
    case 'remove': {
      const [target] = rest
      if (target === undefined || rest.length !== 1) throw new Error('model remove needs one model id or size')
      if (await stopService()) console.log('stopped the running service')
      if (!removeInstalled(target)) {
        console.error(`no installed model matches ${target}`)
        return 1
      }
      console.log(`removed ${target}`)
      return 0
    }
    default:
      throw new Error('model needs list, download, install or remove')
  }
}

function printInstalled(): void {
  const installed = listInstalled()
  if (installed.length === 0) {
    console.log('models: none installed')
    return
  }
  console.log(`models (this device suits up to ${recommendedSizeFor(detectHardware(), requestedProvider())}):`)
  for (const model of installed) {
    const graphs = model.manifest.variants.map(variant => `${variant.precision} on ${variant.devices.join('/')}`).join(', ')
    console.log(`  ${model.manifest.size}  ${model.manifest.id}  [${graphs}]`)
  }
}

function runHardware(): number {
  const hardware = detectHardware()
  console.log(`platform: ${hardware.platform} ${hardware.arch}, memory ${gib(hardware.totalMemory)}`)
  if (hardware.gpus.length === 0) console.log('graphics cards: none found')
  for (const gpu of hardware.gpus) {
    const details = [
      gpu.memoryBytes === undefined ? undefined : gib(gpu.memoryBytes),
      gpu.computeCapability === undefined ? undefined : `compute ${gpu.computeCapability}`,
      gpu.driver === undefined ? undefined : `driver ${gpu.driver}`,
    ].filter(Boolean)
    console.log(`graphics card: ${gpu.name}${details.length === 0 ? '' : ` (${details.join(', ')})`}`)
  }
  for (const state of hardware.providers) console.log(`  ${state.provider.padEnd(4)} ${describeProvider(state)}`)
  const provider = requestedProvider()
  const auto = recommendedProvider(hardware)
  console.log(`device: ${provider}${provider === auto ? '' : ` (set by ${DEVICE_ENV}; recommended ${auto})`}`)
  const size = recommendedSizeFor(hardware, provider)
  const precision = recommendedPrecision(provider, hardware)
  console.log(`recommended model: ${size} ${precision}`)
  const published = chooseDownload(size, precision)
  console.log(published === undefined
    ? 'download: no published model fits'
    : `download: ${published.size} ${published.precision}${published.download === null ? ' (address not published yet; use "model install")' : ' with "model download"'}`)
  return 0
}

/** Readiness of one device and, when it cannot run, what to do about it. */
function describeProvider(state: ProviderState): string {
  if (state.unavailable === undefined) return 'ready'
  switch (state.unavailable) {
    case 'unsupported_platform':
      return state.provider === 'cuda'
        ? 'unavailable: onnxruntime-node ships CUDA for Linux x64 only'
        : 'unavailable: onnxruntime-node ships DirectML for Windows only'
    case 'no_gpu':
      return 'unavailable: no graphics card found'
    case 'nvidia_driver':
      return 'unavailable: nvidia-smi did not answer; install the NVIDIA driver'
    case 'cuda_provider':
      return 'unavailable: the onnxruntime-node CUDA provider is missing; allow its install script (pnpm approve-builds, or npm without --ignore-scripts) and reinstall'
    case 'cuda_libraries':
      return `unavailable: install CUDA 12 and cuDNN 9; missing ${state.missing?.join(', ') ?? ''}`
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

/** Input of `judge`: one call or a list, each optionally carrying options and a size. */
interface JudgeInput {
  readonly project?: string
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly options?: Partial<DecisionOptions>
  readonly model_size?: ModelSize
}

async function runJudge(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { input: { type: 'string' } } })
  if (values.input === undefined) throw new Error('judge needs --input')
  const inputs = asList(JSON.parse(fs.readFileSync(values.input, 'utf8')) as JudgeInput | JudgeInput[])
  const client = new DecisionClient()
  try {
    for (const input of inputs) {
      const call: JudgeCall = {
        host: 'dsh',
        ...input.project === undefined ? {} : { project: input.project },
        tool: input.tool,
        arguments: input.arguments,
      }
      const verdict = await client.judge(call, {
        backend: 'local',
        ...input.model_size === undefined ? {} : { model_size: input.model_size },
        options: { ...DEFAULT_OPTIONS, ...input.options },
      }, AbortSignal.timeout(120_000))
      console.log(JSON.stringify(verdict))
    }
  } finally {
    client.close()
  }
  return 0
}

/** Input of `eval`: the delivery package's `example-input.json` shape. */
interface EvalInput {
  readonly settings: DecisionOptions
  readonly rendered: string
}

async function runEval(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { input: { type: 'string' }, size: { type: 'string' } } })
  if (values.input === undefined) throw new Error('eval needs --input')
  const inputs = asList(JSON.parse(fs.readFileSync(values.input, 'utf8')) as EvalInput | EvalInput[])
  const model = await LoadedModel.load(selectModel(parseSize(values.size)))
  try {
    const started = performance.now()
    const verdicts = await model.predict(inputs.map((input): ModelInput => ({ options: input.settings, rendered: input.rendered })))
    for (const verdict of verdicts) console.log(JSON.stringify(verdict))
    console.error(`${model.model.manifest.id} on ${model.provider}: ${inputs.length} calls in ${Math.round(performance.now() - started)} ms`)
  } finally {
    await model.release()
  }
  return 0
}

function parseSize(value: string | undefined): ModelSize | undefined {
  if (value === undefined) return undefined
  if (!(MODEL_SIZES as readonly string[]).includes(value)) throw new Error(`size must be one of ${MODEL_SIZES.join(', ')}`)
  return value as ModelSize
}

function parsePrecision(value: string | undefined): Precision | undefined {
  if (value === undefined) return undefined
  if (value !== 'fp16-mixed' && value !== 'fp32') throw new Error('precision must be fp16-mixed or fp32')
  return value
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}
