'use strict';

/**
 * @file test_e2e.js
 * @description 端到端完整验证：快速启动、TOTP 动态码绑定与登录、节点毫秒级启停
 */

const assert = require('assert');
const http = require('http');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const ProxyManager = require('../src/core/proxy-manager');
const totp = require('../src/utils/totp');

const path = require('path');
const fs = require('fs');
const TEST_PORT = 3199;
const ADMIN_USER = 'testadmin';
const ADMIN_PASS = 'testpassword123';
const TEMP_DATA_FILE = path.join(__dirname, 'temp_e2e_data.json');
const TEMP_CERT_FILE = path.join(__dirname, 'temp_e2e_cert.pem');
const TEMP_KEY_FILE = path.join(__dirname, 'temp_e2e_key.pem');
const TEMP_RUNTIME_DIR = path.join(__dirname, 'temp_e2e_runtime');

// 初始化干净的测试数据文件，避免和用户本地运行中的 40000 端口冲突
fs.writeFileSync(TEMP_DATA_FILE, JSON.stringify({
    version: 1,
    settings: { hy2Host: 'relay.example.test' },
    relays: [
        { id: '000000000000000000000000', listenPort: 50010, password: 'legacy', enabled: true },
        { id: '111111111111111111111111', proxyId: 'test-node-1', listenPort: 50011, password: 'preserved', enabled: false }
    ],
    proxies: [
        {
            id: "test-node-1",
            name: "VPS-1",
            link: "vless://11111111-1111-4111-8111-111111111111@192.0.2.10:63997?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&sid=01234567&type=tcp#test1",
            enabled: true,
            listenPort: 42001,
            status: "online",
            latencyMs: 120,
            exitIp: '198.51.100.10',
            countryCode: 'US',
            location: 'United States / California / Los Angeles'
        }
    ]
}, null, 2));

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(options, postData = '') {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: TEST_PORT,
            ...options
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function run() {
    console.log('[E2E] 正在启动测试服务...');
    const binary = await ProxyManager.ensureSingBoxBinary();
    const serverProc = spawn(process.execPath, ['server.js'], {
        cwd: __dirname + '/..',
        env: {
            ...process.env,
            ADMIN_USER,
            ADMIN_PASSWORD: ADMIN_PASS,
            PROXY_USERNAME: 'proxy',
            PROXY_PASSWORD: 'proxypassword',
            PROXY_DATA_FILE: TEMP_DATA_FILE,
            PROXY_RUNTIME_DIR: TEMP_RUNTIME_DIR,
            SING_BOX_BIN: binary,
            WEB_PORT: String(TEST_PORT),
            WEB_HOST: '127.0.0.1',
            REQUIRE_AUTH: 'true',
            MANAGE_FIREWALL: 'false',
            TRUSTED_PROXY_CIDRS: '',
            WEB_ALLOWED_CIDRS: '127.0.0.1/32,::1/128',
            PROXY_START_PORT: '42000',
            PROXY_LOCAL_PORT: '41999',
            PROXY_PUBLISHED_LAST_PORT: '42050',
            PROXY_LISTEN_ADDRESS: '127.0.0.1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stdout.on('data', (d) => process.stdout.write(`[Server stdout] ${d}`));
    let capturedStderr = '';
    serverProc.stderr.on('data', (d) => { capturedStderr += d; process.stderr.write(`[Server stderr] ${d}`); });
    let occupiedSocket = null;
    let occupiedTcp = null;

    try {
        // 等待服务端口就绪
        let ready = false;
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            try {
                const res = await request({ path: '/login', method: 'GET' });
                if (res.status === 200) {
                    ready = true;
                    break;
                }
            } catch (e) {
                // 等待就绪
            }
        }
        assert.strictEqual(ready, true, '服务未能在超时时间内启动');
        console.log('✓ 1. 服务成功监听在测试端口', TEST_PORT);

        // 2. 测试获取登录页面并检查 HTML 结构
        const loginPageRes = await request({ path: '/login', method: 'GET' });
        assert.strictEqual(loginPageRes.status, 200);
        assert.strictEqual(loginPageRes.headers['referrer-policy'], 'same-origin');
        assert.strictEqual(loginPageRes.body.includes('ProxyPoolHub'), true);
        assert.strictEqual(loginPageRes.body.includes('Google 动态验证码'), true);
        assert.ok(!loginPageRes.body.includes('无需复杂密码'));
        console.log('✓ 2. 登录页面始终要求密码，并按启用状态显示动态验证码');

        // 3. 使用初始静态密码登录
        const loginPost = `username=${encodeURIComponent(ADMIN_USER)}&password=${encodeURIComponent(ADMIN_PASS)}`;
        for (const origin of ['null', 'not-a-url', 'https://attacker.example']) {
            const rejected = await request({ path: '/login', method: 'POST', headers: {
                'Content-Type': 'application/x-www-form-urlencoded', Origin: origin
            } }, loginPost);
            assert.strictEqual(rejected.status, 403, 'Invalid or opaque origins must be rejected without a URL parsing error');
        }
        const loginRes = await request({
            path: '/login',
            method: 'POST',
            headers: {
                Origin: `http://127.0.0.1:${TEST_PORT}`,
                'Sec-Fetch-Site': 'same-origin',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(loginPost)
            }
        }, loginPost);

        assert.strictEqual(loginRes.status, 303, '静态密码登录应当 303 重定向');
        const cookieHeader = loginRes.headers['set-cookie'];
        assert.strictEqual(Boolean(cookieHeader), true, '登录后应当返回 Set-Cookie');
        const sessionCookie = cookieHeader[0].split(';')[0];
        console.log('✓ 3. 初始静态密码登录成功并获取 Session Cookie');

        // 4. 鉴权访问 API
        const statusRes = await request({
            path: '/api/status',
            method: 'GET',
            headers: { 'Cookie': sessionCookie }
        });
        assert.strictEqual(statusRes.status, 200);
        const statusData = JSON.parse(statusRes.body);
        assert.strictEqual(statusData.service, 'running');
        console.log('✓ 4. 鉴权访问 /api/status 成功');
        const accessSettings = JSON.parse((await request({ path: '/api/settings', headers: { Cookie: sessionCookie } })).body);
        assert.strictEqual(accessSettings.proxyAccess.publicTcp, 'blocked', 'loopback-bound proxies must not advertise public access');
        const invalidProxy = await request({ port: 41999, path: 'http://api.ipify.org/', headers: { Host: 'api.ipify.org', 'Proxy-Authorization': `Basic ${Buffer.from('wrong:proxypassword').toString('base64')}` } });
        assert.strictEqual(invalidProxy.status, 407);
        await sleep(50);
        assert.ok(capturedStderr.includes('password=[redacted]') && !capturedStderr.includes('password=proxypassword'), '真实内核认证失败日志必须脱敏');

        // 5. 获取 TOTP 配置信息
        const totpSetupRes = await request({
            path: '/api/totp/setup',
            method: 'GET',
            headers: { 'Cookie': sessionCookie }
        });
        assert.strictEqual(totpSetupRes.status, 200);
        const totpSetupData = JSON.parse(totpSetupRes.body);
        assert.strictEqual(Boolean(totpSetupData.secret), true);
        assert.strictEqual(totpSetupData.otpauthUrl.includes('otpauth://totp/'), true);
        console.log('✓ 5. 获取 TOTP Secret 成功:', totpSetupData.secret);

        // 6. 绑定 TOTP（动态验证码校验）
        const validTotpCode = totp.generateTotp(totpSetupData.secret);
        const bindPayload = JSON.stringify({ code: validTotpCode, secret: totpSetupData.secret, currentPassword: ADMIN_PASS });
        const bindRes = await request({
            path: '/api/totp/verify-bind',
            method: 'POST',
            headers: {
                'Cookie': sessionCookie,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bindPayload)
            }
        }, bindPayload);
        assert.strictEqual(bindRes.status, 200);
        console.log('✓ 6. 使用 6 位动态验证码成功激活并绑定 Google 身份验证器');

        // 7. 退出登录
        const logoutRes = await request({
            path: '/logout',
            method: 'POST',
            headers: { 'Cookie': sessionCookie }
        });
        assert.strictEqual(logoutRes.status, 303);
        console.log('✓ 7. 成功登出');

        // Both factors are required; Basic authentication cannot bypass MFA.
        const newTotpCode = totp.generateTotp(totpSetupData.secret);
        const onlyTotp = `username=${ADMIN_USER}&totpCode=${newTotpCode}`;
        const loginHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
        assert.strictEqual((await request({ path: '/login', method: 'POST', headers: loginHeaders }, onlyTotp)).status, 401);
        assert.strictEqual((await request({ path: '/login', method: 'POST', headers: loginHeaders }, loginPost)).status, 401);
        assert.strictEqual((await request({ path: '/api/status', headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}` } })).status, 401);
        assert.strictEqual((await request({ path: '/api/status', headers: { Cookie: sessionCookie } })).status, 401, '开启 MFA 使旧会话失效');
        const totpLoginPayload = `${loginPost}&totpCode=${newTotpCode}`;
        const totpLoginRes = await request({
            path: '/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(totpLoginPayload)
            }
        }, totpLoginPayload);

        assert.strictEqual(totpLoginRes.status, 303, 'TOTP 动态码登录应当成功重定向');
        let totpSessionCookie = totpLoginRes.headers['set-cookie'][0].split(';')[0];
        assert.strictEqual((await request({ path: '/login', method: 'POST', headers: loginHeaders }, totpLoginPayload)).status, 401, '已使用的验证码不能重复登录');
        const enabledSetup = JSON.parse((await request({ path: '/api/totp/setup', headers: { Cookie: totpSessionCookie } })).body);
        assert.strictEqual(enabledSetup.secret, undefined, '已启用的 TOTP 密钥不能再次读取');
        assert.strictEqual((await request({ path: '/api/totp/disable', method: 'POST', headers: { Cookie: totpSessionCookie, 'Content-Type': 'application/json' } }, JSON.stringify({ currentPassword: ADMIN_PASS }))).status, 403);
        const disabledTotp = await request({ path: '/api/totp/disable', method: 'POST', headers: { Cookie: totpSessionCookie, 'Content-Type': 'application/json' } }, JSON.stringify({ currentPassword: ADMIN_PASS, totpCode: newTotpCode }));
        assert.strictEqual(disabledTotp.status, 200);
        assert.strictEqual((await request({ path: '/api/status', headers: { Cookie: totpSessionCookie } })).status, 401);
        const freshLogin = await request({ path: '/login', method: 'POST', headers: loginHeaders }, loginPost);
        totpSessionCookie = freshLogin.headers['set-cookie'][0].split(';')[0];
        console.log('✓ 8. 密码+TOTP、禁止密码/验证码/Basic 绕过、防重放、敏感操作重认证和旧会话失效通过');

        // 9. 性能测试：验证节点操作是否不再卡顿
        const listRes = await request({
            path: '/api/proxies',
            method: 'GET',
            headers: { 'Cookie': totpSessionCookie }
        });
        const proxies = JSON.parse(listRes.body);
        assert.strictEqual(proxies[0].isLocal, true);
        assert.strictEqual(proxies[0].name, os.hostname(), '自身节点名称应使用系统主机名');
        assert.strictEqual(proxies[0].listenPort, 41999);
        const initialConfig = JSON.parse(fs.readFileSync(path.join(TEMP_RUNTIME_DIR, 'temp_singbox_config.json'), 'utf8'));
        assert.strictEqual(initialConfig.outbounds.find((item) => item.tag === 'proxy-0').type, 'direct');
        assert.strictEqual(initialConfig.route.rules[0].outbound, 'proxy-0');
        assert.strictEqual((await request({ path: `/api/proxies/${proxies[0].id}`, method: 'DELETE', headers: { Cookie: totpSessionCookie } })).status, 403);
        assert.strictEqual((await request({ path: '/api/proxies/batch-delete', method: 'POST', headers: { Cookie: totpSessionCookie, 'Content-Type': 'application/json' } }, JSON.stringify({ ids: [proxies[0].id] }))).status, 200);
        assert.strictEqual((await request({ path: `/api/proxies/${proxies[0].id}/disable`, method: 'POST', headers: { Cookie: totpSessionCookie } })).status, 200);
        assert.strictEqual(JSON.parse((await request({ path: '/api/proxies', headers: { Cookie: totpSessionCookie } })).body)[0].enabled, false);
        if (proxies.length > 0) {
            const testNode = proxies.find((item) => !item.isLocal);
            const action = testNode.enabled ? 'disable' : 'enable';
            const t0 = Date.now();
            const actionRes = await request({
                path: `/api/proxies/${testNode.id}/${action}`,
                method: 'POST',
                headers: { 'Cookie': totpSessionCookie }
            });
            const duration = Date.now() - t0;
            assert.strictEqual(actionRes.status, 200);
            console.log(`✓ 9. 【性能优化通过】节点开关操作仅耗时 ${duration}ms (彻底解除原有十秒级卡死阻塞)`);
            assert.strictEqual(duration < 2500, true, '操作耗时应当在安全响应时间内');
        }

        // 10. 批量删除测试：添加两个临时节点并验证原子批量删除
        const addNode1 = await request({
            path: '/api/proxies',
            method: 'POST',
            headers: { 'Cookie': totpSessionCookie, 'Content-Type': 'application/json' }
        }, JSON.stringify({
            link: 'vless://11111111-1111-4111-8111-111111111111@192.0.2.10:63991?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&sid=01234567&type=tcp#batch1',
            name: 'Batch1'
        }));
        assert.strictEqual(addNode1.status, 201);
        const node1 = JSON.parse(addNode1.body);

        const addNode2 = await request({
            path: '/api/proxies',
            method: 'POST',
            headers: { 'Cookie': totpSessionCookie, 'Content-Type': 'application/json' }
        }, JSON.stringify({
            link: 'vless://11111111-1111-4111-8111-111111111111@192.0.2.10:63992?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&sid=01234567&type=tcp#batch2',
            name: 'Batch2'
        }));
        assert.strictEqual(addNode2.status, 201);
        const node2 = JSON.parse(addNode2.body);

        const batchDelRes = await request({
            path: '/api/proxies/batch-delete',
            method: 'POST',
            headers: { 'Cookie': totpSessionCookie, 'Content-Type': 'application/json' }
        }, JSON.stringify({ ids: [node1.id, node2.id] }));
        assert.strictEqual(batchDelRes.status, 200);
        const batchDelData = JSON.parse(batchDelRes.body);
        assert.strictEqual(batchDelData.ok, true);
        assert.strictEqual(batchDelData.deleted, 2);
        console.log('✓ 10. 【批量删除通过】原子事务成功批量删除 2 个节点！');

        const importHeaders = { Cookie: totpSessionCookie, 'Content-Type': 'application/json' };
        const portableNode = { name: 'Portable 节点', link: 'trojan://portable@127.0.0.1:9?sni=portable.example.test#portable', enabled: false };
        const importBackup = await request({ path: '/api/proxies/import', method: 'POST', headers: importHeaders }, JSON.stringify({ links: JSON.stringify({ version: 1, nodes: [portableNode] }) }));
        assert.strictEqual(importBackup.status, 201, importBackup.body);
        const exported = await request({ path: '/api/proxies/export', headers: importHeaders });
        const backup = JSON.parse(exported.body);
        assert.strictEqual(backup.version, 1);
        assert.ok(exported.headers['content-disposition'].includes('.json'));
        assert.strictEqual(backup.nodes.length, 2, '本机节点不导出');
        assert.deepStrictEqual(backup.nodes.find((item) => item.name === portableNode.name), portableNode);
        assert.ok(!exported.body.includes('subscriptionToken') && !exported.body.includes('totpSecret'), '导出不能包含管理凭据');
        const exportedNodes = JSON.parse((await request({ path: '/api/proxies', headers: importHeaders })).body);
        const portable = exportedNodes.find((item) => item.name === portableNode.name);
        await request({ path: `/api/proxies/${portable.id}`, method: 'DELETE', headers: importHeaders });
        const reimport = await request({ path: '/api/proxies/import', method: 'POST', headers: importHeaders }, JSON.stringify({ links: exported.body }));
        assert.strictEqual(reimport.status, 201);
        assert.strictEqual(JSON.parse(reimport.body).added, 1);
        assert.strictEqual(JSON.parse(reimport.body).skipped, 1);
        const restored = JSON.parse((await request({ path: '/api/proxies', headers: importHeaders })).body).find((item) => item.name === portableNode.name);
        assert.strictEqual(restored.enabled, false);
        await request({ path: `/api/proxies/${restored.id}`, method: 'DELETE', headers: importHeaders });
        assert.strictEqual((await request({ path: '/api/proxies/import', method: 'POST', headers: importHeaders }, JSON.stringify({ links: '{"version":99,"nodes":[]}' }))).status, 400);
        console.log('✓ 本机节点保护、JSON 导出/导入、名称和启用状态保留通过');

        const relayStatus = await request({ path: '/api/relays', headers: { Cookie: totpSessionCookie } });
        assert.strictEqual(relayStatus.status, 200);
        assert.strictEqual(JSON.parse(relayStatus.body).relays[0].status, 'unbound');
        const migratedRelay = JSON.parse(relayStatus.body).relays[1];
        assert.strictEqual(migratedRelay.listenPort, 42001, '旧 HY2 端口应迁移为节点端口');
        assert.strictEqual(new URL(migratedRelay.link).username, 'preserved', '迁移不修改 HY2 密码');
        assert.strictEqual(decodeURIComponent(new URL(migratedRelay.link).hash), '#VPS-1:198.51.100.10-US');
        assert.strictEqual((await request({ path: '/api/relays/111111111111111111111111', method: 'DELETE', headers: { Cookie: totpSessionCookie } })).status, 200);
        const unboundEnable = await request({ path: '/api/relays/000000000000000000000000/enable', method: 'POST', headers: { Cookie: totpSessionCookie } });
        assert.strictEqual(unboundEnable.status, 400, '旧版未绑定出口不能继续直连');
        const removeUnbound = await request({ path: '/api/relays/000000000000000000000000', method: 'DELETE', headers: { Cookie: totpSessionCookie } });
        assert.strictEqual(removeUnbound.status, 200);
        const noTlsRelay = await request({ path: '/api/relays', method: 'POST', headers: { Cookie: totpSessionCookie } });
        assert.strictEqual(noTlsRelay.status, 400, '无 TLS 证书时不可开启 HY2');

        const relayHeaders = { Cookie: totpSessionCookie, 'Content-Type': 'application/json' };
        const invalidAcme = await request({ path: '/api/relays/tls', method: 'PUT', headers: relayHeaders }, JSON.stringify({
            mode: 'auto', host: '127.0.0.1'
        }));
        assert.strictEqual(invalidAcme.status, 400, '自动签发不允许 IP');
        const acmeRes = await request({ path: '/api/relays/tls', method: 'PUT', headers: relayHeaders }, JSON.stringify({
            mode: 'auto', host: 'relay.example.com'
        }));
        assert.strictEqual(acmeRes.status, 200, acmeRes.body);
        const acmeStatus = JSON.parse((await request({ path: '/api/relays', headers: relayHeaders })).body).tls;
        assert.strictEqual(acmeStatus.mode, 'auto');
        assert.strictEqual(acmeStatus.status, 'not_requested');

        const pem = execFileSync(binary, ['generate', 'tls-keypair', 'relay.example.test'], { encoding: 'utf8' });
        fs.writeFileSync(TEMP_CERT_FILE, pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0]);
        fs.writeFileSync(TEMP_KEY_FILE, pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)[0], { mode: 0o600 });
        const tlsRes = await request({ path: '/api/relays/tls', method: 'PUT', headers: relayHeaders }, JSON.stringify({
            mode: 'manual', host: 'relay.example.test', certificatePath: TEMP_CERT_FILE, keyPath: TEMP_KEY_FILE
        }));
        assert.strictEqual(tlsRes.status, 200, tlsRes.body);
        const relayApi = async (route, method = 'GET', body) => request({ path: route, method, headers: relayHeaders }, body ? JSON.stringify(body) : '');
        assert.strictEqual((await relayApi('/api/relays', 'POST', { proxyId: 'missing' })).status, 400);
        assert.strictEqual((await relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' })).status, 400, '关联节点停用时不可新增出口');
        const enabledRelayNode = await relayApi('/api/proxies/test-node-1/enable', 'POST');
        assert.strictEqual(enabledRelayNode.status, 200, enabledRelayNode.body);
        occupiedSocket = dgram.createSocket('udp4');
        await new Promise((resolve, reject) => {
            occupiedSocket.once('error', reject);
            occupiedSocket.bind({ port: 42001, address: '127.0.0.1', exclusive: true }, resolve);
        });
        assert.strictEqual((await relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' })).status, 400, '同号 UDP 被占用时应报错，不另开端口');
        await new Promise((resolve) => occupiedSocket.close(resolve));
        occupiedSocket = null;
        const createRelay = await relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' });
        assert.strictEqual(createRelay.status, 201, createRelay.body);
        const relay = JSON.parse(createRelay.body);
        assert.strictEqual(relay.proxyId, 'test-node-1');
        assert.strictEqual(relay.listenPort, 42001);
        assert.ok(relay.link.startsWith('hysteria2://'));
        assert.strictEqual(decodeURIComponent(new URL(relay.link).hash), '#VPS-1:198.51.100.10-US');
        const repeated = await Promise.all([relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' }), relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' })]);
        for (const res of repeated) {
            assert.strictEqual(res.status, 200);
            assert.strictEqual(JSON.parse(res.body).id, relay.id, '重复开启不能新增 HY2 出口或修改密码');
        }
        const activeRelay = JSON.parse((await request({ path: '/api/relays', headers: relayHeaders })).body);
        assert.strictEqual(activeRelay.managedCore, true);
        assert.strictEqual(activeRelay.relays.length, 1);
        const relayConfig = () => JSON.parse(fs.readFileSync(path.join(TEMP_RUNTIME_DIR, 'temp_singbox_config.json'), 'utf8'));
        assert.strictEqual(relayConfig().inbounds.find((item) => item.type === 'mixed').listen_port, relayConfig().inbounds.find((item) => item.type === 'hysteria2').listen_port);
        const relayOutbound = (id = relay.id) => relayConfig().route.rules.find((rule) => rule.inbound.includes(`hy2-relay-${id}`))?.outbound;
        assert.strictEqual(relayOutbound(), 'proxy-0');
        for (const [suffix, method] of [['/disable', 'POST'], ['/enable', 'POST']]) {
            const res = await request({ path: `/api/relays/${relay.id}${suffix}`, method, headers: relayHeaders });
            assert.strictEqual(res.status, 200, res.body);
        }
        const secondRes = await relayApi('/api/proxies', 'POST', { name: 'Second relay node', link: 'trojan://secret@127.0.0.1:9?sni=relay.example.test#second' });
        assert.strictEqual(secondRes.status, 201, secondRes.body);
        const second = JSON.parse(secondRes.body);
        assert.strictEqual((await relayApi(`/api/relays/${relay.id}`, 'PUT', { proxyId: second.id })).status, 405, '节点出口不可重新绑定为其他节点');
        const secondRelayRes = await relayApi('/api/relays', 'POST', { proxyId: second.id });
        assert.strictEqual(secondRelayRes.status, 201);
        const secondRelay = JSON.parse(secondRelayRes.body);
        assert.strictEqual(secondRelay.listenPort, second.listenPort);
        assert.strictEqual(relayOutbound(secondRelay.id), 'proxy-1');
        const realityPath = '/api/proxies/test-node-1/reality';
        assert.strictEqual((await relayApi(realityPath, 'PUT', { host: 'http://bad', serverName: 'www.microsoft.com' })).status, 400);
        assert.strictEqual((await relayApi(realityPath, 'PUT', { host: '203.0.113.10', serverName: 'localhost' })).status, 400);
        occupiedTcp = net.createServer();
        await new Promise((resolve, reject) => { occupiedTcp.once('error', reject); occupiedTcp.listen(50000, '127.0.0.1', resolve); });
        const firstReality = await relayApi(realityPath, 'PUT', { host: '203.0.113.10', serverName: 'www.microsoft.com' });
        assert.strictEqual(firstReality.status, 200, firstReality.body);
        const reality = JSON.parse(firstReality.body);
        assert.strictEqual(reality.listenPort, 50001, '自动跳过被其他服务占用的 TCP 端口');
        await new Promise((resolve) => occupiedTcp.close(resolve));
        occupiedTcp = null;
        assert.strictEqual(reality.link.includes('privateKey'), false);
        const realityUrl = new URL(reality.link);
        assert.strictEqual(realityUrl.searchParams.get('type'), 'raw');
        assert.strictEqual(realityUrl.searchParams.get('security'), 'reality');
        assert.strictEqual(realityUrl.searchParams.get('flow'), 'xtls-rprx-vision');
        assert.strictEqual(decodeURIComponent(realityUrl.hash), '#VPS-1:198.51.100.10-US');
        const credentials = JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality;
        assert.strictEqual(Buffer.from(credentials.privateKey, 'base64url').length, 32);
        assert.strictEqual((await relayApi(realityPath, 'PUT', { host: '203.0.113.10', enabled: 'false' })).status, 400);
        assert.strictEqual(JSON.parse((await relayApi(realityPath, 'PUT', { host: '203.0.113.10' })).body).link, reality.link);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality, credentials);
        assert.strictEqual((await relayApi(`${realityPath}/rotate`, 'POST', {})).status, 403);
        const rotatedReality = JSON.parse((await relayApi(`${realityPath}/rotate`, 'POST', { currentPassword: ADMIN_PASS })).body);
        assert.strictEqual(rotatedReality.listenPort, reality.listenPort);
        assert.notStrictEqual(new URL(rotatedReality.link).username, realityUrl.username);
        assert.notStrictEqual(JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality.privateKey, credentials.privateKey);
        const currentRelay = JSON.parse((await relayApi('/api/relays')).body).relays[0];
        const rotatedHy2 = JSON.parse((await relayApi(`/api/relays/${currentRelay.id}/rotate`, 'POST', { currentPassword: ADMIN_PASS })).body);
        assert.strictEqual(rotatedHy2.listenPort, currentRelay.listenPort);
        assert.notStrictEqual(new URL(rotatedHy2.link).username, new URL(currentRelay.link).username);
        const realityOutbound = () => relayConfig().route.rules.find((rule) => rule.inbound.includes('reality-test-node-1'))?.outbound;
        assert.strictEqual(realityOutbound(), 'proxy-0');
        execFileSync(binary, ['check', '-c', path.join(TEMP_RUNTIME_DIR, 'temp_singbox_config.json')]);
        assert.strictEqual((await relayApi('/api/proxies/test-node-1/disable', 'POST')).status, 200);
        assert.strictEqual(realityOutbound(), undefined);
        assert.strictEqual((await relayApi(realityPath, 'PUT', { enabled: true })).status, 400);
        assert.strictEqual(relayOutbound(), undefined);
        assert.strictEqual(relayOutbound(secondRelay.id), 'proxy-0', '节点索引变化后 HY2 仍指向绑定节点');
        assert.strictEqual((await relayApi(`/api/proxies/${second.id}/disable`, 'POST')).status, 200);
        assert.strictEqual(JSON.parse((await relayApi('/api/relays')).body).relays[0].status, 'node_disabled');
        assert.strictEqual((await relayApi(`/api/relays/${secondRelay.id}/enable`, 'POST')).status, 400);
        assert.strictEqual((await relayApi(`/api/proxies/${second.id}/enable`, 'POST')).status, 200);
        assert.strictEqual(relayOutbound(secondRelay.id), 'proxy-0');
        assert.strictEqual((await relayApi(`/api/proxies/${second.id}`, 'DELETE')).status, 200);
        assert.deepStrictEqual(JSON.parse((await relayApi('/api/relays')).body).relays.map((item) => item.id), [relay.id]);
        assert.strictEqual((await relayApi('/api/proxies/test-node-1/enable', 'POST')).status, 200);
        assert.strictEqual(realityOutbound(), 'proxy-0');
        const realityBeforeToggle = JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality;
        const otherInbounds = relayConfig().inbounds.filter(item => item.type !== 'vless');
        assert.strictEqual((await relayApi(realityPath, 'PUT', { enabled: false })).status, 200);
        assert.strictEqual(realityOutbound(), undefined);
        assert.deepStrictEqual(relayConfig().inbounds, otherInbounds, 'VLESS 停用不能改变 HTTP/SOCKS5 和 HY2 入口');
        assert.strictEqual(relayOutbound(), 'proxy-0');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality,
            { ...realityBeforeToggle, enabled: false }, '单独停用应保留端口、UUID 和密钥');
        occupiedTcp = net.createServer();
        await new Promise((resolve, reject) => { occupiedTcp.once('error', reject); occupiedTcp.listen(reality.listenPort, '127.0.0.1', resolve); });
        assert.strictEqual((await relayApi(realityPath, 'PUT', { enabled: true })).status, 400, '重新启用时端口被占用应回滚配置');
        assert.strictEqual(JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality.enabled, false);
        await new Promise((resolve) => occupiedTcp.close(resolve));
        occupiedTcp = null;
        assert.strictEqual((await relayApi(realityPath, 'PUT', { enabled: true })).status, 200);
        assert.strictEqual(realityOutbound(), 'proxy-0');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.find((item) => item.id === 'test-node-1').reality, realityBeforeToggle);
        assert.strictEqual((await relayApi(`/api/relays/${relay.id}`, 'DELETE')).status, 200);
        const replacement = JSON.parse((await relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' })).body);
        assert.strictEqual((await relayApi(`/api/relays/${replacement.id}`, 'DELETE')).status, 200);
        assert.strictEqual((await relayApi('/api/relays', 'POST', { proxyId: 'test-node-1' })).status, 201);
        assert.strictEqual((await relayApi('/api/proxies/batch-delete', 'POST', { ids: ['test-node-1'] })).status, 200);
        assert.deepStrictEqual(JSON.parse((await relayApi('/api/relays')).body).relays, []);
        assert.ok(!JSON.parse(fs.readFileSync(TEMP_DATA_FILE)).proxies.some((item) => item.id === 'test-node-1'), '删除节点应删除其 Reality 配置');
        const localRealityPath = '/api/proxies/local-vps/reality';
        assert.strictEqual((await relayApi('/api/proxies/local-vps/enable', 'POST')).status, 200);
        const localReality = await relayApi(localRealityPath, 'PUT', { host: '203.0.113.10' });
        assert.strictEqual(localReality.status, 200);
        assert.ok(decodeURIComponent(new URL(JSON.parse(localReality.body).link).hash).startsWith(`#${os.hostname()}:`));
        const localHy2 = await relayApi('/api/relays', 'POST', { proxyId: 'local-vps' });
        assert.strictEqual(localHy2.status, 201);
        assert.ok(decodeURIComponent(new URL(JSON.parse(localHy2.body).link).hash).startsWith(`#${os.hostname()}:`));
        assert.ok(!JSON.parse(localHy2.body).link.includes(encodeURIComponent('本机')));
        assert.ok(relayConfig().inbounds.some((item) => item.tag === 'reality-local-vps'));
        assert.strictEqual((await relayApi(localRealityPath, 'DELETE')).status, 200);
        assert.ok(!relayConfig().inbounds.some((item) => item.type === 'vless'));

        const changePassword = async (currentPassword, newPassword) => request({
            path: '/api/admin/password', method: 'POST',
            headers: { Cookie: totpSessionCookie, 'Content-Type': 'application/json' }
        }, JSON.stringify({ currentPassword, newPassword }));
        const nextPassword = 'NewAdminPass1!#%';
        assert.strictEqual((await changePassword('wrong password', nextPassword)).status, 403);
        assert.strictEqual((await changePassword(ADMIN_PASS, 'weak')).status, 400);
        assert.strictEqual((await changePassword(ADMIN_PASS, nextPassword)).status, 200);
        assert.strictEqual((await request({ path: '/api/status', headers: { Cookie: totpSessionCookie } })).status, 401);
        assert.strictEqual((await request({ path: '/api/status', headers: {
            Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`
        } })).status, 401);
        assert.strictEqual((await request({ path: '/api/status', headers: {
            Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${nextPassword}`).toString('base64')}`
        } })).status, 200);
        assert.strictEqual((await request({ path: '/login', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, `username=${ADMIN_USER}&password=${encodeURIComponent(nextPassword)}`)).status, 303);
        const stored = JSON.parse(fs.readFileSync(TEMP_DATA_FILE, 'utf8'));
        assert.ok(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored.settings.adminPasswordHash));
        assert.ok(!fs.readFileSync(TEMP_DATA_FILE, 'utf8').includes(nextPassword));
        assert.strictEqual((await request({ path: '/api/settings', method: 'PUT', headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${nextPassword}`).toString('base64')}`, 'Content-Type': 'application/json' } }, JSON.stringify({ proxyUsername: 'proxy', proxyPassword: 'aaaaaaaaaaaaaaaa', currentPassword: nextPassword }))).status, 400, '弱代理新密码必须拒绝');
        assert.strictEqual((await request({ path: '/api/settings', method: 'PUT', headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${nextPassword}`).toString('base64')}`, Origin: 'https://attacker.example', 'Content-Type': 'application/json' } }, '{}')).status, 403);
        let throttled = false;
        for (let i = 0; i < 12; i++) {
            const result = await request({ path: '/api/status', headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:wrong`).toString('base64')}`, 'X-Real-IP': `203.0.113.${i + 1}` } });
            if (result.status === 429) { throttled = true; assert.ok(result.headers['retry-after']); break; }
        }
        assert.ok(throttled, 'Basic 暴力猜测必须受限，伪造 X-Real-IP 不能绕过');
        console.log('✓ 11. 单节点单 HY2、同号 TCP/UDP、复制备注、端口冲突、停用/删除联动及密码轮换通过');

        console.log('\n🎉 ALL E2E INTEGRATION TESTS PASSED!');
    } finally {
        if (occupiedSocket) occupiedSocket.close();
        if (occupiedTcp) occupiedTcp.close();
        serverProc.kill();
        for (const file of [TEMP_DATA_FILE, TEMP_CERT_FILE, TEMP_KEY_FILE]) {
            try { fs.unlinkSync(file); } catch (e) {}
        }
        try { fs.unlinkSync(path.join(TEMP_RUNTIME_DIR, 'temp_singbox_config.json')); fs.rmdirSync(TEMP_RUNTIME_DIR); } catch (e) {}
    }
}

run().catch((err) => {
    console.error('E2E Test Failed:', err);
    process.exit(1);
});
