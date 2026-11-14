'use strict';

// Apercus Gateway 的 ST 服务端插件核心：与 Express/SillyTavern 无关的纯处理层。
// 路由只在 index.js 中接线到 ST；本文件只依赖 Node 原生能力（fetch/AbortController/
// Buffer），所有外部依赖（绑定读取器、fetch、超时、体积上限）由 createCore 注入，
// 测试可直接以假实现驱动，不接触真实 ST 或网关。
//
// 固定目标（已按网关仓库 docs 核实）：
//   - docs/deploy-runbook.md:341-352：门户 Origin = https://gw.apercus.ai，
//     数据面 Origin = https://api.apercus.ai（数据面白名单 data_plane_hosts）。
//   - docs/api/api.md data-5：GET /catalog/models 属数据面，受 host 闸约束；
//     query-1：GET /api/user/balance 为个人 Bearer 面，部署在门户目标。
// 因此目录走数据面常量、余额走门户常量；二者均为编译期常量，不接受请求方传入的
// URL/Origin，也不读取请求头里的任何目标覆盖。

const PORTAL_ORIGIN = 'https://gw.apercus.ai';
const DATA_ORIGIN = 'https://api.apercus.ai';
const BINDING_SECRET_KEY = 'apercus_gateway_binding';

const CATALOG_PATH = '/catalog/models';
const BALANCE_PATH = '/api/user/balance';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 512 * 1024;

const MAX_NAME = 512;
const MAX_CAPABILITIES = 8192;
const MAX_CLASSIFICATION = 512;
const MAX_OBSERVED_AT = 64;

const PROTOCOL_FACES = new Set([
    'chat',
    'responses',
    'anthropic',
    'image',
    'tts',
    'embedding',
    'video',
]);

const MODALITIES = new Set(['text', 'image', 'embedding', 'tts', 'video']);

const AMOUNT_RE = /^\d+\.\d{6}$/;
const QUOTA_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MESSAGE_STATUS = '网关 Pass 账户绑定尚未开放：网关授权与交付契约未完成，登录暂不可用。';
const MESSAGE_FORBIDDEN = '未登录或会话无效。';
const MESSAGE_NOT_CONNECTED = '尚未完成 Apercus 网关账户绑定。';
const MESSAGE_UPSTREAM = '网关暂时不可用，请稍后重试。';
const MESSAGE_TIMEOUT = '网关响应超时，请稍后重试。';
const MESSAGE_INVALID = '网关返回了无法识别的响应。';
const MESSAGE_INTERNAL = '网关插件内部错误。';

const STATUS_BODY = Object.freeze({
    authAvailable: false,
    connected: false,
    code: 'pass_binding_unavailable',
    message: MESSAGE_STATUS,
    protocols: Object.freeze({
        chat: false,
        anthropic: false,
        responses: false,
    }),
});

class GatewayError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function forbidden() { return new GatewayError(403, 'forbidden', MESSAGE_FORBIDDEN); }
function notConnected() { return new GatewayError(409, 'not_connected', MESSAGE_NOT_CONNECTED); }
function upstreamUnavailable() { return new GatewayError(502, 'upstream_unavailable', MESSAGE_UPSTREAM); }
function upstreamTimeout() { return new GatewayError(504, 'upstream_timeout', MESSAGE_TIMEOUT); }
function invalidResponse() { return new GatewayError(502, 'upstream_invalid_response', MESSAGE_INVALID); }

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(payload));
}

function sendError(res, error) {
    if (error instanceof GatewayError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
        return;
    }
    sendJson(res, 500, { error: { code: 'internal_error', message: MESSAGE_INTERNAL } });
}

// 身份只取 ST 注入的 req.user.directories；不读请求体/query/头的 user id，
// 也不回落到默认用户目录。
function requireDirectories(req) {
    const user = req && req.user;
    const directories = user && user.directories;
    if (!directories || typeof directories !== 'object'
        || typeof directories.root !== 'string' || directories.root.length === 0) {
        throw forbidden();
    }
    return directories;
}

function normalizeBinding(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
        return null;
    }
    if (/[\r\n\x00-\x1f\x7f]/.test(raw)) {
        return null;
    }
    return raw;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, maxLength) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw invalidResponse();
    return value;
}

function requireAmount(value) {
    if (typeof value !== 'string' || !AMOUNT_RE.test(value)) throw invalidResponse();
    return value;
}

function requireQuotaDate(value) {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string' || !QUOTA_DATE_RE.test(value)) {
        throw invalidResponse();
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() !== month - 1
        || parsed.getUTCDate() !== day) {
        throw invalidResponse();
    }
    return value;
}

function requireObservedAt(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OBSERVED_AT
        || Number.isNaN(Date.parse(value))) {
        throw invalidResponse();
    }
    return value;
}

// catalog 原契约五键投影：未知协议面/模态整包拒绝（fail-closed），未知字段丢弃，
// 文本仅做长度上限校验、不改写内容。classification_name 未归类时保持省略。
function projectCatalog(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
        throw invalidResponse();
    }
    const items = payload.items.map((item) => {
        if (!isPlainObject(item)) {
            throw invalidResponse();
        }
        const name = requireString(item.name, MAX_NAME);
        if (!Array.isArray(item.protocol_faces)) {
            throw invalidResponse();
        }
        const protocolFaces = item.protocol_faces.map((face) => {
            if (typeof face !== 'string' || !PROTOCOL_FACES.has(face)) {
                throw invalidResponse();
            }
            return face;
        });
        if (typeof item.modality !== 'string' || !MODALITIES.has(item.modality)) {
            throw invalidResponse();
        }
        if (typeof item.capabilities !== 'string' || item.capabilities.length > MAX_CAPABILITIES) {
            throw invalidResponse();
        }
        const projected = {
            name,
            protocol_faces: protocolFaces,
            modality: item.modality,
            capabilities: item.capabilities,
        };
        if (item.classification_name !== undefined) {
            projected.classification_name = requireString(item.classification_name, MAX_CLASSIFICATION);
        }
        return projected;
    });
    return { items };
}

// 余额八字段白名单投影（query §2）；wallet_balance 与任何契约外字段不出口。
function projectBalance(payload) {
    if (!isPlainObject(payload)) {
        throw invalidResponse();
    }
    if (typeof payload.needs_refresh !== 'boolean') {
        throw invalidResponse();
    }
    return {
        permanent_balance: requireAmount(payload.permanent_balance),
        debt: requireAmount(payload.debt),
        daily_quota: requireAmount(payload.daily_quota),
        daily_quota_used: requireAmount(payload.daily_quota_used),
        daily_quota_remaining: requireAmount(payload.daily_quota_remaining),
        quota_date: requireQuotaDate(payload.quota_date),
        needs_refresh: payload.needs_refresh,
        observed_at: requireObservedAt(payload.observed_at),
    };
}

async function readBoundedBody(response, maxBytes) {
    const body = response && response.body;
    if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (!value) {
                    continue;
                }
                total += value.byteLength;
                if (total > maxBytes) {
                    try {
                        await reader.cancel();
                    } catch {
                        // 取消失败不影响拒绝结论。
                    }
                    throw invalidResponse();
                }
                chunks.push(Buffer.from(value));
            }
        } catch (error) {
            if (error instanceof GatewayError) {
                throw error;
            }
            throw upstreamUnavailable();
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    throw invalidResponse();
}

// 只读 GET 上游：固定 URL、redirect:error、总超时、流式体积上限。
// 非 200 一律固定错误、不读取也不回显上游正文；错误消息不含任何上游内容。
async function fetchJson(url, binding, options) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(upstreamTimeout());
        }, options.timeoutMs);
    });
    try {
        const response = await Promise.race([
            Promise.resolve().then(() => options.fetchImpl(url, {
                method: 'GET',
                redirect: 'error',
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${binding}`,
                },
                signal: controller.signal,
            })),
            timeoutPromise,
        ]);
        if (!response || response.status !== 200) {
            throw upstreamUnavailable();
        }
        const text = await Promise.race([
            readBoundedBody(response, options.maxBytes),
            timeoutPromise,
        ]);
        try {
            return JSON.parse(text);
        } catch {
            throw invalidResponse();
        }
    } catch (error) {
        if (error instanceof GatewayError) {
            throw error;
        }
        if (timedOut) {
            throw upstreamTimeout();
        }
        throw upstreamUnavailable();
    } finally {
        clearTimeout(timer);
    }
}

function createCore(deps) {
    const readBinding = deps && deps.readBinding;
    const fetchImpl = (deps && deps.fetchImpl) || globalThis.fetch;
    const timeoutMs = (deps && deps.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const maxBytes = (deps && deps.maxBytes) || DEFAULT_MAX_BYTES;

    if (typeof readBinding !== 'function') {
        throw new TypeError('createCore requires readBinding(directories)');
    }
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('createCore requires a fetch implementation');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError('timeoutMs must be a positive integer');
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError('maxBytes must be a positive integer');
    }

    // 绑定读取只接收本请求的 req.user.directories；读取失败/无值均按未连接拒绝。
    async function resolveBinding(req) {
        const directories = requireDirectories(req);
        let raw = null;
        try {
            raw = await readBinding(directories);
        } catch {
            throw notConnected();
        }
        const binding = normalizeBinding(raw);
        if (!binding) {
            throw notConnected();
        }
        return binding;
    }

    async function statusHandler(req, res) {
        try {
            requireDirectories(req);
            sendJson(res, 200, STATUS_BODY);
        } catch (error) {
            sendError(res, error);
        }
    }

    async function modelsHandler(req, res) {
        try {
            const binding = await resolveBinding(req);
            const payload = await fetchJson(`${DATA_ORIGIN}${CATALOG_PATH}`, binding, {
                fetchImpl,
                timeoutMs,
                maxBytes,
            });
            sendJson(res, 200, projectCatalog(payload));
        } catch (error) {
            sendError(res, error);
        }
    }

    async function balanceHandler(req, res) {
        try {
            const binding = await resolveBinding(req);
            const payload = await fetchJson(`${PORTAL_ORIGIN}${BALANCE_PATH}`, binding, {
                fetchImpl,
                timeoutMs,
                maxBytes,
            });
            sendJson(res, 200, projectBalance(payload));
        } catch (error) {
            sendError(res, error);
        }
    }

    async function loginHandler(req, res) {
        try {
            requireDirectories(req);
            // 登录/凭据交付未交付：即便存在专用 secret 也不得报告登录完成。
            sendJson(res, 501, {
                error: {
                    code: 'pass_binding_unavailable',
                    message: MESSAGE_STATUS,
                },
            });
        } catch (error) {
            sendError(res, error);
        }
    }

    const handlers = {
        status: statusHandler,
        models: modelsHandler,
        balance: balanceHandler,
        login: loginHandler,
    };

    function registerRoutes(router) {
        if (!router || typeof router.get !== 'function' || typeof router.post !== 'function') {
            throw new TypeError('registerRoutes requires an Express-style router');
        }
        router.get('/status', handlers.status);
        router.get('/models', handlers.models);
        router.get('/balance', handlers.balance);
        router.post('/login', handlers.login);
    }

    return { handlers, registerRoutes };
}

module.exports = {
    createCore,
    PORTAL_ORIGIN,
    DATA_ORIGIN,
    BINDING_SECRET_KEY,
    MESSAGE_STATUS,
};
