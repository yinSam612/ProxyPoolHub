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
    const manager = new ProxyManager({ listenAddress: '127.0.0.1', proxyUsername: 'test', proxyPassword: 'test-only-secret' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pph-reality-'));
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
        target = http.createServer((request, response) => { response.end('reality-direct-route-ok'); });
        const targetPort = await listen(target);
        const mixedPort = await freePort();
        const realityPort = await freePort();
        const clientPort = await freePort();
        const proxies = [{ proxyId: 'local', tag: 'node-local', type: 'direct', listenPort: mixedPort }];
        const relay = { ...credentials, proxyId: 'local', listenPort: realityPort, serverName: 'localhost' };
        const config = manager.generateConfig(proxies, [], [relay]);
        assert.deepStrictEqual(config.route.rules[1], { inbound: ['reality-local'], outbound: 'node-local' });
        assert.throws(() => manager.generateConfig(proxies, [], [{ ...relay, listenPort: mixedPort }]), /invalid Reality TCP port/);
        assert.throws(() => manager.generateConfig(proxies, [], [relay, relay]), /invalid Reality target/);
        assert.throws(() => manager.generateConfig(proxies, [], [{ ...relay, proxyId: 'missing' }]), /invalid Reality target/);
        // Local TLS target avoids any external service dependency in the transport test.
        config.inbounds[1].tls.reality.handshake = { server: '127.0.0.1', server_port: handshakePort };
        outbound.server_port = realityPort;
        delete outbound.displayName;
        const client = {
            log: { level: 'debug' },
            inbounds: [{ type: 'mixed', tag: 'client', listen: '127.0.0.1', listen_port: clientPort }],
            outbounds: [outbound], route: { final: outbound.tag }
        };
        let logs = '';
        for (const [name, value] of [['server', config], ['client', client]]) {
            const file = path.join(dir, `${name}.json`);
            fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
            execFileSync(binary, ['check', '-c', file]);
            const proc = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            processes.push(proc);
            proc.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-8000); });
            proc.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-8000); });
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
        const body = await new Promise((resolve, reject) => {
            const request = http.get({ host: '127.0.0.1', port: clientPort, path: `http://127.0.0.1:${targetPort}/`, timeout: 8000 }, (response) => {
                let body = '';
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve(body));
            });
            request.on('timeout', () => request.destroy(new Error('Reality transport timed out')));
            request.on('error', (error) => reject(new Error(`${error.message}\n${logs}`)));
        });
        assert.strictEqual(body, 'reality-direct-route-ok', logs);
        console.log('Reality passed: X25519 keys, RAW/TCP import, configuration checks, bound routes and actual Vision/Reality traffic.');
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
