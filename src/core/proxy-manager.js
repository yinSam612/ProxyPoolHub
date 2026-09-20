const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const LogManager = require('./log-manager');

const MODULE_ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_RUNTIME_DIR = path.join(MODULE_ROOT_DIR, 'runtime');
const DEFAULT_STATE_FILE_PATH = path.join(DEFAULT_RUNTIME_DIR, 'proxy-state.json');
const DEFAULT_LOCK_FILE_PATH = path.join(DEFAULT_RUNTIME_DIR, 'proxy-state.lock');
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_INFO_URL = 'https://ipapi.co/json/';
const FALLBACK_INFO_URLS = ['https://api64.ipify.org', 'https://ifconfig.me/ip'];
const DEFAULT_SING_BOX_VERSION = '1.13.3';
const DEFAULT_SING_BOX_GITHUB_BASE_URL = 'https://github.com/SagerNet/sing-box/releases/download';
const DEFAULT_MODULE_CONFIG_PATH = path.join(MODULE_ROOT_DIR, 'proxy-socks5.json');

function readJsonIfExists(filePath) {
    const resolved = path.resolve(String(filePath || '').trim());
    if (!resolved || !fs.existsSync(resolved)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function loadProxyModuleSettings(options = {}) {
    const moduleConfigPath = path.resolve(String(options.moduleConfigPath || DEFAULT_MODULE_CONFIG_PATH));
    const config = readJsonIfExists(moduleConfigPath) || {};
    return {
        moduleConfigPath,
        config: config && typeof config === 'object' ? config : {}
    };
}

function safeDecodeURIComponent(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    try {
        return decodeURIComponent(text);
    } catch (error) {
        return text;
    }
}

function nowBeijingString() {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(new Date()).reduce((acc, item) => {
        acc[item.type] = item.value;
        return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathExists(targetPath) {
    try {
        fs.accessSync(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

function once(fn) {
    let called = false;
    return (...args) => {
        if (called) {
            return;
        }
        called = true;
        fn(...args);
    };
}

function parseHttpResponseBody(buffer) {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) {
        return raw.toString('utf8');
    }

    const headerText = raw.slice(0, headerEnd).toString('utf8');
    const body = raw.slice(headerEnd + 4);
    const headers = {};

    for (const line of headerText.split('\r\n').slice(1)) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex <= 0) {
            continue;
        }
        const key = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();
        headers[key] = value;
    }

    if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
        const chunks = [];
        let offset = 0;
        while (offset < body.length) {
            const lineEnd = body.indexOf(Buffer.from('\r\n'), offset);
            if (lineEnd < 0) {
                break;
            }
            const sizeText = body.slice(offset, lineEnd).toString('utf8').split(';')[0].trim();
            const size = parseInt(sizeText, 16);
            if (!Number.isFinite(size)) {
                break;
            }
            offset = lineEnd + 2;
            if (size === 0) {
                break;
            }
            const nextOffset = offset + size;
            chunks.push(body.slice(offset, nextOffset));
            offset = nextOffset + 2;
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    const contentLength = Number(headers['content-length'] || 0);
    if (contentLength > 0 && contentLength <= body.length) {
        return body.slice(0, contentLength).toString('utf8');
    }

    return body.toString('utf8');
}

function isProcessAlive(pid) {
    const normalizedPid = Number(pid || 0);
    if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
        return false;
    }
    try {
        process.kill(normalizedPid, 0);
        return true;
    } catch (error) {
        return false;
    }
}

function resolvePlatformName(platform = process.platform) {
    if (platform === 'win32') {
        return 'windows';
    }
    if (platform === 'darwin') {
        return 'darwin';
    }
    if (platform === 'linux') {
        return 'linux';
    }
    throw new Error(`unsupported platform: ${platform}`);
}

function resolveArchName(arch = process.arch) {
    if (arch === 'x64') {
        return 'amd64';
    }
    if (arch === 'arm64') {
        return 'arm64';
    }
    if (arch === 'ia32') {
        return '386';
    }
    throw new Error(`unsupported arch: ${arch}`);
}

function getSingBoxAssetInfo(options = {}) {
    const version = String(options.singBoxVersion || DEFAULT_SING_BOX_VERSION);
    const platform = resolvePlatformName(options.platform || process.platform);
    const arch = resolveArchName(options.arch || process.arch);
    const extension = platform === 'windows' ? 'zip' : 'tar.gz';
    const assetFileName = `sing-box-${version}-${platform}-${arch}.${extension}`;
    const extractedDirName = `sing-box-${version}-${platform}-${arch}`;
    const binaryName = platform === 'windows' ? 'sing-box.exe' : 'sing-box';
    return {
        version,
        platform,
        arch,
        extension,
        assetFileName,
        extractedDirName,
        binaryName
    };
}

function resolveModuleConfig(options = {}) {
    const { moduleConfigPath, config: moduleSettings } = loadProxyModuleSettings(options);
    const proxySettings = moduleSettings && typeof moduleSettings.proxy === 'object' ? moduleSettings.proxy : moduleSettings;
    const moduleRoot = path.resolve(String(options.moduleRoot || MODULE_ROOT_DIR));
    const runtimeDir = path.resolve(String(options.runtimeDir || path.join(moduleRoot, 'runtime')));
    const downloadDir = path.resolve(String(options.downloadDir || path.join(runtimeDir, 'downloads')));
    const toolsDir = path.resolve(String(options.toolsDir || path.join(runtimeDir, 'tools')));
    const stateFilePath = path.resolve(String(options.stateFilePath || path.join(runtimeDir, 'proxy-state.json')));
    const assetInfo = getSingBoxAssetInfo(options);
    const managedExtractDir = path.resolve(String(options.managedExtractDir || path.join(toolsDir, assetInfo.extractedDirName)));
    const managedBinPath = path.resolve(String(options.managedBinPath || path.join(managedExtractDir, assetInfo.binaryName)));
    const basePort = Number(options.startPort || proxySettings.startPort || 50000);
    const instanceName = String(options.instanceName || proxySettings.instanceName || proxySettings.name || '').trim();
    return {
        moduleRoot,
        runtimeDir,
        downloadDir,
        toolsDir,
        stateFilePath,
        lockFilePath: path.resolve(String(options.lockFilePath || path.join(runtimeDir, 'proxy-state.lock'))),
        binPath: options.binPath ? path.resolve(String(options.binPath)) : '',
        envBinPath: process.env.SING_BOX_BIN ? path.resolve(String(process.env.SING_BOX_BIN)) : '',
        singBoxVersion: assetInfo.version,
        singBoxGithubBaseUrl: String(options.singBoxGithubBaseUrl || DEFAULT_SING_BOX_GITHUB_BASE_URL),
        managedExtractDir,
        managedBinPath,
        bundledBinPath: path.resolve(String(options.bundledBinPath || path.join(runtimeDir, 'tools', assetInfo.extractedDirName, assetInfo.binaryName))),
        moduleConfigPath,
        instanceName,
        assetInfo,
        listPath: path.resolve(String(options.listPath || proxySettings.listPath || path.join(moduleRoot, 'proxies.txt'))),
        configPath: path.resolve(String(options.configPath || proxySettings.configPath || path.join(runtimeDir, 'temp_singbox_config.json'))),
        startPort: basePort,
        listenAddress: String(options.listenAddress || proxySettings.listenAddress || process.env.PROXY_LISTEN_ADDRESS || '127.0.0.1'),
        proxyUsername: options.proxyUsername != null
            ? String(options.proxyUsername)
            : String(proxySettings.proxyUsername || process.env.PROXY_USERNAME || ''),
        proxyPassword: options.proxyPassword != null
            ? String(options.proxyPassword)
            : String(proxySettings.proxyPassword || process.env.PROXY_PASSWORD || ''),
        testUrl: String(options.testUrl || proxySettings.testUrl || DEFAULT_TEST_URL),
        infoUrl: String(options.infoUrl || proxySettings.infoUrl || DEFAULT_INFO_URL),
        timeoutSeconds: Number(options.timeoutSeconds || proxySettings.timeoutSeconds || 8),
        startupDelayMs: Math.max(1000, Number(options.startupDelayMs || proxySettings.startupDelayMs || 2000)),
        healthCheckIntervalMs: Math.max(5000, Number(options.healthCheckIntervalMs || proxySettings.healthCheckIntervalMs || 30000)),
        maxConsecutiveHealthCheckFailures: Math.max(1, Number(options.maxConsecutiveHealthCheckFailures || proxySettings.maxConsecutiveHealthCheckFailures || 3)),
        restartDelayMs: Math.max(1000, Number(options.restartDelayMs || proxySettings.restartDelayMs || 3000)),
        maxRestartDelayMs: Math.max(3000, Number(options.maxRestartDelayMs || proxySettings.maxRestartDelayMs || 30000))
    };
}

function readStateFile(options = {}) {
    const config = resolveModuleConfig(options);
    try {
        if (!pathExists(config.stateFilePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(config.stateFilePath, 'utf8'));
    } catch (error) {
        return null;
    }
}

async function withStateLock(options = {}, runner) {
    const config = resolveModuleConfig(options);
    ensureDirectory(path.dirname(config.lockFilePath));
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60000) {
        try {
            const fd = fs.openSync(config.lockFilePath, 'wx');
            try {
                return await runner();
            } finally {
                fs.closeSync(fd);
                try {
                    fs.unlinkSync(config.lockFilePath);
                } catch (error) {
                    // ignore
                }
            }
        } catch (error) {
            try {
                const stat = fs.statSync(config.lockFilePath);
                if (Date.now() - stat.mtimeMs > 60000) {
                    fs.unlinkSync(config.lockFilePath);
                    continue;
                }
            } catch (_lockError) {
                // ignore
            }
            await sleep(100);
        }
    }
    throw new Error(`failed to acquire state lock: ${config.lockFilePath}`);
}

function writeStateFile(state, options = {}) {
    const config = resolveModuleConfig(options);
    ensureDirectory(path.dirname(config.stateFilePath));
    fs.writeFileSync(config.stateFilePath, JSON.stringify({
        ...state,
        updatedAt: nowBeijingString()
    }, null, 2));
}

function removeStateFile(options = {}) {
    const config = resolveModuleConfig(options);
    try {
        fs.unlinkSync(config.stateFilePath);
    } catch (error) {
        // ignore
    }
}

function shuffleArray(list) {
    const items = Array.isArray(list) ? list.slice() : [];
    for (let index = items.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
    }
    return items;
}

function parseProxySelection(value) {
    const normalized = String(value == null ? 'auto' : value).trim().toLowerCase();
    if (!normalized || normalized === 'auto' || normalized === 'enabled' || normalized === 'true' || normalized === 'on') {
        return { kind: 'round-robin', raw: normalized || 'auto' };
    }
    if (normalized === 'disabled' || normalized === 'false' || normalized === 'off' || normalized === 'none') {
        return { kind: 'disabled', raw: normalized };
    }
    if (normalized === 'round-robin' || normalized === 'sequential' || normalized === 'rotate') {
        return { kind: 'round-robin', raw: normalized };
    }
    if (normalized === 'random-cycle' || normalized === 'random') {
        return { kind: 'random-cycle', raw: normalized };
    }
    if (normalized.startsWith('port:') || normalized.startsWith('fixed:') || normalized.startsWith('proxy:')) {
        const port = Number(normalized.split(':')[1] || 0);
        return {
            kind: 'fixed',
            raw: normalized,
            port: Number.isFinite(port) && port > 0 ? port : 0
        };
    }
    return { kind: 'round-robin', raw: normalized };
}

function normalizeUseProxy(value) {
    if (value === true || value == null) {
        return 'auto';
    }
    if (value === false) {
        return 'disabled';
    }
    return String(value).trim() || 'auto';
}

function ensureSelectionState(state) {
    const validPorts = Array.isArray(state.validPorts) ? state.validPorts.map((port) => Number(port || 0)).filter((port) => port > 0) : [];
    const nextIndex = Number(state?.selection?.nextIndex || 0);
    const remainingPorts = Array.isArray(state?.selection?.remainingPorts)
        ? state.selection.remainingPorts.map((port) => Number(port || 0)).filter((port) => validPorts.includes(port))
        : [];
    return {
        mode: String(state?.selection?.mode || 'round-robin').trim() || 'round-robin',
        nextIndex: validPorts.length > 0 ? nextIndex % validPorts.length : 0,
        remainingPorts,
        lastSelectedPort: Number(state?.selection?.lastSelectedPort || 0) || 0
    };
}

function normalizePoolState(state) {
    const validPorts = Array.isArray(state && state.validPorts)
        ? state.validPorts.map((port) => Number(port || 0)).filter((port) => port > 0)
        : [];
    const normalized = {
        started: false,
        validPorts,
        pid: state && state.pid ? Number(state.pid) : null,
        configPath: state && state.configPath ? String(state.configPath) : '',
        listPath: state && state.listPath ? String(state.listPath) : '',
        stateFilePath: state && state.stateFilePath ? String(state.stateFilePath) : DEFAULT_STATE_FILE_PATH,
        selection: ensureSelectionState({ ...state, validPorts }),
        daemonPid: state && state.daemonPid ? Number(state.daemonPid) : null,
        corePid: state && state.corePid ? Number(state.corePid) : null,
        status: state && state.status ? String(state.status) : '',
        restartCount: Math.max(0, Number(state && state.restartCount || 0)),
        lastError: state && state.lastError ? String(state.lastError) : '',
        lastRestartAt: state && state.lastRestartAt ? String(state.lastRestartAt) : '',
        healthCheckIntervalMs: Math.max(0, Number(state && state.healthCheckIntervalMs || 0)),
        maxConsecutiveHealthCheckFailures: Math.max(0, Number(state && state.maxConsecutiveHealthCheckFailures || 0)),
        restartDelayMs: Math.max(0, Number(state && state.restartDelayMs || 0)),
        maxRestartDelayMs: Math.max(0, Number(state && state.maxRestartDelayMs || 0)),
        updatedAt: state && state.updatedAt ? String(state.updatedAt) : ''
    };
    normalized.started = Boolean(
        normalized.validPorts.length > 0
        || normalized.status === 'running'
        || normalized.status === 'degraded'
    );
    return normalized;
}

function buildManagedState(manager, previousState = {}, overrides = {}) {
    const snapshot = manager.getState();
    return normalizePoolState({
        ...previousState,
        ...snapshot,
        ...overrides,
        pid: Number(overrides.pid || previousState.pid || 0) || null,
        daemonPid: Number(overrides.daemonPid || previousState.daemonPid || 0) || null,
        corePid: Number(overrides.corePid || previousState.corePid || snapshot.pid || 0) || null,
        status: String(overrides.status || previousState.status || '').trim(),
        restartCount: Math.max(0, Number(overrides.restartCount || previousState.restartCount || 0)),
        lastError: String(overrides.lastError != null ? overrides.lastError : previousState.lastError || '').trim(),
        lastRestartAt: String(overrides.lastRestartAt || previousState.lastRestartAt || '').trim(),
        healthCheckIntervalMs: Math.max(0, Number(overrides.healthCheckIntervalMs || previousState.healthCheckIntervalMs || manager.moduleConfig.healthCheckIntervalMs || 0)),
        maxConsecutiveHealthCheckFailures: Math.max(0, Number(overrides.maxConsecutiveHealthCheckFailures || previousState.maxConsecutiveHealthCheckFailures || manager.moduleConfig.maxConsecutiveHealthCheckFailures || 0)),
        restartDelayMs: Math.max(0, Number(overrides.restartDelayMs || previousState.restartDelayMs || manager.moduleConfig.restartDelayMs || 0)),
        maxRestartDelayMs: Math.max(0, Number(overrides.maxRestartDelayMs || previousState.maxRestartDelayMs || manager.moduleConfig.maxRestartDelayMs || 0))
    });
}

function getPersistedPoolState(options = {}) {
    const config = resolveModuleConfig(options);
    const state = readStateFile(config);
    if (!state) {
        return normalizePoolState({
            started: false,
            validPorts: [],
            stateFilePath: config.stateFilePath
        });
    }
    const statePid = Number(state.pid || state.daemonPid || 0);
    if (statePid > 0 && !isProcessAlive(statePid)) {
        removeStateFile(options);
        return normalizePoolState({
            started: false,
            validPorts: [],
            stateFilePath: config.stateFilePath
        });
    }
    return normalizePoolState({
        ...state,
        stateFilePath: config.stateFilePath
    });
}

function getSingBoxDownloadUrl(config) {
    return `${String(config.singBoxGithubBaseUrl).replace(/\/$/, '')}/v${config.singBoxVersion}/${config.assetInfo.assetFileName}`;
}

function downloadToFile(url, destinationPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('too many redirects'));
            return;
        }
        ensureDirectory(path.dirname(destinationPath));
        const client = String(url).startsWith('https:') ? https : http;
        const request = client.get(url, {
            headers: {
                'User-Agent': 'proxy-socks5'
            }
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                downloadToFile(response.headers.location, destinationPath, redirectCount + 1).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`download failed status=${response.statusCode}`));
                return;
            }
            const output = fs.createWriteStream(destinationPath);
            response.pipe(output);
            output.on('finish', () => {
                output.close(() => resolve(destinationPath));
            });
            output.on('error', (error) => {
                output.close(() => reject(error));
            });
        });
        request.on('error', reject);
    });
}

function extractArchive(archivePath, outputDir, options = {}) {
    const platform = options.platform || process.platform;
    ensureDirectory(outputDir);
    if (platform === 'win32') {
        return new Promise((resolve, reject) => {
            execFile('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`
            ], { windowsHide: true }, (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(outputDir);
            });
        });
    }
    return new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', archivePath, '-C', outputDir], { windowsHide: true }, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(outputDir);
        });
    });
}

async function ensureSingBoxBinary(options = {}) {
    const config = resolveModuleConfig(options);
    if (config.binPath && pathExists(config.binPath)) {
        return config.binPath;
    }
    if (config.envBinPath && pathExists(config.envBinPath)) {
        return config.envBinPath;
    }
    if (pathExists(config.managedBinPath)) {
        return config.managedBinPath;
    }
    if (pathExists(config.bundledBinPath)) {
        return config.bundledBinPath;
    }

    const downloadUrl = getSingBoxDownloadUrl(config);
    const archivePath = path.join(config.downloadDir, config.assetInfo.assetFileName);
    const tempExtractRoot = path.join(config.toolsDir, `${config.assetInfo.extractedDirName}-extract`);

    console.log(`[proxy] Downloading sing-box ${config.singBoxVersion}...`);
    await downloadToFile(downloadUrl, archivePath);

    if (pathExists(tempExtractRoot)) {
        fs.rmSync(tempExtractRoot, { recursive: true, force: true });
    }
    ensureDirectory(tempExtractRoot);
    await extractArchive(archivePath, tempExtractRoot, { platform: process.platform });

    const extractedBinaryPath = path.join(tempExtractRoot, config.assetInfo.extractedDirName, config.assetInfo.binaryName);
    if (!pathExists(extractedBinaryPath)) {
        throw new Error(`sing-box binary not found after extract: ${extractedBinaryPath}`);
    }

    ensureDirectory(path.dirname(config.managedBinPath));
    if (pathExists(config.managedExtractDir)) {
        fs.rmSync(config.managedExtractDir, { recursive: true, force: true });
    }
    fs.renameSync(path.join(tempExtractRoot, config.assetInfo.extractedDirName), config.managedExtractDir);

    if (!pathExists(config.managedBinPath)) {
        throw new Error(`managed sing-box binary missing: ${config.managedBinPath}`);
    }
    return config.managedBinPath;
}

function parseTargetUrl(targetUrl) {
    const url = new URL(String(targetUrl || DEFAULT_TEST_URL));
    return {
        protocol: url.protocol,
        hostname: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    };
}

function createSocks5Connection(options = {}) {
    const proxyHost = String(options.proxyHost || '127.0.0.1');
    const proxyPort = Number(options.proxyPort || 0);
    const destinationHost = String(options.destinationHost || '');
    const destinationPort = Number(options.destinationPort || 0);
    const timeoutMs = Number(options.timeoutMs || 8000);
    const username = String(options.username || '');
    const password = String(options.password || '');

    return new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, proxyHost);
        let input = Buffer.alloc(0);
        let pendingRead = null;
        const finishError = once((error) => {
            if (pendingRead) {
                pendingRead.reject(error);
                pendingRead = null;
            }
            socket.destroy();
            reject(error);
        });

        const onData = (chunk) => {
            input = Buffer.concat([input, Buffer.from(chunk)]);
            if (pendingRead && input.length >= pendingRead.length) {
                const value = input.slice(0, pendingRead.length);
                input = input.slice(pendingRead.length);
                const current = pendingRead;
                pendingRead = null;
                current.resolve(value);
            }
        };
        const readBytes = (length) => {
            if (input.length >= length) {
                const value = input.slice(0, length);
                input = input.slice(length);
                return Promise.resolve(value);
            }
            return new Promise((readResolve, readReject) => {
                pendingRead = { length, resolve: readResolve, reject: readReject };
            });
        };

        socket.setTimeout(timeoutMs, () => finishError(new Error('SOCKS5 connection timeout')));
        socket.once('error', finishError);
        socket.on('data', onData);

        socket.once('connect', async () => {
            try {
                socket.write(Buffer.from([0x05, 0x01, username || password ? 0x02 : 0x00]));
                const greetingResponse = await readBytes(2);
                if (greetingResponse[0] !== 0x05) {
                    throw new Error('SOCKS5 greeting rejected');
                }

                if (greetingResponse[1] === 0x02) {
                    const userBuffer = Buffer.from(username, 'utf8');
                    const passwordBuffer = Buffer.from(password, 'utf8');
                    socket.write(Buffer.from([0x01, userBuffer.length, ...userBuffer, passwordBuffer.length, ...passwordBuffer]));
                    const authResponse = await readBytes(2);
                    if (authResponse[1] !== 0x00) {
                        throw new Error('SOCKS5 authentication rejected');
                    }
                } else if (greetingResponse[1] !== 0x00) {
                    throw new Error('SOCKS5 greeting rejected');
                }

                const hostBuffer = Buffer.from(destinationHost, 'utf8');
                const request = Buffer.alloc(7 + hostBuffer.length);
                request[0] = 0x05;
                request[1] = 0x01;
                request[2] = 0x00;
                request[3] = 0x03;
                request[4] = hostBuffer.length;
                hostBuffer.copy(request, 5);
                request.writeUInt16BE(destinationPort, 5 + hostBuffer.length);
                socket.write(request);

                const connectResponse = await readBytes(2);
                if (connectResponse[0] !== 0x05 || connectResponse[1] !== 0x00) {
                    throw new Error('SOCKS5 connect rejected');
                }
                socket.setTimeout(0);
                socket.removeListener('error', finishError);
                socket.removeListener('data', onData);
                resolve(socket);
            } catch (error) {
                finishError(error);
            }
        });
    });
}

async function probeProxyPort(port, options = {}) {
    const config = resolveModuleConfig(options);
    const targetPort = Number(port || 0);
    if (targetPort <= 0) {
        return { ok: false, reason: 'invalid-port' };
    }

    const target = parseTargetUrl(config.testUrl);
    const timeoutMs = Number(config.timeoutSeconds || 8) * 1000;
    let baseSocket;
    try {
        baseSocket = await createSocks5Connection({
            proxyHost: '127.0.0.1',
            proxyPort: targetPort,
            destinationHost: target.hostname,
            destinationPort: target.port,
            timeoutMs,
            username: config.proxyUsername,
            password: config.proxyPassword
        });

        if (target.protocol === 'https:') {
            const tlsSocket = tls.connect({
                socket: baseSocket,
                servername: target.hostname,
                timeout: timeoutMs
            });

            await new Promise((resolve, reject) => {
                const finish = once((error) => {
                    tlsSocket.destroy();
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
                tlsSocket.once('secureConnect', () => finish());
                tlsSocket.once('error', finish);
                tlsSocket.setTimeout(timeoutMs, () => finish(new Error('TLS handshake timeout')));
            });

            tlsSocket.destroy();
            return { ok: true, reason: 'tls-ok' };
        }

        baseSocket.destroy();
        return { ok: true, reason: 'tcp-ok' };
    } catch (error) {
        if (baseSocket) {
            baseSocket.destroy();
        }
        return {
            ok: false,
            reason: String(error && error.message || 'probe-failed')
        };
    }
}

async function fetchTextViaProxyPort(port, url, options = {}) {
    const config = resolveModuleConfig(options);
    const targetPort = Number(port || 0);
    if (targetPort <= 0) {
        throw new Error('invalid-port');
    }

    const parsed = new URL(String(url || config.infoUrl));
    const timeoutMs = Number(config.timeoutSeconds || 8) * 1000;
    let baseSocket;
    try {
        baseSocket = await createSocks5Connection({
            proxyHost: '127.0.0.1',
            proxyPort: targetPort,
            destinationHost: parsed.hostname,
            destinationPort: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
            timeoutMs,
            username: config.proxyUsername,
            password: config.proxyPassword
        });

        const socket = parsed.protocol === 'https:'
            ? await new Promise((resolve, reject) => {
                const tlsSocket = tls.connect({
                    socket: baseSocket,
                    servername: parsed.hostname,
                    timeout: timeoutMs
                });
                const finish = once((error) => {
                    if (error) {
                        tlsSocket.destroy();
                        reject(error);
                        return;
                    }
                    resolve(tlsSocket);
                });
                tlsSocket.once('secureConnect', () => finish());
                tlsSocket.once('error', finish);
                tlsSocket.setTimeout(timeoutMs, () => finish(new Error('TLS handshake timeout')));
            })
            : baseSocket;

        const pathName = `${parsed.pathname || '/'}${parsed.search || ''}`;
        const requestText = [
            `GET ${pathName} HTTP/1.1`,
            `Host: ${parsed.host}`,
            'Connection: close',
            'Accept: application/json,text/plain,*/*',
            'Accept-Encoding: identity',
            'User-Agent: proxy-socks5',
            '',
            ''
        ].join('\r\n');
        socket.write(requestText);

        const bodyText = await new Promise((resolve, reject) => {
            const chunks = [];
            const finish = once((error) => {
                if (error) {
                    socket.destroy();
                    reject(error);
                    return;
                }
                resolve(parseHttpResponseBody(Buffer.concat(chunks)));
            });
            socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            socket.once('end', () => finish());
            socket.once('close', () => finish());
            socket.once('error', finish);
            socket.setTimeout(timeoutMs, () => finish(new Error('HTTP response timeout')));
        });

        return String(bodyText || '').trim();
    } finally {
        if (baseSocket) {
            baseSocket.destroy();
        }
    }
}

function lookupIpGeo(ip, timeoutMs) {
    const targetIp = String(ip || '').trim();
    if (!targetIp) {
        return Promise.resolve({
            ip: '',
            country: '',
            region: '',
            city: ''
        });
    }

    const requestUrl = `http://ip-api.com/json/${encodeURIComponent(targetIp)}?fields=status,country,regionName,city,query`;
    return new Promise((resolve) => {
        const request = http.get(requestUrl, {
            headers: {
                'User-Agent': 'proxy-socks5',
                'Accept': 'application/json,text/plain,*/*'
            },
            timeout: timeoutMs
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                try {
                    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    resolve({
                        ip: String(payload.query || targetIp).trim(),
                        country: String(payload.country || '').trim(),
                        region: String(payload.regionName || '').trim(),
                        city: String(payload.city || '').trim()
                    });
                } catch (_error) {
                    resolve({
                        ip: targetIp,
                        country: '',
                        region: '',
                        city: ''
                    });
                }
            });
            response.on('error', () => resolve({
                ip: targetIp,
                country: '',
                region: '',
                city: ''
            }));
        });

        request.on('error', () => resolve({
            ip: targetIp,
            country: '',
            region: '',
            city: ''
        }));
        request.setTimeout(timeoutMs, () => {
            request.destroy();
            resolve({
                ip: targetIp,
                country: '',
                region: '',
                city: ''
            });
        });
    });
}

function extractIpAddress(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.ip === 'string' && net.isIP(parsed.ip.trim())) {
            return parsed.ip.trim();
        }
    } catch (error) {
        // Plain-text IP responses are expected.
    }
    return (text.match(/[0-9a-f:.]+/gi) || [])
        .map((candidate) => candidate.replace(/^\[|\]$/g, ''))
        .find((candidate) => net.isIP(candidate)) || '';
}

async function fetchProxyNodeInfo(port, options = {}) {
    const config = resolveModuleConfig(options);
    const urls = Array.from(new Set([config.infoUrl, ...FALLBACK_INFO_URLS].filter(Boolean)));
    let lastError = '';
    for (const url of urls) {
        try {
            const ip = extractIpAddress(await fetchTextViaProxyPort(port, url, options));
            if (ip) {
                return lookupIpGeo(ip, Number(config.timeoutSeconds || 15) * 1000);
            }
        } catch (error) {
            lastError = String(error && error.message || 'node-info-failed');
        }
    }
    return { ip: '', country: '', region: '', city: '', error: lastError || 'node-info-failed' };
}

function toProxyEndpoint(port) {
    return {
        server: `socks5://127.0.0.1:${Number(port || 0)}`,
        host: '127.0.0.1',
        port: Number(port || 0)
    };
}

function padCell(value, width, align = 'left') {
    const text = String(value == null ? '' : value);
    if (text.length >= width) {
        return text;
    }
    const padding = ' '.repeat(width - text.length);
    return align === 'right' ? `${padding}${text}` : `${text}${padding}`;
}

function formatNodeLocation(nodeInfo) {
    if (!nodeInfo) {
        return '- / - / -';
    }
    const country = nodeInfo.country || '-';
    const region = nodeInfo.region || '-';
    const city = nodeInfo.city || '-';
    return `${country} / ${region} / ${city}`;
}

function extractProxyDisplayName(link, url, index) {
    const decodedHash = safeDecodeURIComponent(String(url?.hash || '').replace(/^#/, ''));
    if (decodedHash) {
        return decodedHash;
    }

    const candidates = [
        url?.searchParams?.get('remark'),
        url?.searchParams?.get('remarks'),
        url?.searchParams?.get('name'),
        url?.searchParams?.get('ps'),
        url?.searchParams?.get('tag')
    ].map((item) => safeDecodeURIComponent(item)).filter(Boolean);
    if (candidates.length > 0) {
        return candidates[0];
    }

    const host = String(url?.hostname || '').trim();
    const port = String(url?.port || '').trim();
    if (host && port) {
        return `${host}:${port}`;
    }
    if (host) {
        return host;
    }
    return `proxy-${index + 1}`;
}

function setTerminalTitle(title) {
    const text = String(title || '').trim();
    if (!text || !process.stdout || !process.stdout.isTTY) {
        return;
    }
    process.stdout.write(`\u001b]0;${text}\u0007`);
}

function buildInstanceSummary(manager) {
    const instanceName = String(manager.moduleConfig.instanceName || '').trim() || 'proxy-socks5';
    const validPorts = Array.isArray(manager.validPorts) ? manager.validPorts.slice().sort((a, b) => a - b) : [];
    const firstPort = validPorts.length > 0 ? validPorts[0] : manager.startPort;
    const lastPort = validPorts.length > 0 ? validPorts[validPorts.length - 1] : manager.startPort;
    const portSummary = validPorts.length > 1 ? `${firstPort}-${lastPort}` : String(firstPort);
    const firstProxyName = Array.isArray(manager.proxies) && manager.proxies[0] && manager.proxies[0].displayName
        ? manager.proxies[0].displayName
        : '';
    const nodeSummary = manager.proxies.length > 1 && firstProxyName
        ? `${firstProxyName} +${manager.proxies.length - 1}`
        : firstProxyName || `${manager.proxies.length} nodes`;
    return {
        instanceName,
        portSummary,
        nodeSummary,
        title: `${instanceName} | ${portSummary} | ${nodeSummary}`,
        banner: `[proxy] Instance: ${instanceName} | Ports: ${portSummary} | Nodes: ${nodeSummary}`
    };
}

function renderTestResultsTable(results) {
    const rows = results.map((item) => ({
        port: String(item.port),
        status: item.success ? 'OK' : 'FAIL',
        latency: item.success ? `${item.latencyMs}ms` : '-',
        ip: item.nodeInfo && item.nodeInfo.ip ? item.nodeInfo.ip : '-',
        location: item.success ? formatNodeLocation(item.nodeInfo) : '-',
        reason: item.reason || '-'
    }));

    const headers = {
        port: 'Port',
        status: 'Status',
        latency: 'Latency',
        ip: 'IP',
        location: 'Location',
        reason: 'Reason'
    };

    const widths = {
        port: Math.max(headers.port.length, ...rows.map((row) => row.port.length)),
        status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
        latency: Math.max(headers.latency.length, ...rows.map((row) => row.latency.length)),
        ip: Math.max(headers.ip.length, ...rows.map((row) => row.ip.length)),
        location: Math.max(headers.location.length, ...rows.map((row) => row.location.length)),
        reason: Math.max(headers.reason.length, ...rows.map((row) => row.reason.length))
    };

    const separator = `+-${'-'.repeat(widths.port)}-+-${'-'.repeat(widths.status)}-+-${'-'.repeat(widths.latency)}-+-${'-'.repeat(widths.ip)}-+-${'-'.repeat(widths.location)}-+-${'-'.repeat(widths.reason)}-+`;
    const header = `| ${padCell(headers.port, widths.port)} | ${padCell(headers.status, widths.status)} | ${padCell(headers.latency, widths.latency)} | ${padCell(headers.ip, widths.ip)} | ${padCell(headers.location, widths.location)} | ${padCell(headers.reason, widths.reason)} |`;
    const body = rows.map((row) => `| ${padCell(row.port, widths.port, 'right')} | ${padCell(row.status, widths.status)} | ${padCell(row.latency, widths.latency, 'right')} | ${padCell(row.ip, widths.ip)} | ${padCell(row.location, widths.location)} | ${padCell(row.reason, widths.reason)} |`);
    return [separator, header, separator, ...body, separator].join('\n');
}

function shouldIgnoreSingBoxErrorLog(line) {
    const text = String(line || '');
    return [
        /stream \d+ canceled by remote with error code 0/i,
        /connection upload closed:\s*raw[\s-]?read/i,
        /read tcp .*: wsarecv: an existing connection was forcibly closed by the remote host\./i,
        /raw read: an established connection was aborted by the software in your host machine\./i
    ].some((pattern) => pattern.test(text));
}

class ProxyManager {
    constructor(options = {}) {
        this.moduleConfig = resolveModuleConfig(options);
        this.binPath = '';
        this.listPath = this.moduleConfig.listPath;
        this.configPath = this.moduleConfig.configPath;
        this.stateFilePath = this.moduleConfig.stateFilePath;
        this.startPort = this.moduleConfig.startPort;
        this.process = null;
        this.proxies = [];
        this.proxiesCount = 0;
        this.loadedProxyCount = 0;
        this.validPorts = [];
        this.lastResults = [];
        this.nodeInfoPromise = null;
        this.logManager = options.logManager || new LogManager({
            logDir: path.join(this.moduleConfig.moduleRoot, 'data', 'logs'),
            trafficFile: path.join(this.moduleConfig.moduleRoot, 'data', 'traffic.json'),
            retentionDays: Number(options.retentionDays || process.env.LOG_RETENTION_DAYS || 30),
            maxTotalMb: Number(options.maxTotalMb || process.env.LOG_MAX_TOTAL_MB || 1024)
        });
    }

    getState() {
        return {
            started: true,
            pid: Number(this.process?.pid || 0),
            validPorts: this.validPorts || [],
            configPath: this.configPath,
            listPath: this.listPath,
            stateFilePath: this.stateFilePath,
            startPort: this.startPort,
            proxiesCount: this.proxiesCount,
            selection: {
                mode: 'round-robin',
                nextIndex: 0,
                remainingPorts: [],
                lastSelectedPort: 0
            }
        };
    }

    getProxyPort(proxy, index) {
        const configuredPort = Number(proxy && proxy.listenPort || 0);
        return configuredPort > 0 ? configuredPort : this.startPort + index;
    }

    parseProxyLink(link, index) {
        try {
            const url = new URL(link.trim());
            const protocol = url.protocol.replace(':', '');
            if (protocol === 'hysteria2' || protocol === 'hy2') {
                return this.parseHy2(url, index, link);
            }
            if (protocol === 'vless') {
                return this.parseVless(url, index, link);
            }
            if (protocol === 'trojan') {
                return this.parseTrojan(url, index, link);
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    parseHy2(url, index, link) {
        const password = url.username || url.password;
        const server = url.hostname;
        const port = parseInt(url.port, 10);
        const sni = url.searchParams.get('sni') || server;
        const insecure = url.searchParams.get('insecure') === '1' || url.searchParams.get('allowInsecure') === '1';
        const obfs = url.searchParams.get('obfs');
        const obfsParam = url.searchParams.get('obfs-password') || url.searchParams.get('obfsParam');

        return {
            tag: `proxy-${index}`,
            displayName: extractProxyDisplayName(link, url, index),
            type: 'hysteria2',
            server,
            server_port: port,
            password,
            tls: {
                enabled: true,
                server_name: sni,
                insecure
            },
            ...(obfs ? { obfs: { type: obfs, password: obfsParam } } : {})
        };
    }

    parseVless(url, index, link) {
        const uuid = url.username;
        const server = url.hostname;
        const port = parseInt(url.port, 10);
        const security = url.searchParams.get('security') || 'none';
        const sni = url.searchParams.get('sni') || url.searchParams.get('peer') || server;
        const fingerprint = url.searchParams.get('fp') || 'chrome';
        const transportType = url.searchParams.get('type') || 'tcp';
        const host = url.searchParams.get('host') || url.searchParams.get('sni') || '';
        const insecure = url.searchParams.get('insecure') === '1' || url.searchParams.get('allowInsecure') === '1';

        const config = {
            tag: `proxy-${index}`,
            displayName: extractProxyDisplayName(link, url, index),
            type: 'vless',
            server,
            server_port: port,
            uuid
        };

        if (security === 'tls' || security === 'reality') {
            config.tls = {
                enabled: true,
                server_name: sni,
                insecure,
                utls: {
                    enabled: true,
                    fingerprint
                }
            };

            if (security === 'reality') {
                config.tls.reality = {
                    enabled: true,
                    public_key: url.searchParams.get('pbk') || url.searchParams.get('public_key') || '',
                    short_id: url.searchParams.get('sid') || url.searchParams.get('short_id') || ''
                };
            }
        }

        if (transportType === 'ws') {
            config.transport = {
                type: 'ws',
                path: url.searchParams.get('path') || '/',
                headers: host ? { Host: host } : {}
            };
        } else if (transportType === 'grpc') {
            config.transport = {
                type: 'grpc',
                service_name: url.searchParams.get('serviceName') || url.searchParams.get('service_name') || '',
                headers: host ? { Host: host } : {}
            };
        }

        const flow = url.searchParams.get('flow');
        if (flow) {
            config.flow = flow;
        }

        return config;
    }

    parseTrojan(url, index, link) {
        const password = url.username || url.password;
        const server = url.hostname;
        const port = parseInt(url.port, 10);
        const security = url.searchParams.get('security') || 'none';
        const sni = url.searchParams.get('sni') || url.searchParams.get('peer') || server;
        const fingerprint = url.searchParams.get('fp') || 'chrome';
        const transportType = url.searchParams.get('type') || 'tcp';
        const host = url.searchParams.get('host') || url.searchParams.get('sni') || '';
        const insecure = url.searchParams.get('insecure') === '1' || url.searchParams.get('allowInsecure') === '1';

        const config = {
            tag: `proxy-${index}`,
            displayName: extractProxyDisplayName(link, url, index),
            type: 'trojan',
            server,
            server_port: port,
            password
        };

        if (security === 'tls') {
            config.tls = {
                enabled: true,
                server_name: sni,
                insecure,
                utls: {
                    enabled: true,
                    fingerprint
                }
            };
        }

        if (transportType === 'ws') {
            config.transport = {
                type: 'ws',
                path: url.searchParams.get('path') || '/',
                headers: host ? { Host: host } : {}
            };
        } else if (transportType === 'grpc') {
            config.transport = {
                type: 'grpc',
                service_name: url.searchParams.get('serviceName') || url.searchParams.get('service_name') || '',
                headers: host ? { Host: host } : {}
            };
        }

        return config;
    }

    generateConfig(proxies) {
        const inbounds = [];
        const outbounds = [];
        const rules = [];

        proxies.forEach((proxy, index) => {
            const port = this.getProxyPort(proxy, index);
            const inboundTag = `inbound-${index}`;
            const outboundTag = proxy.tag;
            const { displayName, listenPort, ...proxyConfig } = proxy;
            void displayName;
            void listenPort;

            const inbound = {
                type: 'mixed',
                tag: inboundTag,
                listen: this.moduleConfig.listenAddress,
                listen_port: port
            };
            if (this.moduleConfig.proxyUsername && this.moduleConfig.proxyPassword) {
                inbound.users = [{
                    username: this.moduleConfig.proxyUsername,
                    password: this.moduleConfig.proxyPassword
                }];
            }
            inbounds.push(inbound);

            outbounds.push(proxyConfig);

            rules.push({
                inbound: [inboundTag],
                outbound: outboundTag
            });
        });

        outbounds.push({ type: 'direct', tag: 'direct' });

        return {
            log: {
                level: 'info',
                timestamp: true
            },
            dns: {
                servers: [
                    { tag: 'google', type: 'udp', server: '8.8.8.8', server_port: 53 },
                    { tag: 'cloudflare', type: 'udp', server: '1.1.1.1', server_port: 53 }
                ]
            },
            inbounds,
            outbounds,
            route: {
                rules,
                final: 'direct',
                auto_detect_interface: true,
                default_domain_resolver: 'google'
            }
        };
    }

    spawnSingBoxProcess(detachProcess = false) {
        const env = {
            ...process.env,
            ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true'
        };

        this.process = spawn(this.binPath, ['run', '-c', this.configPath], {
            cwd: path.dirname(this.binPath),
            detached: detachProcess,
            env,
            stdio: detachProcess
                ? [
                    'ignore',
                    fs.openSync(path.join(this.moduleConfig.runtimeDir, 'sing-box.stdout.log'), 'a'),
                    fs.openSync(path.join(this.moduleConfig.runtimeDir, 'sing-box.stderr.log'), 'a')
                ]
                : 'pipe',
            windowsHide: true
        });

        if (detachProcess && typeof this.process.unref === 'function') {
            this.process.unref();
        }

        if (this.process.stdout) {
            let stdoutBuf = '';
            this.process.stdout.on('data', (data) => {
                stdoutBuf += String(data);
                const lines = stdoutBuf.split(/\r?\n/);
                stdoutBuf = lines.pop();
                for (const line of lines) {
                    if (this.logManager) {
                        this.logManager.feedKernelLogLine(line);
                    }
                }
            });
        }

        if (this.process.stderr) {
            let stderrBuf = '';
            this.process.stderr.on('data', (data) => {
                const text = String(data || '');
                stderrBuf += text;
                const lines = stderrBuf.split(/\r?\n/);
                stderrBuf = lines.pop();
                for (const line of lines) {
                    if (this.logManager) {
                        this.logManager.feedKernelLogLine(line);
                    }
                    if (shouldIgnoreSingBoxErrorLog(line)) {
                        continue;
                    }
                    process.stderr.write(`${line}\n`);
                }
            });
        }

        this.process.on('error', (error) => {
            console.error(`[proxy] sing-box spawn failed: ${error.message}`);
        });
    }

    /**
     * 启动指定候选节点集的 sing-box 进程
     * @param {Array<object>} proxies - 节点列表
     * @param {object} [options={}] - 启动选项
     * @param {boolean} [options.detachProcess=false] - 是否以脱离进程模式运行
     * @param {boolean} [options.skipTest=false] - 是否跳过同步连通性检测（用于 Web 快速生效）
     * @param {boolean} [options.eagerNodeInfo=false] - 是否同步获取出口 IP 信息
     * @returns {Promise<Array<object>>} 连通性测试结果
     */
    async startCandidateSet(proxies, options = {}) {
        const detachProcess = Boolean(options.detachProcess);
        this.proxies = Array.isArray(proxies) ? proxies.slice() : [];
        this.proxiesCount = this.proxies.length;
        this.validPorts = [];
        const config = this.generateConfig(this.proxies);
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
        this.spawnSingBoxProcess(detachProcess);

        // 如果明确指定跳过测试，仅需极短等待确认进程启动成功即可快速返回，极大提升 Web 操作响应性
        if (options.skipTest) {
            await sleep(200);
            if (this.process && this.process.exitCode !== null) {
                throw new Error(`sing-box exited immediately with code ${this.process.exitCode}`);
            }
            this.validPorts = this.proxies.map((item) => Number(item.listenPort)).filter(Boolean);
            return [];
        }

        await sleep(this.moduleConfig.startupDelayMs);
        return this.testAll({ silent: true, eagerNodeInfo: options.eagerNodeInfo === true });
    }


    async compactToSequentialValidPorts(options = {}) {
        let candidates = this.proxies.slice();
        let pass = 0;

        while (candidates.length > 0) {
            pass += 1;
            if (pass === 1) {
                console.log('[proxy] Starting sing-box...');
            } else {
                console.log(`[proxy] Rebuilding with ${candidates.length} valid proxy links...`);
            }

            const results = await this.startCandidateSet(candidates, options);
            const successfulIndexes = results
                .map((item, index) => item.success ? index : -1)
                .filter((index) => index >= 0);

            if (successfulIndexes.length <= 0) {
                throw new Error('proxy started but no valid ports passed connectivity test');
            }

            if (successfulIndexes.length === candidates.length) {
                this.validPorts = results.filter((item) => item.success).map((item) => item.port);
                return results;
            }

            const filteredCount = candidates.length - successfulIndexes.length;
            console.log(`[proxy] Filtered out ${filteredCount} invalid proxy links, reassigning ports...`);
            this.stop({ silent: true });
            candidates = successfulIndexes.map((index) => candidates[index]);
        }

        throw new Error('no valid proxy links found after filtering');
    }

    async start(options = {}) {
        this.binPath = await ensureSingBoxBinary(this.moduleConfig);
        ensureDirectory(this.moduleConfig.runtimeDir);

        let proxies;
        if (Array.isArray(options.proxies)) {
            proxies = options.proxies.map((entry, index) => {
                const link = typeof entry === 'string' ? entry : entry && entry.link;
                const parsed = this.parseProxyLink(link, index);
                if (parsed && entry && typeof entry === 'object' && Number(entry.listenPort) > 0) {
                    parsed.listenPort = Number(entry.listenPort);
                }
                return parsed;
            }).filter(Boolean);
        } else {
            if (!fs.existsSync(this.listPath)) {
                throw new Error(`proxy list not found: ${this.listPath}`);
            }
            const lines = fs.readFileSync(this.listPath, 'utf8').split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
            proxies = lines.map((line, index) => this.parseProxyLink(line, index)).filter(Boolean);
        }
        this.proxies = proxies;
        this.proxiesCount = proxies.length;
        this.loadedProxyCount = proxies.length;

        if (this.proxiesCount <= 0) {
            throw new Error('no valid proxy links found in proxies.txt');
        }

        console.log(`[proxy] Loaded ${this.proxiesCount} proxy links`);
        const finalResults = options.filterInvalid === false
            ? await this.startCandidateSet(proxies, options)
            : await this.compactToSequentialValidPorts(options);
        this.lastResults = Array.isArray(finalResults) ? finalResults.slice() : [];
        console.log(renderTestResultsTable(finalResults));
        console.log(`[proxy] Valid ports: ${this.validPorts.length} / ${this.loadedProxyCount}`);

        if (this.validPorts.length <= 0 && options.requireValid !== false) {
            throw new Error('proxy started but no valid ports passed connectivity test');
        }

        const summary = buildInstanceSummary(this);
        setTerminalTitle(summary.title);
        console.log(summary.banner);
        console.log(`[proxy] Ready on ports: ${JSON.stringify(this.validPorts)}`);
        this.refreshNodeInfoInBackground().catch(() => {});
    }

    async testAll(options = {}) {
        const silent = Boolean(options.silent);
        const results = await Promise.all(this.proxies.map((proxy, index) => this.testPort(this.getProxyPort(proxy, index), options)));
        this.validPorts = results.filter((item) => item.success).map((item) => item.port);
        this.lastResults = results.slice();
        if (!silent) {
            console.log(renderTestResultsTable(results));
            console.log(`[proxy] Valid ports: ${this.validPorts.length} / ${this.proxiesCount}`);
        }
        return results;
    }

    async testPort(port, options = {}) {
        const silent = Boolean(options.silent);
        const eagerNodeInfo = options.eagerNodeInfo !== false;
        const startedAt = Date.now();
        const probe = await probeProxyPort(port, this.moduleConfig);
        const latencyMs = Date.now() - startedAt;
        let nodeInfo = null;
        if (probe.ok && eagerNodeInfo) {
            nodeInfo = await fetchProxyNodeInfo(port, this.moduleConfig);
        }
        return {
            port,
            success: probe.ok,
            latencyMs,
            reason: probe.reason,
            nodeInfo: nodeInfo || {
                ip: '',
                country: '',
                region: '',
                city: ''
            }
        };
    }

    async refreshNodeInfoInBackground() {
        if (this.nodeInfoPromise) {
            return this.nodeInfoPromise;
        }
        this.nodeInfoPromise = this.collectNodeInfo();
        try {
            return await this.nodeInfoPromise;
        } finally {
            this.nodeInfoPromise = null;
        }
    }

    async collectNodeInfo() {
        const baseResults = Array.isArray(this.lastResults) ? this.lastResults.slice() : [];
        const pending = baseResults.filter((item) => item && item.success && (!item.nodeInfo || !item.nodeInfo.ip));
        if (pending.length <= 0) {
            return baseResults;
        }

        const refreshed = await Promise.all(baseResults.map(async (item) => {
            if (!item || !item.success) {
                return item;
            }
            if (item.nodeInfo && item.nodeInfo.ip) {
                return item;
            }
            const nodeInfo = await fetchProxyNodeInfo(item.port, this.moduleConfig).catch(() => ({
                ip: '',
                country: '',
                region: '',
                city: ''
            }));
            return {
                ...item,
                nodeInfo: nodeInfo || item.nodeInfo
            };
        }));

        this.lastResults = refreshed;
        const resolvedCount = refreshed.filter((item) => item && item.success && item.nodeInfo && item.nodeInfo.ip).length;
        if (resolvedCount > 0) {
            console.log('[proxy] Node info refreshed:');
            console.log(renderTestResultsTable(refreshed));
        }
        return refreshed;
    }

    waitForProcessExit() {
        if (!this.process) {
            return Promise.resolve({ code: 0, signal: null });
        }
        const currentProcess = this.process;
        if (currentProcess.exitCode !== null || currentProcess.signalCode !== null) {
            return Promise.resolve({
                code: currentProcess.exitCode,
                signal: currentProcess.signalCode || null
            });
        }
        return new Promise((resolve) => {
            currentProcess.once('exit', (code, signal) => {
                resolve({ code, signal: signal || null });
            });
        });
    }

    stop(options = {}) {
        const silent = Boolean(options.silent);
        if (this.process) {
            try {
                this.process.kill();
            } catch (error) {
                // ignore
            }
            this.process = null;
            if (!silent) {
                console.log('[proxy] Service stopped');
            }
        }
    }
}

function selectRoundRobinPort(state) {
    if (state.validPorts.length <= 0) {
        return 0;
    }
    const index = Number(state.selection.nextIndex || 0) % state.validPorts.length;
    const port = Number(state.validPorts[index] || 0);
    state.selection.nextIndex = state.validPorts.length > 0 ? (index + 1) % state.validPorts.length : 0;
    state.selection.lastSelectedPort = port;
    return port;
}

function selectRandomCyclePort(state) {
    if (state.validPorts.length <= 0) {
        return 0;
    }
    if (!Array.isArray(state.selection.remainingPorts) || state.selection.remainingPorts.length <= 0) {
        state.selection.remainingPorts = shuffleArray(state.validPorts);
    }
    const port = Number(state.selection.remainingPorts.shift() || 0);
    state.selection.lastSelectedPort = port;
    return port;
}

function verifyProxyPort(port, options = {}) {
    const targetPort = Number(port || 0);
    if (targetPort <= 0) {
        return Promise.resolve(false);
    }
    return probeProxyPort(targetPort, options).then((result) => result.ok);
}

async function selectProxyStateAndPort(options = {}) {
    let state = getPersistedPoolState(options);
    if (!state.started || state.validPorts.length <= 0) {
        try {
            state = normalizePoolState(await startManagedDaemon(options));
        } catch (error) {
            return {
                state,
                port: 0,
                selection: parseProxySelection(options.useProxy)
            };
        }
    }

    return withStateLock(options, async () => {
        const latest = normalizePoolState(readStateFile(options) || state);
        const selection = parseProxySelection(options.useProxy);
        let port = 0;

        if (selection.kind === 'fixed') {
            port = Number(selection.port || 0);
        } else if (selection.kind === 'random-cycle') {
            latest.selection.mode = 'random-cycle';
            port = selectRandomCyclePort(latest);
        } else {
            latest.selection.mode = 'round-robin';
            port = selectRoundRobinPort(latest);
        }

        writeStateFile(latest, options);
        return {
            state: normalizePoolState(latest),
            port,
            selection
        };
    });
}

async function resolveRuntimeProxy(options = {}) {
    const mode = normalizeUseProxy(options.useProxy);
    const selection = parseProxySelection(mode);
    if (selection.kind === 'disabled') {
        return {
            enabled: false,
            mode: 'disabled',
            reason: 'proxy-disabled-by-option',
            proxyServer: '',
            host: '',
            port: 0,
            source: 'proxy-socks5',
            validPorts: [],
            pid: null
        };
    }

    const selected = await selectProxyStateAndPort(options);
    const state = selected.state;
    const selectedPort = Number(selected.port || 0);

    if (!state.started || state.validPorts.length <= 0) {
        return {
            enabled: false,
            mode: 'ignored',
            reason: 'proxy-no-valid-ports',
            proxyServer: '',
            host: '',
            port: 0,
            source: 'proxy-socks5',
            validPorts: state.validPorts,
            pid: state.pid
        };
    }

    if (selection.kind === 'fixed' && !state.validPorts.includes(selectedPort)) {
        return {
            enabled: false,
            mode: 'ignored',
            reason: `proxy-fixed-port-invalid:${selectedPort}`,
            proxyServer: '',
            host: '',
            port: 0,
            source: 'proxy-socks5',
            validPorts: state.validPorts,
            pid: state.pid
        };
    }

    if (options.verifyConnectivity !== false) {
        const verified = await verifyProxyPort(selectedPort, options);
        if (!verified) {
            return {
                enabled: false,
                mode: 'ignored',
                reason: 'proxy-port-unreachable',
                proxyServer: '',
                host: '',
                port: 0,
                source: 'proxy-socks5',
                validPorts: state.validPorts,
                pid: state.pid
            };
        }
    }

    const endpoint = toProxyEndpoint(selectedPort);
    return {
        enabled: true,
        mode: selection.kind,
        reason: 'proxy-ready',
        proxyServer: endpoint.server,
        host: endpoint.host,
        port: endpoint.port,
        source: 'proxy-socks5',
        validPorts: state.validPorts,
        pid: state.pid
    };
}

function computeRestartDelay(config, restartCount) {
    const baseDelay = Math.max(1000, Number(config.restartDelayMs || 3000));
    const maxDelay = Math.max(baseDelay, Number(config.maxRestartDelayMs || 30000));
    const exponent = Math.max(0, Number(restartCount || 1) - 1);
    return Math.min(baseDelay * (2 ** exponent), maxDelay);
}

function collectManagerPorts(manager) {
    return manager.proxies.map((proxy, index) => manager.getProxyPort(proxy, index));
}

async function probeManagerPorts(manager, options = {}) {
    const ports = collectManagerPorts(manager);
    const results = await Promise.all(ports.map(async (port) => ({
        port,
        probe: await probeProxyPort(port, options)
    })));
    manager.validPorts = results.filter((item) => item.probe.ok).map((item) => item.port);
    return manager.validPorts.slice();
}

async function writeManagedStateFile(manager, options = {}, overrides = {}) {
    const previousState = readStateFile(options) || {};
    const state = buildManagedState(manager, previousState, overrides);
    writeStateFile(state, options);
    return state;
}

async function monitorProxyManager(manager, options = {}, handlers = {}) {
    const intervalMs = Math.max(5000, Number(manager.moduleConfig.healthCheckIntervalMs || 30000));
    const maxConsecutiveFailures = Math.max(1, Number(manager.moduleConfig.maxConsecutiveHealthCheckFailures || 3));
    return new Promise((resolve) => {
        let finished = false;
        let busy = false;
        let timer = null;
        let consecutiveFailureCount = 0;

        const finish = (payload) => {
            if (finished) {
                return;
            }
            finished = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (manager.process) {
                manager.process.removeListener('exit', onExit);
                manager.process.removeListener('error', onError);
            }
            resolve(payload);
        };

        const onExit = (code, signal) => finish({ reason: 'core-exit', code, signal });
        const onError = (error) => finish({ reason: 'core-error', message: error?.message || '' });

        if (!manager.process) {
            finish({ reason: 'core-error', message: 'sing-box process missing' });
            return;
        }

        manager.process.once('exit', onExit);
        manager.process.once('error', onError);

        timer = setInterval(async () => {
            if (finished || busy) {
                return;
            }
            busy = true;
            try {
                const previousValidPorts = Array.isArray(manager.validPorts) ? manager.validPorts.slice() : [];
                const currentValidPorts = await probeManagerPorts(manager, options);
                const status = currentValidPorts.length > 0 ? 'running' : 'degraded';
                const changed = previousValidPorts.length !== currentValidPorts.length
                    || previousValidPorts.some((port) => !currentValidPorts.includes(port));

                if (typeof handlers.onHealthCheck === 'function') {
                    await handlers.onHealthCheck({
                        status,
                        changed,
                        currentValidPorts,
                        consecutiveFailureCount
                    });
                }

                if (changed) {
                    console.log(`[proxy] Available ports updated: ${JSON.stringify(currentValidPorts)}`);
                }
                if (currentValidPorts.length <= 0) {
                    consecutiveFailureCount += 1;
                    console.warn(`[proxy] Health check failed for all ports (${consecutiveFailureCount}/${maxConsecutiveFailures})`);
                    if (consecutiveFailureCount >= maxConsecutiveFailures) {
                        finish({
                            reason: 'no-valid-ports',
                            message: `all proxy ports became unavailable for ${consecutiveFailureCount} consecutive checks`
                        });
                    }
                } else {
                    consecutiveFailureCount = 0;
                }
            } catch (error) {
                consecutiveFailureCount += 1;
                const message = error?.message || 'health check failed';
                console.warn(`[proxy] Health check error (${consecutiveFailureCount}/${maxConsecutiveFailures}): ${message}`);
                if (consecutiveFailureCount >= maxConsecutiveFailures) {
                    finish({ reason: 'health-check-failed', message });
                }
            } finally {
                busy = false;
            }
        }, intervalMs);
    });
}

function formatRestartReason(payload = {}) {
    if (payload.reason === 'core-exit') {
        return `sing-box exited code=${payload.code} signal=${payload.signal || 'unknown'}`;
    }
    if (payload.reason === 'core-error') {
        return payload.message || 'sing-box process error';
    }
    if (payload.reason === 'health-check-failed') {
        return payload.message || 'proxy health check failed';
    }
    if (payload.reason === 'no-valid-ports') {
        return payload.message || 'all proxy ports became unavailable';
    }
    return String(payload.reason || 'unknown restart reason');
}

async function runDaemon(options = {}) {
    const manager = new ProxyManager(options);
    let restartCount = 0;
    let stopping = false;

    const shutdown = () => {
        if (stopping) {
            return;
        }
        stopping = true;
        try {
            manager.stop();
        } catch (error) {
            // ignore
        }
        removeStateFile(options);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    while (!stopping) {
        let restartReason = '';
        try {
            await writeManagedStateFile(manager, options, {
                pid: process.pid,
                daemonPid: process.pid,
                corePid: null,
                status: restartCount > 0 ? 'restarting' : 'starting',
                restartCount,
                lastError: '',
                lastRestartAt: restartCount > 0 ? nowBeijingString() : '',
                healthCheckIntervalMs: manager.moduleConfig.healthCheckIntervalMs,
                maxConsecutiveHealthCheckFailures: manager.moduleConfig.maxConsecutiveHealthCheckFailures,
                restartDelayMs: manager.moduleConfig.restartDelayMs,
                maxRestartDelayMs: manager.moduleConfig.maxRestartDelayMs
            });

            await manager.start({ detachProcess: false });
            await writeManagedStateFile(manager, options, {
                pid: process.pid,
                daemonPid: process.pid,
                corePid: manager.process?.pid || null,
                status: manager.validPorts.length > 0 ? 'running' : 'degraded',
                restartCount,
                healthCheckIntervalMs: manager.moduleConfig.healthCheckIntervalMs,
                maxConsecutiveHealthCheckFailures: manager.moduleConfig.maxConsecutiveHealthCheckFailures,
                restartDelayMs: manager.moduleConfig.restartDelayMs,
                maxRestartDelayMs: manager.moduleConfig.maxRestartDelayMs
            });

            const watchResult = await monitorProxyManager(manager, options, {
                onHealthCheck: async ({ status }) => {
                    await writeManagedStateFile(manager, options, {
                        pid: process.pid,
                        daemonPid: process.pid,
                        corePid: manager.process?.pid || null,
                        status,
                        restartCount,
                        healthCheckIntervalMs: manager.moduleConfig.healthCheckIntervalMs,
                        maxConsecutiveHealthCheckFailures: manager.moduleConfig.maxConsecutiveHealthCheckFailures,
                        restartDelayMs: manager.moduleConfig.restartDelayMs,
                        maxRestartDelayMs: manager.moduleConfig.maxRestartDelayMs
                    });
                }
            });

            restartReason = formatRestartReason(watchResult);
        } catch (error) {
            restartReason = error?.message || 'daemon failed';
        } finally {
            try {
                manager.stop();
            } catch (error) {
                // ignore
            }
        }

        if (stopping) {
            break;
        }

        restartCount += 1;
        const delayMs = computeRestartDelay(manager.moduleConfig, restartCount);
        console.log(`[proxy] Restarting after ${delayMs}ms: ${restartReason}`);
        await writeManagedStateFile(manager, options, {
            pid: process.pid,
            daemonPid: process.pid,
            corePid: null,
            status: 'restarting',
            restartCount,
            lastError: restartReason,
            lastRestartAt: nowBeijingString(),
            healthCheckIntervalMs: manager.moduleConfig.healthCheckIntervalMs,
            maxConsecutiveHealthCheckFailures: manager.moduleConfig.maxConsecutiveHealthCheckFailures,
            restartDelayMs: manager.moduleConfig.restartDelayMs,
            maxRestartDelayMs: manager.moduleConfig.maxRestartDelayMs
        });
        await sleep(delayMs);
    }
}

async function startManagedDaemon(options = {}) {
    const existing = getPersistedPoolState(options);
    if (existing.started) {
        console.log(`[proxy] daemon already running pid=${existing.pid} validPorts=${JSON.stringify(existing.validPorts)}`);
        return existing;
    }

    const config = resolveModuleConfig(options);
    ensureDirectory(config.runtimeDir);
    const child = spawn(process.execPath, [__filename, 'daemon-run'], {
        cwd: MODULE_ROOT_DIR,
        detached: true,
        env: process.env,
        stdio: [
            'ignore',
            fs.openSync(path.join(config.runtimeDir, 'proxy-daemon.stdout.log'), 'a'),
            fs.openSync(path.join(config.runtimeDir, 'proxy-daemon.stderr.log'), 'a')
        ],
        windowsHide: true
    });

    if (typeof child.unref === 'function') {
        child.unref();
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 45000) {
        await sleep(500);
        const state = getPersistedPoolState(options);
        if ((state.status === 'running' || state.status === 'degraded') && Number(state.pid || 0) === Number(child.pid || 0)) {
            console.log(`[proxy] daemon started pid=${state.pid} validPorts=${JSON.stringify(state.validPorts)}`);
            return state;
        }
        if (!isProcessAlive(child.pid)) {
            break;
        }
    }

    const latestState = getPersistedPoolState(options);
    throw new Error(latestState.lastError || 'daemon startup timed out');
}

function stopManagedDaemon(options = {}) {
    const state = getPersistedPoolState(options);
    if (state.started && state.corePid) {
        try {
            process.kill(state.corePid);
        } catch (error) {
            // ignore
        }
    }
    if (state.started && state.pid) {
        try {
            process.kill(state.pid);
        } catch (error) {
            // ignore
        }
    }
    removeStateFile(options);
    console.log('[proxy] daemon stopped');
    return getPersistedPoolState(options);
}

async function restartManagedDaemon(options = {}) {
    stopManagedDaemon(options);
    await sleep(1000);
    return startManagedDaemon(options);
}

module.exports = ProxyManager;
module.exports.DEFAULT_STATE_FILE_PATH = DEFAULT_STATE_FILE_PATH;
module.exports.DEFAULT_LOCK_FILE_PATH = DEFAULT_LOCK_FILE_PATH;
module.exports.DEFAULT_SING_BOX_VERSION = DEFAULT_SING_BOX_VERSION;
module.exports.DEFAULT_SING_BOX_GITHUB_BASE_URL = DEFAULT_SING_BOX_GITHUB_BASE_URL;
module.exports.resolveModuleConfig = resolveModuleConfig;
module.exports.getSingBoxAssetInfo = getSingBoxAssetInfo;
module.exports.getSingBoxDownloadUrl = getSingBoxDownloadUrl;
module.exports.ensureSingBoxBinary = ensureSingBoxBinary;
module.exports.getPersistedPoolState = getPersistedPoolState;
module.exports.startDaemon = startManagedDaemon;
module.exports.stopDaemon = stopManagedDaemon;
module.exports.restartDaemon = restartManagedDaemon;
module.exports.verifyProxyPort = verifyProxyPort;
module.exports.resolveRuntimeProxy = resolveRuntimeProxy;
module.exports.normalizeUseProxy = normalizeUseProxy;
module.exports.extractIpAddress = extractIpAddress;

if (require.main === module) {
    const action = String(process.argv[2] || 'start').trim().toLowerCase();

    if (action === 'status') {
        console.log(JSON.stringify(getPersistedPoolState(), null, 2));
        process.exit(0);
    }

    if (action === 'stop') {
        stopManagedDaemon();
        process.exit(0);
    }

    if (action === 'restart') {
        restartManagedDaemon().catch((error) => {
            console.error(`[proxy] ${error.message}`);
            process.exit(1);
        });
        return;
    }

    if (action === 'rotate-ip') {
        rotateProxyIp(process.argv.slice(3)).catch((error) => {
            console.error(`[proxy] ${error.message}`);
            process.exit(1);
        });
        return;
    }

    if (action === 'daemon-run') {
        runDaemon().catch((error) => {
            console.error(`[proxy] ${error.message}`);
            process.exit(1);
        });
        return;
    }

    if (action === 'start-daemon') {
        startManagedDaemon().catch((error) => {
            console.error(`[proxy] ${error.message}`);
            process.exit(1);
        });
        return;
    }

    const manager = new ProxyManager();
    process.on('SIGINT', () => {
        manager.stop();
        process.exit(0);
    });
    manager.start()
        .then(async () => {
            const result = await manager.waitForProcessExit();
            manager.stop({ silent: true });
            if (result.code !== 0) {
                console.error(`[proxy] sing-box exited code=${result.code} signal=${result.signal || 'unknown'}`);
                process.exit(typeof result.code === 'number' ? result.code : 1);
            }
        })
        .catch((error) => {
            console.error(`[proxy] ${error.message}`);
            manager.stop();
            process.exit(1);
        });
}
