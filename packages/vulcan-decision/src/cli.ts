/**
 * The `vulcan-decision` command line: runs the resident service and manages installed models.
 */

import fs from 'node:fs'
import { parseArgs } from 'node:util'

import { DecisionClient, exchange, ping } from './client.js'
import { listInstalled, installFromDirectory, recommendedSize, removeInstalled, selectModel } from './model/package.js'
import { LoadedModel, type ModelInput } from './model/runtime.js'
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
  vulcan-decision model list                  List installed models
  vulcan-decision model install <dir> --size <0.2b|0.4b|0.6b> [--id <id>]
                                              Install a model package from a local directory
  vulcan-decision model remove <id|size>      Remove an installed model
  vulcan-decision judge --input <file>        Judge calls through the service (debugging)
  vulcan-decision eval --input <file> [--size <size>]
                                              Score rendered calls in this process (debugging)

The data directory is ${dataDir()}; set VULCAN_DECISION_HOME to use another one.`

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
      throw new Error('model needs list, install or remove')
  }
}

function printInstalled(): void {
  const installed = listInstalled()
  if (installed.length === 0) {
    console.log('models: none installed')
    return
  }
  console.log(`models (this device suits up to ${recommendedSize()}):`)
  for (const model of installed) {
    const graphs = model.manifest.variants.map(variant => `${variant.precision} on ${variant.devices.join('/')}`).join(', ')
    console.log(`  ${model.manifest.size}  ${model.manifest.id}  [${graphs}]`)
  }
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

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}
