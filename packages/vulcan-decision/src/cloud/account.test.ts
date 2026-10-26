import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { DecisionError } from '../protocol.js'
import { OpenVulcanAccount, REFRESH_AHEAD_MS, type Credential, type CredentialStore } from './account.js'
import { startMockOpenVulcan } from './mock-openvulcan.test.helper.js'

class MemoryStore implements CredentialStore {
  value: Credential | undefined
  async read() { return this.value }
  async write(credential: Credential) { this.value = credential }
  async delete() { this.value = undefined }
}

const DEVICE = { display_name: 'test device', client_version: 'test 0' }
const mock = await startMockOpenVulcan()
after(() => mock.close())

async function signedIn(): Promise<{ store: MemoryStore; account: OpenVulcanAccount }> {
  const store = new MemoryStore()
  const account = new OpenVulcanAccount(store, DEVICE, mock.origin)
  const pending = await account.signIn('cn')
  await mock.approve(pending.approvalUrl)
  await pending.done
  return { store, account }
}

test('signs in through the loopback callback and keeps the credential in the host store', async () => {
  const { store, account } = await signedIn()
  const status = await account.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.site, 'cn')
  assert.equal(store.value?.auth_origin, mock.origin)
  assert.match(store.value?.access_token ?? '', /^[A-Za-z0-9_-]{43}$/)
  // The token never appears in what the account reports.
  assert.equal(JSON.stringify(status).includes(store.value!.access_token), false)
})

test('a cancelled sign-in stores nothing', async () => {
  const store = new MemoryStore()
  const account = new OpenVulcanAccount(store, DEVICE, mock.origin)
  const pending = await account.signIn('cn')
  pending.cancel()
  await assert.rejects(pending.done, (error: unknown) => error instanceof DecisionError && error.code === 'not_signed_in')
  assert.equal(store.value, undefined)
})

test('refreshes a credential close to expiry and keeps its authorization', async () => {
  mock.credentialLifetimeMs = REFRESH_AHEAD_MS / 2
  try {
    const { store, account } = await signedIn()
    const before = store.value!
    const refreshed = await account.credential()
    assert.notEqual(refreshed.access_token, before.access_token)
    assert.equal(refreshed.authorization_id, before.authorization_id)
    assert.equal(store.value?.rotation_pending, undefined)
  } finally {
    mock.credentialLifetimeMs = 14 * 24 * 3_600_000
  }
})

test('an interrupted rotation requires a new sign-in instead of guessing', async () => {
  mock.credentialLifetimeMs = REFRESH_AHEAD_MS / 2
  mock.refreshStatus = 503
  try {
    const { account } = await signedIn()
    await assert.rejects(account.credential(), (error: unknown) => error instanceof DecisionError && error.code === 'not_signed_in')
    const status = await account.status()
    assert.equal(status.signedIn, false)
    assert.equal(status.reauthRequired, true)
  } finally {
    mock.credentialLifetimeMs = 14 * 24 * 3_600_000
    mock.refreshStatus = undefined
  }
})

test('signing out revokes the device and forgets the credential', async () => {
  const { store, account } = await signedIn()
  const authorization = store.value!.authorization_id
  await account.signOut()
  assert.equal(store.value, undefined)
  assert.ok(mock.revoked.includes(authorization))
  assert.deepEqual(await account.status(), { signedIn: false })
})
