'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const web = path.join(__dirname, '..', 'web');

async function run() {
    const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const output = process.env.PPH_WEB_SCREENSHOT_DIR;
    if (output) fs.mkdirSync(output, { recursive: true });
    try {
        const context = await browser.newContext();
        const nodes = [
            { name: 'vps-demo', listenPort: 39999, location: 'United States / California / Los Angeles' },
            { name: 'VPS-1', listenPort: 40000, location: 'Singapore / Singapore' }
        ];
        const record = (port, protocol, target) => ({ id: `${protocol}:${port}:${target}`, timestamp: '2026-10-02T12:53:08Z', listenPort: port,
            nodePort: port === 50000 ? 39999 : port, protocol, target, client: '[2001:db8::20]:11981',
            uploadBytes: null, downloadBytes: null, durationMs: null });
        let logs = [record(39999, 'hysteria2', 'play.googleapis.com:443'), record(50000, 'vless', 'www.example.com:443'), record(40000, 'mixed', 'other.example:443')];
        let gate = null;
        let failure = false;
        let requests = 0;
        let active = 0;
        let maxActive = 0;
        let accounting = { status: 'disabled' };
        let storage = { usedFormatted: '16.3 KB', usedBytes: 16700, maxTotalMb: 50, retentionDays: 30, fileCount: 2 };
        let traffic = {
            39999: { todayConnections: 2, connections: 100, todayUpload: 0, todayDownload: 0, trafficMeasured: false },
            40000: { todayConnections: 1, connections: 50, todayUpload: 0, todayDownload: 0, trafficMeasured: false }
        };
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            const file = { '/logs': 'logs.html', '/logs.js': 'logs.js', '/style.css': 'style.css', '/lucide.svg': 'lucide.svg' }[url.pathname];
            if (file) return route.fulfill({ headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }, contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)], body: fs.readFileSync(path.join(web, file), 'utf8') });
            if (url.pathname === '/api/proxies') return route.fulfill({ json: nodes });
            if (url.pathname === '/api/log-settings') {
                if (route.request().method() === 'PUT') {
                    const policy = route.request().postDataJSON();
                    if (policy.maxTotalMb < 1) return route.fulfill({ status: 400, json: { error: 'Invalid quota' } });
                    storage = { ...storage, ...policy };
                }
                return route.fulfill({ json: { ...storage, totpEnabled: false } });
            }
            if (url.pathname === '/api/logs/clear') {
                if (route.request().postDataJSON().currentPassword !== 'correct-password') return route.fulfill({ status: 403, json: { error: '密码无效' } });
                logs = [];
                storage = { ...storage, usedBytes: 0, usedFormatted: '0 B', fileCount: 0 };
                return route.fulfill({ json: storage });
            }
            if (url.pathname !== '/api/logs') return route.fulfill({ status: 404 });
            requests++;
            active++;
            maxActive = Math.max(maxActive, active);
            const port = Number(url.searchParams.get('port'));
            const keyword = url.searchParams.get('keyword') || '';
            const snapshot = logs.filter(log => (!port || log.nodePort === port || log.listenPort === port) && log.target.includes(keyword));
            const sort = url.searchParams.get('sort');
            if (sort) snapshot.sort((a, b) => {
                if (!Number.isFinite(a[sort]) || !Number.isFinite(b[sort])) return Number(Number.isFinite(b[sort])) - Number(Number.isFinite(a[sort]));
                return (a[sort] - b[sort]) * (url.searchParams.get('order') === 'asc' ? 1 : -1);
            });
            snapshot.splice(Number(url.searchParams.get('limit') || 100));
            try {
                if (gate) await gate;
                if (failure) return await route.fulfill({ status: 500, json: { error: 'Audit read failed' } });
                await route.fulfill({ json: { logs: snapshot, traffic, storage, accounting } });
            } finally { active--; }
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.text().includes('Content Security Policy')) errors.push(message.text()); });
        await page.clock.install();
        await page.goto('http://127.0.0.1:3186/logs?port=39999');
        await page.waitForFunction(() => document.querySelector('#refreshStatus').textContent.includes('已更新'));
        await page.locator('#autoRefreshSelect').selectOption('0');
        assert.strictEqual(await page.locator('.log-row').count(), 2, 'Node filtering must include HY2 and VLESS');
        assert.strictEqual(await page.locator('#metricTotalConns').innerText(), '2', 'Daily count must not show lifetime count');
        assert.strictEqual(await page.locator('#metricTodayDown').innerText(), '未采集');
        assert.ok((await page.locator('.log-node-cell').last().innerText()).includes('VLESS :50000'));
        assert.ok((await page.locator('.log-node-label').first().innerText()).includes('vps-demo'));
        assert.strictEqual(await page.locator('.log-duration-tag').first().innerText(), '-');

        const beforeRefresh = requests;
        logs.push(record(39999, 'hysteria2', 'new-request.example:443'));
        await page.locator('#refreshBtn').click();
        await page.waitForFunction(() => document.querySelectorAll('.log-row').length === 3);
        assert.ok(requests > beforeRefresh, 'The refresh button must issue a new request');

        let release;
        gate = new Promise(resolve => { release = resolve; });
        await page.locator('#refreshBtn').click();
        await page.waitForFunction(() => document.querySelector('#refreshBtn').getAttribute('aria-busy') === 'true');
        await page.locator('#nodeSelect').selectOption('40000');
        await page.locator('#refreshBtn').click();
        gate = null;
        release();
        await page.waitForFunction(() => document.querySelectorAll('.log-row').length === 1 && document.querySelector('.log-target-cell').textContent === 'other.example:443');
        assert.strictEqual(maxActive, 1, 'Polling, manual refresh and filter changes must not overlap');
        assert.strictEqual(await page.locator('#metricTotalConns').innerText(), '1');

        failure = true;
        await page.locator('#refreshBtn').click();
        await page.waitForFunction(() => document.querySelector('#refreshStatus').textContent === '刷新失败');
        assert.ok((await page.locator('#refreshStatus').getAttribute('title')).includes('Audit read failed'), 'Show the backend error');
        assert.strictEqual(await page.locator('.log-row').count(), 1, 'A failed refresh must not remove the last successful records');
        assert.strictEqual(await page.locator('#refreshBtn').getAttribute('aria-busy'), 'false');
        await page.locator('#nodeSelect').selectOption('39999');
        await page.locator('.logs-error').waitFor();
        assert.strictEqual(await page.locator('.log-row').count(), 0, 'A failed filter change must not show records from the previously selected node');
        assert.strictEqual(await page.locator('#matchedCount').innerText(), '0');
        if (output) await page.screenshot({ path: path.join(output, 'logs-error.png') });
        failure = false;
        logs = [];
        await page.locator('#refreshBtn').click();
        await page.locator('.logs-empty-box').waitFor();
        if (output) await page.screenshot({ path: path.join(output, 'logs-empty.png') });
        logs = [record(39999, 'hysteria2', 'play.googleapis.com:443'), record(50000, 'vless', 'www.example.com:443')];
        await page.locator('#nodeSelect').selectOption('39999');
        await page.waitForFunction(() => document.querySelectorAll('.log-row').length === 2);
        for (const [width, height] of [[1385, 844], [1024, 768], [768, 1024], [430, 932], [390, 844], [320, 568]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
            const problems = await page.evaluate(() => {
                const issues = [];
                if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('page horizontal overflow');
                const controls = [...document.querySelectorAll('button, select, input, .back-home-btn')].filter(element => element.getClientRects().length && !element.closest('.logs-table-wrap'));
                for (const control of controls) {
                    const r = control.getBoundingClientRect();
                    if (r.left < 0 || r.right > innerWidth) issues.push(`${control.id || control.className} outside viewport`);
                    if (r.top >= 0 && r.bottom <= innerHeight && !control.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))) issues.push(`${control.id || control.className} covered`);
                }
                return issues;
            });
            assert.deepStrictEqual(problems, [], `${width}x${height}: ${problems.join(', ')}`);
            await page.locator('#refreshBtn').scrollIntoViewIfNeeded();
            assert.ok(await page.locator('#refreshBtn').isVisible());
            if (output) await page.screenshot({ path: path.join(output, `logs-${width}x${height}.png`), fullPage: true });
        }
        await page.reload();
        await page.waitForFunction(() => document.querySelectorAll('.log-row').length === 2);
        await page.locator('#autoRefreshSelect').selectOption('0');
        logs = Array.from({ length: 80 }, (_, index) => record(39999, index % 2 ? 'mixed' : 'hysteria2', `target-${index}.example:443`));
        await page.evaluate(() => fetchLogs());
        const bounds = () => page.evaluate(() => {
            const selectors = ['.logs-shell', '.overview-grid', '.metric-card', '.metric-value', '.logs-workspace-bar', '#nodeSelect', '#searchInput', '#refreshBtn', '#recordCounter', '#refreshStatus', '.logs-table-wrap', '.logs-table th'];
            return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
                const box = element.getBoundingClientRect();
                return [box.x, box.y, box.width, box.height].map(value => Math.round(value * 100) / 100);
            }));
        });
        for (const [width, height] of [[1385, 844], [1180, 720], [1025, 768], [1024, 768], [768, 1024], [430, 932], [390, 844], [320, 568]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate(() => { document.querySelector('.logs-table-wrap').scrollTop = 0; window.scrollTo({ top: 0, behavior: 'instant' }); });
            const before = await bounds();
            let releaseRefresh;
            gate = new Promise(resolve => { releaseRefresh = resolve; });
            await page.evaluate(() => { void fetchLogs(); });
            await page.waitForFunction(() => document.querySelector('#refreshBtn').getAttribute('aria-busy') === 'true');
            assert.deepStrictEqual(await bounds(), before, `${width}px: loading feedback must not move the toolbar or columns`);
            gate = null;
            releaseRefresh();
            await page.waitForFunction(() => document.querySelector('#refreshBtn').getAttribute('aria-busy') === 'false');
            assert.deepStrictEqual(await bounds(), before, `${width}px: completion must not change layout`);
            await page.evaluate(() => {
                window.auditSavedRow = document.querySelector('.log-row');
                window.auditSavedClient = document.querySelector('.log-client-pill');
                document.querySelector('.logs-table-wrap').scrollTop = 130;
                document.querySelector('.logs-table-wrap').scrollLeft = 80;
            });
            const scrolled = await bounds();
            const scroll = await page.locator('.logs-table-wrap').evaluate(element => [element.scrollTop, element.scrollLeft]);
            const oldFirstId = logs[0].id;
            logs = [{ ...record(39999, 'vless', 'new-live.example:443'), id: `new-${width}` }, ...logs];
            logs.find(log => log.id === oldFirstId).uploadFormatted = '999.9 GB';
            logs.find(log => log.id === oldFirstId).downloadFormatted = '123.4 MB';
            logs.find(log => log.id === oldFirstId).durationMs = 123456;
            traffic[39999] = { ...traffic[39999], todayConnections: 123456789, todayUpload: 123456789, todayDownload: 987654321, trafficMeasured: true };
            await page.evaluate(() => fetchLogs(false));
            assert.deepStrictEqual(await bounds(), scrolled, `${width}px: data updates must preserve dimensions`);
            assert.deepStrictEqual(await page.locator('.logs-table-wrap').evaluate(element => [element.scrollTop, element.scrollLeft]), scroll, `${width}px: data updates must preserve scroll position`);
            assert.ok(await page.evaluate(() => document.querySelector('.log-row') === window.auditSavedRow && document.querySelector('.log-client-pill') === window.auditSavedClient), `${width}px: passive updates must preserve existing rows and unchanged cells`);
            if (output) await page.screenshot({ path: path.join(output, `logs-stable-${width}x${height}.png`), fullPage: true });
        }
        for (const width of [1385, 1025, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(() => {
                window.scrollTo({ top: 0, behavior: 'instant' });
                const wrap = document.querySelector('.logs-table-wrap');
                wrap.scrollTop = 156;
                const range = document.createRange();
                range.selectNodeContents(document.querySelector('.log-client-pill'));
                getSelection().removeAllRanges();
                getSelection().addRange(range);
            });
            const before = await bounds();
            const saved = await page.evaluate(() => ({ selected: getSelection().toString(), scroll: document.querySelector('.logs-table-wrap').scrollTop, row: document.querySelector('.log-row').dataset.logId, windowY: scrollY }));
            await page.locator('#autoRefreshSelect').selectOption('2000');
            for (let cycle = 0; cycle < 6; cycle++) {
                logs = [{ ...record(39999, 'hysteria2', `live-${width}-${cycle}.example:443`) }, ...logs].slice(0, 100);
                const previousRequests = requests;
                await page.clock.runFor(2000);
                await page.waitForFunction(() => !state.isFetching);
                assert.ok(requests > previousRequests, `${width}px: automatic polling must fetch new data`);
                assert.deepStrictEqual(await bounds(), before, `${width}px: continuous polling must not shift layout`);
                assert.deepStrictEqual(await page.evaluate(() => ({ selected: getSelection().toString(), scroll: document.querySelector('.logs-table-wrap').scrollTop, row: document.querySelector('.log-row').dataset.logId, windowY: scrollY })), saved, `${width}px: preserve selection, reading position and row order during polling`);
            }
            await page.locator('#autoRefreshSelect').selectOption('0');
            await page.evaluate(() => getSelection().removeAllRanges());
        }
        const stableBefore = await bounds();
        failure = true;
        await page.evaluate(() => fetchLogs(false));
        assert.deepStrictEqual(await bounds(), stableBefore, 'A backend failure must not resize the page or remove the table');
        failure = false;
        logs = [];
        await page.evaluate(() => fetchLogs());
        assert.deepStrictEqual(await bounds(), stableBefore, 'Empty results must not resize the table, cards or toolbar');

        accounting = { status: 'connected' };
        traffic[39999] = { todayConnections: 100, todayUpload: 4096, todayDownload: 8192, trafficMeasured: true, trafficPartial: true };
        logs = [{ ...record(39999, 'hysteria2', 'measured.example:443'), uploadFormatted: '4.0 KB', downloadFormatted: '8.0 KB', durationMs: 123 }];
        await page.evaluate(() => fetchLogs());
        assert.strictEqual(await page.locator('#metricTodayDown').innerText(), '8.0 KB', 'Old unmeasured history must not hide newly measured bytes');
        assert.strictEqual(await page.locator('#metricDownMeta').innerText(), '仅含已采集流量');
        assert.ok((await page.locator('.log-traffic-group').innerText()).includes('4.0 KB'));
        await page.setViewportSize({ width: 1385, height: 844 });
        if (output) await page.screenshot({ path: path.join(output, 'logs-measured.png'), fullPage: true });
        for (const width of [1385, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await page.locator('#logSettingsBtn').click();
            await page.waitForFunction(() => !document.querySelector('#logMaxMb').disabled);
            const box = await page.locator('#logSettingsDialog').boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844, `${width}px: settings must fit the viewport`);
            if (output) await page.screenshot({ path: path.join(output, `logs-policy-${width}.png`) });
            await page.locator('#logMaxMb').fill('1');
            await page.locator('#logRetentionDays').fill('7');
            await page.locator('#logSettingsForm [type=submit]').click();
            await page.waitForFunction(() => document.querySelector('#logSettingsFeedback').textContent === '已保存');
            await page.locator('[data-close=logSettingsDialog]').click();
            await page.locator('#logSettingsBtn').click();
            await page.waitForFunction(() => document.querySelector('#logMaxMb').value === '1');
            await page.locator('#clearLogsBtn').click();
            await page.locator('#clearLogsForm [name=currentPassword]').fill('wrong-password');
            await page.locator('#clearLogsForm [type=submit]').click();
            await page.waitForFunction(() => document.querySelector('#clearLogsFeedback').textContent === '密码无效');
            assert.strictEqual(await page.locator('.log-row').count(), 1, 'Wrong credentials must retain records');
            if (output) await page.screenshot({ path: path.join(output, `logs-clear-${width}.png`) });
            await page.locator('#clearLogsForm [data-close]').click();
            assert.strictEqual(await page.locator('#clearLogsForm [name=currentPassword]').inputValue(), '', 'Closing the dialog must clear password input');
        }
        await page.locator('#logSettingsBtn').click();
        await page.waitForFunction(() => !document.querySelector('#logMaxMb').disabled);
        await page.locator('#clearLogsBtn').click();
        const totals = await page.locator('#metricTodayDown').innerText();
        let releaseClear;
        gate = new Promise(resolve => { releaseClear = resolve; });
        await page.evaluate(() => { void fetchLogs(false); });
        await page.waitForFunction(() => state.isFetching);
        await page.locator('#clearLogsForm [name=currentPassword]').fill('correct-password');
        await page.locator('#clearLogsForm [type=submit]').click();
        await page.waitForFunction(() => !document.querySelector('#clearLogsDialog').open);
        gate = null;
        releaseClear();
        await page.waitForFunction(() => !state.isFetching);
        assert.strictEqual(await page.locator('.log-row').count(), 0, 'A stale pre-clear response must not resurrect deleted records');
        assert.strictEqual(await page.locator('#metricTodayDown').innerText(), totals, 'Clear must retain measured traffic totals');
        assert.strictEqual(await page.locator('#metricStorageUsed').innerText(), '0 B');

        await page.setViewportSize({ width: 1385, height: 844 });
        await page.evaluate(() => { document.querySelector('.logs-table-wrap').scrollTop = 0; });
        logs = [null, 9, 1024, 1048576, 0, 9].map((value, index) => ({ ...record(39999, 'hysteria2', `sorted-${index}.example:443`),
            uploadBytes: value, downloadBytes: value, durationMs: value, uploadFormatted: value == null ? '' : String(value), downloadFormatted: value == null ? '' : String(value) }));
        await page.evaluate(() => fetchLogs());
        const orderOfRows = () => page.locator('.log-target-cell').allTextContents();
        for (const sort of ['uploadBytes', 'downloadBytes', 'durationMs']) {
            const button = page.locator(`[data-sort="${sort}"]`);
            const before = await bounds();
            await button.click();
            await page.waitForFunction(() => !state.isFetching && state.order === 'desc');
            assert.deepStrictEqual(await orderOfRows(), [3, 2, 1, 5, 4, 0].map(index => `sorted-${index}.example:443`));
            assert.strictEqual(await button.getAttribute('aria-pressed'), 'true');
            assert.strictEqual(await button.locator('use').getAttribute('href'), '/lucide.svg#arrow-down');
            assert.deepStrictEqual(await bounds(), before, 'Sorting indicators must not resize the table or toolbar');
            await button.press('Enter');
            await page.waitForFunction(() => !state.isFetching && state.order === 'asc');
            const expected = [4, 1, 5, 2, 3, 0].map(index => `sorted-${index}.example:443`);
            assert.deepStrictEqual(await orderOfRows(), expected);
            await page.evaluate(() => fetchLogs(false));
            assert.deepStrictEqual(await orderOfRows(), expected, 'Passive refresh must retain sort direction');
        }
        let releaseSort;
        gate = new Promise(resolve => { releaseSort = resolve; });
        await page.locator('[data-sort="downloadBytes"]').click();
        await page.waitForFunction(() => state.isFetching);
        await page.locator('[data-sort="uploadBytes"]').click();
        gate = null;
        releaseSort();
        await page.waitForFunction(() => !state.isFetching);
        assert.strictEqual(await page.locator('[data-sort="uploadBytes"]').getAttribute('aria-pressed'), 'true');
        assert.deepStrictEqual(await orderOfRows(), [3, 2, 1, 5, 4, 0].map(index => `sorted-${index}.example:443`), 'Discard stale sort responses');
        assert.strictEqual(maxActive, 1, 'Sort changes must not overlap log requests');
        for (const width of [1385, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await page.locator('[data-sort="durationMs"]').scrollIntoViewIfNeeded();
            const problems = await page.locator('[data-sort="durationMs"]').evaluate(element => {
                const r = element.getBoundingClientRect();
                const header = element.closest('th').getBoundingClientRect();
                return r.right > header.right || r.left < header.left || !element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
            });
            assert.ok(!problems, `${width}px: duration sort must fit its column and be clickable`);
            if (output) await page.screenshot({ path: path.join(output, `logs-sorted-${width}.png`), fullPage: true });
        }
        assert.deepStrictEqual(errors, []);
        console.log('PASS: Numeric upload/download/duration sorting, stale sort protection, measured traffic, log policy, reauthenticated clear, CSP and desktop/mobile geometry across eight viewports and 24 stable polling cycles');
    } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
