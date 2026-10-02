'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const ProxyManager = require('../src/core/proxy-manager');
const { realityCredentials, validateRealityAddress } = require('../server');

const listen = (server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pph-reality-'));
    const manager = new ProxyManager({ moduleRoot: dir, listenAddress: '127.0.0.1', proxyUsername: 'test', proxyPassword: 'test-only-secret' });
    const processes = [];
    let target;
    let handshake;
    try {
        const credentials = realityCredentials();
        const key = crypto.createPrivateKey({
            key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(credentials.privateKey, 'base64url')]),
            type: 'pkcs8', format: 'der'
        });
        assert.strictEqual(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'), credentials.publicKey);
        validateRealityAddress('203.0.113.1', 'www.microsoft.com');
        assert.throws(() => validateRealityAddress('https://example.com', 'www.microsoft.com'), /invalid/);
        assert.throws(() => validateRealityAddress('example.com', 'localhost'), /invalid/);
        const link = `vless://${credentials.uuid}@127.0.0.1:443?security=reality&type=raw&flow=xtls-rprx-vision&sni=localhost&pbk=${credentials.publicKey}&sid=${credentials.shortId}`;
        const outbound = manager.parseProxyLink(link, 0);
        assert.ok(!outbound.transport, 'RAW is native TCP, not a V2Ray transport');
        assert.deepStrictEqual(manager.parseProxyLink(link.replace('type=raw', 'type=tcp'), 0), outbound);
        assert.strictEqual(manager.parseProxyLink(link.replace('type=raw', 'type=xhttp'), 0), null);

        const binary = await ProxyManager.ensureSingBoxBinary();
        const pem = execFileSync(binary, ['generate', 'tls-keypair', 'localhost'], { encoding: 'utf8' });
        handshake = tls.createServer({
            cert: pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0],
            key: pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)[0],
            minVersion: 'TLSv1.3', ALPNProtocols: ['h2', 'http/1.1']
        }, (socket) => socket.end());
        const handshakePort = await listen(handshake);
        target = http.createServer((request, response) => {
            if (request.url !== '/stream') return response.end('reality-direct-route-ok');
            response.write(Buffer.alloc(32768, 'y'));
            setTimeout(() => response.end(Buffer.alloc(32768, 'y')), 2500);
        });
        const targetPort = await listen(target);
        const mixedPort = await freePort();
        const realityPort = await freePort();
        const clientPort = await freePort();
        const hy2ClientPort = await freePort();
        const proxies = [{ proxyId: 'local', tag: 'node-local', type: 'direct', listenPort: mixedPort }];
        const relay = { ...credentials, proxyId: 'local', listenPort: realityPort, serverName: 'localhost' };
        const config = manager.generateConfig(proxies, [], [relay]);
        assert.deepStrictEqual(config.route.rules[1], { inbound: ['reality-local'], outbound: 'node-local' });
        assert.throws(() => manager.generateConfig(proxies, [], [{ ...relay, listenPort: mixedPort }]), /invalid Reality TCP port/);
        assert.throws(() => manager.generateConfig(proxies, [], [relay, relay]), /invalid Reality target/);
        assert.throws(() => manager.generateConfig(proxies, [], [{ ...relay, proxyId: 'missing' }]), /invalid Reality target/);
        const certificatePath = path.join(dir, 'cert.pem');
        const keyPath = path.join(dir, 'key.pem');
        fs.writeFileSync(certificatePath, pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
        fs.writeFileSync(keyPath, pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)[0], { mode: 0o600 });
        const hy2 = { id: 'test', proxyId: 'local', mode: 'manual', password: 'test-hy2-secret', certificatePath, keyPath };
        Object.assign(config, manager.generateConfig(proxies, [hy2], [relay]));
        config.services = [await manager.logManager.prepareAccounting()];
        // Local TLS target avoids any external service dependency in the transport test.
        config.inbounds.find(item => item.type === 'vless').tls.reality.handshake = { server: '127.0.0.1', server_port: handshakePort };
        manager.logManager.configure(config);
        outbound.server_port = realityPort;
        delete outbound.displayName;
        const client = {
            log: { level: 'debug' },
            inbounds: [{ type: 'mixed', tag: 'client', listen: '127.0.0.1', listen_port: clientPort },
                { type: 'mixed', tag: 'hy2-client', listen: '127.0.0.1', listen_port: hy2ClientPort }],
            outbounds: [outbound, { type: 'hysteria2', tag: 'hy2', server: '127.0.0.1', server_port: mixedPort, password: hy2.password,
                tls: { enabled: true, server_name: 'localhost', certificate: [fs.readFileSync(certificatePath, 'utf8')] } }],
            route: { rules: [{ inbound: ['hy2-client'], outbound: 'hy2' }], final: outbound.tag }
        };
        let logs = '';
        for (const [name, value] of [['server', config], ['client', client]]) {
            const file = path.join(dir, `${name}.json`);
            fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
            execFileSync(binary, ['check', '-c', file]);
            const proc = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            processes.push(proc);
            for (const stream of [proc.stdout, proc.stderr]) {
                let pending = '';
                stream.on('data', (chunk) => {
                    logs = (logs + chunk).slice(-8000);
                    pending += String(chunk);
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop();
                    if (name === 'server') for (const line of lines) manager.logManager.feedKernelLogLine(line);
                });
            }
        }
        manager.logManager.startAccounting();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const send = (port, route = '/') => new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${targetPort}${route}`, method: 'POST', timeout: 8000,
                headers: { 'Content-Length': 8192, Connection: 'close', ...(port === mixedPort ? {
                    'Proxy-Authorization': `Basic ${Buffer.from('test:test-only-secret').toString('base64')}`
                } : {}) } }, (response) => {
                let body = '';
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve(body));
            });
            request.on('timeout', () => request.destroy(new Error('Reality transport timed out')));
            request.on('error', (error) => reject(new Error(`${error.message}\n${logs}`)));
            request.end(Buffer.alloc(8192, 'x'));
        });
        for (const port of [clientPort, hy2ClientPort, mixedPort]) assert.strictEqual(await send(port), 'reality-direct-route-ok', logs);
        let audit;
        for (let i = 0; i < 80; i++) {
            audit = manager.logManager.getRecentLogs({ port: mixedPort, keyword: `127.0.0.1:${targetPort}` });
            if (audit.length === 3 && audit.every(item => item.status === 'closed' && item.uploadBytes >= 8192 && item.downloadBytes >= 22)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.strictEqual(audit.length, 3, logs);
        for (const [protocol, port] of [['vless', realityPort], ['hysteria2', mixedPort], ['mixed', mixedPort]]) {
            const entry = audit.find(item => item.protocol === protocol);
            assert.ok(entry, `${protocol}: actual connection must appear`);
            assert.strictEqual(entry.listenPort, port);
            assert.strictEqual(entry.outbound, 'node-local');
            assert.strictEqual(entry.status, 'closed');
            assert.ok(entry.uploadBytes >= 8192 && entry.downloadBytes >= 22, `${protocol}: final byte totals must include short-lived transfers`);
            assert.ok(entry.durationMs >= 0);
        }
        const summary = manager.logManager.getTrafficSummary()[mixedPort];
        assert.strictEqual(summary.connections, 3);
        assert.strictEqual(summary.todayUpload, audit.reduce((sum, item) => sum + item.uploadBytes, 0));
        assert.strictEqual(summary.todayDownload, audit.reduce((sum, item) => sum + item.downloadBytes, 0));
        manager.logManager.stopAccounting();
        manager.logManager.startAccounting();
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.strictEqual(manager.logManager.accountingStatus, 'connected');
        assert.strictEqual(manager.logManager.getTrafficSummary()[mixedPort].todayUpload, summary.todayUpload, 'Reconnect replay must not count bytes twice');
        assert.strictEqual(manager.logManager.getTrafficSummary()[mixedPort].connections, 3);
        const streaming = send(hy2ClientPort, '/stream');
        let live;
        for (let i = 0; i < 40; i++) {
            live = manager.logManager.getRecentLogs().find(item => item.status === 'active' && item.protocol === 'hysteria2');
            if (live?.uploadBytes >= 8192 && live.downloadBytes >= 32768 && live.durationMs >= 1000) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(live?.uploadBytes >= 8192 && live.downloadBytes >= 32768, 'Active connections must update byte totals before they close');
        manager.logManager.stopAccounting();
        manager.logManager.startAccounting();
        assert.strictEqual((await streaming).length, 65536);
        for (let i = 0; i < 40; i++) {
            audit = manager.logManager.getRecentLogs({ port: mixedPort, keyword: `127.0.0.1:${targetPort}` });
            if (audit.every(item => item.status === 'closed')) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.strictEqual(audit.length, 4);
        assert.ok(audit.every(item => item.status === 'closed'));
        const final = manager.logManager.getTrafficSummary()[mixedPort];
        assert.strictEqual(final.connections, 4);
        assert.strictEqual(final.todayUpload, audit.reduce((sum, item) => sum + item.uploadBytes, 0));
        assert.strictEqual(final.todayDownload, audit.reduce((sum, item) => sum + item.downloadBytes, 0));
        console.log('PASS: Actual HTTP, HY2 and VLESS/Reality transfers, live byte updates, short-lived close totals, node sums and active/closed reconnect deduplication');
    } finally {
        await Promise.all(processes.map((proc) => new Promise((resolve) => {
            if (proc.exitCode !== null) return resolve();
            proc.once('exit', resolve);
            proc.kill();
        })));
        if (target) await new Promise((resolve) => target.close(resolve));
        if (handshake) await new Promise((resolve) => handshake.close(resolve));
        manager.logManager.destroy();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
