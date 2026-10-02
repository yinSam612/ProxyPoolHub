'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const web = path.join(__dirname, '..', 'web');

async function run() {
    const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    try {
        const context = await browser.newContext();
        const node = { id: 'local-vps', isLocal: true, name: 'vps-machine', protocol: 'direct', listenPort: 39999,
            enabled: true, status: 'online', latencyMs: 27, exitIp: '198.51.100.1', location: 'United States / Los Angeles' };
        const calls = [];
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            const file = { '/': 'index.html', '/logs': 'logs.html', '/app.js': 'app.js', '/logs.js': 'logs.js', '/style.css': 'style.css', '/lucide.svg': 'lucide.svg' }[url.pathname];
            if (file) return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)], body: fs.readFileSync(path.join(web, file)) });
            calls.push({ path: url.pathname, started: Date.now() });
            await new Promise(resolve => setTimeout(resolve, 200));
            const responses = {
                '/api/proxies': [node], '/api/status': { core: 'running', total: 1, enabled: 1, online: 1, healthCheck: { running: false } },
                '/api/settings': { publicHost: 'example.test', proxyUsername: 'test', proxyPassword: 'test', authDisabled: true, subscriptions: {} },
                '/api/logs': { logs: [{ id: 'navigation', listenPort: 39999, protocol: 'mixed', timestamp: new Date().toISOString(), target: 'video.example:443', client: '127.0.0.1:1234' }], traffic: {}, storage: {} }
            };
            return route.fulfill({ status: responses[url.pathname] ? 200 : 404, json: responses[url.pathname] || {} });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const timings = [];
        for (const width of [1385, 390]) {
            await page.setViewportSize({ width, height: 844 });
            await page.goto('http://127.0.0.1:3185/');
            await page.locator('#row-local-vps').waitFor();
            for (let cycle = 0; cycle < 3; cycle++) {
                const firstCall = calls.length;
                const start = Date.now();
                await page.locator('a[href="/logs"]').click();
                await page.locator('.log-row').waitFor();
                const elapsed = Date.now() - start;
                const requests = calls.slice(firstCall);
                const nodes = requests.filter(call => call.path === '/api/proxies');
                const logs = requests.filter(call => call.path === '/api/logs');
                const spread = Math.abs(nodes[0].started - logs[0].started);
                timings.push({ width, cycle, readyMs: elapsed, requestSpreadMs: spread });
                assert.strictEqual(nodes.length, 1, 'Navigation must fetch nodes only once');
                assert.strictEqual(logs.length, 1, 'Navigation must fetch logs only once');
                if (!process.env.PPH_NAV_BASELINE) assert.ok(spread < 100, `Node and log requests must start concurrently, not ${spread}ms apart`);
                assert.strictEqual(await page.locator('.log-node-label').innerText(), node.name, 'First paint must have the correct node name');
                assert.ok(await page.locator('.logs-table-wrap').evaluate(element => element.clientHeight >= 380));
                await page.locator('.back-home-btn').click();
                await page.locator('#row-local-vps').waitFor();
                assert.strictEqual(await page.locator('#endpoint').innerText(), 'example.test');
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            }
        }
        assert.deepStrictEqual(errors, []);
        console.log(`PASS: Desktop/mobile navigation, single requests, first-paint labels; timings ${JSON.stringify(timings)}`);
    } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
