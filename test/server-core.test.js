'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createCore,
    PORTAL_ORIGIN,
    DATA_ORIGIN,
} = require('../server/core.js');

const STATUS_BODY = {
    authAvailable: false,
    connected: false,
    code: 'pass_binding_unavailable',
    message: '网关 Pass 账户绑定尚未开放：网关授权与交付契约未完成，登录暂不可用。',
    protocols: { chat: false, anthropic: false, responses: false },
};

const MESSAGES = {
    forbidden: '未登录或会话无效。',
    notConnected: '尚未完成 Apercus 网关账户绑定。',
    upstream: '网关暂时不可用，请稍后重试。',
    timeout: '网关响应超时，请稍后重试。',
    invalid: '网关返回了无法识别的响应。',
    internal: '网关插件内部错误。',
};

function makeRes() {
    const headers = {};
    return {
        statusCode: 200,
        headers,
        body: '',
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        end(value) {
            this.body = value || '';
        },
    };
}

async function call(handler, req) {
    const res = makeRes();
    await handler(req, res);
    return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body,
        json: () => JSON.parse(res.body),
    };
}

function makeReq(directories, extra) {
    const req = {
        method: 'GET',
        url: '/api/plugins/apercus-gateway/status',
        headers: {},
        ...extra,
    };
    req.user = { directories };
    return req;
}

function streamOf(text, chunkSize) {
    const bytes = Buffer.from(text, 'utf8');
    const size = chunkSize || bytes.length || 1;
    return new ReadableStream({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += size) {
                controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)));
            }
            controller.close();
        },
    });
}

function jsonResponse(payload, status) {
    return {
        status: status || 200,
        body: streamOf(JSON.stringify(payload)),
    };
}

function makeFetch(result) {
    const calls = [];
    async function fetchImpl(url, options) {
        calls.push({ url, options });
        return typeof result === 'function' ? result(url, options) : result;
    }
    fetchImpl.calls = calls;
    return fetchImpl;
}

const VALID_CATALOG = {
    items: [
        {
            name: 'gpt-test',
            protocol_faces: ['chat', 'anthropic'],
            modality: 'text',
            capabilities: '{"tools": true}',
            classification_name: 'standard',
            unknown_field: 'drop-me',
        },
        {
            name: 'image-test',
            protocol_faces: ['image'],
            modality: 'image',
            capabilities: '',
        },
    ],
};

const VALID_BALANCE = {
    permanent_balance: '1.000000',
    debt: '0.000000',
    daily_quota: '5.000000',
    daily_quota_used: '2.500000',
    daily_quota_remaining: '2.500000',
    quota_date: '2026-11-12',
    needs_refresh: false,
    observed_at: '2026-11-12T00:00:00Z',
    wallet_balance: '1.000000',
    unknown_field: 'drop-me',
};

function buildCore(overrides) {
    const options = overrides || {};
    return createCore({
        readBinding: options.readBinding || (async () => null),
        fetchImpl: options.fetchImpl || makeFetch(jsonResponse(VALID_CATALOG)),
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
    });
}

function assertNoStore(result) {
    assert.equal(result.headers['cache-control'], 'no-store');
}

test('status is fixed unavailable shape even when a binding exists', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_CATALOG));
    const core = createCore({
        readBinding: async () => 'agw_test_binding',
        fetchImpl,
    });
    const result = await call(core.handlers.status, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), STATUS_BODY);
    assertNoStore(result);
    assert.equal(fetchImpl.calls.length, 0);
});

test('missing or malformed req.user identity is forbidden on every endpoint', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_CATALOG));
    const core = createCore({
        readBinding: async () => 'agw_binding',
        fetchImpl,
    });
    const cases = [
        { headers: {}, user: undefined },
        { headers: {}, user: {} },
        { headers: {}, user: { directories: {} } },
        { headers: {}, user: { directories: { root: 123 } } },
        { headers: { 'x-user-id': '9' }, user: undefined },
    ];
    for (const base of cases) {
        for (const name of ['status', 'models', 'balance', 'login']) {
            const result = await call(core.handlers[name], { method: 'GET', url: '/', ...base });
            assert.equal(result.statusCode, 403, name);
            assert.equal(result.json().error.code, 'forbidden', name);
            assert.equal(result.json().error.message, MESSAGES.forbidden, name);
            assertNoStore(result);
        }
    }
    assert.equal(fetchImpl.calls.length, 0);
});

test('login is always 501 pass_binding_unavailable', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_BALANCE));
    const core = createCore({
        readBinding: async () => 'agw_binding',
        fetchImpl,
    });
    const result = await call(core.handlers.login, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 501);
    assert.deepEqual(result.json(), {
        error: { code: 'pass_binding_unavailable', message: STATUS_BODY.message },
    });
    assertNoStore(result);
    assert.equal(fetchImpl.calls.length, 0);
});

test('models and balance return 409 not_connected without a binding', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_CATALOG));
    const seenDirectories = [];
    const core = createCore({
        readBinding: async (directories) => {
            seenDirectories.push(directories);
            return null;
        },
        fetchImpl,
    });
    const dirs = { root: '/u/alice' };
    for (const name of ['models', 'balance']) {
        const result = await call(core.handlers[name], makeReq(dirs));
        assert.equal(result.statusCode, 409, name);
        assert.equal(result.json().error.code, 'not_connected', name);
        assert.equal(result.json().error.message, MESSAGES.notConnected, name);
        assertNoStore(result);
    }
    assert.deepEqual(seenDirectories, [dirs, dirs]);
    assert.equal(fetchImpl.calls.length, 0);
});

test('per-request directories isolate users and never fall back to a default user', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(VALID_CATALOG));
    const core = createCore({
        readBinding: async (directories) => {
            if (directories.root === '/u/alice') {
                return 'agw_alice';
            }
            if (directories.root === '/u/bob') {
                return 'agw_bob';
            }
            return null;
        },
        fetchImpl,
    });

    const alice = await call(core.handlers.models, makeReq({ root: '/u/alice' }, {
        headers: { 'x-user-id': 'bob', authorization: 'Bearer client-supplied' },
    }));
    const bob = await call(core.handlers.models, makeReq({ root: '/u/bob' }));
    const nobody = await call(core.handlers.balance, makeReq({ root: '/u/charlie' }));

    assert.equal(alice.statusCode, 200);
    assert.equal(bob.statusCode, 200);
    assert.equal(nobody.statusCode, 409);
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer agw_alice');
    assert.equal(fetchImpl.calls[1].options.headers.authorization, 'Bearer agw_bob');
    assert.equal(JSON.stringify(alice.body).includes('agw_alice'), false);
    assert.equal(JSON.stringify(bob.body).includes('agw_bob'), false);

    const statusAlice = await call(core.handlers.status, makeReq({ root: '/u/alice' }));
    const statusBob = await call(core.handlers.status, makeReq({ root: '/u/bob' }));
    assert.deepEqual(statusAlice.json(), STATUS_BODY);
    assert.deepEqual(statusBob.json(), STATUS_BODY);
});

test('binding reader failures are treated as not connected', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_CATALOG));
    const core = createCore({
        readBinding: async () => {
            throw new Error('secrets file unreadable');
        },
        fetchImpl,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'not_connected');
    assert.equal(JSON.stringify(result.body).includes('secrets file unreadable'), false);
});

test('catalog uses the fixed data-plane URL and ignores client-supplied targets', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_CATALOG));
    const core = createCore({
        readBinding: async () => 'agw_alice',
        fetchImpl,
    });
    const req = makeReq({ root: '/u/alice' }, {
        method: 'GET',
        url: '/api/plugins/apercus-gateway/models?url=https://evil.example/catalog',
        headers: {
            host: 'evil.example',
            'x-apercus-url': 'https://evil.example/catalog',
            'x-secret-id': 'other-user',
            authorization: 'Bearer client-supplied',
        },
        query: { url: 'https://evil.example/catalog', user_id: '42' },
        body: { url: 'https://evil.example/catalog' },
    });
    const result = await call(core.handlers.models, req);
    assert.equal(result.statusCode, 200);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, `${DATA_ORIGIN}/catalog/models`);
    assert.deepEqual(fetchImpl.calls[0].options.headers, {
        accept: 'application/json',
        authorization: 'Bearer agw_alice',
    });
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.equal(fetchImpl.calls[0].options.redirect, 'error');
    assert.ok(fetchImpl.calls[0].options.signal);
});

test('balance uses the fixed portal URL and only exact contract fields leave the plugin', async () => {
    const fetchImpl = makeFetch(jsonResponse(VALID_BALANCE));
    const core = createCore({
        readBinding: async () => 'agw_alice',
        fetchImpl,
    });
    const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }, {
        url: '/api/plugins/apercus-gateway/balance?url=https://evil.example/api/user/balance',
    }));
    assert.equal(result.statusCode, 200);
    assert.equal(fetchImpl.calls[0].url, `${PORTAL_ORIGIN}/api/user/balance`);
    assert.deepEqual(result.json(), {
        permanent_balance: '1.000000',
        debt: '0.000000',
        daily_quota: '5.000000',
        daily_quota_used: '2.500000',
        daily_quota_remaining: '2.500000',
        quota_date: '2026-11-12',
        needs_refresh: false,
        observed_at: '2026-11-12T00:00:00Z',
    });
    assert.equal(Object.hasOwn(result.json(), 'wallet_balance'), false);
    assert.equal(Object.hasOwn(result.json(), 'unknown_field'), false);
    assertNoStore(result);
});

test('catalog projection keeps original strings, drops unknown fields, omits absent classification', async () => {
    const core = buildCore({ readBinding: async () => 'agw_alice' });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 200);
    const payload = result.json();
    assert.deepEqual(payload.items[0], {
        name: 'gpt-test',
        protocol_faces: ['chat', 'anthropic'],
        modality: 'text',
        capabilities: '{"tools": true}',
        classification_name: 'standard',
    });
    assert.deepEqual(payload.items[1], {
        name: 'image-test',
        protocol_faces: ['image'],
        modality: 'image',
        capabilities: '',
    });
    assert.equal(Object.hasOwn(payload.items[1], 'classification_name'), false);
    assert.equal(Object.hasOwn(payload.items[0], 'unknown_field'), false);
    assertNoStore(result);
});

test('catalog rejects unknown protocol faces, modalities, and malformed items', async () => {
    const cases = [
        { items: [{ name: 'x', protocol_faces: ['openai-write'], modality: 'text', capabilities: '' }] },
        { items: [{ name: 'x', protocol_faces: ['chat'], modality: 'audio', capabilities: '' }] },
        { items: [{ name: '', protocol_faces: ['chat'], modality: 'text', capabilities: '' }] },
        { items: [null] },
        { items: 'not-an-array' },
        { nope: true },
    ];
    for (const payload of cases) {
        const fetchImpl = makeFetch(jsonResponse(payload));
        const core = createCore({ readBinding: async () => 'agw_alice', fetchImpl });
        const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 502);
        assert.equal(result.json().error.code, 'upstream_invalid_response');
        assert.equal(result.json().error.message, MESSAGES.invalid);
        assertNoStore(result);
    }
});

test('balance rejects wrong types and non-contract decimal strings', async () => {
    const cases = [
        { ...VALID_BALANCE, permanent_balance: 1 },
        { ...VALID_BALANCE, debt: '1' },
        { ...VALID_BALANCE, daily_quota: '-1.000000' },
        { ...VALID_BALANCE, quota_date: '2026-02-30' },
        { ...VALID_BALANCE, needs_refresh: 'false' },
        { ...VALID_BALANCE, observed_at: 'not-a-date' },
        {},
    ];
    for (const payload of cases) {
        const fetchImpl = makeFetch(jsonResponse(payload));
        const core = createCore({ readBinding: async () => 'agw_alice', fetchImpl });
        const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }));
        assert.equal(result.statusCode, 502);
        assert.equal(result.json().error.code, 'upstream_invalid_response');
        assertNoStore(result);
    }
});

test('upstream HTTP errors become a fixed error without body or credential leakage', async () => {
    const leaked = 'agw_secret_should_never_leave_upstream';
    const fetchImpl = makeFetch({
        status: 401,
        body: streamOf(JSON.stringify({ error: leaked })),
    });
    const core = createCore({ readBinding: async () => leaked, fetchImpl });
    const result = await call(core.handlers.balance, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(result.json().error.message, MESSAGES.upstream);
    assert.equal(result.body.includes(leaked), false);
    assert.equal(result.body.includes('401'), false);
    assertNoStore(result);
    assert.equal(fetchImpl.calls.length, 1);
});

test('redirects fail closed because fetch uses redirect:error', async () => {
    const fetchImpl = async () => {
        throw new TypeError('unexpected redirect');
    };
    const core = createCore({ readBinding: async () => 'agw_alice', fetchImpl });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_unavailable');
    assert.equal(JSON.stringify(result.body).includes('redirect'), false);
});

test('invalid upstream JSON fails closed', async () => {
    const fetchImpl = makeFetch({ status: 200, body: streamOf('{not json') });
    const core = createCore({ readBinding: async () => 'agw_alice', fetchImpl });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_invalid_response');
});

test('timeout aborts the upstream request and returns 504', async () => {
    const fetchImpl = (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
    });
    const core = createCore({
        readBinding: async () => 'agw_alice',
        fetchImpl,
        timeoutMs: 25,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 504);
    assert.equal(result.json().error.code, 'upstream_timeout');
    assert.equal(result.json().error.message, MESSAGES.timeout);
    assertNoStore(result);
});

test('body cap rejects oversized upstream bodies while streaming', async () => {
    const fetchImpl = makeFetch({ status: 200, body: streamOf('x'.repeat(200), 10) });
    const core = createCore({
        readBinding: async () => 'agw_alice',
        fetchImpl,
        maxBytes: 64,
    });
    const result = await call(core.handlers.models, makeReq({ root: '/u/alice' }));
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, 'upstream_invalid_response');
    assert.equal(result.json().error.message, MESSAGES.invalid);
});

test('registerRoutes wires the exact fixed paths and methods', () => {
    const calls = [];
    const core = buildCore();
    core.registerRoutes({
        get(path, handler) {
            calls.push({ method: 'GET', path, handler });
        },
        post(path, handler) {
            calls.push({ method: 'POST', path, handler });
        },
    });
    assert.deepEqual(calls.map((item) => `${item.method} ${item.path}`), [
        'GET /status',
        'GET /models',
        'GET /balance',
        'POST /login',
    ]);
});
