import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountBinding } from '../lib/zcode/account-binding.mjs'

const SESSION = { zcodeJwt: 'synthetic-zcode-token', businessJwt: 'synthetic-business-token', businessFamily: 'bigmodel' }
const CANDIDATE = { route: 'glm-a', family: 'bigmodel', apiKey: 'key-a.secret-a' }
const UNAVAILABLE = { status: 'unavailable', matchingRoutes: [] }
const MATCHED = { status: 'matched', matchingRoutes: ['glm-a'] }
const UNMATCHED = { status: 'unmatched', matchingRoutes: [] }
const envelope = (data, code = 200) => new Response(JSON.stringify({ code, data }), { headers: { 'content-type': 'application/json' } })
const customer = (projects = [{ projectId: 'project-a', projectType: 1 }]) => ({ organizations: [{ organizationId: 'org-a', projects }] })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(options = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (options.respond) {
      const response = await options.respond(url, init, calls.length)
      if (response !== undefined) return response
    }
    if (url.endsWith('/getCustomerInfo')) return envelope(options.customer ?? customer(), options.code ?? 200)
    const copy = /\/organization\/([^/]+)\/projects\/([^/]+)\/api_keys\/copy\/([^/]+)$/.exec(url)
    if (copy) {
      const location = [copy[1], copy[2], copy[3]].map(decodeURIComponent).join('/')
      return envelope(options.copies?.[location] ?? { apiKey: decodeURIComponent(copy[3]), secretKey: 'secret-a' }, options.code ?? 200)
    }
    const list = /\/organization\/([^/]+)\/projects\/([^/]+)\/api_keys$/.exec(url)
    if (list) {
      const location = [list[1], list[2]].map(decodeURIComponent).join('/')
      return envelope(options.lists?.[location] ?? [{ apiKey: 'key-a', secretKey: '****' }], options.code ?? 200)
    }
    throw new Error('unexpected mock request')
  }
  return { calls, fetchImpl }
}

test('two same-region providers: only the complete matching key binds; copy only candidate IDs', async () => {
  const mock = fixture({ lists: { 'org-a/project-a': [{ apiKey: 'unrelated-id' }, { apiKey: 'key-a', secretKey: '***' }] } })
  const binding = createAccountBinding(mock)
  const result = await binding.resolve(SESSION, [CANDIDATE, { ...CANDIDATE, route: 'glm-b', apiKey: 'other-id.other-secret' }])
  assert.deepEqual(result, MATCHED)
  assert.equal(mock.calls.length, 3)
  assert.equal(mock.calls.filter(({ url }) => url.includes('/copy/')).length, 1)
  assert.ok(mock.calls[2].url.endsWith('/copy/key-a'))
  for (const { url, init } of mock.calls) {
    assert.equal(new URL(url).origin, 'https://bigmodel.cn')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.body, undefined)
    assert.equal(init.headers.Authorization, SESSION.businessJwt)
    assert.equal(init.headers.accept, 'application/json')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
  }
  assert.deepEqual(Object.keys(result).sort(), ['matchingRoutes', 'status'])
  for (const secret of [SESSION.zcodeJwt, SESSION.businessJwt, CANDIDATE.apiKey, 'secret-a', 'org-a', 'project-a']) {
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

test('scans every personal project across organizations and URL-encodes locations and key IDs', async () => {
  const mock = fixture({
    customer: { organizations: [
      { organizationId: 'first-org', projects: [{ projectId: 'first-project' }] },
      { organizationId: 'second/org', projects: [{ projectId: 'second project' }] },
    ] },
    lists: { 'first-org/first-project': [], 'second/org/second project': [{ apiKey: 'id/special' }] },
    copies: { 'second/org/second project/id/special': { apiKey: 'id/special', secretKey: 'secret-a' } },
  })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [{ ...CANDIDATE, apiKey: 'id/special.secret-a' }]), MATCHED)
  assert.equal(mock.calls.length, 4)
  assert.ok(mock.calls[3].url.endsWith('/organization/second%2Forg/projects/second%20project/api_keys/copy/id%2Fspecial'))
})

test('same key ID with different secret is unmatched, never an account-ID match', async () => {
  const mock = fixture()
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [{ ...CANDIDATE, apiKey: 'key-a.wrong-secret' }]), UNMATCHED)
})

test('two complete matching routes are ambiguous and both routes are returned', async () => {
  const mock = fixture({ lists: { 'org-a/project-a': [{ apiKey: 'key-a.secret-a' }, { apiKey: 'key-b.secret-b' }] } })
  const result = await createAccountBinding(mock).resolve(SESSION, [CANDIDATE, { ...CANDIDATE, route: 'glm-b', apiKey: 'key-b.secret-b' }])
  assert.deepEqual(result, { status: 'ambiguous', matchingRoutes: ['glm-a', 'glm-b'] })
  assert.equal(mock.calls.length, 2, 'complete list keys do not need copy')
})

test('two routes using the same complete key remain ambiguous; duplicate route evidence is deduplicated', async () => {
  const mock = fixture()
  const binding = createAccountBinding(mock)
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE, CANDIDATE]), MATCHED)
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE, { ...CANDIDATE, route: 'glm-alias' }]), { status: 'ambiguous', matchingRoutes: ['glm-a', 'glm-alias'] })
})

test('Z.ai customer uses raw token; lists and copy use Bearer; other-family candidates are ignored', async () => {
  const mock = fixture()
  const session = { ...SESSION, businessFamily: 'zai' }
  const result = await createAccountBinding(mock).resolve(session, [CANDIDATE, { ...CANDIDATE, route: 'zai-only', family: 'zai' }])
  assert.deepEqual(result, { status: 'matched', matchingRoutes: ['zai-only'] })
  for (const { url } of mock.calls) assert.equal(new URL(url).origin, 'https://api.z.ai')
  assert.equal(mock.calls[0].init.headers.Authorization, SESSION.businessJwt)
  for (const { init } of mock.calls.slice(1)) assert.equal(init.headers.Authorization, 'Bearer ' + SESSION.businessJwt)
})

test('team projects and team keys never bind even if the full key matches', async () => {
  const mock = fixture({
    customer: customer([{ projectId: 'team-number', projectType: 2 }, { projectId: 'team-string', projectType: '2' }, { projectId: 'personal', projectType: '1' }]),
    lists: { 'org-a/personal': [{ apiKey: 'key-a.secret-a', keyType: 2 }, { apiKey: 'key-a', keyType: '2' }] },
  })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNMATCHED)
  assert.equal(mock.calls.length, 2)
  assert.ok(mock.calls[1].url.includes('/projects/personal/'))
})

test('masked list secret is never used; copy without optional apiKey can prove exact key', async () => {
  const mock = fixture({ copies: { 'org-a/project-a/key-a': { secretKey: 'secret-a' } } })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), MATCHED)
  assert.equal(mock.calls.length, 3)
})

test('masked, missing, malformed or mismatched copy material fails closed', async (t) => {
  for (const value of [
    { apiKey: 'key-a', secretKey: 'sec***' }, { apiKey: 'key-a', secretKey: 'sec...' },
    { apiKey: 'key-a', secretKey: 'sec…' }, { apiKey: 'key-a', secretKey: 'sec⋯' },
    { apiKey: 'wrong-id', secretKey: 'secret-a' }, { apiKey: null, secretKey: 'secret-a' },
    { apiKey: 'key-a' }, { apiKey: 'key-a', secretKey: '' },
    { apiKey: 'key-a', secretKey: 'key-a.secret-a' }, { apiKey: 'key-a', secretKey: 'secret-a', keyType: 2 },
    [], 'secret-a',
  ]) {
    await t.test(JSON.stringify(value), async () => {
      const mock = fixture({ copies: { 'org-a/project-a/key-a': value } })
      assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
    })
  }
})

test('no matching candidate ID means unmatched and no copy requests', async () => {
  const mock = fixture({ lists: { 'org-a/project-a': [{ apiKey: 'someone-else', secretKey: '***' }] } })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNMATCHED)
  assert.equal(mock.calls.length, 2)
})

test('missing login/current family and malformed candidates make no requests', async (t) => {
  for (const session of [null, {}, { ...SESSION, businessFamily: 'unknown' }, { ...SESSION, businessFamily: '__proto__' }, { ...SESSION, businessJwt: '' }, { ...SESSION, zcodeJwt: '' }]) {
    await t.test(JSON.stringify(session), async () => {
      const mock = fixture()
      assert.deepEqual(await createAccountBinding(mock).resolve(session, [CANDIDATE]), UNAVAILABLE)
      assert.equal(mock.calls.length, 0)
    })
  }
  const mock = fixture()
  const binding = createAccountBinding(mock)
  assert.deepEqual(await binding.resolve(SESSION, [{ ...CANDIDATE, apiKey: 'only-id' }]), UNAVAILABLE)
  assert.deepEqual(await binding.resolve(SESSION, [{ ...CANDIDATE, apiKey: 'id.***' }]), UNAVAILABLE)
  assert.deepEqual(await binding.resolve(SESSION, []), UNMATCHED)
  assert.deepEqual(await binding.resolve(SESSION, [{ ...CANDIDATE, family: 'zai' }]), UNMATCHED)
  assert.equal(mock.calls.length, 0)
})

test('HTTP failures, copy errors and invalid success envelopes return no raw error data', async (t) => {
  const failures = [
    () => new Response('secret-a raw upstream', { status: 401 }),
    () => new Response('secret-a raw upstream', { status: 500 }),
    () => new Response(JSON.stringify({ code: 401, data: { secretKey: 'secret-a' } })),
    () => new Response(JSON.stringify({ code: '200 ', data: {} })),
    () => new Response(JSON.stringify({ data: {} })),
    () => new Response('not-json secret-a'),
    () => { throw new Error('raw-error key-a.secret-a ' + SESSION.businessJwt) },
  ]
  for (const [index, fail] of failures.entries()) {
    await t.test(String(index), async () => {
      const mock = fixture({ respond: (url) => url.includes('/copy/') ? fail() : undefined })
      assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
    })
  }
  for (const code of [0, 200, '0', '200']) {
    const mock = fixture({ code })
    assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), MATCHED)
  }
})

test('partial project failure discards an earlier complete match', async () => {
  const mock = fixture({
    customer: customer([{ projectId: 'project-a' }, { projectId: 'project-b' }]),
    respond: (url) => url.includes('/projects/project-b/') ? new Response('', { status: 403 }) : undefined,
  })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(mock.calls.length, 4)
})

test('unexpected customer/key shapes and pagination cannot yield a binding', async (t) => {
  const responses = [
    { stage: 'customer', response: () => envelope({}) },
    { stage: 'customer', response: () => envelope({ organizations: [{ organizationId: 'org-a' }] }) },
    { stage: 'customer', response: () => envelope(customer([{ projectType: 1 }])) },
    { stage: 'keys', response: () => envelope({ items: [{ apiKey: 'key-a.secret-a' }], total: 1 }) },
    { stage: 'keys', response: () => envelope([null]) },
    { stage: 'customer', response: () => envelope(customer([{ projectId: 'project-a', projectType: {} }])) },
    { stage: 'keys', response: () => envelope([{ apiKey: 'key-a.secret-a', keyType: {} }]) },
    { stage: 'keys', response: () => new Response(JSON.stringify({ code: 200, data: [{ apiKey: 'key-a.secret-a' }] }), { headers: { 'x-total-count': '100' } }) },
    { stage: 'keys', response: () => envelope([{ secretKey: 'secret-a' }]) },
    { stage: 'keys', response: () => new Response(JSON.stringify({ code: 200, data: [{ apiKey: 'key-a.secret-a' }], next_cursor: 'more' })) },
    { stage: 'keys', response: () => new Response(JSON.stringify({ code: 200, data: [{ apiKey: 'key-a.secret-a' }] }), { headers: { link: '<https://example.invalid/next>; rel=next' } }) },
  ]
  for (const [index, scenario] of responses.entries()) {
    await t.test(String(index), async () => {
      const mock = fixture({ respond: (url) => (scenario.stage === 'customer' ? url.endsWith('/getCustomerInfo') : url.endsWith('/api_keys')) ? scenario.response() : undefined })
      assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
    })
  }
})

test('projects are bounded at 32 and duplicate project locations do not consume the budget', async () => {
  const projects = Array.from({ length: 32 }, (_, index) => ({ projectId: 'p' + index }))
  const lists = Object.fromEntries(projects.map(({ projectId }) => ['org-a/' + projectId, []]))
  const mock = fixture({ customer: customer([...projects, projects[0]]), lists })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNMATCHED)
  assert.equal(mock.calls.length, 33)
  const excessive = fixture({ customer: customer([...projects, { projectId: 'p32' }]) })
  assert.deepEqual(await createAccountBinding(excessive).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(excessive.calls.length, 1)
})

test('redirects are prohibited, including a fetch implementation that reports following one', async () => {
  for (const redirected of [false, true]) {
    const mock = fixture({ respond: (_url, init) => {
      assert.equal(init.redirect, 'error')
      if (!redirected) return new Response('', { status: 302, headers: { location: 'https://example.invalid/leak' } })
      const response = envelope(customer())
      Object.defineProperty(response, 'redirected', { value: true })
      return response
    } })
    assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
    assert.equal(mock.calls.length, 1)
  }
})

test('one deadline covers fetch even when the implementation ignores abort', async () => {
  let signal
  const binding = createAccountBinding({ timeoutMs: 20, fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}) } })
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(signal.aborted, true)
})

test('deadline covers a stalled response body and cancels the stream', async () => {
  let canceled = false
  const mock = fixture({ respond: (url) => url.includes('/copy/') ? new Response(new ReadableStream({ cancel() { canceled = true } })) : undefined })
  assert.deepEqual(await createAccountBinding({ ...mock, timeoutMs: 20 }).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(canceled, true)
  assert.equal(mock.calls.length, 3)
})

test('each response is limited to 2 MiB and oversized body is canceled', async () => {
  let canceled = false
  const mock = fixture({ respond: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
    cancel() { canceled = true },
  })) })
  assert.deepEqual(await createAccountBinding(mock).resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(canceled, true)
  assert.equal(mock.calls.length, 1)
})

test('TTL caches only result and callers cannot mutate the cached route array', async () => {
  let clock = 100
  const mock = fixture()
  const binding = createAccountBinding({ ...mock, now: () => clock })
  const first = await binding.resolve(SESSION, [CANDIDATE])
  first.matchingRoutes.push('forged-route')
  first.status = 'unmatched'
  clock += 299999
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), MATCHED)
  assert.equal(mock.calls.length, 3)
  clock++
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), MATCHED)
  assert.equal(mock.calls.length, 6)
})

test('a failed refresh clears previous binding and uses a 30-second failure cooldown', async () => {
  let clock = 0
  let failing = false
  const mock = fixture({ respond: () => failing ? new Response('', { status: 401 }) : undefined })
  const binding = createAccountBinding({ ...mock, now: () => clock, ttlMs: 100 })
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), MATCHED)
  clock = 100
  failing = true
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(mock.calls.length, 4)
  clock += 29999
  failing = false
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), UNAVAILABLE)
  assert.equal(mock.calls.length, 4)
  clock++
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), MATCHED)
  assert.equal(mock.calls.length, 7)
})

test('each credential field and route change immediately invalidates the single cache slot', async () => {
  const mock = fixture()
  const binding = createAccountBinding(mock)
  const session = { ...SESSION }
  const candidate = { ...CANDIDATE }
  assert.deepEqual(await binding.resolve(session, [candidate]), MATCHED)
  session.businessJwt += '-new'
  assert.deepEqual(await binding.resolve(session, [candidate]), MATCHED)
  session.zcodeJwt += '-new'
  assert.deepEqual(await binding.resolve(session, [candidate]), MATCHED)
  session.businessFamily = 'zai'
  candidate.family = 'zai'
  assert.deepEqual(await binding.resolve(session, [candidate]), MATCHED)
  candidate.route = 'new-route'
  assert.deepEqual(await binding.resolve(session, [candidate]), { status: 'matched', matchingRoutes: ['new-route'] })
  candidate.apiKey = 'key-a.different-secret'
  assert.deepEqual(await binding.resolve(session, [candidate]), UNMATCHED)
  assert.equal(mock.calls.length, 18)
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), MATCHED)
  assert.equal(mock.calls.length, 21, 'returning to previous credentials must re-query, not reuse an old-account cache')
})

test('same-signature concurrent requests share one query and return independent results', async () => {
  const gate = deferred()
  const mock = fixture({ respond: (url) => url.endsWith('/getCustomerInfo') ? gate.promise : undefined })
  const binding = createAccountBinding(mock)
  const first = binding.resolve(SESSION, [CANDIDATE])
  const second = binding.resolve({ ...SESSION }, [{ ...CANDIDATE }])
  assert.equal(mock.calls.length, 1)
  gate.resolve(envelope(customer()))
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, MATCHED)
  assert.deepEqual(b, MATCHED)
  assert.notEqual(a, b)
  assert.notEqual(a.matchingRoutes, b.matchingRoutes)
  assert.equal(mock.calls.length, 3)
})

test('invalidate aborts an in-flight request and late results cannot overwrite the new account', async () => {
  const gate = deferred()
  let oldSignal
  const mock = fixture({ respond: (_url, init, index) => {
    if (index === 1) { oldSignal = init.signal; return gate.promise }
  } })
  const binding = createAccountBinding(mock)
  const old = binding.resolve(SESSION, [CANDIDATE])
  binding.invalidate()
  assert.equal(oldSignal.aborted, true)
  assert.deepEqual(await old, UNAVAILABLE)
  const nextSession = { ...SESSION, businessJwt: 'new-account-business-token' }
  const nextCandidates = [{ ...CANDIDATE, apiKey: 'key-a.wrong-secret' }]
  assert.deepEqual(await binding.resolve(nextSession, nextCandidates), UNMATCHED)
  gate.resolve(envelope(customer()))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await binding.resolve(nextSession, nextCandidates), UNMATCHED)
  assert.equal(mock.calls.length, 4, 'late response must not continue with key queries')
})

test('signature change aborts previous query automatically; missing session also clears binding', async () => {
  const gate = deferred()
  let oldSignal
  const mock = fixture({ respond: (_url, init, index) => {
    if (index === 1) { oldSignal = init.signal; return gate.promise }
  } })
  const binding = createAccountBinding(mock)
  const old = binding.resolve(SESSION, [CANDIDATE])
  const next = binding.resolve(SESSION, [{ ...CANDIDATE, apiKey: 'key-a.wrong-secret' }])
  assert.equal(oldSignal.aborted, true)
  assert.deepEqual(await old, UNAVAILABLE)
  assert.deepEqual(await next, UNMATCHED)
  gate.resolve(envelope(customer()))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await binding.resolve(null, [CANDIDATE]), UNAVAILABLE)
  assert.deepEqual(await binding.resolve(SESSION, [CANDIDATE]), MATCHED)
  assert.equal(mock.calls.length, 7)
})

test('BigModel complete array total is accepted; partial and contradictory envelopes are not', async () => {
  for (const [meta, expected] of [[{ total: 1 }, MATCHED], [{ total: 2 }, UNAVAILABLE], [{ total: 0 }, UNAVAILABLE], [{ total: '1' }, UNAVAILABLE], [{ total: 1, success: false }, UNAVAILABLE]]) {
    const mock = fixture({ respond: (url) => url.endsWith('/api_keys') ? new Response(JSON.stringify({code:200,data:[{apiKey:'key-a',secretKey:'******'}],...meta})) : undefined })
    assert.deepEqual(await createAccountBinding(mock).resolve(SESSION,[CANDIDATE]), expected)
  }
})
