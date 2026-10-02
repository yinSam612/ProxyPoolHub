'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

async function run() {
    const browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true });
    const web = path.join(__dirname, '..', 'web');
    const output = process.env.PPH_WEB_SCREENSHOT_DIR;
    if (output) fs.mkdirSync(output, { recursive: true });
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'pph-login-browser-'));
    const dataFile = path.join(runtime, 'proxies.json');
    fs.writeFileSync(dataFile, JSON.stringify({ proxies: [{ id: 'local-vps', enabled: false }] }));
    const liveServer = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, WEB_HOST: '127.0.0.1', WEB_PORT: '3191', REQUIRE_AUTH: 'true', MANAGE_FIREWALL: 'false',
            WEB_ALLOWED_CIDRS: '127.0.0.1/32,::1/128', TRUSTED_PROXY_CIDRS: '', ADMIN_USER: 'browser-test',
            ADMIN_PASSWORD: 'BrowserTestPassword1!', PROXY_USERNAME: 'proxy', PROXY_PASSWORD: 'BrowserProxyPassword1!',
            PROXY_DATA_FILE: dataFile, PROXY_RUNTIME_DIR: runtime }
    });
    liveServer.stderr.on('data', () => {});
    try {
        const live = await browser.newContext();
        const base = 'http://127.0.0.1:3191';
        let ready = false;
        for (let i = 0; i < 30; i++) {
            try { if ((await live.request.get(`${base}/login`)).status() === 200) { ready = true; break; } } catch {}
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(ready, 'isolated login server must start');
        const livePage = await live.newPage();
        const loginPage = await livePage.goto(`${base}/login`);
        assert.strictEqual((await loginPage.allHeaders())['referrer-policy'], 'same-origin');
        await livePage.locator('#username').fill('browser-test');
        await livePage.locator('#password').fill('BrowserTestPassword1!');
        const posted = livePage.waitForResponse((response) => response.url().endsWith('/login') && response.request().method() === 'POST');
        await livePage.locator('#submitBtn').click();
        const loggedIn = await posted;
        assert.strictEqual((await loggedIn.request().allHeaders()).origin, base);
        assert.strictEqual(loggedIn.status(), 303, 'native browser form must authenticate against the real server');
        await livePage.waitForURL(`${base}/`);
        assert.strictEqual((await live.request.get(`${base}/api/status`)).status(), 200);
        await livePage.locator('.settings-menu .menu-trigger').click();
        const setupResponse = livePage.waitForResponse(response => response.url().endsWith('/api/totp/setup'));
        await livePage.locator('#openTotpDialog').click();
        const setup = await (await setupResponse).json();
        const issuer = `ProxyPH-${os.hostname()}`;
        assert.strictEqual(setup.issuer, issuer);
        assert.strictEqual(decodeURIComponent(new URL(setup.otpauthUrl).pathname), `/${issuer}:browser-test`);
        await livePage.locator('#totpQrContainer svg').waitFor();
        assert.strictEqual(await livePage.locator('#totpSecretText').innerText(), setup.secret);
        const setupAgain = await (await live.request.get(`${base}/api/totp/setup`)).json();
        assert.strictEqual(setupAgain.secret, setup.secret, 'Opening setup must preserve the pending secret');
        await livePage.locator('#totpDialog [data-close]').first().click();
        await live.request.post(`${base}/logout`);
        await livePage.goto(`${base}/login`);
        await livePage.locator('#username').fill('browser-test');
        await livePage.locator('#password').fill('wrong-password');
        const rejected = livePage.waitForResponse((response) => response.url().endsWith('/login') && response.request().method() === 'POST');
        await livePage.locator('#submitBtn').click();
        assert.strictEqual((await rejected).status(), 401, 'wrong password must show the login error, not Invalid URL');
        await live.close();
        const context = await browser.newContext({ viewport: { width: 1385, height: 946 } });
        let mfa = true;
        const settings = { proxyUsername: 'proxy', proxyPassword: 'example-only-secret', publicHost: 'example.test', subscriptions: {}, totpEnabled: true };
        const node = { id: 'local-vps', name: 'vps-machine', isLocal: true, protocol: 'direct', enabled: true, listenPort: 39999, status: 'online',
            hy2: { id: '111111111111111111111111', status: 'enabled', link: 'hysteria2://old@example.test:39999' },
            reality: { host: 'example.test', serverName: 'www.apple.com', listenPort: 50000, enabled: true, link: 'vless://old@example.test:50000' } };
        const calls = [];
        let login;
        await context.route('**/*', async (route) => {
            const request = route.request();
            const pathname = new URL(request.url()).pathname;
            if (pathname === '/login') {
                if (request.method() === 'POST') { login = new URLSearchParams(request.postData()); return route.fulfill({ body: 'ok' }); }
                const body = fs.readFileSync(path.join(web, 'login.html'), 'utf8').replace('{{TOTP_CONFIGURED}}', String(mfa))
                    .replace('{{DEFAULT_USER}}', 'admin').replace('{{ERROR_STYLE}}', 'display:none').replace('{{ERROR}}', '');
                return route.fulfill({ contentType: 'text/html', body });
            }
            const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/lucide.svg': 'lucide.svg' }[pathname];
            if (file) return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)], body: fs.readFileSync(path.join(web, file), 'utf8') });
            if (!pathname.startsWith('/api/')) return route.fulfill({ status: 404 });
            let data;
            if (pathname === '/api/proxies') data = [node];
            else if (pathname === '/api/settings') data = settings;
            else if (pathname === '/api/status') data = { core: 'running', enabled: 1, online: 1, total: 1 };
            else if (pathname.endsWith('/rotate')) {
                const body = request.postDataJSON();
                assert.strictEqual(body.currentPassword, 'example-admin-password');
                assert.strictEqual(body.totpCode, '123456');
                calls.push(pathname);
                if (pathname.includes('/relays/')) { node.hy2.link = 'hysteria2://new@example.test:39999'; data = node.hy2; }
                else { node.reality.link = 'vless://new@example.test:50000'; data = node.reality; }
            } else return route.fulfill({ status: 400, json: { error: 'unexpected test request' } });
            return route.fulfill({ json: data });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        for (const width of [1385, 390, 320]) {
            await page.setViewportSize({ width, height: 946 });
            await page.goto('http://127.0.0.1:3190/login');
            assert.ok(await page.locator('#password').isVisible());
            assert.ok(await page.locator('#totpCode').isVisible());
            assert.ok(await page.locator('#totpCode').evaluate((input) => input.required));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            if (output) await page.screenshot({ path: path.join(output, `login-mfa-${width}.png`) });
        }
        await page.locator('#password').fill('example-admin-password');
        await page.locator('#totpCode').fill('123456');
        await page.locator('#submitBtn').click();
        await page.waitForFunction(() => document.body.textContent === 'ok');
        assert.strictEqual(login.get('password'), 'example-admin-password');
        assert.strictEqual(login.get('totpCode'), '123456');
        mfa = false;
        await page.goto('http://127.0.0.1:3190/login');
        assert.ok(await page.locator('#password').isVisible());
        assert.ok(!await page.locator('#totpCode').isVisible());
        await page.setViewportSize({ width: 1385, height: 946 });
        await page.goto('http://127.0.0.1:3190/');
        await page.waitForSelector('#row-local-vps');
        await page.locator('#row-local-vps .row-menu .menu-trigger').click();
        await page.locator('#row-local-vps [data-action="manage"]').click();
        await page.locator('#nodeSettingsDialog [data-action="rotate-hy2"]').click();
        await page.waitForSelector('#reauthDialog[open]');
        assert.ok(await page.locator('#reauthForm [name="totpCode"]').isVisible());
        if (output) await page.screenshot({ path: path.join(output, 'reauth-desktop.png') });
        await page.locator('#reauthDialog [data-close]').first().click();
        assert.strictEqual(calls.length, 0, 'cancel cannot rotate credentials');
        await page.locator('#nodeSettingsDialog [data-action="rotate-hy2"]').click();
        await page.locator('#reauthForm [name="currentPassword"]').fill('example-admin-password');
        await page.locator('#reauthForm [name="totpCode"]').fill('123456');
        await Promise.all([
            page.waitForResponse((response) => response.url().includes('/relays/') && response.url().endsWith('/rotate')),
            page.locator('#reauthForm [type="submit"]').click()
        ]);
        assert.ok(calls[0].includes('/relays/'));
        await page.locator('#nodeSettingsDialog [data-action="reality"]').click();
        await page.setViewportSize({ width: 320, height: 800 });
        assert.ok(await page.locator('#rotateReality').isVisible());
        const bounds = await page.locator('#realityDialog').evaluate((dialog) => { const box = dialog.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth; });
        assert.ok(bounds, 'Reality controls must fit narrow screens');
        await page.locator('#rotateReality').click();
        if (output) await page.screenshot({ path: path.join(output, 'reauth-mobile.png') });
        await page.locator('#reauthForm [name="currentPassword"]').fill('example-admin-password');
        await page.locator('#reauthForm [name="totpCode"]').fill('123456');
        await Promise.all([
            page.waitForResponse((response) => response.url().endsWith('/reality/rotate')),
            page.locator('#reauthForm [type="submit"]').click()
        ]);
        assert.ok(calls.some((entry) => entry.includes('/reality/rotate')));
        assert.deepStrictEqual(errors, []);
        console.log('Web security passed: real browser/server form login, password+TOTP login, desktop/mobile bounds, credential reauthentication, cancel and HY2/Reality rotation.');
    } finally {
        await browser.close();
        if (liveServer.exitCode === null) {
            const exited = new Promise((resolve) => liveServer.once('exit', resolve));
            liveServer.kill();
            await exited;
        }
        assert.strictEqual(path.dirname(path.resolve(runtime)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(runtime).startsWith('pph-login-browser-'));
        fs.rmSync(runtime, { recursive: true, force: true });
    }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
