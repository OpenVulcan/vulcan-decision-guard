/**
 * The `vulcan-decision` command line: the account, runtime packs, models and test judgements.
 */

import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'

import { FileCredentialStore, isSite, OpenVulcanAccount, type Site } from './cloud/account.js'
import { CLOUD_MODELS, EdgeClient } from './cloud/edge.js'
import { DOWNLOAD_SOURCES, type DownloadSource } from './download.js'
import { DecisionEngine } from './engine.js'
import { detectHardware, gpuGeneration, recommend } from './hardware.js'
import { defaultHome, type DecisionHome } from './home.js'
import { LocalEngine } from './local/engine.js'
import { backendOf, downloadModel, installModelFromDirectory, listModels, MODEL_CATALOG, MODEL_FAMILIES, MODEL_SOURCES, removeModel, type ModelFamily, type ModelSource } from './local/models.js'
import { installPack, installedPack, isPackId, PACK_IDS, PLANNED_PACKS, readLock, removePack, type PackId } from './local/packs.js'
import { DEFAULT_OPTIONS, DecisionError, type JudgeInput } from './protocol.js'
import { VERSION } from './version.js'

const USAGE = `vulcan-decision ${VERSION}

Usage:
  vulcan-decision hardware                     Graphics cards, NPUs and the recommended runtime pack
  vulcan-decision login [--site cn|global]     Sign in to OpenVulcan in the browser
  vulcan-decision logout                       Sign out and revoke this device
  vulcan-decision account                      Show the signed-in account
  vulcan-decision cloud models                 Models this account may use
  vulcan-decision cloud probe [--model <id>]   Measure the endpoints of a cloud model
  vulcan-decision packs                        Runtime packs and whether they fit this machine
  vulcan-decision packs install <pack> [--source official|cn]
  vulcan-decision packs remove <pack>
  vulcan-decision models                       Installed and published local models
  vulcan-decision models install <dir>         Install a model package from a local directory
  vulcan-decision models download <mini|flash|standard> --from <huggingface|modelscope-intl|modelscope-cn>
  vulcan-decision models remove <id>
  vulcan-decision judge --tool <name> --args <json> [--project <dir>] [--cloud <model> | --pack <pack> --model <id>]
  vulcan-decision eval --input <file> --pack <pack> --model <id>
                                               Judge {settings, rendered} records locally, printing JSON

The data directory is ${defaultHome().root}; set VULCAN_DECISION_HOME to use another one.`

/** Run one command. @returns the process exit code. */
export async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args
  const home = defaultHome()
  try {
    switch (command) {
      case 'hardware':
        return runHardware()
      case 'login':
        return await runLogin(home, rest)
      case 'logout':
        await account(home).signOut()
        console.log('signed out')
        return 0
      case 'account':
        console.log(JSON.stringify(await account(home).status(), null, 2))
        return 0
      case 'cloud':
        return await runCloud(home, rest)
      case 'packs':
        return await runPacks(home, rest)
      case 'models':
        return await runModels(home, rest)
      case 'judge':
        return await runJudge(home, rest)
      case 'eval':
        return await runEval(home, rest)
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE)
        return 0
      default:
        console.error(`unknown command ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    console.error(error instanceof DecisionError ? `${error.code}: ${error.message}` : (error as Error).message)
    return 1
  }
}

function account(home: DecisionHome): OpenVulcanAccount {
  return new OpenVulcanAccount(new FileCredentialStore(home.file('account.json')), device(), process.env.VULCAN_DECISION_AUTH_ORIGIN)
}

function device() {
  return { display_name: `Vulcan Decision CLI on ${os.hostname()}`, client_version: `vulcan-decision ${VERSION}` }
}

function runHardware(): number {
  const hardware = detectHardware()
  const recommendation = recommend(hardware)
  const gpus = hardware.gpus.map(gpu => ({
    ...gpu,
    ...gpu.computeCapability === undefined ? {} : { generation: gpuGeneration(gpu.computeCapability) },
  }))
  console.log(JSON.stringify({ ...hardware, gpus, recommendation }, null, 2))
  return 0
}

async function runLogin(home: DecisionHome, args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { site: { type: 'string', default: 'global' } } })
  if (!isSite(values.site)) throw new Error('--site must be cn or global')
  const pending = await account(home).signIn(values.site as Site)
  console.log(`Open this page to approve the sign-in:\n${pending.approvalUrl}`)
  const status = await pending.done
  console.log(`signed in to ${status.site}, valid until ${status.expiresAt}`)
  return 0
}

async function runCloud(home: DecisionHome, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  const edge = new EdgeClient(account(home))
  if (sub === 'models') {
    console.log((await edge.models()).join('\n'))
    return 0
  }
  if (sub === 'probe') {
    const { values } = parseArgs({ args: rest, options: { model: { type: 'string', default: CLOUD_MODELS[0] } } })
    const status = await edge.probe(values.model!)
    console.log(JSON.stringify({ ...status, endpoints: status.endpoints.map(endpoint => ({ ...endpoint })) }, null, 2))
    return 0
  }
  throw new Error('usage: cloud models | cloud probe [--model <id>]')
}

async function runPacks(home: DecisionHome, args: readonly string[]): Promise<number> {
  const [sub, id, ...rest] = args
  if (sub === undefined) {
    const recommendation = recommend(detectHardware())
    for (const pack of PACK_IDS) {
      const fit = recommendation.packs.find(item => item.pack === pack)!
      const installed = installedPack(home, pack)
      const state = installed === undefined ? 'not installed' : installed.lock === readLock(pack).id ? 'installed' : 'installed, outdated'
      const size = fit.bytes === undefined ? '' : `${(fit.bytes / 1024 ** 2).toFixed(0)} MiB`
      console.log(`${pack.padEnd(12)} ${fit.fit.padEnd(16)} ${size.padStart(9)}  ${state}`)
    }
    for (const planned of PLANNED_PACKS) console.log(`${planned.id.padEnd(12)} planned          (${planned.accelerator}: waiting for an NPU model release)`)
    return 0
  }
  if (!isPackId(id)) throw new Error(`unknown pack ${String(id)}; known: ${PACK_IDS.join(', ')}`)
  if (sub === 'install') {
    const { values } = parseArgs({ args: rest, options: { source: { type: 'string', default: 'official' } } })
    if (!(DOWNLOAD_SOURCES as readonly string[]).includes(values.source!)) throw new Error('--source must be official or cn')
    let lastPercent = -1
    const record = await installPack(home, id as PackId, {
      source: values.source as DownloadSource,
      onProgress: progress => {
        if (progress.phase !== 'download') {
          console.error(progress.phase)
          return
        }
        const percent = Math.floor((progress.done / progress.total) * 100)
        if (percent !== lastPercent && percent % 5 === 0) console.error(`download ${percent}% (${progress.file})`)
        lastPercent = percent
      },
    })
    console.log(JSON.stringify(record, null, 2))
    return 0
  }
  if (sub === 'remove') {
    console.log(removePack(home, id as PackId) ? `removed ${id}` : `${id} was not installed`)
    return 0
  }
  throw new Error('usage: packs [install <pack> | remove <pack>]')
}

async function runModels(home: DecisionHome, args: readonly string[]): Promise<number> {
  const [sub, target, ...rest] = args
  const progress = (done: number, total: number, file: string) => {
    if (file !== '') console.error(`${total === 0 ? 100 : Math.floor((done / total) * 100)}% ${file}`)
  }
  if (sub === undefined) {
    for (const model of listModels(home)) console.log(`installed  ${model.id}  ${model.package_format}  ${(model.bytes / 1024 ** 2).toFixed(0)} MiB`)
    for (const model of MODEL_CATALOG) {
      const sources = MODEL_SOURCES.filter(source => model.sources[source] !== null)
      console.log(`published  ${model.family} (${model.name}, ${model.parameters})  ${sources.length === 0 ? 'no download address yet' : sources.join(', ')}`)
    }
    return 0
  }
  if (sub === 'install' && target !== undefined) {
    const model = await installModelFromDirectory(home, target, { onProgress: progress })
    console.log(`installed ${model.id} (${model.package_format})`)
    return 0
  }
  if (sub === 'download' && target !== undefined) {
    const { values } = parseArgs({ args: rest, options: { from: { type: 'string' } } })
    if (!(MODEL_FAMILIES as readonly string[]).includes(target)) throw new Error(`unknown model ${target}; known: ${MODEL_FAMILIES.join(', ')}`)
    if (!(MODEL_SOURCES as readonly (string | undefined)[]).includes(values.from)) throw new Error(`--from must be one of ${MODEL_SOURCES.join(', ')}`)
    const model = await downloadModel(home, target as ModelFamily, values.from as ModelSource, { onProgress: progress })
    console.log(`installed ${model.id}`)
    return 0
  }
  if (sub === 'remove' && target !== undefined) {
    console.log(removeModel(home, target) ? `removed ${target}` : `${target} was not installed`)
    return 0
  }
  throw new Error('usage: models [install <dir> | download <family> --from <source> | remove <id>]')
}

async function runJudge(home: DecisionHome, args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      tool: { type: 'string' }, args: { type: 'string', default: '{}' }, project: { type: 'string' },
      cloud: { type: 'string' }, pack: { type: 'string' }, model: { type: 'string' },
    },
  })
  if (values.tool === undefined) throw new Error('--tool is required')
  const engine = new DecisionEngine({
    home, credentials: new FileCredentialStore(home.file('account.json')), device: device(),
    ...process.env.VULCAN_DECISION_AUTH_ORIGIN === undefined ? {} : { authOrigin: process.env.VULCAN_DECISION_AUTH_ORIGIN },
  })
  try {
    const local = values.pack === undefined ? undefined : { pack: packArgument(values.pack), model: values.model ?? '' }
    const verdict = await engine.judge(
      { tool: values.tool, arguments: JSON.parse(values.args!) as Record<string, unknown>, ...values.project === undefined ? {} : { project: values.project } },
      { backend: local === undefined ? 'cloud' : 'local', cloudModel: values.cloud ?? CLOUD_MODELS[0], ...local === undefined ? {} : { local }, options: DEFAULT_OPTIONS },
    )
    console.log(JSON.stringify(verdict, null, 2))
    return 0
  } finally {
    engine.stop()
  }
}

async function runEval(home: DecisionHome, args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { input: { type: 'string' }, pack: { type: 'string' }, model: { type: 'string' } } })
  if (values.input === undefined || values.pack === undefined || values.model === undefined) throw new Error('--input, --pack and --model are required')
  const inputs = JSON.parse(fs.readFileSync(values.input, 'utf8')) as JudgeInput[]
  const model = listModels(home).find(item => item.id === values.model)
  const pack = packArgument(values.pack)
  if (model !== undefined && backendOf(model.package_format) !== readLock(pack).backend) throw new Error(`${model.id} does not run on ${pack}`)
  const engine = new LocalEngine(home)
  try {
    const started = performance.now()
    const loaded = await engine.warm({ pack, model: values.model })
    const loadedAt = performance.now()
    const results = await engine.judge({ pack, model: values.model }, inputs)
    console.log(JSON.stringify({ loaded, load_ms: Math.round(loadedAt - started), judge_ms: Math.round(performance.now() - loadedAt), results }, null, 2))
    return 0
  } finally {
    engine.stop()
  }
}

function packArgument(value: string): PackId {
  if (!isPackId(value)) throw new Error(`unknown pack ${value}; known: ${PACK_IDS.join(', ')}`)
  return value
}
