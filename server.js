'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const ProxyManager = require('./src/core/proxy-manager');
const totp = require('./src/utils/totp');
const { generateQrSvg } = require('./src/utils/qrcode');

const ROOT = __dirname;

/**
 * 确保 .env 配置文件存在，若不存在则基于模板自动初始化一份开箱即用的默认配置
 * @param {string} envFile - .env 目标路径
 * @param {string} exampleFile - 模板路径
 */
function ensureEnvFile(envFile, exampleFile) {
    if (!fs.existsSync(envFile) && fs.existsSync(exampleFile)) {
        try {
            let template = fs.readFileSync(exampleFile, 'utf8');
            template = template
                .replace(/ADMIN_PASSWORD=change-this-admin-password/, 'ADMIN_PASSWORD=admin888')
                .replace(/PROXY_PASSWORD=change-this-proxy-password/, 'PROXY_PASSWORD=123456');
            fs.writeFileSync(envFile, template, 'utf8');
            console.log('[proxy] 首次运行检测到未配置 .env，已自动为您生成默认配置文件 (.env)');
        } catch (error) {
            // 忽略创建失败，继续向下加载
        }
    }
}

function loadEnvFile(file) {
    try {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const text = line.trim();
            const separator = text.indexOf('=');
            if (!text || text.startsWith('#') || separator <= 0) continue;
            const name = text.slice(0, separator).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || process.env[name] != null) continue;
            let value = text.slice(separator + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            process.env[name] = value;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
ensureEnvFile(ENV_PATH, ENV_EXAMPLE_PATH);
loadEnvFile(ENV_PATH);

const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.resolve(process.env.PROXY_DATA_FILE || path.join(DATA_DIR, 'proxies.json'));
const WEB_DIR = path.join(ROOT, 'web');
const RUNTIME_DIR = path.resolve(process.env.PROXY_RUNTIME_DIR || path.join(ROOT, 'runtime'));
const BASE_PORT = Number(process.env.PROXY_START_PORT || 40000);
const configuredLastPort = Number(process.env.PROXY_PUBLISHED_LAST_PORT || BASE_PORT + 100);
const LAST_PUBLISHED_PORT = Number.isInteger(configuredLastPort) && configuredLastPort >= BASE_PORT
    ? configuredLastPort
    : BASE_PORT + 100;
const ADMIN_USER = String(process.env.ADMIN_USER || 'admin');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'admin888');
const SESSION_COOKIE = 'proxy_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const RECOVERY_FAILURES = Math.max(1, Math.floor(Number(process.env.PROXY_RECOVERY_FAILURES) || 3));
const RECOVERY_MAX_DELAY_MS = Math.max(30000, Number(process.env.PROXY_RECOVERY_MAX_DELAY_MS) || 300000);
const INTERNAL_PROXY_HOST = 'proxy-socks5';
const sessions = new Map();
const loginAttempts = new Map();
let store = loadStore();
let proxyUser = String(store.settings?.proxyUsername || process.env.PROXY_USERNAME || '');
let proxyPassword = String(store.settings?.proxyPassword || process.env.PROXY_PASSWORD || '');
const manager = new ProxyManager({
    runtimeDir: RUNTIME_DIR,
    listenAddress: process.env.PROXY_LISTEN_ADDRESS || '0.0.0.0',
    startPort: BASE_PORT,
    proxyUsername: proxyUser,
    proxyPassword
});

let shuttingDown = false;
let operationQueue = Promise.resolve();
let restartTimer = null;
let coreRestartAttempt = 0;
let allOfflineChecks = 0;
let recoveryAttempt = 0;
let recoveryNotBefore = 0;
let healthCheckPromise = null;
let healthCheckStartedAt = '';
let lastHealthCheckError = '';
let lastHealthTickAt = Date.now();

function wasSystemResumed(previousTickAt, currentTickAt, intervalMs) {
    return currentTickAt - previousTickAt > intervalMs + 5000;
}

function loadStore() {
    try {
        const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return {
            version: 1,
            settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
            proxies: Array.isArray(value.proxies) ? value.proxies : []
        };
    } catch (error) {
        return { version: 1, settings: {}, proxies: [] };
    }
}

function saveStore() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const temp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(temp, DATA_FILE);
}

function subscriptionToken() {
    const token = String(store.settings?.subscriptionToken || '');
    if (/^[a-f0-9]{64}$/.test(token)) return token;
    const generated = crypto.randomBytes(32).toString('hex');
    store.settings = { ...store.settings, subscriptionToken: generated };
    saveStore();
    return generated;
}

function subscriptionUrls() {
    const token = subscriptionToken();
    const port = Number(process.env.WEB_PORT || 3100);
    return {
        http: `http://${INTERNAL_PROXY_HOST}:${port}/subscription/http/${token}`,
        socks5: `http://${INTERNAL_PROXY_HOST}:${port}/subscription/socks5/${token}`
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function exclusive(task) {
    const result = operationQueue.then(task);
    operationQueue = result.catch(() => {});
    return result;
}

function authMatches(value, expected) {
    const left = Buffer.from(String(value));
    const right = Buffer.from(String(expected));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function basicAuthorized(request) {
    const header = String(request.headers.authorization || '');
    if (!header.startsWith('Basic ')) {
        return false;
    }
    let decoded;
    try {
        decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch (error) {
        return false;
    }
    const separator = decoded.indexOf(':');
    return separator >= 0
        && authMatches(decoded.slice(0, separator), ADMIN_USER)
        && authMatches(decoded.slice(separator + 1), ADMIN_PASSWORD);
}

function cookieValue(request, name) {
    const prefix = `${name}=`;
    const entry = String(request.headers.cookie || '')
        .split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : '';
}

function sessionAuthorized(request) {
    const token = cookieValue(request, SESSION_COOKIE);
    const expiresAt = sessions.get(token);
    if (!expiresAt) {
        return false;
    }
    if (expiresAt <= Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

/**
 * 判断当前是否处于免密模式
 * Windows 平台默认免密直接进入控制台，亦可通过 DISABLE_AUTH=true 或 REQUIRE_AUTH=true 显式控制
 * @returns {boolean}
 */
function isAuthDisabled() {
    if (process.env.REQUIRE_AUTH === 'true') return false;
    if (process.env.DISABLE_AUTH === 'true') return true;
    return process.platform === 'win32';
}

function authorized(request, url) {
    if (isAuthDisabled()) {
        return true;
    }
    return sessionAuthorized(request)
        || (url.pathname.startsWith('/api/') && basicAuthorized(request));
}

function sessionCookie(request, token, maxAge) {
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = request.socket.encrypted || forwardedProto === 'https';
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function loginKey(request) {
    return String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown');
}

function loginAllowed(request) {
    const attempt = loginAttempts.get(loginKey(request));
    if (!attempt || Date.now() - attempt.startedAt >= LOGIN_WINDOW_MS) {
        return true;
    }
    return attempt.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(request) {
    const key = loginKey(request);
    const now = Date.now();
    const attempt = loginAttempts.get(key);
    loginAttempts.set(key, !attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS
        ? { count: 1, startedAt: now }
        : { ...attempt, count: attempt.count + 1 });
}

function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(payload)
    });
    response.end(payload);
}

function sendError(response, status, message) {
    sendJson(response, status, { error: String(message || 'request failed') });
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > 128 * 1024) {
                reject(new Error('request body too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        request.on('error', reject);
    });
}

async function parseBody(request) {
    try {
        return JSON.parse(await readBody(request) || '{}');
    } catch (error) {
        throw new Error('invalid JSON body');
    }
}

async function parseForm(request) {
    return new URLSearchParams(await readBody(request));
}

function publicProxy(item) {
    const parsed = manager.parseProxyLink(item.link, 0);
    return {
        id: item.id,
        name: item.name || parsed?.displayName || item.id,
        protocol: parsed?.type || 'unknown',
        server: parsed?.server || '',
        upstreamPort: parsed?.server_port || 0,
        link: item.link,
        listenPort: item.listenPort,
        enabled: Boolean(item.enabled),
        status: item.enabled ? (item.status || 'unknown') : 'disabled',
        latencyMs: item.latencyMs || 0,
        exitIp: item.exitIp || '',
        location: item.location || '',
        lastCheckedAt: item.lastCheckedAt || '',
        lastError: item.lastError || ''
    };
}

function publicSettings() {
    return {
        adminUser: ADMIN_USER || 'admin',
        proxyUsername: proxyUser,
        proxyPassword,
        publicHost: String(store.settings?.publicHost || process.env.PUBLIC_HOST || ''),
        subscriptions: subscriptionUrls(),
        totpEnabled: Boolean(store.settings?.totpEnabled),
        totpConfigured: Boolean(store.settings?.totpSecret),
        authDisabled: isAuthDisabled()
    };
}

function buildSubscription(items, scheme, options = {}) {
    const user = encodeURIComponent(options.username ?? proxyUser);
    const password = encodeURIComponent(options.password ?? proxyPassword);
    const host = options.host ?? INTERNAL_PROXY_HOST;
    return items
        .filter((item) => item.enabled)
        .map((item) => `${scheme}://${user}:${password}@${host}:${item.listenPort}`)
        .join('\n');
}

function subscriptionRequest(url) {
    const match = url.pathname.match(/^\/subscription\/(http|socks5)\/([a-f0-9]{64})$/);
    return match ? { scheme: match[1], token: match[2] } : null;
}

function serveSubscription(response, scheme) {
    const payload = buildSubscription(store.proxies, scheme);
    response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(payload),
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(payload);
}

function applyResult(item, result) {
    item.status = result.success ? 'online' : 'offline';
    item.latencyMs = result.success ? Number(result.latencyMs || 0) : 0;
    if (result.nodeInfo?.ip) {
        item.exitIp = result.nodeInfo.ip;
        item.location = [result.nodeInfo.country, result.nodeInfo.region, result.nodeInfo.city]
            .filter(Boolean)
            .join(' / ');
    }
    item.lastCheckedAt = new Date().toISOString();
    item.lastError = result.success ? '' : String(result.reason || 'health check failed');
}

function applyResults(results) {
    const byPort = new Map(results.map((result) => [Number(result.port), result]));
    for (const item of store.proxies) {
        if (!item.enabled) {
            item.status = 'disabled';
            continue;
        }
        const result = byPort.get(Number(item.listenPort));
        if (result) {
            applyResult(item, result);
        } else {
            item.status = 'offline';
            item.lastError = 'proxy process did not expose this port';
        }
    }
}

function applyNodeInfo(results) {
    let changed = false;
    for (const result of results || []) {
        if (!result?.success || !result.nodeInfo?.ip) continue;
        const item = store.proxies.find((candidate) => candidate.enabled && Number(candidate.listenPort) === Number(result.port));
        if (!item) continue;
        item.exitIp = result.nodeInfo.ip;
        item.location = [result.nodeInfo.country, result.nodeInfo.region, result.nodeInfo.city]
            .filter(Boolean)
            .join(' / ');
        changed = true;
    }
    if (changed) saveStore();
}

function refreshNodeInfo() {
    manager.refreshNodeInfoInBackground()
        .then((results) => exclusive(() => applyNodeInfo(results)))
        .catch((error) => console.error(`[proxy] exit IP refresh failed: ${error.message}`));
}

function scheduleCoreRestart(reason) {
    if (shuttingDown || !store.proxies.some((item) => item.enabled)) {
        return;
    }
    clearTimeout(restartTimer);
    const delay = Math.min(RECOVERY_MAX_DELAY_MS, 2000 * (2 ** Math.min(coreRestartAttempt, 8)));
    coreRestartAttempt += 1;
    console.error(`[proxy] core recovery in ${delay}ms: ${reason}`);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        exclusive(rebuild)
            .then(() => { coreRestartAttempt = 0; })
            .catch((error) => scheduleCoreRestart(error.message));
    }, delay);
    restartTimer.unref?.();
}

function watchCore(core) {
    if (!core) {
        return;
    }
    core.once('exit', () => {
        if (shuttingDown || manager.process !== core) {
            return;
        }
        manager.process = null;
        scheduleCoreRestart('sing-box exited');
    });
}

/**
 * 重启代理核心并应用最新配置
 * @param {object} [options={}] - 重载配置选项
 * @param {boolean} [options.skipTest=true] - 默认跳过耗时的同步全量测试，实现毫秒级快速响应
 */
async function rebuild(options = {}) {
    const skipTest = options.skipTest !== false;
    const active = store.proxies.filter((item) => item.enabled);
    manager.stop({ silent: true });
    if (active.length === 0) {
        for (const item of store.proxies) {
            item.status = 'disabled';
        }
        saveStore();
        return;
    }
    await manager.start({
        proxies: active,
        filterInvalid: false,
        requireValid: false,
        eagerNodeInfo: false,
        detachProcess: false,
        skipTest
    });
    if (!manager.process || manager.process.exitCode !== null) {
        throw new Error('sing-box exited during startup; check the proxy port and runtime log');
    }
    if (!skipTest) {
        applyResults(manager.lastResults || []);
        saveStore();
        refreshNodeInfo();
    }
    watchCore(manager.process);
    coreRestartAttempt = 0;
}

async function checkHealth() {
    const results = await manager.testAll({ eagerNodeInfo: false });
    applyResults(results);
    saveStore();
    refreshNodeInfo();

    const active = store.proxies.filter((item) => item.enabled);
    const allOffline = active.length > 0
        && results.length === active.length
        && results.every((result) => !result.success);
    if (!allOffline) {
        allOfflineChecks = 0;
        recoveryAttempt = 0;
        recoveryNotBefore = 0;
        return;
    }

    allOfflineChecks += 1;
    if (allOfflineChecks < RECOVERY_FAILURES || Date.now() < recoveryNotBefore) {
        return;
    }

    const delay = Math.min(RECOVERY_MAX_DELAY_MS, 2000 * (2 ** Math.min(recoveryAttempt, 8)));
    recoveryAttempt += 1;
    recoveryNotBefore = Date.now() + delay;
    console.error(`[proxy] all ${active.length} enabled nodes are offline; rebuilding core (next retry in ${delay}ms)`);
    try {
        await rebuild();
    } catch (error) {
        scheduleCoreRestart(error.message);
        throw error;
    }
}

function startHealthCheck() {
    if (!manager.process || manager.process.exitCode !== null) {
        return null;
    }
    if (healthCheckPromise) {
        return healthCheckPromise;
    }
    healthCheckStartedAt = new Date().toISOString();
    lastHealthCheckError = '';
    healthCheckPromise = exclusive(checkHealth)
        .catch((error) => {
            lastHealthCheckError = error.message;
            console.error(`[proxy] health check failed: ${error.message}`);
        })
        .finally(() => {
            healthCheckPromise = null;
        });
    return healthCheckPromise;
}

/**
 * 安全事务性修改 store 数据并热重载核心
 * @param {Function} mutator - store 变更回调函数
 * @param {object} [options={}] - 重载配置选项（默认 skipTest: true）
 */
async function commit(mutator, options = {}) {
    const previous = clone(store);
    mutator(store);
    saveStore();
    try {
        await rebuild(options);
    } catch (error) {
        store = previous;
        saveStore();
        await rebuild(options).catch(() => {});
        throw error;
    }
}

async function updateSettings(settings) {
    const previousStore = clone(store);
    const previousUser = proxyUser;
    const previousPassword = proxyPassword;
    const username = String(settings.proxyUsername || '').trim();
    const password = String(settings.proxyPassword || '');
    const publicHost = String(settings.publicHost || '').trim();
    if (!username || !password) {
        throw new Error('proxy username and password are required');
    }
    store.settings = { ...store.settings, proxyUsername: username, proxyPassword: password, publicHost };
    proxyUser = username;
    proxyPassword = password;
    manager.moduleConfig.proxyUsername = username;
    manager.moduleConfig.proxyPassword = password;
    saveStore();
    try {
        await rebuild();
    } catch (error) {
        store = previousStore;
        proxyUser = previousUser;
        proxyPassword = previousPassword;
        manager.moduleConfig.proxyUsername = previousUser;
        manager.moduleConfig.proxyPassword = previousPassword;
        saveStore();
        await rebuild().catch(() => {});
        throw error;
    }
}

function validateLink(link) {
    const value = normalizeProxyLink(link);
    const parsed = manager.parseProxyLink(value, 0);
    if (!parsed || !parsed.server || !Number.isInteger(parsed.server_port) || parsed.server_port <= 0) {
        throw new Error('unsupported or invalid proxy link');
    }
    return { value, parsed };
}

function normalizeProxyLink(link) {
    return String(link || '').trim().replace(/\\([:@])/g, '$1');
}

function firstAvailablePort(items, firstPort, lastPort) {
    const used = new Set(items.map((item) => Number(item.listenPort)));
    for (let port = firstPort; port <= lastPort; port += 1) {
        if (!used.has(port)) {
            return port;
        }
    }
    throw new Error('no available published proxy ports');
}

function allocatePort() {
    return firstAvailablePort(store.proxies, BASE_PORT, LAST_PUBLISHED_PORT);
}

function newProxyItem(value, parsed, name, listenPort) {
    return {
        id: newId(),
        name: String(name || parsed.displayName || '').trim().slice(0, 100),
        link: value,
        enabled: true,
        listenPort,
        status: 'testing',
        latencyMs: 0,
        exitIp: '',
        location: '',
        lastCheckedAt: '',
        lastError: ''
    };
}

function findProxy(id) {
    return store.proxies.find((item) => item.id === id);
}

function newId() {
    return crypto.randomBytes(12).toString('hex');
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

async function testDisabled(item) {
    const port = await getFreePort();
    const temp = new ProxyManager({
        runtimeDir: RUNTIME_DIR,
        configPath: path.join(RUNTIME_DIR, `test-${item.id}.json`),
        stateFilePath: path.join(RUNTIME_DIR, `test-${item.id}.state.json`),
        lockFilePath: path.join(RUNTIME_DIR, `test-${item.id}.lock`),
        listenAddress: '127.0.0.1',
        proxyUsername: '',
        proxyPassword: '',
        startPort: port
    });
    try {
        await temp.start({ proxies: [{ ...item, listenPort: port }], filterInvalid: false, requireValid: false });
        return await temp.testPort(port, { eagerNodeInfo: true });
    } finally {
        temp.stop({ silent: true });
        for (const file of [temp.configPath, temp.stateFilePath]) {
            try { fs.unlinkSync(file); } catch (error) { /* ignore */ }
        }
    }
}

async function testProxy(item) {
    if (item.enabled && manager.process && manager.process.exitCode === null) {
        return manager.testPort(item.listenPort, { eagerNodeInfo: true });
    }
    return testDisabled(item);
}

/**
 * 在后台异步触发对特定节点的连通性测速，绝不阻塞用户操作
 * 检测完毕后自动更新节点状态并落盘，前端通过智能轮询无缝平滑刷新
 * @param {Array<object>} targetItems - 目标节点集合
 */
function triggerAsyncNodeCheck(targetItems) {
    if (!Array.isArray(targetItems) || !targetItems.length) return;
    const activeTargets = targetItems.filter((it) => it && it.enabled);
    if (!activeTargets.length) return;

    // 延迟 400ms 等待 sing-box 进程完成端口绑定与就绪
    setTimeout(async () => {
        for (const item of activeTargets) {
            try {
                const currentItem = findProxy(item.id);
                if (!currentItem || !currentItem.enabled) continue;
                const result = await testProxy(currentItem);
                applyResult(currentItem, result);
            } catch (err) {
                const currentItem = findProxy(item.id);
                if (currentItem) {
                    currentItem.status = 'offline';
                    currentItem.lastError = err.message || 'connection failed';
                }
            }
        }
        saveStore();
        refreshNodeInfo();
    }, 400);
}

async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/settings') {
        return sendJson(response, 200, publicSettings());
    }
    if (request.method === 'PUT' && url.pathname === '/api/settings') {
        const body = await parseBody(request);
        await exclusive(async () => {
            await updateSettings(body);
            sendJson(response, 200, publicSettings());
        });
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/totp/setup') {
        const secret = store.settings?.totpSecret || totp.generateSecret();
        const otpauthUrl = totp.buildOtpauthUrl('ProxyPoolHub', ADMIN_USER || 'admin', secret);
        const qrSvg = generateQrSvg(otpauthUrl);
        return sendJson(response, 200, {
            secret,
            account: ADMIN_USER || 'admin',
            issuer: 'ProxyPoolHub',
            otpauthUrl,
            qrSvg,
            enabled: Boolean(store.settings?.totpEnabled)
        });
    }
    if (request.method === 'POST' && url.pathname === '/api/totp/verify-bind') {
        const body = await parseBody(request);
        const code = String(body.code || '').trim();
        const secret = String(body.secret || '').trim();
        if (!code || !secret) {
            return sendError(response, 400, '缺少动态验证码或密钥');
        }
        if (!totp.verifyTotp(code, secret)) {
            return sendError(response, 400, '动态验证码无效，请确保手机时间同步后重试');
        }
        store.settings = { ...store.settings, totpSecret: secret, totpEnabled: true };
        saveStore();
        return sendJson(response, 200, { ok: true, message: 'Google 身份验证器已成功绑定并启用' });
    }
    if (request.method === 'POST' && url.pathname === '/api/totp/disable') {
        store.settings = { ...store.settings, totpEnabled: false };
        saveStore();
        return sendJson(response, 200, { ok: true, message: 'Google 身份验证器已停用' });
    }
    if (request.method === 'POST' && url.pathname === '/api/subscriptions/rotate') {
        return exclusive(() => {
            store.settings = { ...store.settings, subscriptionToken: crypto.randomBytes(32).toString('hex') };
            saveStore();
            sendJson(response, 200, publicSettings());
        });
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
        const online = store.proxies.filter((item) => item.enabled && item.status === 'online').length;
        return sendJson(response, 200, {
            service: 'running',
            core: manager.process && manager.process.exitCode === null ? 'running' : 'stopped',
            pid: manager.process?.pid || null,
            total: store.proxies.length,
            enabled: store.proxies.filter((item) => item.enabled).length,
            online,
            healthCheck: {
                running: Boolean(healthCheckPromise),
                startedAt: healthCheckStartedAt,
                lastError: lastHealthCheckError
            },
            dataFile: DATA_FILE
        });
    }
    if (request.method === 'GET' && url.pathname === '/api/proxies') {
        return sendJson(response, 200, store.proxies.map(publicProxy));
    }

    const testAll = request.method === 'POST' && url.pathname === '/api/proxies/test-all';
    if (testAll) {
        const alreadyRunning = Boolean(healthCheckPromise);
        if (!startHealthCheck()) {
            return sendError(response, 409, 'proxy core is not running');
        }
        return sendJson(response, 202, { running: true, alreadyRunning });
    }

    if (request.method === 'POST' && url.pathname === '/api/proxies/import') {
        const body = await parseBody(request);
        await exclusive(async () => {
            const imported = [];
            const invalid = [];
            let skipped = 0;
            const knownLinks = new Set(store.proxies.map((item) => item.link));
            const lines = String(typeof body.links === 'string' ? body.links : '').split(/\r?\n/);

            lines.forEach((line, index) => {
                const link = normalizeProxyLink(line);
                if (!link || link.startsWith('#')) return;
                if (knownLinks.has(link)) {
                    skipped += 1;
                    return;
                }
                try {
                    const { value, parsed } = validateLink(link);
                    const listenPort = firstAvailablePort(
                        store.proxies.concat(imported), BASE_PORT, LAST_PUBLISHED_PORT
                    );
                    imported.push(newProxyItem(value, parsed, '', listenPort));
                    knownLinks.add(value);
                } catch (error) {
                    invalid.push({ line: index + 1, error: error.message });
                }
            });

            if (imported.length) {
                await commit((current) => current.proxies.push(...imported));
                triggerAsyncNodeCheck(imported);
            }
            sendJson(response, imported.length ? 201 : 200, {
                added: imported.length,
                skipped,
                invalid
            });
        });
        return;
    }
    // 批量删除选中的多个代理节点（单事务轻量重载）
    if (request.method === 'POST' && url.pathname === '/api/proxies/batch-delete') {
        const body = await parseBody(request);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ids.length) {
            return sendError(response, 400, '请选择需要删除的节点');
        }
        const idSet = new Set(ids);
        let deletedCount = 0;
        await exclusive(async () => {
            await commit((current) => {
                const initialLength = current.proxies.length;
                current.proxies = current.proxies.filter((candidate) => !idSet.has(candidate.id));
                deletedCount = initialLength - current.proxies.length;
            });
            sendJson(response, 200, { ok: true, deleted: deletedCount });
        });
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/proxies') {
        const body = await parseBody(request);
        let createdItem = null;
        await exclusive(async () => {
            const { value, parsed } = validateLink(body.link);
            if (store.proxies.some((item) => item.link === value)) {
                throw new Error('proxy link already exists');
            }
            createdItem = newProxyItem(value, parsed, body.name, allocatePort());
            await commit((current) => current.proxies.push(createdItem));
            sendJson(response, 201, publicProxy(createdItem));
        });
        if (createdItem) {
            triggerAsyncNodeCheck([createdItem]);
        }
        return;
    }

    const match = url.pathname.match(/^\/api\/proxies\/([^/]+)(?:\/(test|enable|disable))?$/);
    if (!match) {
        return sendError(response, 404, 'not found');
    }
    const item = findProxy(decodeURIComponent(match[1]));
    if (!item) {
        return sendError(response, 404, 'proxy not found');
    }
    const action = match[2];
    if (request.method === 'PUT' && !action) {
        const body = await parseBody(request);
        const { value, parsed } = validateLink(body.link);
        const name = String(body.name || parsed.displayName || '').trim().slice(0, 100);
        if (store.proxies.some((candidate) => candidate.id !== item.id && candidate.link === value)) {
            throw new Error('proxy link already exists');
        }
        if (item.link === value) {
            return exclusive(() => {
                findProxy(item.id).name = name;
                saveStore();
                sendJson(response, 200, publicProxy(findProxy(item.id)));
            });
        }
        await exclusive(async () => {
            await commit((current) => {
                const candidate = current.proxies.find((entry) => entry.id === item.id);
                candidate.link = value;
                candidate.name = name;
                candidate.status = candidate.enabled ? 'testing' : 'disabled';
                candidate.latencyMs = 0;
                candidate.exitIp = '';
                candidate.location = '';
                candidate.lastCheckedAt = '';
                candidate.lastError = '';
            });
            sendJson(response, 200, publicProxy(findProxy(item.id)));
        });
        return;
    }
    if (request.method === 'DELETE' && !action) {
        await exclusive(async () => {
            await commit((current) => {
                current.proxies = current.proxies.filter((candidate) => candidate.id !== item.id);
            });
            sendJson(response, 200, { ok: true });
        });
        return;
    }
    if (request.method === 'POST' && action === 'test') {
        await exclusive(async () => {
            const result = await testProxy(item);
            applyResult(item, result);
            saveStore();
            sendJson(response, 200, publicProxy(item));
        });
        return;
    }
    if (request.method === 'POST' && (action === 'enable' || action === 'disable')) {
        await exclusive(async () => {
            await commit((current) => {
                const candidate = current.proxies.find((entry) => entry.id === item.id);
                candidate.enabled = action === 'enable';
                candidate.status = candidate.enabled ? 'testing' : 'disabled';
            });
            sendJson(response, 200, publicProxy(item));
        });
        if (action === 'enable') {
            triggerAsyncNodeCheck([findProxy(item.id)]);
        }
        return;
    }
    sendError(response, 405, 'method not allowed');
}

function serveStatic(request, response, url) {
    const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
    const name = files[url.pathname];
    if (!name) {
        return sendError(response, 404, 'not found');
    }
    const file = path.join(WEB_DIR, name);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    response.writeHead(200, {
        'Content-Type': types[path.extname(file)],
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
    });
    response.end(fs.readFileSync(file));
}

function serveLogin(response, status = 200, error = '') {
    const template = fs.readFileSync(path.join(WEB_DIR, 'login.html'), 'utf8');
    const message = String(error).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
    const isTotpConfigured = Boolean(store.settings?.totpSecret && store.settings?.totpEnabled);
    const body = template
        .replace('{{ERROR_STYLE}}', message ? '' : 'display: none;')
        .replace('{{ERROR}}', message)
        .replace('{{TOTP_CONFIGURED}}', isTotpConfigured ? 'true' : 'false')
        .replace('{{DEFAULT_USER}}', ADMIN_USER || 'admin');
    response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
    });
    response.end(body);
}

function redirect(response, location, headers = {}) {
    response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
    response.end();
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
        const subscription = request.method === 'GET' && subscriptionRequest(url);
        if (subscription) {
            if (!authMatches(subscription.token, subscriptionToken())) {
                return sendError(response, 404, 'not found');
            }
            return serveSubscription(response, subscription.scheme);
        }
        if (request.method === 'GET' && url.pathname === '/login') {
            if (isAuthDisabled()) {
                return redirect(response, '/');
            }
            return sessionAuthorized(request) ? redirect(response, '/') : serveLogin(response);
        }
        if (request.method === 'GET' && url.pathname === '/style.css') {
            return serveStatic(request, response, url);
        }
        if (request.method === 'POST' && url.pathname === '/login') {
            if (!loginAllowed(request)) {
                return serveLogin(response, 429, '登录失败次数过多，请 10 分钟后再试。');
            }
            const form = await parseForm(request);
            const username = String(form.get('username') || '').trim();
            const password = String(form.get('password') || '');
            const totpCode = String(form.get('totpCode') || '').trim();
            const remember = form.get('remember') === 'on' || form.get('remember') === 'true';

            let valid = false;

            // 模式 1: 使用 Google 身份验证器 6 位动态验证码登录（解决记不住复杂长密码痛点）
            if (totpCode && /^\d{6}$/.test(totpCode)) {
                if (authMatches(username, ADMIN_USER) && store.settings?.totpSecret) {
                    valid = totp.verifyTotp(totpCode, store.settings.totpSecret);
                }
            }
            // 模式 2: 使用管理员原始密码登录
            else if (password) {
                valid = authMatches(username, ADMIN_USER)
                    && authMatches(password, ADMIN_PASSWORD);
            }

            if (!valid) {
                recordLoginFailure(request);
                const tip = totpCode ? '管理账号或 6 位动态验证码无效。' : '管理账号或密码错误。';
                return serveLogin(response, 401, tip);
            }
            loginAttempts.delete(loginKey(request));
            const token = crypto.randomBytes(32).toString('hex');
            // 勾选记住登录则保持 7 天 Session，否则为默认 12 小时
            const ttl = remember ? 7 * 24 * 60 * 60 * 1000 : SESSION_TTL_MS;
            sessions.set(token, Date.now() + ttl);
            return redirect(response, '/', {
                'Set-Cookie': sessionCookie(request, token, Math.floor(ttl / 1000))
            });
        }
        if (!authorized(request, url)) {
            return url.pathname.startsWith('/api/')
                ? sendError(response, 401, 'login required')
                : redirect(response, '/login');
        }
        if (request.method === 'POST' && url.pathname === '/logout') {
            sessions.delete(cookieValue(request, SESSION_COOKIE));
            return redirect(response, '/login', {
                'Set-Cookie': sessionCookie(request, '', 0)
            });
        }
        if (url.pathname.startsWith('/api/')) {
            await handleApi(request, response, url);
        } else if (request.method === 'GET') {
            serveStatic(request, response, url);
        } else {
            sendError(response, 405, 'method not allowed');
        }
    } catch (error) {
        const status = /already exists|invalid|unsupported|too large|no available|required/.test(error.message) ? 400 : 500;
        sendError(response, status, error.message);
    }
});

async function main() {
    if (!ADMIN_USER || !ADMIN_PASSWORD || !proxyUser || !proxyPassword) {
        throw new Error('ADMIN_USER, ADMIN_PASSWORD, PROXY_USERNAME and PROXY_PASSWORD are required');
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await exclusive(rebuild).catch((error) => {
        for (const item of store.proxies) {
            if (item.enabled) {
                item.status = 'offline';
                item.lastError = error.message;
            }
        }
        saveStore();
        console.error(`[proxy] initial start failed: ${error.message}`);
        scheduleCoreRestart(error.message);
    });
    const port = Number(process.env.WEB_PORT || 3100);
    const host = process.env.WEB_HOST || '127.0.0.1';
    server.listen(port, host, () => {
        console.log(`[proxy] Web 管理控制台已启动: http://${host}:${port}`);
        if (isAuthDisabled()) {
            console.log('[proxy] Windows 免密模式已生效：直接在浏览器访问即可，无需输入密码');
        } else {
            console.log(`[proxy] 管理账号: ${ADMIN_USER} | 管理密码: ${ADMIN_PASSWORD}`);
        }
    });
    const interval = Math.max(10000, Number(process.env.PROXY_HEALTH_INTERVAL_MS || 60000));
    const timer = setInterval(() => {
        const now = Date.now();
        if (wasSystemResumed(lastHealthTickAt, now, interval)) {
            console.log('[proxy] system resume detected; rebuilding proxy core');
            scheduleCoreRestart('system resume detected');
        }
        lastHealthTickAt = now;
        startHealthCheck();
    }, interval);
    timer.unref();
}

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(restartTimer);
    manager.stop({ silent: true });
    server.close(() => process.exit(0));
}

if (require.main === module) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    main().catch((error) => {
        console.error(`[proxy] ${error.message}`);
        process.exit(1);
    });
}

module.exports = { buildSubscription, firstAvailablePort, normalizeProxyLink, wasSystemResumed };
