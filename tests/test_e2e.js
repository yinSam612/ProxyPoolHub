'use strict';

/**
 * @file test_e2e.js
 * @description 端到端完整验证：快速启动、TOTP 动态码绑定与登录、节点毫秒级启停
 */

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const totp = require('../src/utils/totp');

const path = require('path');
const fs = require('fs');
const TEST_PORT = 3199;
const ADMIN_USER = 'testadmin';
const ADMIN_PASS = 'testpassword123';
const TEMP_DATA_FILE = path.join(__dirname, 'temp_e2e_data.json');

// 初始化干净的测试数据文件，避免和用户本地运行中的 40000 端口冲突
fs.writeFileSync(TEMP_DATA_FILE, JSON.stringify({
    version: 1,
    settings: {},
    proxies: [
        {
            id: "test-node-1",
            name: "Test-Node-1",
            link: "vless://2bcf8cc8-caa8-4c4b-a069-4be58b233fb9@45.66.128.48:63997?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=iNKE_lgNSOKnuFSTKNbHmaKEdcHWd7NEhCVLZFo04S4&sid=d75c98fd&type=tcp#test1",
            enabled: true,
            listenPort: 42001,
            status: "online",
            latencyMs: 120
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
    const serverProc = spawn(process.execPath, ['server.js'], {
        cwd: __dirname + '/..',
        env: {
            ...process.env,
            ADMIN_USER,
            ADMIN_PASSWORD: ADMIN_PASS,
            PROXY_USERNAME: 'proxy',
            PROXY_PASSWORD: 'proxypassword',
            PROXY_DATA_FILE: TEMP_DATA_FILE,
            WEB_PORT: String(TEST_PORT),
            WEB_HOST: '127.0.0.1',
            REQUIRE_AUTH: 'true',
            PROXY_START_PORT: '42000',
            PROXY_PUBLISHED_LAST_PORT: '42050'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stdout.on('data', (d) => process.stdout.write(`[Server stdout] ${d}`));
    serverProc.stderr.on('data', (d) => process.stderr.write(`[Server stderr] ${d}`));

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
        assert.strictEqual(loginPageRes.body.includes('ProxyPoolHub'), true);
        assert.strictEqual(loginPageRes.body.includes('Google 动态验证码'), true);
        console.log('✓ 2. 登录页面成功渲染双模式 Tab 结构');

        // 3. 使用初始静态密码登录
        const loginPost = `username=${encodeURIComponent(ADMIN_USER)}&password=${encodeURIComponent(ADMIN_PASS)}`;
        const loginRes = await request({
            path: '/login',
            method: 'POST',
            headers: {
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
        const bindPayload = JSON.stringify({ code: validTotpCode, secret: totpSetupData.secret });
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

        // 8. 核心关键测试：【仅使用账号 + Google 身份验证器 6 位动态验证码】直接快捷登录（无需长密码）
        const newTotpCode = totp.generateTotp(totpSetupData.secret);
        const totpLoginPayload = `username=${encodeURIComponent(ADMIN_USER)}&totpCode=${encodeURIComponent(newTotpCode)}`;
        const totpLoginRes = await request({
            path: '/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(totpLoginPayload)
            }
        }, totpLoginPayload);

        assert.strictEqual(totpLoginRes.status, 303, 'TOTP 动态码登录应当成功重定向');
        const totpSessionCookie = totpLoginRes.headers['set-cookie'][0].split(';')[0];
        console.log('✓ 8. 【重点特性通过】使用 Google Authenticator 6 位动态码成功免密登录！');

        // 9. 性能测试：验证节点操作是否不再卡顿
        const listRes = await request({
            path: '/api/proxies',
            method: 'GET',
            headers: { 'Cookie': totpSessionCookie }
        });
        const proxies = JSON.parse(listRes.body);
        if (proxies.length > 0) {
            const testNode = proxies[0];
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
            link: 'vless://2bcf8cc8-caa8-4c4b-a069-4be58b233fb9@45.66.128.48:63991?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=iNKE_lgNSOKnuFSTKNbHmaKEdcHWd7NEhCVLZFo04S4&sid=d75c98fd&type=tcp#batch1',
            name: 'Batch1'
        }));
        assert.strictEqual(addNode1.status, 201);
        const node1 = JSON.parse(addNode1.body);

        const addNode2 = await request({
            path: '/api/proxies',
            method: 'POST',
            headers: { 'Cookie': totpSessionCookie, 'Content-Type': 'application/json' }
        }, JSON.stringify({
            link: 'vless://2bcf8cc8-caa8-4c4b-a069-4be58b233fb9@45.66.128.48:63992?encryption=none&flow=xtls-rprx-vision&security=reality&sni=apple.com&fp=chrome&pbk=iNKE_lgNSOKnuFSTKNbHmaKEdcHWd7NEhCVLZFo04S4&sid=d75c98fd&type=tcp#batch2',
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

        console.log('\n🎉 ALL E2E INTEGRATION TESTS PASSED!');
    } finally {
        serverProc.kill();
        try { fs.unlinkSync(TEMP_DATA_FILE); } catch (e) {}
    }
}

run().catch((err) => {
    console.error('E2E Test Failed:', err);
    process.exit(1);
});
