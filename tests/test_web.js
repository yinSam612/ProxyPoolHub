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
            exitIp: `198.51.100.${index + 1}`, countryCode: 'US', location: 'United States / California / Los Angeles',
            lastCheckedAt: '2026-10-02T01:00:00Z', lastError: '',
            hy2: index < 2 ? { id: `relay-${index}`, status: 'enabled', link: `hysteria2://example@example.test:${39999 + index}/#${index ? `VPS-${index}` : 'vps-machine'}:198.51.100.${index + 1}-US` } : null
        }));
        const settings = { proxyUsername: 'proxy+user', proxyPassword: 'P@$$:word#? "quoted"', publicHost: 'example.test', subscriptions: {}, authDisabled: true,
            proxyAccess: { publicTcp: 'unverified', sources: '' } };
        const dockerEndpoint = (node, scheme) => `${scheme}://${encodeURIComponent(settings.proxyUsername)}:${encodeURIComponent(settings.proxyPassword)}@host:${node.listenPort}`;
        let core = 'running';
        let healthRunning = false;
        let slow = false;
        let rejectReality = false;
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
                        if (rejectReality) return route.fulfill({ status: 400, json: { error: 'Reality port unavailable' } });
                        const body = request.postDataJSON();
                        assert.strictEqual(typeof body.enabled, 'boolean');
                        const reality = { ...node.reality, ...body };
                        node.reality = { ...reality, listenPort: 50000, status: body.enabled ? 'enabled' : 'disabled',
                            link: `vless://test-uuid@${reality.host}:50000?type=raw&security=reality&sni=${reality.serverName}#${encodeURIComponent(node.name)}:198.51.100.1-US` };
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
        const openNodePanel = async (id) => {
            await page.locator(`#row-${id} .row-menu .menu-trigger`).click();
            await page.locator(`#row-${id} [data-action="manage"]`).click();
            await page.locator('#nodeSettingsDialog').waitFor({ state: 'visible' });
        };
        const readClipboard = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.clock.install();
        await page.goto('http://127.0.0.1:3188');
        await page.waitForSelector('#row-local-vps');
        assert.strictEqual(await page.locator('#endpoint').innerText(), 'example.test');
        await page.locator('#row-test-1 .row-select').check();
        assert.ok(await page.locator('#row-test-1').evaluate((row) => row.classList.contains('is-selected')));
        assert.ok(!await page.locator('#row-local-vps').evaluate((row) => row.classList.contains('is-selected')));
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
        await page.locator('#copyMenu .menu-trigger').click();
        await page.locator('#copyHy2').click();
        assert.strictEqual(await readClipboard(), nodes[1].hy2.link);
        await page.locator('#dockerMenu .menu-trigger').click();
        await page.locator('#copyDockerCompose').click();
        const composeFragment = '    extra_hosts:\n      - "host:host-gateway"';
        assert.strictEqual(await readClipboard(), composeFragment);
        assert.ok(await page.locator('#dockerBubble').isVisible(), 'copying Compose should leave its example visible');
        for (const [button, scheme] of [['copyDockerHttp', 'http'], ['copyDockerSocks', 'socks5']]) {
            await page.locator(`#${button}`).click();
            assert.strictEqual(await readClipboard(), [nodes[1], nodes[2]].map((node) => dockerEndpoint(node, scheme)).join('\n'));
        }
        await page.keyboard.press('Escape');
        await page.locator('#copyScope').selectOption('docker');
        await page.locator('#row-test-2 [data-action="copy-http"]').click();
        assert.strictEqual(await readClipboard(), dockerEndpoint(nodes[2], 'http'));
        await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false }));
        await page.locator('#row-local-vps [data-action="copy-socks"]').click();
        assert.strictEqual(await readClipboard(), dockerEndpoint(nodes[0], 'socks5'), 'Docker copying must work on HTTP panels using the clipboard fallback');
        await page.evaluate(() => { delete window.isSecureContext; });
        assert.ok(await page.locator('#row-test-10 [data-action="copy-http"]').isDisabled());
        assert.ok(await page.locator('#row-test-10 [data-action="copy-socks"]').isDisabled());
        await page.locator('#copyScope').selectOption('local');
        await openNodePanel('local-vps');
        await page.locator('#nodeSettingsDialog [data-action="reality"]').focus();
        await page.evaluate(() => refresh(false));
        assert.ok(await page.locator('#nodeSettingsDialog [data-action="reality"]').evaluate((button) => button === document.activeElement),
            'passive sync must preserve node settings focus');
        await page.locator('#nodeSettingsDialog [data-action="reality"]').click();
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
        await openNodePanel('local-vps');
        const realitySwitch = page.locator('#nodeSettingsDialog [data-action="toggle-reality"]');
        assert.strictEqual(await realitySwitch.count(), 1, 'configured VLESS needs a direct switch alongside HY2');
        assert.strictEqual(await realitySwitch.getAttribute('aria-checked'), 'true');
        const originalReality = { ...nodes[0].reality };
        const originalHy2 = { ...nodes[0].hy2 };
        rejectReality = true;
        await realitySwitch.click();
        await page.waitForFunction(() => document.querySelector('#nodeSettingsDialog .dialog-feedback')?.textContent.includes('port unavailable'));
        assert.ok(!await realitySwitch.isDisabled(), 'failed toggles must restore the switch');
        assert.strictEqual(await realitySwitch.getAttribute('aria-checked'), 'true', 'failed toggles must retain the saved state');
        assert.deepStrictEqual(nodes[0].reality, originalReality);
        rejectReality = false;
        slow = true;
        const writesBefore = requests.filter(entry => entry.pathname.endsWith('/reality') && entry.method === 'PUT').length;
        await realitySwitch.click();
        assert.ok(await realitySwitch.isDisabled(), 'pending toggles must prevent duplicate requests');
        await realitySwitch.evaluate(button => button.click());
        await page.waitForFunction(() => document.querySelector('#nodeSettingsDialog [data-action="toggle-reality"]').getAttribute('aria-checked') === 'false');
        slow = false;
        assert.strictEqual(requests.filter(entry => entry.pathname.endsWith('/reality') && entry.method === 'PUT').length, writesBefore + 1);
        assert.ok(await page.locator('#row-local-vps [data-action="copy-reality"]').isDisabled());
        assert.strictEqual(nodes[0].reality.link, originalReality.link, 'disabling must preserve the public link');
        assert.deepStrictEqual(nodes[0].hy2, originalHy2, 'disabling VLESS must not change HY2');
        await realitySwitch.press('Enter');
        await page.waitForFunction(() => document.querySelector('#nodeSettingsDialog [data-action="toggle-reality"]').getAttribute('aria-checked') === 'true');
        assert.deepStrictEqual(nodes[0].reality, originalReality, 'reenabling must preserve Reality configuration');
        await page.locator('#nodeSettingsDialog [data-close]').click();
        await page.locator('#row-local-vps [data-action="copy-reality"]').click();
        assert.strictEqual(await readClipboard(), nodes[0].reality.link);
        assert.ok((await readClipboard()).includes('#vps-machine:'));
        await page.locator('#row-local-vps .row-select').check();
        for (const index of [1, 2, 10]) {
            nodes[index].reality = { status: index === 2 ? 'disabled' : 'enabled', enabled: index !== 2, listenPort: 50000 + index,
                link: `vless://example@example.test:${50000 + index}?type=raw&security=reality#VPS-${index}` };
        }
        await page.evaluate(() => refresh(false));
        await page.locator('#copyMenu .menu-trigger').click();
        await page.locator('#selectedCopyMenu').waitFor({ state: 'visible' });
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
        for (const [button, scheme, host, scope] of [['copyHttp', 'http', '127.0.0.1', 'local'], ['copySocks', 'socks5', '127.0.0.1', 'local'], ['copyHttp', 'http', 'host', 'docker'], ['copySocks', 'socks5', 'host', 'docker'], ['copyHttp', 'http', 'example.test', 'public'], ['copySocks', 'socks5', 'example.test', 'public']]) {
            await page.locator('#copyScope').selectOption(scope);
            await page.locator('#copyMenu .menu-trigger').click();
            await page.locator(`#${button}`).click();
            assert.strictEqual(await readClipboard(), [nodes[0], nodes[1], nodes[2]].map((node) => proxyEndpoint(node, scheme, host)).join('\n'));
        }
        await page.locator('#copyScope').selectOption('local');
        for (const [action, scheme] of [['copy-http', 'http'], ['copy-socks', 'socks5']]) {
            await page.locator(`#row-local-vps [data-action="${action}"]`).click();
            assert.strictEqual(await readClipboard(), proxyEndpoint(nodes[0], scheme, '127.0.0.1'), 'default HTTP/SOCKS5 copies are for the VPS itself');
        }
        await page.locator('#copyScope').selectOption('public');
        for (const [action, scheme] of [['copy-http', 'http'], ['copy-socks', 'socks5']]) {
            await page.locator(`#row-local-vps [data-action="${action}"]`).click();
            assert.strictEqual(await readClipboard(), proxyEndpoint(nodes[0], scheme, 'example.test'));
        }
        settings.proxyAccess = { publicTcp: 'blocked', sources: '' };
        await page.evaluate(() => refresh());
        assert.ok(await page.locator('#copyScope [value="public"]').isDisabled());
        assert.strictEqual(await page.locator('#copyScope').inputValue(), 'local');
        assert.strictEqual(await page.locator('#publicProxyStatus').innerText(), '公网未开放');
        const blockedCopy = await page.evaluate(async () => {
            try { await copyItems([items[0]], 'http'); return ''; } catch (error) { return error.message; }
        });
        assert.ok(blockedCopy.includes('未开放'), 'blocked public addresses cannot be presented as working proxies');
        settings.proxyAccess = { publicTcp: 'restricted', sources: '203.0.113.8/32' };
        await page.evaluate(() => refresh());
        assert.ok(!await page.locator('#copyScope [value="public"]').isDisabled());
        assert.strictEqual(await page.locator('#publicProxyStatus').getAttribute('title'), '203.0.113.8/32');
        settings.proxyAccess = { publicTcp: 'blocked', sources: '' };
        await page.evaluate(() => refresh());
        await page.locator('#copyScope').selectOption('docker');
        await page.locator('#row-local-vps [data-action="copy-hy2"]').click();
        assert.strictEqual(await readClipboard(), nodes[0].hy2.link, 'HY2 remains public in Docker mode');
        await page.locator('#row-local-vps [data-action="copy-reality"]').click();
        assert.strictEqual(await readClipboard(), nodes[0].reality.link, 'VLESS remains public in Docker mode');
        await page.locator('#copyScope').selectOption('local');
        await page.locator('.settings-menu .menu-trigger').click();
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
        for (const [width, height] of [[1385, 844], [1024, 844], [390, 844], [320, 844], [390, 440]]) {
            await page.setViewportSize({ width, height });
            for (const block of ['start', 'end']) {
                const trigger = page.locator('#row-test-3 .row-menu .menu-trigger');
                await trigger.evaluate((element, block) => element.scrollIntoView({ block, behavior: 'instant' }), block);
                await trigger.click();
                await page.locator('#node-menu-test-3').waitFor({ state: 'visible' });
                const menu = await page.locator('#node-menu-test-3').boundingBox();
                assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= width && menu.y + menu.height <= height,
                    `scrolled menu must fit ${width}x${height}, ${block}: ${JSON.stringify(menu)}`);
                assert.strictEqual(await page.locator('#node-menu-test-3 .node-menu-name').innerText(), 'VPS-3');
                assert.strictEqual(await page.locator('.menu-items:popover-open').count(), 1);
                nodes[3].lastCheckedAt = '2026-10-02T03:00:00Z';
                await page.evaluate(() => refresh(false));
                assert.ok(await page.locator('#node-menu-test-3').isVisible(), 'passive sync cannot dismiss an active menu');
                if (process.env.PPH_WEB_SCREENSHOT_DIR && block === 'start') await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `scrolled-menu-${width}-${height}.png`) });
                await page.keyboard.press('Escape');
                assert.ok(!await page.locator('#node-menu-test-3').isVisible());
            }
        }
        await page.setViewportSize({ width: 1385, height: 844 });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
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
            await page.locator('.node-row .row-menu .menu-trigger').first().click();
            await page.locator('.row-menu .menu-items:popover-open').waitFor({ state: 'visible' });
            const menu = await page.locator('.row-menu .menu-items:popover-open').boundingBox();
            assert.ok(menu.x >= 0 && menu.x + menu.width <= width && menu.y >= 0 && menu.y + menu.height <= 844, 'row menu must remain fully on screen');
            assert.ok(await page.locator('.row-menu .menu-items:popover-open button').count() <= 3);
            if (width > 900) assert.ok(row.height <= 80, `desktop rows must stay compact at ${width}px: ${row.height}; ${JSON.stringify(await page.locator('.node-row').first().evaluate(row => [...row.querySelectorAll('.col-actions, .copy-actions, .node-actions')].map(e => ({ class: e.className, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }))))}`);
            await page.keyboard.press('Escape');
            await page.locator('#copyMenu .menu-trigger').click();
            await page.locator('#selectedCopyMenu').waitFor({ state: 'visible' });
            const copyMenu = await page.locator('#copyMenu .menu-items').boundingBox();
            assert.ok(copyMenu.x >= 0 && copyMenu.x + copyMenu.width <= width && copyMenu.y >= 0 && copyMenu.y + copyMenu.height <= 844, `public/internal copy menu must fit at ${width}px`);
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) {
                await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `copy-menu-${width}.png`) });
            }
            await page.keyboard.press('Escape');
            await page.locator('#dockerMenu .menu-trigger').click();
            await page.locator('#dockerBubble').waitFor({ state: 'visible' });
            const bubble = await page.locator('.docker-bubble').boundingBox();
            assert.ok(bubble.x >= 0 && bubble.x + bubble.width <= width && bubble.y + bubble.height <= 844, `Docker bubble must fit at ${width}px`);
            await page.locator('#copyDockerCompose').click();
            assert.strictEqual(await readClipboard(), composeFragment);
            const hitbox = await page.locator('#copyDockerCompose').boundingBox();
            assert.ok(hitbox.height >= 38);
            await page.keyboard.press('Escape');
            await page.clock.fastForward(4000);
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) {
                await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `nodes-${width}.png`) });
            }
            await openNodePanel('local-vps');
            const panel = await page.locator('#nodeSettingsDialog').boundingBox();
            assert.ok(panel.x >= 0 && panel.x + panel.width <= width && panel.y >= 0 && panel.y + panel.height <= 844, 'node settings must fit the viewport');
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `node-settings-${width}.png`) });
            await page.locator('#nodeSettingsDialog [data-action="reality"]').click();
            const modal = await page.locator('#realityDialog').boundingBox();
            assert.ok(modal.x >= 0 && modal.x + modal.width <= width && modal.y >= 0 && modal.y + modal.height <= 844, `Reality dialog must fit at ${width}px`);
            if (process.env.PPH_WEB_SCREENSHOT_DIR && [1385, 390, 320].includes(width)) {
                fs.mkdirSync(process.env.PPH_WEB_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PPH_WEB_SCREENSHOT_DIR, `reality-${width}.png`) });
            }
            await page.locator('#realityDialog [data-close]').click();
        }
        await openNodePanel('local-vps');
        await page.locator('#nodeSettingsDialog [data-action="reality"]').click();
        await page.locator('#removeReality').click();
        await page.locator('#confirmOkBtn').click();
        await page.waitForFunction(() => !document.querySelector('#realityDialog').open);
        assert.ok(await page.locator('#row-local-vps [data-action="copy-reality"]').isDisabled());
        await page.setViewportSize({ width: 1385, height: 946 });
        await page.goto('http://127.0.0.1:3188/logs');
        assert.strictEqual(await page.locator('.logs-table-wrap').evaluate((element) => getComputedStyle(element).maxHeight), '526px');
        assert.deepStrictEqual(errors, []);
        console.log('Web regression passed: batch public VLESS/HY2, host names, internal/public HTTP/SOCKS5, Docker clipboard, Reality settings, polling and desktop/mobile layout.');
    } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
