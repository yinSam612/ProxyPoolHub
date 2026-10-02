'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { generateQrSvg } = require('../src/utils/qrcode');
const web = path.join(__dirname, '..', 'web');

async function run() {
    const browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true });
    const failures = [];
    const check = (condition, label) => { if (!condition) failures.push(label); };
    const output = process.env.PPH_WEB_SCREENSHOT_DIR;
    if (output) fs.mkdirSync(output, { recursive: true });
    try {
        const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
        const snapshot = process.env.PPH_UI_VPS_SNAPSHOT ? JSON.parse(fs.readFileSync(process.env.PPH_UI_VPS_SNAPSHOT, 'utf8')) : null;
        const nodes = snapshot?.nodes || Array.from({ length: 11 }, (_, index) => ({
            id: index ? `node-${index}` : 'local-vps', isLocal: index === 0, name: index ? `VPS-${index}` : 'vps-demo',
            protocol: index ? 'hysteria2' : 'direct', server: `vps-${index}.example.test`, upstreamPort: 20443,
            exitIp: `198.51.100.${index + 10}`, listenPort: 39999 + index, enabled: true, status: 'online', latencyMs: 27 + index,
            location: 'United States / California / Los Angeles', lastCheckedAt: '2026-10-02T09:00:00Z',
            traffic: { todayUploadFormatted: '128.35 MB', todayDownloadFormatted: '1.25 GB', totalDownloadFormatted: '3.48 GB' },
            hy2: index < 2 ? { id: `relay-${index}`, status: 'enabled', link: `hysteria2://example@public.example.test:${39999 + index}` } : null,
            reality: index < 2 ? { enabled: true, status: 'enabled', listenPort: 50000 + index, host: 'public.example.test',
                serverName: 'www.apple.com', link: `vless://example@public.example.test:${50000 + index}` } : null
        }));
        const settings = { publicHost: snapshot?.publicHost || 'public.example.test', proxyUsername: 'proxy', proxyPassword: 'ExamplePassword1!',
            authDisabled: false, totpEnabled: false, subscriptions: { http: 'https://public.example.test/subscription/http/example', socks5: 'https://public.example.test/subscription/socks5/example' },
            proxyAccess: { publicTcp: 'blocked', sources: '' } };
        await context.route('**/*', async route => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/lucide.svg': 'lucide.svg' }[pathname];
            if (file) return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)], body: fs.readFileSync(path.join(web, file), 'utf8') });
            if (request.method() !== 'GET') return route.fulfill({ status: 400, json: { error: 'Example validation error' } });
            const data = {
                '/api/proxies': nodes, '/api/settings': settings,
                '/api/status': { core: 'running', total: 11, enabled: 11, online: 11 },
                '/api/relays': { managedCore: true, cores: { singBox: true, xray: false }, tls: snapshot?.tls || { mode: 'manual', host: 'public.example.test', certificatePath: '/etc/cert.crt', keyPath: '/etc/private.key' },
                    relays: nodes.filter(n => n.hy2).map(n => ({ ...n.hy2, listenPort: n.listenPort, proxyName: n.name, enabled: true })) },
                '/api/totp/setup': { enabled: false, secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', qrSvg: generateQrSvg('otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP') }
            }[pathname];
            return data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, json: { error: 'unexpected UI request' } });
        });
        const page = await context.newPage();
        page.on('pageerror', error => failures.push(`Browser error: ${error.message}`));
        const screenshot = async name => { if (output) await page.screenshot({ path: path.join(output, `${name}.png`) }); };
        const openSettings = async button => {
            await page.locator('.settings-menu .menu-trigger').click();
            await page.locator(button).click();
        };
        const geometry = async root => page.locator(root).evaluate(element => {
            const box = element.getBoundingClientRect();
            const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
            const controls = [...element.querySelectorAll('button, input, select, textarea, a')].filter(visible);
            const issues = [];
            for (const e of controls) {
                const r = e.getBoundingClientRect();
                if (r.left < box.left - 1 || r.right > box.right + 1) issues.push(`${e.id || e.dataset.action || e.tagName}: outside container`);
                const x = r.left + r.width / 2, y = r.top + r.height / 2;
                let clipped = false;
                for (let parent = e.parentElement; parent; parent = parent.parentElement) {
                    const p = parent.getBoundingClientRect(), style = getComputedStyle(parent);
                    if (/auto|scroll|hidden/.test(style.overflowY) && (y < p.top || y > p.bottom)) clipped = true;
                }
                const center = document.elementFromPoint(x, y);
                if (!clipped && !e.disabled && r.top >= 0 && r.bottom <= innerHeight && center && !e.contains(center)) issues.push(`${e.id || e.dataset.action || e.tagName}: covered by ${center.id || center.className}`);
            }
            for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
                if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
                const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
                if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) issues.push(`${controls[i].id || controls[i].dataset.action || controls[i].tagName} overlaps ${controls[j].id || controls[j].dataset.action || controls[j].tagName}`);
            }
            return issues;
        });
        for (const [width, height] of [[1385, 844], [1280, 720], [1180, 720], [1101, 720], [1024, 768], [901, 720], [900, 720], [768, 1024], [430, 932], [390, 844], [360, 640], [320, 568], [844, 390]]) {
            await page.setViewportSize({ width, height });
            await page.goto('http://127.0.0.1:3187');
            await page.locator('#row-local-vps').waitFor();
            await page.locator('#autoRefresh').uncheck();
            const size = `${width}x${height}`;
            check(await page.locator('#copyHttp').isDisabled() && await page.locator('#copyHy2').isDisabled(), `${size} empty selection enables copy commands`);
            const base = await geometry('.workspace-bar');
            check(!base.length, `${size} initial toolbar: ${base.join('; ')}`);
            await page.locator('#row-node-1 .row-select').check();
            const selected = await geometry('.workspace-bar');
            check(!selected.length, `${size} selected toolbar: ${selected.join('; ')}`);
            const row = await geometry('#row-local-vps');
            check(!row.length, `${size} row controls: ${row.join('; ')}`);
            if (width > 900) {
                const intrusions = await page.locator('#row-local-vps td').evaluateAll(cells => cells.flatMap(cell => {
                    const c = cell.getBoundingClientRect();
                    return [...cell.querySelectorAll('.port-chip, .traffic-mini-text, .actions-group, .protocol-badge')].filter(e => e.getBoundingClientRect().left < c.left - 1 || e.getBoundingClientRect().right > c.right + 1).map(e => e.className);
                }));
                check(!intrusions.length, `${size} column overflow: ${intrusions.join(', ')}`);
            }
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
            await screenshot(`dashboard-${size}`);
            await page.locator('#nodeFilter').fill('VPS-1');
            await page.locator('#row-node-1 .menu-trigger').click();
            await page.locator('#node-menu-node-1').waitFor({ state: 'visible' });
            nodes[1].latencyMs++;
            await page.evaluate(() => refresh(false));
            check(await page.locator('#node-menu-node-1').isVisible(), `${size} filtered refresh dismisses menu`);
            await page.keyboard.press('Escape');
            await page.locator('#nodeFilter').fill('');
            await page.locator('#nodeFilter').fill('20443');
            check(await page.locator('.node-row').count() === nodes.filter(node => node.upstreamPort === 20443).length, `${size} upstream port search fails`);
            await page.locator('#nodeFilter').fill('50001');
            check(await page.locator('.node-row').count() === 1, `${size} Reality port search fails`);
            await page.locator('#nodeFilter').fill('');
            await page.locator('#copyDockerCompose').evaluate(() => showMessage('Compose configuration copied'));
            const toastRow = await geometry('#row-node-4');
            check(!toastRow.length, `${size} toast obscures controls: ${toastRow.join('; ')}`);
            await page.evaluate(() => { clearTimeout(toastTimer); message.className = 'toast-card'; });
            await page.locator('#row-node-1 .menu-trigger').click();
            await page.locator('#node-menu-node-1 [data-action="manage"]').click();
            check(await page.locator('#nodeSettingsDialog [data-action="toggle-reality"]').count() === 1, `${size} configured VLESS has no direct switch`);
            const protocolControls = await geometry('#nodeSettingsDialog');
            check(!protocolControls.length, `${size} protocol controls: ${protocolControls.join('; ')}`);
            await screenshot(`node-settings-${size}`);
            await page.locator('#nodeSettingsDialog [data-close]').click();
            await page.locator('#row-node-2 .menu-trigger').click();
            await page.locator('#node-menu-node-2 [data-action="manage"]').click();
            check(!await page.locator('#nodeSettingsDialog [data-action="toggle-reality"]').count(), `${size} unconfigured VLESS offers a nonfunctional switch`);
            await page.locator('#nodeSettingsDialog [data-action="reality"]').click();
            check(!await page.locator('#removeReality').isVisible(), `${size} unconfigured Reality displays delete`);
            check(!await page.locator('#rotateReality').isVisible(), `${size} unconfigured Reality displays reset`);
            await screenshot(`new-reality-${size}`);
            await page.locator('#realityDialog [data-close]').click();
            for (const [name, trigger, dialog] of [['add', '#openAddDialog', '#addDialog'], ['import', '#openImportDialog', '#importDialog'], ['edit', null, '#editDialog'], ['settings', '#openSettingsDialog', '#settingsDialog'], ['password', '#openPasswordDialog', '#passwordDialog'], ['hy2', '#openRelayDialog', '#relayDialog'], ['totp', '#openTotpDialog', '#totpDialog']]) {
                if (name === 'add') await page.locator(trigger).click();
                else if (name === 'import') { await page.locator('.file-menu .menu-trigger').click(); await page.locator(trigger).click(); }
                else if (name === 'edit') { await page.locator('#row-node-2 .menu-trigger').click(); await page.locator('#node-menu-node-2 [data-action="edit"]').click(); }
                else await openSettings(trigger);
                await page.locator(dialog).waitFor({ state: 'visible' });
                if (name === 'totp') await page.locator('#totpSecretText').filter({ hasText: 'JBSW' }).waitFor();
                const issues = await geometry(dialog);
                check(!issues.length, `${size} ${name} controls: ${issues.join('; ')}`);
                const overflow = await page.locator(dialog).evaluate(d => d.scrollWidth > d.clientWidth + 1);
                check(!overflow, `${size} ${name} horizontal overflow`);
                if (name === 'add') {
                    await page.locator('#addForm [name="link"]').fill('hysteria2://example@example.test:443');
                    await page.locator('#addForm [type="submit"]').click();
                    await page.waitForFunction(() => !document.querySelector('#addForm [type="submit"]').disabled);
                    const feedback = page.locator('#addDialog .dialog-feedback');
                    check(await feedback.isVisible() && (await feedback.innerText()).includes('validation error'), `${size} form error is not visible inside dialog`);
                }
                if (name === 'settings') {
                    await page.locator('#settingsForm [name="publicHost"]').fill('unsaved.example.test');
                    await page.locator('#togglePassword').click();
                    await page.locator(`${dialog} [data-close]`).first().click();
                    await openSettings(trigger);
                    check(await page.locator('#settingsForm [name="publicHost"]').inputValue() === settings.publicHost, `${size} canceled settings are not restored`);
                    check(await page.locator('#proxyPassword').getAttribute('type') === 'password', `${size} reopened settings reveal the password`);
                }
                const submit = page.locator(`${dialog} [type="submit"]`).last();
                if (await submit.count()) {
                    await submit.scrollIntoViewIfNeeded();
                    const reachable = await submit.evaluate(button => {
                        const r = button.getBoundingClientRect();
                        return button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
                    });
                    check(reachable, `${size} ${name} submit cannot be reached by scrolling`);
                }
                if ([1385, 430, 320].includes(width)) await screenshot(`${name}-${size}`);
                await page.locator(`${dialog} [data-close]`).first().click();
            }
        }
        nodes[2].name = 'VPS-' + 'LongMachineName'.repeat(8);
        nodes[2].server = 'a'.repeat(63) + '.example.test';
        nodes[2].exitIp = '2001:db8:abcd:1234:5678:9abc:def0:1234';
        for (const width of [1385, 430, 320]) {
            await page.setViewportSize({ width, height: 932 });
            await page.goto('http://127.0.0.1:3187');
            await page.locator('#row-node-2').waitFor();
            await page.locator('#row-node-2 .row-select').check();
            check(await page.locator('#copyHy2').isDisabled() && await page.locator('#copyVless').isDisabled(), `${width}px selection without protocols enables encrypted copy`);
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px long data causes page overflow`);
            await page.locator('#row-node-2 .menu-trigger').click();
            await page.locator('#node-menu-node-2 [data-action="manage"]').click();
            check(!(await geometry('#nodeSettingsDialog')).length, `${width}px long node name covers settings controls`);
            await screenshot(`long-name-${width}`);
            await page.locator('#nodeSettingsDialog [data-close]').click();
            await page.locator('#batchDelete').click();
            await page.locator('#confirmDialog').waitFor({ state: 'visible' });
            check(!(await geometry('#confirmDialog')).length, `${width}px confirmation controls overlap`);
            await page.locator('#confirmCancelBtn').click();
            await page.locator('#nodeFilter').fill('no-such-node');
            check(await page.locator('.empty-state').isVisible(), `${width}px empty search has no visible state`);
        }
        console.log(`UI audit found ${failures.length} failures`);
        failures.forEach(failure => console.error(failure));
        assert.strictEqual(failures.length, 0, 'UI audit failures listed above');
    } finally { await browser.close(); }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
