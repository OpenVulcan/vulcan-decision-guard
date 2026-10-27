import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { DecisionHome } from '@openvulcan/vulcan-decision'

import { RECORDS_FILE, RecordStore, RETENTION_DAYS, type NewRecord } from './records.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 27)

function home(): DecisionHome {
  return new DecisionHome(fs.mkdtempSync(path.join(os.tmpdir(), 'vdg-records-')))
}

function call(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    judgedAtMs: NOW,
    sessionId: 's1',
    workspaceRoot: '/work/a',
    toolName: 'bash',
    arguments: '{"command":"git push"}',
    attended: true,
    judge: {
      label: 'review',
      elapsedMs: 12,
      trace: {
        backend: 'cloud', model: 'm', via: 'edge-1', policyVersion: 'v2',
        settings: { cross_project_writes: 'allow', database_reset: 'confirm', project_reset: 'confirm' },
        rendered: 'Tool: bash',
      },
    },
    outcome: 'user_allowed',
    ...overrides,
  }
}

test('records survive a reload and page newest first with filters', () => {
  const where = home()
  const store = new RecordStore(where, () => NOW)
  store.append(call({ judgedAtMs: NOW - 2000 }))
  store.append(call({ judgedAtMs: NOW - 1000, workspaceRoot: '/work/b', judge: { label: 'allow', elapsedMs: 3 }, outcome: 'judge_allowed' }))
  store.append(call({ judgedAtMs: NOW, judge: { error: 'offline', elapsedMs: 1 }, outcome: 'not_asked' }))

  const reloaded = new RecordStore(where, () => NOW)
  const page = reloaded.page({ limit: 50 })
  assert.deepEqual(page.records.map(record => record.judgedAtMs), [NOW, NOW - 1000, NOW - 2000])
  assert.equal(page.total, 3)
  assert.deepEqual(page.workspaces, ['/work/a', '/work/b'])
  assert.deepEqual(reloaded.page({ limit: 50, label: 'failed' }).records.map(record => record.outcome), ['not_asked'])
  assert.deepEqual(reloaded.page({ limit: 50, workspace: '/work/b' }).records.map(record => record.outcome), ['judge_allowed'])
  assert.throws(() => reloaded.page({ limit: 50, label: 'maybe' }), RangeError)
})

test('pages continue after the last record of the previous page', () => {
  const store = new RecordStore(home(), () => NOW)
  for (let index = 0; index < 5; index += 1) store.append(call({ judgedAtMs: NOW - index }))
  const first = store.page({ limit: 2 })
  assert.equal(first.hasMore, true)
  const second = store.page({ limit: 2, before: first.records[1]!.id })
  assert.deepEqual(second.records.map(record => record.judgedAtMs), [NOW - 2, NOW - 3])
  const last = store.page({ limit: 2, before: second.records[1]!.id })
  assert.equal(last.hasMore, false)
  assert.equal(last.records.length, 1)
})

test('records older than the retention days are dropped on load', () => {
  const where = home()
  const store = new RecordStore(where, () => NOW)
  store.append(call({ judgedAtMs: NOW - (RETENTION_DAYS + 1) * DAY }))
  store.append(call())
  assert.equal(new RecordStore(where, () => NOW).page({ limit: 10 }).total, 1)
})

test('marks persist, need model input, and only marked records are exported', () => {
  const where = home()
  const store = new RecordStore(where, () => NOW)
  const traced = store.append(call())
  const untraced = store.append(call({ judge: { error: 'not signed in', elapsedMs: 0 }, outcome: 'not_asked' }))
  assert.throws(() => store.mark(untraced.id, 'allow'), RangeError)
  assert.equal(store.mark(traced.id, 'allow').correction, 'allow')

  const reloaded = new RecordStore(where, () => NOW)
  assert.equal(reloaded.page({ limit: 10, markedOnly: true }).marked, 1)
  const exported = reloaded.export()
  assert.equal(exported.count, 1)
  const sample = JSON.parse(exported.content.trim()) as Record<string, unknown>
  assert.deepEqual(Object.keys(sample).sort(), ['id', 'label', 'metadata', 'policy_version', 'rendered', 'settings'])
  assert.equal(sample['label'], 'allow')

  assert.equal(reloaded.mark(traced.id, null).correction, undefined)
  assert.equal(reloaded.export().count, 0)
})

test('an unreadable log fails every read until it is cleared', () => {
  const where = home()
  fs.writeFileSync(where.file(RECORDS_FILE), '{"not":"a record"}\n')
  const store = new RecordStore(where, () => NOW)
  assert.throws(() => store.page({ limit: 10 }), /line 1/)
  assert.throws(() => store.append(call()), /line 1/)
  store.clear()
  assert.equal(store.page({ limit: 10 }).total, 0)
  store.append(call())
  assert.equal(new RecordStore(where, () => NOW).page({ limit: 10 }).total, 1)
})
