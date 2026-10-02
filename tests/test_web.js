'use strict';

// Browser regression check; API responses are intercepted, never written to a VPS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const web = path.join(__dirname, '..', 'web');

async function run() {
    const browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1385, height: 946 }, permissions: ['clipboard-read', 'clipboard-write'] });
        let nodes = Array.from({ length: 11 }, (_, index) => ({
            id: index ? `test-${index}` : 'local-vps', isLocal: index === 0,
            name: index ? `VPS-${index}` : 'vps-machine', protocol: index ? 'hysteria2' : 'direct',
            server: `198.51.100.${index + 1}`, upstreamPort: 20443, listenPort: 39999 + index,
            enabled: index !== 10, status: index === 10 ? 'disabled' : 'online', latencyMs: 27 + index,
            exitIp: `198.51.100.${index + 1}`, location: 'United States / California / Los Angeles',
            lastCheckedAt: '2026-10-02T01:00:00Z', lastError: '',
            hy2: index < 2 ? { id: `relay-${index}`, status: 'enabled', link: `hysteria2://example@example.test:${39999 + index}/#${index ? `VPS-${index}` : 'vps-machine'}:198.51.100.${index + 1}-US` } : null
        }));
        const settings = { proxyUsername: 'proxy+user', proxyPassword: 'P@$$:word#? "quoted"', publicHost: 'example.test', subscriptions: {}, authDisabled: true };
        const dockerEndpoint = (node, scheme) => `${scheme}://${encodeURIComponent(settings.proxyUsername)}:${encodeURIComponent(settings.proxyPassword)}@host:${node.listenPort}`;
        let core = 'running';
        let healthRunning = false;
        let slow = false;
        let active = 0;
        let maxActive = 0;
        const requests = [];
        await context.route('**/*', async (route) => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/lucide.svg': 'lucide.svg', '/logs': 'logs.html', '/logs.js': 'logs.js' };
            const file = files[pathname];
            if (file) return route.fulfill({ contentType: { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)], body: fs.readFileSync(path.join(web, file), 'utf8') });
            requests.push({ pathname, method: request.method() });
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                if (slow) await new Promise((resolve) => setTimeout(resolve, 100));
                let data;
                const realityAction = pathname.match(/^\/api\/proxies\/([^/]+)\/reality$/);
                const action = pathname.match(/^\/api\/proxies\/([^/]+)\/(enable|disable|test)$/);
                if (pathname === '/api/proxies/test-all') { healthRunning = true; data = { running: true }; }
                else if (realityAction) {
                    const node = nodes.find((candidate) => candidate.id === realityAction[1]);
                    if (request.method() === 'DELETE') { node.reality = null; data = { ok: true }; }
                    else {
                        const body = request.postDataJSON();
                        assert.strictEqual(typeof body.enabled, 'boolean');
                        node.reality = { ...body, listenPort: 50000, status: body.enabled ? 'enabled' : 'disabled',
                            link: `vless://test-uuid@${body.host}:50000?type=raw&security=reality&sni=${body.serverName}#${encodeURIComponent(node.name)}:198.51.100.1-US` };
                        data = node.reality;
                    }
                }
                else if (action) {
                    const node = nodes.find((candidate) => candidate.id === action[1]);
                    if (action[2] === 'test') node.latencyMs = 91;
                    else node.enabled = action[2] === 'enable';
                    node.status = node.enabled ? 'online' : 'disabled';
                    data = node;
                }
                else if (pathname === '/api/proxies/batch-delete') {
                    const ids = request.postDataJSON().ids;
                    assert.ok(!ids.includes('local-vps'), 'fixed local node must not be deleted');
                    nodes = nodes.filter((node) => !ids.includes(node.id));
                    data = { deleted: ids.length };
                } else if (pathname === '/api/proxies') data = nodes;
                else if (pathname === '/api/status') data = { core, total: nodes.length, enabled: nodes.filter((node) => node.enabled).length, online: core === 'running' ? nodes.filter((node) => node.status === 'online').length : 0, healthCheck: { running: healthRunning } };
                else if (pathname === '/api/settings') data = settings;
                else return route.fulfill({ status: 400, json: { error: 'unexpected test request' } });
                await route.fulfill({ json: data });
            } finally { active--; }
        });
        const page = await context.newPage();
        const readClipboard = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.clock.install();
        await page.goto('http://127.0.0.1:3188');
        await page.waitForSelector('#row-local-vps');
        assert.strictEqual(await page.locator('#endpoint').innerText(), 'example.test');
        await page.locator('#row-test-1 .row-select').check();
        await page.locator('#nodeFilter').fill('VPS-2');
        await page.locator('#selectAll').check();
        await page.locator('#nodeFilter').fill('');
        assert.ok(await page.locator('#row-test-1 .row-select').isChecked());
        assert.ok(await page.locator('#row-test-2 .row-select').isChecked());
        assert.ok(await page.locator('#selectAll').evaluate((element) => element.indeterminate));
        await page.locator('#row-test-10 .row-select').check();
        assert.ok(await page.locator('#row-test-10 .row-select').isChecked(), 'disabled nodes remain selectable');
        nodes[10].lastCheckedAt = '2026-10-02T02:00:00Z';
        await page.evaluate(() => refresh(false));
        assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.id), 'test-10', 'passive updates must preserve checkbox focus');
        await page.locator('#row-test-10 [role="switch"]').click();
        await page.waitForFunction(() => document.querySelector('#row-test-10 [role="switch"]').getAttribute('aria-checked') === 'true');
        await page.locator('#row-test-10 [role="switch"]').click();
        await page.waitForFunction(() => document.querySelector('#row-test-10 [role="switch"]').getAttribute('aria-checked') === 'false');
        assert.ok(await page.locator('#row-test-10 .row-select').isChecked());
        await page.locator('#row-test-2 [data-action="test"]').click();
        await page.waitForFunction(() => document.querySelector('#row-test-2 .latency-val').textContent.includes('91'));
        await page.locator('.toolbar .tool-menu').nth(1).locator('summary').click();
        await page.locator('#copyHy2').click();
        assert.strictEqual(await readClipboard(), nodes[1].hy2.link);
        await page.locator('#dockerMenu summary').click();
        await page.locator('#copyDockerCompose').click();
        const composeFragment = '    extra_hosts:\n      - "host:host-gateway"';
        assert.strictEqual(await readClipboard(), composeFragment);
        assert.ok(await page.locator('#dockerMenu').evaluate((element) => element.open), 'copying Compose should leave its example visible');
        for (const [button, scheme] of [['copyDockerHttp', 'http'], ['copyDockerSocks', 'socks5']]) {
            await page.locator(`#${button}`).click();
            assert.strictEqual(await readClipboard(), [nodes[1], nodes[2]].map((node) => dockerEndpoint(node, scheme)).join('\n'));
        }
        await page.keyboard.press('Escape');
        await page.locator('#row-test-2 .row-menu summary').click();
        await page.locator('#row-test-2 [data-action="copy-docker-http"]').click();
        assert.strictEqual(await readClipboard(), dockerEndpoint(nodes[2], 'http'));
        await page.locator('#row-local-vps .row-menu summary').click();
        await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false }));
        await page.locator('#row-local-vps [data-action="copy-docker-socks"]').click();
        assert.strictEqual(await readClipboard(), dockerEndpoint(nodes[0], 'socks5'), 'Docker copying must work on HTTP panels using the clipboard fallback');
        await page.evaluate(() => { delete window.isSecureContext; });
        await page.locator('#row-test-10 .row-menu summary').click();
        assert.ok(await page.locator('#row-test-10 [data-action="copy-docker-http"]').isDisabled());
        assert.ok(await page.locator('#row-test-10 [data-action="copy-docker-socks"]').isDisabled());
        await page.keyboard.press('Escape');
        await page.locator('#row-local-vps [data-action="reality"]').first().click();
        assert.strictEqual(await page.locator('#realityForm [name="host"]').inputValue(), 'example.test');
        assert.strictEqual(await page.locator('#realityForm [name="serverName"]').inputValue(), 'www.apple.com');
        assert.ok(await page.locator('#copyRealityLink').isDisabled());
        await page.locator('#realityForm [type="submit"]').click();
        await page.waitForFunction(() => !document.querySelector('#copyRealityLink').disabled);
        assert.strictEqual(await page.locator('#realityPort').innerText(), 'TCP 50000');
        await page.locator('#copyRealityLink').click();
        assert.strictEqual(await readClipboard(), nodes[0].reality.link);
        await page.locator('#realityForm [name="enabled"]').uncheck();
        await page.locator('#realityForm [type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('#realityDialog .dialog-feedback').textContent.includes('已停用'));
        await page.locator('#realityForm [name="enabled"]').check();
        await page.locator('#realityForm [type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('#realityDialog .dialog-feedback').textContent.includes('已启用'));
        await page.locator('#realityDialog [data-close]').click();
        await page.locator('#row-local-vps [data-action="copy-reality"]').click();
        assert.strictEqual(await readClipboard(), nodes[0].reality.link);
        assert.ok((await readClipboard()).includes('#vps-machine:'));
        await page.locator('#row-local-vps .row-select').check();
        for (const index of [1, 2, 10]) {
            nodes[index].reality = { status: index === 2 ? 'disabled' : 'enabled', enabled: index !== 2, listenPort: 50000 + index,
                link: `vless://example@example.test:${50000 + index}?type=raw&security=reality#VPS-${index}` };
        }
        await page.evaluate(() => refresh(false));
        await page.locator('#copyMenu summary').click();
        assert.strictEqual(await page.locator('#copyVless').innerText(), 'VLESS Reality');
        assert.strictEqual(await page.locator('#copyVless').evaluate((el) => el.previousElementSibling.id), 'copyHy2');
        await page.locator('#copyVless').click();
        assert.strictEqual(await readClipboard(), [nodes[0], nodes[1]].map((node) => node.reality.link).join('\n'), 'batch VLESS copies public links and excludes disabled/unconfigured entries');
        assert.ok(!(await readClipboard()).includes('127.0.0.1'));
        const noVless = await page.evaluate(async () => {
            try { await copyItems(items.filter((item) => ['test-2', 'test-10'].includes(item.id)), 'vless', undefined, 'VLESS Reality'); return ''; }
            catch (error) { return error.message; }
        });
        assert.ok(noVless.includes('已启用 VLESS Reality'));
        const proxyEndpoint = (node, scheme, host) => dockerEndpoint(node, scheme).replace('@host:', `@${host}:`);
        for (const [button, scheme, host] of [['copyInternalHttp', 'http', '127.0.0.1'], ['copyInternalSocks', 'socks5', '127.0.0.1'], ['copyHttp', 'http', 'example.test'], ['copySocks', 'socks5', 'example.test']]) {
            await page.locator('#copyMenu summary').click();
            await page.locator(`#${button}`).click();
            assert.strictEqual(await readClipboard(), [nodes[0], nodes[1], nodes[2]].map((node) => proxyEndpoint(node, scheme, host)).join('\n'));
        }
        for (const [action, scheme] of [['copy-http', 'http'], ['copy-socks', 'socks5']]) {
            await page.locator(`#row-local-vps [data-action="${action}"]`).click();
            assert.strictEqual(await readClipboard(), proxyEndpoint(nodes[0], scheme, '127.0.0.1'), 'default HTTP/SOCKS5 copies are for the VPS itself');
        }
        for (const [action, scheme] of [['copy-public-http', 'http'], ['copy-public-socks', 'socks5']]) {
            await page.locator('#row-local-vps .row-menu summary').click();
            await page.locator(`#row-local-vps [data-action="${action}"]`).click();
            assert.strictEqual(await readClipboard(), proxyEndpoint(nodes[0], scheme, 'example.test'));
        }
        await page.locator('.settings-menu summary').click();
        await page.locator('#openSettingsDialog').click();
        await page.locator('#settingsForm [name="publicHost"]').fill('unsaved.example.test');
        const settingsBeforePolling = requests.filter((request) => request.pathname === '/api/settings').length;
        nodes[2].latencyMs = 89;
        await page.clock.fastForward(15000);
        await page.waitForFunction(() => document.querySelector('#row-test-2 .latency-val').textContent.includes('89'));
        assert.strictEqual(await page.locator('#settingsForm [name="publicHost"]').inputValue(), 'unsaved.example.test');
        await page.locator('#settingsDialog [data-close]').first().click();
        const settingsRequests = requests.filter((request) => request.pathname === '/api/settings').length;
        assert.strictEqual(settingsRequests, settingsBeforePolling, 'passive polling must not fetch or overwrite settings');
        await page.locator('#autoRefresh').uncheck();
        const pausedCount = requests.length;
        await page.clock.fastForward(30000);
        assert.strictEqual(requests.length, pausedCount);
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.locator('#autoRefresh').check();
        await page.clock.fastForward(30000);
        assert.strictEqual(requests.length, pausedCount, 'hidden pages must not poll');
        await page.locator('#autoRefresh').uncheck();
        await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
        await page.locator('#testAll').click();
        await page.waitForFunction(() => document.querySelector('#testAll').disabled);
        healthRunning = false;
        await page.clock.fastForward(1500);
        await page.waitForFunction(() => !document.querySelector('#testAll').disabled);
        slow = true;
        maxActive = 0;
        await page.evaluate(() => Promise.all([refresh(false), refresh(false), refresh(false)]));
        assert.strictEqual(maxActive, 2, 'one state sync may request proxies/status concurrently, never overlap another sync');
        slow = false;
        core = 'stopped';
        await page.evaluate(() => { document.activeElement.blur(); return refresh(false); });
        assert.strictEqual(await page.locator('#online').innerText(), '0');
        assert.ok((await page.locator('#row-test-1 .col-status').innerText()).includes('核心停止'));
        assert.ok((await page.locator('#row-test-1 .hy2-port-chip').innerText()).includes('停止'));
        assert.ok(await page.locator('#row-test-1 [data-action="copy-hy2"]').isVisible(), 'a stopped core must not erase HY2 configuration');
        assert.ok((await page.locator('#row-local-vps .reality-port-chip').innerText()).includes('停止'));
        core = 'running';
        await page.evaluate(() => refresh(false));
        await page.locator('#row-local-vps .row-select').check();
        await page.locator('#batchDelete').click();
        assert.ok(await page.locator('#confirmDialog').isVisible());
        assert.strictEqual(await page.locator('.confirm-card').evaluate((element) => getComputedStyle(element).maxWidth), '440px');
        await page.locator('#confirmOkBtn').click();
        await page.waitForFunction(() => !document.querySelector('#row-test-10'));
        assert.ok(await page.locator('#row-local-vps .row-select').isChecked());
        for (const width of [1385, 1024, 900, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
            assert.ok(dimensions.scroll <= dimensions.width, `horizontal overflow at ${width}px (${dimensions.scroll}px): ${JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => ({ cls: element.className, id: element.id, right: element.getBoundingClientRect().right }))))}`);
            const row = await page.locator('.node-row').first().boundingBox();
            if (width <= 900) assert.ok(row.y + row.height < 844, 'first node and actions must fit in first viewport');
            await page.locator('.node-row .row-menu summary').first().click();
            const menu = await page.locator('.row-menu[open] .menu-items').boundingBox();
            assert.ok(menu.x >= 0 && menu.x + menu.width <= width, 'row menu must remain on screen');
            await page.keyboard.press('Escape');
            await page.locator('#copyMenu summary').click();
            const copyMenu = await page.locator('#copyMenu .menu-items').boundingBox();
            assert.ok(copyMenu.x >= 0 && copyMenu.x + copyMenu.width <= width && copyMenu.y >= 0 && copyMenu.y + copyMenu.height <= 844, `public/internal copy menu must fit at ${width}px`);
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) {
                await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `copy-menu-${width}.png`) });
            }
            await page.keyboard.press('Escape');
            await page.locator('#dockerMenu summary').click();
            const bubble = await page.locator('.docker-bubble').boundingBox();
            assert.ok(bubble.x >= 0 && bubble.x + bubble.width <= width && bubble.y + bubble.height <= 844, `Docker bubble must fit at ${width}px`);
            await page.locator('#copyDockerCompose').click();
            assert.strictEqual(await readClipboard(), composeFragment);
            const hitbox = await page.locator('#copyDockerCompose').boundingBox();
            assert.ok(hitbox.height >= 38);
            await page.keyboard.press('Escape');
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) {
                await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `nodes-${width}.png`) });
            }
            await page.locator('#row-local-vps .row-menu summary').click();
            await page.locator('#row-local-vps .row-menu [data-action="reality"]').click();
            const modal = await page.locator('#realityDialog').boundingBox();
            assert.ok(modal.x >= 0 && modal.x + modal.width <= width && modal.y >= 0 && modal.y + modal.height <= 844, `Reality dialog must fit at ${width}px`);
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) {
                fs.mkdirSync(process.env.PPH_WEB_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `reality-${width}.png`) });
            }
            await page.locator('#realityDialog [data-close]').click();
        }
        await page.locator('#row-local-vps .row-menu summary').click();
        await page.locator('#row-local-vps .row-menu [data-action="reality"]').click();
        await page.locator('#removeReality').click();
        await page.locator('#confirmOkBtn').click();
        await page.waitForFunction(() => !document.querySelector('#realityDialog').open);
        assert.ok(await page.locator('#row-local-vps [data-action="reality"]').first().isVisible());
        await page.setViewportSize({ width: 1385, height: 946 });
        await page.goto('http://127.0.0.1:3188/logs');
        assert.strictEqual(await page.locator('.logs-table-wrap').evaluate((element) => getComputedStyle(element).maxHeight), '526px');
        assert.deepStrictEqual(errors, []);
        console.log('Web regression passed: batch public VLESS/HY2, host names, internal/public HTTP/SOCKS5, Docker clipboard, Reality settings, polling and desktop/mobile layout.');
    } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
