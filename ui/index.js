/**
 * Apercus Gateway — SillyTavern UI extension.
 *
 * Source-checked against SillyTavern 1.17.0 files only (st-context.js
 * getContext, events.js event names, openai.js custom source, secrets.js,
 * #leftSendForm). It has not been loaded in a running SillyTavern; 1.19.0 is
 * not checked.
 *
 * Current boundary:
 * - Reads only: /api/plugins/apercus-gateway status, models, balance.
 * - POST login is wired to the real endpoint and reports its 501 honestly.
 * - No native protocol adapter is active. Without an account binding the
 *   /models route returns 409 not_connected, so no catalog can be shown; even if
 *   a directory becomes available later, a verified safe adapter would still be
 *   required, so no model can be switched now. This file never mutates ST
 *   source/model/secret settings.
 * - All remote strings are assigned with textContent. No HTML string sinks,
 *   no browser storage, and no credentials or raw keys are persisted.
 */

import { getContext } from '../../../extensions.js';
import * as L from './logic.mjs';

const ROUTE = '/api/plugins/apercus-gateway';
const STATUS_KEYS = L.STATUS_PROTOCOLS;

const state = {
    status: null,
    statusError: null,
    catalog: null,
    catalogError: null,
    balance: null,
    balanceError: null,
    loginPending: false,
    modelsPending: false,
    balancePending: false,
};

let ctx = null;
let els = null;
let infoDialog = null;
let infoOpener = null;

function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function reasonText(reason) {
    switch (reason) {
        case 'invalid_entry': return '目录条目无效';
        case 'status_unavailable': return '插件状态不可用';
        case 'protocol_not_connected': return '协议面未接通';
        case 'anthropic_adapter_unavailable': return 'anthropic 面没有经过核实的适配，已禁用';
        case 'responses_not_enabled': return 'responses 面尚未接通';
        case 'face_not_enabled': return '没有可用的协议面';
        case 'adapter_unavailable': return '协议适配待接通';
        default: return '已阻止';
    }
}

function buildPanel() {
    const root = h('div', 'extension_container ag-root');
    const panel = h('section', 'ag-panel');
    panel.id = 'apercus_gateway_panel';
    panel.setAttribute('aria-labelledby', 'apercus_gateway_title');
    panel.tabIndex = -1;

    const header = h('div', 'ag-header');
    const heading = h('h4', 'ag-title');
    heading.id = 'apercus_gateway_title';
    heading.textContent = 'Apercus Gateway';
    const stamp = h('span', 'ag-stamp', 'APERCUS');
    const dot = h('span', 'ag-dot ag-dot-unknown');
    dot.setAttribute('aria-hidden', 'true');
    header.append(heading, stamp, dot);

    const statusLine = h('p', 'ag-status');
    statusLine.setAttribute('role', 'status');
    statusLine.setAttribute('aria-live', 'polite');
    statusLine.textContent = '正在读取插件状态…';

    const protocolLine = h('div', 'ag-protocols');
    const chips = {};
    for (const face of STATUS_KEYS) {
        const chip = h('span', 'ag-chip', `${face}：未加载`);
        chips[face] = chip;
        protocolLine.append(chip);
    }

    const authRow = h('div', 'ag-auth');
    const loginButton = h('button', 'menu_button ag-btn', '登录 Apercus');
    loginButton.type = 'button';
    loginButton.id = 'apercus_gateway_login';
    const loginNote = h('span', 'ag-note');
    authRow.append(loginButton, loginNote);

    const actions = h('div', 'ag-actions');
    const modelsButton = h('button', 'menu_button ag-btn', '刷新目录');
    modelsButton.type = 'button';
    const balanceButton = h('button', 'menu_button ag-btn', '刷新额度');
    balanceButton.type = 'button';
    const infoButton = h('button', 'menu_button ag-btn', '说明');
    infoButton.type = 'button';
    actions.append(modelsButton, balanceButton, infoButton);

    const modelsTitle = h('h5', 'ag-section-title', '模型目录');
    const modelsList = h('div', 'ag-list');
    const modelsNote = h('p', 'ag-note', '尚未加载目录。');

    const balanceTitle = h('h5', 'ag-section-title', '额度（只读快照）');
    const balanceList = h('div', 'ag-list');
    const balanceNote = h('p', 'ag-note');

    const boundary = h('p', 'ag-boundary');
    boundary.textContent = '本轮只读：登录与协议连接未接通；不会写入 SillyTavern 的 source、secret 或 key。';

    const version = h('p', 'ag-version');
    version.textContent = '版本说明：仅按 SillyTavern 1.17.0 源码核对；未加载运行，1.19.0 未核对。';

    panel.append(
        header,
        statusLine,
        protocolLine,
        authRow,
        actions,
        modelsTitle,
        modelsNote,
        modelsList,
        balanceTitle,
        balanceNote,
        balanceList,
        boundary,
        version,
    );
    root.append(panel);

    loginButton.addEventListener('click', () => { void doLogin(); });
    modelsButton.addEventListener('click', () => { void refreshModels(); });
    balanceButton.addEventListener('click', () => { void refreshBalance(); });
    infoButton.addEventListener('click', () => openInfo(infoButton));

    return {
        root,
        panel,
        statusLine,
        dot,
        chips,
        loginButton,
        loginNote,
        modelsButton,
        balanceButton,
        modelsNote,
        modelsList,
        balanceNote,
        balanceList,
    };
}

function buildQuickButton() {
    const button = h('button', 'menu_button ag-quick');
    button.type = 'button';
    button.id = 'apercus_gateway_quick';
    button.title = 'Apercus Gateway 状态与模型';
    button.setAttribute('aria-label', 'Apercus Gateway');
    const label = h('span', 'ag-quick-label', 'Apercus');
    button.append(label);
    button.addEventListener('click', openPanel);
    return button;
}

function attach() {
    const settings = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2')
        || document.body;
    const built = buildPanel();
    settings.append(built.root);
    els = built;

    const leftSendForm = document.getElementById('leftSendForm');
    const quick = buildQuickButton();
    if (leftSendForm && leftSendForm.parentElement) {
        leftSendForm.parentElement.insertBefore(quick, leftSendForm.nextSibling);
    } else {
        quick.hidden = true;
    }
    els.quick = quick;

    buildInfoDialog();
    void refreshStatus();
}

function buildInfoDialog() {
    infoDialog = document.createElement('dialog');
    infoDialog.className = 'ag-dialog';
    const title = h('h4', 'ag-title', 'Apercus Gateway 边界说明');
    title.id = 'apercus_gateway_info_title';
    infoDialog.setAttribute('aria-labelledby', title.id);
    const body = h('div', 'ag-dialog-body');
    for (const line of [
        '状态、目录和额度来自同源插件 /api/plugins/apercus-gateway，只读展示。',
        'Pass 登录绑定尚未接通：当前登录请求会返回 501，扩展不会伪装成功。',
        '未绑定时 /models 返回 409 not_connected，无法取得目录；未来目录接通后仍须实现安全协议适配，当前不能切换模型。',
        '不会修改 SillyTavern 的 chat source、模型或 secret；也不会保存任何原始 key。',
        '仅按 SillyTavern 1.17.0 源码核对；未加载运行，1.19.0 未核对。',
    ]) {
        body.append(h('p', 'ag-dialog-line', line));
    }
    const close = h('button', 'menu_button ag-btn', '关闭');
    close.type = 'button';
    infoDialog.append(title, body, close);
    document.body.append(infoDialog);

    close.addEventListener('click', () => infoDialog.close());
    infoDialog.addEventListener('close', () => {
        if (infoOpener && typeof infoOpener.focus === 'function') infoOpener.focus();
        infoOpener = null;
    });
}

function openInfo(opener) {
    if (!infoDialog) return;
    infoOpener = opener || null;
    if (!infoDialog.open) infoDialog.showModal();
    const close = infoDialog.querySelector('button');
    if (close) close.focus();
}

function openPanel() {
    if (!els) return;
    const drawer = document.getElementById('rm_extensions_block');
    if (drawer && drawer.classList.contains('closedDrawer')) {
        const toggle = document.querySelector('#extensions-settings-button .drawer-icon');
        if (toggle) toggle.click();
    }
    window.setTimeout(() => {
        els.panel.scrollIntoView({ block: 'center' });
        els.panel.focus({ preventScroll: true });
    }, 60);
}

async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
        const headers = ctx && typeof ctx.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const response = await fetch(`${ROUTE}${path}`, {
            method: options.method || 'GET',
            headers,
            signal: controller.signal,
            body: options.body,
        });
        const text = await response.text();
        if (text.length > L.MAX_RESPONSE_BYTES) {
            return { ok: false, status: response.status, json: null, error: { code: 'response_too_large', message: '响应过大' } };
        }
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = null;
            }
        }
        return { ok: response.ok, status: response.status, json, text };
    } catch (error) {
        const timedOut = error && error.name === 'AbortError';
        return {
            ok: false,
            status: 0,
            json: null,
            error: {
                code: timedOut ? 'timeout' : 'network_error',
                message: timedOut ? '请求超时' : '网络请求失败',
            },
        };
    } finally {
        window.clearTimeout(timer);
    }
}

function errorFrom(result, fallback) {
    const nested = result && result.json && result.json.error;
    if (nested && typeof nested === 'object'
        && (typeof nested.code === 'string' || typeof nested.message === 'string')) {
        return {
            code: typeof nested.code === 'string' ? nested.code : 'request_failed',
            message: typeof nested.message === 'string' && nested.message ? nested.message : fallback,
        };
    }
    if (result && result.error) return result.error;
    return { code: 'request_failed', message: fallback };
}

function describeError(result, fallback) {
    const error = errorFrom(result, fallback);
    const http = result && result.status ? `HTTP ${result.status}` : '无响应';
    return `${http} · ${error.code}：${error.message}`;
}

async function refreshStatus() {
    if (!els) return;
    els.statusLine.textContent = '正在读取插件状态…';
    const result = await request('/status');
    if (!result.ok) {
        state.status = null;
        state.statusError = describeError(result, '插件状态不可用');
        renderStatus();
        return;
    }
    if (!result.json) {
        state.status = null;
        state.statusError = '状态响应不是 JSON';
        renderStatus();
        return;
    }
    const parsed = L.parseStatus(result.json);
    if (!parsed.ok) {
        state.status = null;
        state.statusError = `状态响应不符合契约（${parsed.reason}）`;
        renderStatus();
        return;
    }
    state.status = parsed;
    state.statusError = null;
    renderStatus();
}

function renderStatus() {
    if (!els) return;
    if (state.statusError || !state.status) {
        els.statusLine.textContent = `插件状态不可用：${state.statusError || '未知错误'}`;
        els.dot.className = 'ag-dot ag-dot-error';
        for (const face of STATUS_KEYS) {
            els.chips[face].textContent = `${face}：未知`;
            els.chips[face].className = 'ag-chip';
        }
        els.loginNote.textContent = '尚未取得后端状态；登录请求可能直接返回错误。';
        updateQuick();
        return;
    }

    const value = state.status.value;
    els.statusLine.textContent = `${value.connected ? '已连接' : '未连接'} · ${value.code || '无状态码'}：${value.message || '无说明'}`;
    let usable = false;
    for (const face of STATUS_KEYS) {
        const on = value.connected === true && value.protocols[face] === true;
        usable = usable || on;
        els.chips[face].textContent = `${face}：${on ? '已接通' : '未接通'}`;
        els.chips[face].className = `ag-chip ${on ? 'ag-chip-on' : 'ag-chip-off'}`;
    }
    els.dot.className = `ag-dot ${usable ? 'ag-dot-ok' : value.authAvailable ? 'ag-dot-warn' : 'ag-dot-error'}`;

    if (value.authAvailable === true) {
        els.loginNote.textContent = '授权接口声明可用；未验证的成功响应不会被当作已连接。';
    } else {
        els.loginNote.textContent = 'Pass 绑定接口待接通：点击登录会调用 /login 并如实显示服务器错误（当前为 501），不会建立连接。';
    }
    if (state.loginPending) {
        els.loginButton.textContent = '正在登录…';
    } else {
        els.loginButton.textContent = value.authAvailable === true ? '登录 Apercus' : '登录（待接通）';
    }
    els.loginButton.disabled = state.loginPending;
    updateQuick();
}

function updateQuick() {
    if (!els || !els.quick) return;
    const kind = els.dot && els.dot.className.includes('ag-dot-ok')
        ? 'ok'
        : els.dot && els.dot.className.includes('ag-dot-warn')
            ? 'warn'
            : els.dot && els.dot.className.includes('ag-dot-error') ? 'error' : 'unknown';
    const labels = {
        ok: 'Apercus Gateway：已接通',
        warn: 'Apercus Gateway：接口已声明但未连接',
        error: 'Apercus Gateway：不可用',
        unknown: 'Apercus Gateway：状态未知',
    };
    els.quick.className = 'menu_button ag-quick';
    els.quick.setAttribute('aria-label', labels[kind]);
}

async function doLogin() {
    if (!els || state.loginPending) return;
    state.loginPending = true;
    renderStatus();
    const result = await request('/login', { method: 'POST', body: JSON.stringify({}) });
    state.loginPending = false;

    let message;
    if (result.status === 501) {
        message = `登录未接通（501）：${describeError(result, 'Pass 绑定尚未实现')}`;
    } else if (!result.ok) {
        message = `登录失败：${describeError(result, '登录请求失败')}`;
    } else {
        message = '登录返回 200，但当前契约没有定义成功响应；未建立连接，也未修改任何设置。';
    }
    els.loginNote.textContent = message;
    await refreshStatus();
    els.loginNote.textContent = message;
}

async function refreshModels() {
    if (!els || state.modelsPending) return;
    state.modelsPending = true;
    els.modelsButton.disabled = true;
    els.modelsNote.textContent = '正在刷新目录…';
    const result = await request('/models');
    state.modelsPending = false;
    els.modelsButton.disabled = false;

    if (!result.ok) {
        state.catalog = null;
        state.catalogError = describeError(result, '目录请求失败');
        renderModels();
        return;
    }
    if (!result.json) {
        state.catalog = null;
        state.catalogError = '目录响应不是 JSON';
        renderModels();
        return;
    }
    const parsed = L.classifyCatalog(result.json);
    if (!parsed.ok) {
        state.catalog = null;
        state.catalogError = `目录响应不符合契约（${parsed.reason}）`;
        renderModels();
        return;
    }
    state.catalog = parsed;
    state.catalogError = null;
    renderModels();
}

function renderModels() {
    if (!els) return;
    clear(els.modelsList);
    if (state.catalogError) {
        els.modelsNote.textContent = `目录不可用：${state.catalogError}`;
        return;
    }
    if (!state.catalog) {
        els.modelsNote.textContent = '尚未加载目录。';
        return;
    }
    const notes = [`共 ${state.catalog.items.length} 条`];
    if (state.catalog.invalidCount > 0) notes.push(`忽略 ${state.catalog.invalidCount} 条无效条目`);
    if (state.catalog.truncated) notes.push(`仅显示前 ${L.MAX_CATALOG_ITEMS} 条`);
    els.modelsNote.textContent = notes.join(' · ');

    if (state.catalog.items.length === 0) {
        els.modelsList.append(h('p', 'ag-empty', '目录为空。'));
        return;
    }

    for (const item of state.catalog.items) {
        const view = L.rowView(item, state.status);
        const row = h('div', `ag-model ${view.disabled ? 'ag-model-disabled' : ''}`);
        const top = h('div', 'ag-model-top');
        const name = h('span', 'ag-model-name');
        name.textContent = view.name || '（无效条目）';
        name.title = view.name || '';
        top.append(name);
        if (view.face) top.append(h('span', 'ag-badge', view.face));
        if (view.modality) top.append(h('span', 'ag-badge ag-badge-dim', view.modality));
        if (view.classification) top.append(h('span', 'ag-badge ag-badge-dim', view.classification));
        const reason = h('span', `ag-reason ${view.disabled ? '' : 'ag-reason-ok'}`.trim());
        reason.textContent = view.disabled ? reasonText(view.reason) : '可连接';
        row.append(top, reason);
        els.modelsList.append(row);
    }
}

async function refreshBalance() {
    if (!els || state.balancePending) return;
    state.balancePending = true;
    els.balanceButton.disabled = true;
    els.balanceNote.textContent = '正在读取额度…';
    const result = await request('/balance');
    state.balancePending = false;
    els.balanceButton.disabled = false;

    if (!result.ok) {
        state.balance = null;
        state.balanceError = describeError(result, '额度请求失败');
        renderBalance();
        return;
    }
    if (!result.json) {
        state.balance = null;
        state.balanceError = '额度响应不是 JSON';
        renderBalance();
        return;
    }
    const parsed = L.parseBalance(result.json);
    if (!parsed.ok) {
        state.balance = null;
        state.balanceError = `额度响应不符合契约（${parsed.reason}）`;
        renderBalance();
        return;
    }
    state.balance = parsed.value;
    state.balanceError = null;
    renderBalance();
}

function renderBalance() {
    if (!els) return;
    clear(els.balanceList);
    if (state.balanceError) {
        els.balanceNote.textContent = `额度不可用：${state.balanceError}`;
        els.balanceNote.className = 'ag-note ag-warn';
        return;
    }
    if (!state.balance) {
        els.balanceNote.textContent = '尚未加载额度。';
        els.balanceNote.className = 'ag-note';
        return;
    }
    const view = L.balanceRows(state.balance);
    for (const row of view.rows) {
        const line = h('div', 'ag-balance-row');
        line.append(h('span', 'ag-balance-label', row.label), h('span', 'ag-balance-value', row.value));
        els.balanceList.append(line);
    }
    const meta = [];
    if (view.quotaDate === null) meta.push('账日：未设置');
    else meta.push(`账日：${view.quotaDate}`);
    meta.push(`观察时点：${view.observedAt}`);
    if (view.warning) {
        els.balanceNote.textContent = `${view.warning} ${meta.join(' · ')}`;
        els.balanceNote.className = 'ag-note ag-warn';
    } else {
        els.balanceNote.textContent = meta.join(' · ');
        els.balanceNote.className = 'ag-note';
    }
}

function init() {
    ctx = getContext();
    if (!ctx) return;
    attach();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
