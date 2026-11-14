'use strict';

// Apercus SillyTavern 服务端插件入口（CommonJS）。
//
// 已核实的 ST 生命周期（F:/SillyTavern/src/plugin-loader.js）：
//   - 目录插件读取 package.json.main，或 index.js/index.cjs/index.mjs；
//   - 模块须导出 info{id,name,description} 与 init(router)；
//   - init 收到的 router 最终挂载在 /api/plugins/<id>；
//   - 可选 exit()，本插件不需要。
// server-main.js 在认证中间件与 CSRF 之后、启动监听之前调用 loadPlugins；
// server.js:11 先 process.chdir(serverDirectory)，故 process.cwd() 即 ST 根。
//
// 未交付边界（未来 key 安装）：本插件不写入任何 secret、不提供凭据交付/安装入口，
// 不读取共享 key、不接触 Passtoken，也不把 ST 外部 secret 当作用户网关 key。
// 专用命名空间 'apercus_gateway_binding' 故意不加入 SECRET_KEYS 的公共提供商组。
// 未来网关 Pass 授权/交付契约落地后，唯一允许的演进是把 readGatewayBinding 换成
// 经 ST secrets 模块按 req.user.directories 读取该命名空间的已验签绑定记录；
// 在此之前生产 reader 恒返回 null，任何名称存在都不代表已授权。登录状态与
// /login 保持不可用，UI 不得把 status.authAvailable=false 解读为登录完成。

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createCore, BINDING_SECRET_KEY } = require('./core');

const info = Object.freeze({
    id: 'apercus-gateway',
    name: 'Apercus Gateway',
    description: 'Apercus 网关账户绑定与只读目录/余额查询（登录与凭据交付未交付）',
});

// 定位并校验既有 ST secrets 模块。失败即抛错，由 loader 记录并拒绝挂载路由。
async function loadStSecretsModule() {
    const stRoot = process.cwd();
    const packageFile = path.join(stRoot, 'package.json');
    const secretsFile = path.join(stRoot, 'src', 'endpoints', 'secrets.js');

    if (!fs.existsSync(packageFile) || !fs.existsSync(secretsFile)) {
        throw new Error('Apercus 插件：未能在 loader cwd 定位 SillyTavern 根目录');
    }

    const secrets = await import(pathToFileURL(secretsFile).href);
    if (typeof secrets.readSecret !== 'function') {
        throw new Error('Apercus 插件：ST secrets 模块缺少 readSecret');
    }
    if (!secrets.SECRET_KEYS || typeof secrets.SECRET_KEYS !== 'object') {
        throw new Error('Apercus 插件：ST secrets 模块缺少 SECRET_KEYS');
    }
    if (Object.values(secrets.SECRET_KEYS).includes(BINDING_SECRET_KEY)) {
        throw new Error('Apercus 插件：专用绑定命名空间不得并入公共提供商组');
    }
    return true;
}

// 当前生产绑定 reader：恒返回 null（网关授权/交付契约缺失）。
// 每请求只接收 ST 注入的 req.user.directories，绝不回落到默认用户。
async function readGatewayBinding(_directories) {
    return null;
}

async function init(router) {
    await loadStSecretsModule();

    const core = createCore({
        readBinding: readGatewayBinding,
    });
    core.registerRoutes(router);
}

module.exports = { info, init };
