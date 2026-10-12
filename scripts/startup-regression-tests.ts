import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useApp } from '../src/renderer/src/stores/app'

// A separate test process models a fresh renderer module with its startup guard.
test('fresh unsigned installation becomes ready without starting a legacy Grok agent', async () => {
  let started = 0
  Object.assign(globalThis, {
    document: { documentElement: { dataset: {}, lang: '' } },
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { grok: {
      snapshot: async () => ({ projects: [], threads: [], auth: { signedIn: false }, theme: 'dark', locale: 'zh-CN', permissionMode: 'ask', skills: [] }),
      acp: { start: async () => { started++; throw new Error('No account is connected') } }
    } }
  })
  await useApp.getState().hydrate()
  assert.equal(started, 0)
  assert.equal(useApp.getState().ready, true)
  assert.equal(useApp.getState().startupError, null)
  assert.equal(useApp.getState().error, null)
})
