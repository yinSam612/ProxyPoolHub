'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LogManager = require('../src/core/log-manager');

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pph-log-storage-'));
    const options = { logDir: dir, trafficFile: path.join(dir, 'traffic.json') };
    const manager = new LogManager(options);
    try {
        assert.strictEqual(manager.maxTotalMb, 50);
        for (const maxTotalMb of [0, -1, 1.5, 4097, 'bad']) assert.throws(() => manager.validateStoragePolicy({ maxTotalMb, retentionDays: 30 }), /invalid/);
        for (const retentionDays of [0, 366, 1.5]) assert.throws(() => manager.validateStoragePolicy({ maxTotalMb: 1, retentionDays }), /invalid/);
        manager.configure({ inbounds: [{ type: 'mixed', tag: 'test', listen_port: 39999 }], route: { rules: [] } });
        const connection = { id: 'native-short', inbound: 'test', source: '127.0.0.1:10001', destination: '127.0.0.1:80',
            createdAt: Date.now(), closedAt: Date.now() + 2, uplinkTotal: 1234, downlinkTotal: 5678, network: 'tcp' };
        manager.feedAccountingEvent({ type: 2, id: connection.id, connection });
        manager.feedAccountingEvent({ type: 0, id: connection.id, connection });
        assert.strictEqual(manager.getTrafficSummary()[39999].todayUpload, 1234);
        assert.strictEqual(manager.getTrafficSummary()[39999].todayDownload, 5678);
        assert.strictEqual(manager.getTrafficSummary()[39999].connections, 1);
        assert.strictEqual(manager.getRecentLogs().length, 1);
        await manager.flushLogs();
        fs.writeFileSync(path.join(dir, 'access-2026-01-01.log'), Buffer.alloc(2 * 1024 * 1024));
        fs.writeFileSync(path.join(dir, 'unrelated.log'), 'keep');
        await manager.setStoragePolicy({ maxTotalMb: 1, retentionDays: 7 });
        assert.ok(manager.getStorageInfo().usedBytes <= 1024 * 1024, 'Reducing quota must remove an oversized legacy daily file');
        for (let i = 0; i < 120; i++) manager.writeLog({ id: `load-${i}`, timestamp: new Date().toISOString(), listenPort: 39999, target: 'x'.repeat(20000) });
        await manager.flushLogs();
        await new Promise(resolve => setImmediate(resolve));
        manager.cleanExpiredLogs();
        assert.ok(manager.getStorageInfo().usedBytes <= 1024 * 1024, 'Same-day segments must rotate within the quota');
        assert.ok(manager.getStorageInfo().fileCount > 1);
        const before = manager.getTrafficSummary();
        const storage = await manager.clearLogs();
        assert.strictEqual(storage.usedBytes, 0);
        assert.strictEqual(storage.fileCount, 0);
        assert.deepStrictEqual(manager.getRecentLogs(), []);
        assert.deepStrictEqual(manager.getTrafficSummary(), before, 'Clearing records must retain all traffic totals');
        manager.feedAccountingEvent({ type: 0, id: connection.id, connection });
        assert.deepStrictEqual(manager.getRecentLogs(), [], 'Replay must not resurrect cleared records');
        manager.feedAccountingEvent({ type: 2, id: 'after-clear', connection: { ...connection, id: 'after-clear', createdAt: manager.clearedBefore + 10 } });
        assert.strictEqual(manager.getRecentLogs().length, 1, 'New connections after clearing must still be recorded');
        await manager.flushLogs();
        assert.strictEqual(fs.readFileSync(path.join(dir, 'unrelated.log'), 'utf8'), 'keep');
        console.log('PASS: Storage validation, 50 MB default, same-day rotation, reduced quota, clear without deleting traffic or unrelated files');
    } finally {
        manager.destroy();
        assert.strictEqual(path.dirname(dir), os.tmpdir());
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
