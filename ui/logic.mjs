/**
 * Pure data and gating logic for the Apercus Gateway SillyTavern extension.
 *
 * This module deliberately has no SillyTavern imports and no side effects so it
 * can be exercised with node:test. Every function returns new values; nothing
 * here writes settings, secrets, or request state.
 *
 * Source contracts:
 * - Gateway catalog fields: docs/api/api.md data-5 (`items[].name`,
 *   `protocol_faces`, `modality`, `capabilities`, optional `classification_name`).
 * - Gateway balance fields: docs/api/api.md query-2 (`permanent_balance`,
 *   `debt`, `daily_quota`, `daily_quota_used`, `daily_quota_remaining`,
 *   `quota_date`, `needs_refresh`, `observed_at`).
 * - ST plugin routes: /api/plugins/apercus-gateway status, models, balance,
 *   login. No success shape for login is defined yet; callers must not infer
 *   one.
 */

export const PROTOCOLS = Object.freeze(['chat', 'responses', 'anthropic', 'image', 'tts', 'embedding', 'video']);
export const MODALITIES = Object.freeze(['text', 'image', 'embedding', 'tts', 'video']);
export const STATUS_PROTOCOLS = Object.freeze(['chat', 'anthropic', 'responses']);

export const MAX_CATALOG_ITEMS = 500;
export const MAX_RESPONSE_BYTES = 262144;

const MODEL_MAX_LENGTH = 512;
const DECIMAL_6 = /^\d+\.\d{6}$/;
const QUOTA_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** @param {string} value */
function isValidQuotaDate(value) {
    if (!QUOTA_DATE.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

/** @param {unknown} value */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize one catalog item, keeping only contract fields. Invalid entries
 * return null; no defaults are invented.
 * @param {unknown} item
 */
export function normalizeModelItem(item) {
    if (!isPlainObject(item)) return null;
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > MODEL_MAX_LENGTH) return null;
    const name = item.name;

    if (!Array.isArray(item.protocol_faces)) return null;
    const faces = [];
    for (const face of item.protocol_faces) {
        if (typeof face !== 'string' || !PROTOCOLS.includes(face)) return null;
        if (!faces.includes(face)) faces.push(face);
    }

    if (typeof item.modality !== 'string' || !MODALITIES.includes(item.modality)) return null;
    if (typeof item.capabilities !== 'string') return null;

    let classificationName = null;
    if (Object.hasOwn(item, 'classification_name')) {
        if (!isNonEmptyString(item.classification_name)) return null;
        classificationName = item.classification_name.trim();
    }

    const normalized = {
        name,
        protocol_faces: Object.freeze(faces),
        modality: item.modality,
        capabilities: item.capabilities,
    };
    if (classificationName !== null) {
        normalized.classification_name = classificationName;
    }
    return Object.freeze(normalized);
}

/**
 * Validate the `{ items: [...] }` catalog envelope and drop invalid entries.
 * @param {unknown} payload
 */
export function classifyCatalog(payload) {
    if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
        return { ok: false, reason: 'catalog_envelope_invalid', items: [], invalidCount: 0, truncated: false };
    }
    const items = [];
    let invalidCount = 0;
    let truncated = false;
    for (let index = 0; index < payload.items.length; index += 1) {
        if (items.length >= MAX_CATALOG_ITEMS) {
            truncated = true;
            break;
        }
        const normalized = normalizeModelItem(payload.items[index]);
        if (normalized === null) {
            invalidCount += 1;
            continue;
        }
        items.push(normalized);
    }
    return { ok: true, reason: null, items: Object.freeze(items), invalidCount, truncated };
}

/**
 * Select a protocol face for a model from protocol_faces only.
 * chat wins when present. anthropic is always disabled in this delivery because
 * no verified safe anthropic adapter exists. responses-only, unsupported faces,
 * malformed entries, and empty faces also stay disabled.
 * @param {unknown} rawItem
 */
export function faceForModel(rawItem) {
    const normalized = normalizeModelItem(rawItem);
    if (normalized === null) {
        return { face: null, disabled: true, reason: 'invalid_entry' };
    }
    const faces = normalized.protocol_faces;
    if (faces.includes('chat')) {
        return { face: 'chat', disabled: false, reason: null };
    }
    if (faces.includes('anthropic')) {
        return { face: 'anthropic', disabled: true, reason: 'anthropic_adapter_unavailable' };
    }
    if (faces.includes('responses')) {
        return { face: null, disabled: true, reason: 'responses_not_enabled' };
    }
    return { face: null, disabled: true, reason: 'face_not_enabled' };
}

/**
 * Validate the plugin status payload. Missing or wrongly typed fields make the
 * status unusable; no protocol is assumed to be available.
 * @param {unknown} payload
 */
export function parseStatus(payload) {
    if (!isPlainObject(payload)) return { ok: false, reason: 'status_envelope_invalid' };
    if (typeof payload.authAvailable !== 'boolean') return { ok: false, reason: 'status_auth_invalid' };
    if (typeof payload.connected !== 'boolean') return { ok: false, reason: 'status_connected_invalid' };
    if (typeof payload.code !== 'string') return { ok: false, reason: 'status_code_invalid' };
    if (typeof payload.message !== 'string') return { ok: false, reason: 'status_message_invalid' };
    if (!isPlainObject(payload.protocols)) return { ok: false, reason: 'status_protocols_invalid' };

    const protocols = {};
    for (const face of STATUS_PROTOCOLS) {
        if (typeof payload.protocols[face] !== 'boolean') {
            return { ok: false, reason: 'status_protocols_invalid' };
        }
        protocols[face] = payload.protocols[face];
    }

    return {
        ok: true,
        value: Object.freeze({
            authAvailable: payload.authAvailable,
            connected: payload.connected,
            code: payload.code,
            message: payload.message,
            protocols: Object.freeze(protocols),
        }),
    };
}

/**
 * A face is usable only when the plugin says the gateway is connected and that
 * exact face is true.
 * @param {ReturnType<typeof parseStatus>} status
 * @param {string | null} face
 */
export function canUseProtocol(status, face) {
    if (!status || !status.ok || !face || !STATUS_PROTOCOLS.includes(face)) return false;
    return status.value.connected === true && status.value.protocols[face] === true;
}

/**
 * Validate one gateway balance number. Contract values are fixed six-decimal
 * non-negative strings; no numeric conversion is performed.
 * @param {unknown} value
 */
export function isBalanceDecimal(value) {
    return typeof value === 'string' && DECIMAL_6.test(value);
}

/**
 * Validate the gateway balance payload without deriving, merging, or rounding
 * any value.
 * @param {unknown} payload
 */
export function parseBalance(payload) {
    if (!isPlainObject(payload)) return { ok: false, reason: 'balance_envelope_invalid' };
    const decimalFields = [
        'permanent_balance',
        'debt',
        'daily_quota',
        'daily_quota_used',
        'daily_quota_remaining',
    ];
    for (const field of decimalFields) {
        if (!isBalanceDecimal(payload[field])) {
            return { ok: false, reason: `balance_${field}_invalid` };
        }
    }
    if (payload.quota_date !== null && !(typeof payload.quota_date === 'string' && isValidQuotaDate(payload.quota_date))) {
        return { ok: false, reason: 'balance_quota_date_invalid' };
    }
    if (typeof payload.needs_refresh !== 'boolean') return { ok: false, reason: 'balance_needs_refresh_invalid' };
    if (typeof payload.observed_at !== 'string' || !UTC_DATE_TIME.test(payload.observed_at) || Number.isNaN(Date.parse(payload.observed_at))) {
        return { ok: false, reason: 'balance_observed_at_invalid' };
    }

    return {
        ok: true,
        value: Object.freeze({
            permanent_balance: payload.permanent_balance,
            debt: payload.debt,
            daily_quota: payload.daily_quota,
            daily_quota_used: payload.daily_quota_used,
            daily_quota_remaining: payload.daily_quota_remaining,
            quota_date: payload.quota_date,
            needs_refresh: payload.needs_refresh,
            observed_at: payload.observed_at,
        }),
    };
}

/**
 * Build the display rows for a parsed balance. Daily remaining, permanent
 * balance, and debt remain separate strings; a stale ledger is never presented
 * as today's usable quota.
 * @param {ReturnType<typeof parseBalance>['value']} balance
 */
export function balanceRows(balance) {
    return {
        rows: [
            { key: 'daily_quota_remaining', label: '每日剩余', value: balance.daily_quota_remaining },
            { key: 'permanent_balance', label: '长期余额', value: balance.permanent_balance },
            { key: 'debt', label: '欠额', value: balance.debt },
        ],
        warning: balance.needs_refresh
            ? '账本待刷新：当前账日不是今日，以下数值不是今日可调用余额。'
            : null,
        quotaDate: balance.quota_date,
        observedAt: balance.observed_at,
    };
}

/**
 * View model for one catalog row. There is no active native adapter, so a row
 * is enabled only when protocol_faces and status agree and a verified adapter
 * exists; no such adapter exists in this delivery.
 * @param {unknown} rawItem
 * @param {ReturnType<typeof parseStatus>} status
 */
export function rowView(rawItem, status) {
    const item = normalizeModelItem(rawItem);
    if (item === null) {
        return { name: null, face: null, modality: null, classification: null, disabled: true, reason: 'invalid_entry' };
    }
    const face = faceForModel(item);
    const base = {
        name: item.name,
        face: face.face,
        modality: item.modality,
        classification: item.classification_name ?? null,
        disabled: true,
        reason: null,
    };
    if (!status || !status.ok) return { ...base, reason: 'status_unavailable' };
    if (face.disabled) return { ...base, reason: face.reason };
    if (!canUseProtocol(status, face.face)) return { ...base, reason: 'protocol_not_connected' };
    return { ...base, reason: 'adapter_unavailable' };
}

