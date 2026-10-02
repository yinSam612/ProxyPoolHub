'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LogManager = require('../src/core/log-manager');
const { parseBytes, formatBytes } = LogManager;

// 临时测试目录
const TEST_DIR = path.join(__dirname, '.temp_test_log');
const TEST_TRAFFIC_FILE = path.join(TEST_DIR, 'test_traffic.json');

function cleanup() {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
}

cleanup();
fs.mkdirSync(TEST_DIR, { recursive: true });

console.log('[Test LogManager] 1. 流量解析与格式化测试...');
assert.strictEqual(parseBytes('1024 B'), 1024);
assert.strictEqual(parseBytes('1 KB'), 1024);
assert.strictEqual(parseBytes('2.5 MB'), 2.5 * 1024 * 1024);
assert.strictEqual(parseBytes('1 GB'), 1024 * 1024 * 1024);
assert.strictEqual(formatBytes(512), '512 B');
assert.strictEqual(formatBytes(1024 * 2), '2.0 KB');
assert.strictEqual(formatBytes(1024 * 1024 * 5.5), '5.5 MB');

console.log('[Test LogManager] 2. 内核日志行事件生命周期与流量统计测试...');
const manager = new LogManager({
    logDir: TEST_DIR,
    trafficFile: TEST_TRAFFIC_FILE,
    retentionDays: 30,
    maxTotalMb: 10
});
manager.configure({
    inbounds: [{ type: 'mixed', tag: 'inbound-40001', listen_port: 40001 }],
    route: { rules: [{ inbound: ['inbound-40001'], outbound: 'node-hk' }] }
});

// 模拟连接接入
manager.feedKernelLogLine('INFO[0001] [998877] inbound/mixed[inbound-40001]: inbound connection from 127.0.0.1:58421');
assert.strictEqual(manager.activeConnections.size, 1);
const active = manager.activeConnections.get('998877');
assert.strictEqual(active.listenPort, 40001);
assert.strictEqual(active.clientAddress, '127.0.0.1:58421');
assert.strictEqual(manager.getRecentLogs({ port: 40001 }).length, 1, 'Record connections before they close');
assert.strictEqual(manager.getRecentLogs()[0].uploadBytes, null, 'Unknown traffic is not zero');

// 模拟路由识别目标域名
manager.feedKernelLogLine('INFO[0002] [998877] outbound/vless[node-hk]: outbound connection to api.openai.com:443');
assert.strictEqual(active.target, 'api.openai.com:443');
assert.strictEqual(active.outbound, 'node-hk');

// 模拟连接关闭结算流量
manager.feedKernelLogLine('INFO[0003] [998877] inbound/mixed[inbound-40001]: closed, upload: 12.5 KB, download: 150.0 KB');
assert.strictEqual(manager.activeConnections.size, 0); // 活跃表中已移除

// 验证内存环形队列已记录
const recent = manager.getRecentLogs();
assert.strictEqual(recent.length, 1);
assert.strictEqual(recent[0].listenPort, 40001);
assert.strictEqual(recent[0].target, 'api.openai.com:443');
assert.strictEqual(recent[0].uploadBytes, parseBytes('12.5 KB'));
assert.strictEqual(recent[0].downloadBytes, parseBytes('150.0 KB'));

// 验证流量统计累加
const summary = manager.getTrafficSummary();
assert.ok(summary[40001], '应该存在40001端口的流量统计');
assert.strictEqual(summary[40001].connections, 1);
assert.strictEqual(summary[40001].todayConnections, 1);
assert.strictEqual(summary[40001].trafficMeasured, true);
assert.strictEqual(summary[40001].todayUpload, parseBytes('12.5 KB'));
assert.strictEqual(summary[40001].todayDownload, parseBytes('150.0 KB'));

console.log('[Test LogManager] 3. 筛选与搜索测试...');
const filteredByPort = manager.getRecentLogs({ port: 40001 });
assert.strictEqual(filteredByPort.length, 1);
const filteredByWrongPort = manager.getRecentLogs({ port: 40002 });
assert.strictEqual(filteredByWrongPort.length, 0);
const filteredByKw = manager.getRecentLogs({ keyword: 'openai' });
assert.strictEqual(filteredByKw.length, 1);
const filteredByWrongKw = manager.getRecentLogs({ keyword: 'google' });
assert.strictEqual(filteredByWrongKw.length, 0);

console.log('[Test LogManager] Numeric sorting before limits, unknown values, stable ties and live duration...');
const sortable = Object.create(LogManager.prototype);
sortable.maxMemoryLogs = 500;
sortable.recentLogs = [null, 9, 1024, 1048576, 0, 9, undefined, NaN].map((value, id) => ({
    id, listenPort: 39999, target: 'video.example:443', uploadBytes: value, downloadBytes: value, durationMs: value
}));
for (const sort of ['uploadBytes', 'downloadBytes', 'durationMs']) {
    assert.deepStrictEqual(sortable.getRecentLogs({ sort, order: 'asc' }).map(item => item.id), [4, 1, 5, 2, 3, 0, 6, 7]);
    assert.deepStrictEqual(sortable.getRecentLogs({ sort, order: 'desc' }).map(item => item.id), [3, 2, 1, 5, 4, 0, 6, 7]);
    assert.deepStrictEqual(sortable.getRecentLogs({ port: 39999, keyword: 'video', sort, limit: 1 }).map(item => item.id), [3]);
    assert.deepStrictEqual(sortable.getRecentLogs().map(item => item.id), [0, 1, 2, 3, 4, 5, 6, 7], 'Sorting must not mutate default chronological order');
}
sortable.recentLogs = Array.from({ length: 120 }, (_, id) => ({ id, downloadBytes: id }));
assert.strictEqual(sortable.getRecentLogs({ sort: 'downloadBytes', limit: 50 })[0].id, 119, 'Sort all recent records, not only the selected display limit');
sortable.recentLogs = [{ id: 'live', status: 'active', timestamp: new Date(Date.now() - 60000).toISOString(), durationMs: 0 }, { id: 'closed', durationMs: 2000 }];
assert.strictEqual(sortable.getRecentLogs({ sort: 'durationMs' })[0].id, 'live');
assert.strictEqual(sortable.recentLogs[0].durationMs, 0, 'Computed live duration must not mutate stored records');
assert.throws(() => sortable.getRecentLogs({ sort: '__proto__' }), /invalid/);
assert.throws(() => sortable.getRecentLogs({ order: 'sideways' }), /invalid/);

console.log('[Test LogManager] Real sing-box colored logs, indexed tags, HY2, VLESS and UDP...');
manager.configure({
    inbounds: [
        { type: 'mixed', tag: 'inbound-0', listen_port: 39999 },
        { type: 'mixed', tag: 'inbound-1', listen_port: 40000 },
        { type: 'hysteria2', tag: 'hy2-relay-local', listen_port: 39999 },
        { type: 'vless', tag: 'reality-local-vps', listen_port: 50000 }
    ],
    route: { rules: [
        { inbound: ['inbound-0', 'hy2-relay-local', 'reality-local-vps'], outbound: 'proxy-0' },
        { inbound: ['inbound-1'], outbound: 'proxy-1' }
    ] }
});
const real = (id, elapsed, message) => `+0100 2026-10-02 13:53:08 \x1b[36mINFO\x1b[0m [\x1b[38;5;169m${id}\x1b[0m ${elapsed}] ${message}`;
manager.feedKernelLogLine(real('4108316295', '0ms', 'inbound/hysteria2[hy2-relay-local]: inbound connection from 198.51.100.20:11981'));
manager.feedKernelLogLine(real('4108316295', '3ms', 'inbound/hysteria2[hy2-relay-local]: inbound connection to play.googleapis.com:443'));
manager.feedKernelLogLine(real('4108316295', '10ms', 'outbound/direct[proxy-0]: outbound connection to play.googleapis.com:443'));
let records = manager.getRecentLogs({ port: 39999 });
assert.strictEqual(records.length, 1);
assert.strictEqual(records[0].target, 'play.googleapis.com:443');
assert.strictEqual(records[0].timestamp, '2026-10-02T12:53:08.000Z');
assert.strictEqual(records[0].outbound, 'proxy-0');
assert.strictEqual(records[0].protocol, 'hysteria2');
assert.strictEqual(records[0].durationMs, null);
assert.strictEqual(manager.getTrafficSummary()[39999].todayConnections, 1);
assert.strictEqual(manager.getTrafficSummary()[39999].trafficMeasured, false);
manager.feedKernelLogLine(real('4058296261', '0ms', 'inbound/hysteria2[hy2-relay-local]: inbound packet connection from [2001:db8::1]:11981'));
manager.feedKernelLogLine(real('4058296261', '5ms', 'inbound/hysteria2[hy2-relay-local]: inbound packet connection to m.youtube.com:443'));
manager.feedKernelLogLine(real('4058296261', '7ms', 'outbound/direct[proxy-0]: outbound packet connection'));
records = manager.getRecentLogs({ keyword: 'youtube' });
assert.strictEqual(records[0].client, '[2001:db8::1]:11981');
assert.strictEqual(records[0].network, 'udp');
assert.strictEqual(records[0].outbound, 'proxy-0');
manager.feedKernelLogLine(real('2844055705', '0ms', 'inbound/mixed[inbound-0]: inbound connection from 127.0.0.1:58412'));
manager.feedKernelLogLine(real('2844055705', '3ms', 'inbound/mixed[inbound-0]: [proxy] inbound connection to api.ipify.org:443'));
manager.feedKernelLogLine(real('1234', '0ms', 'inbound/vless[reality-local-vps]: inbound connection from [2001:db8::2]:58412'));
manager.feedKernelLogLine(real('1234', '1ms', 'inbound/vless[reality-local-vps]: inbound connection to [2606:4700::1111]:443'));
assert.strictEqual(manager.getRecentLogs({ port: 39999 }).length, 4, 'Node filtering must include its VLESS port');
assert.strictEqual(manager.getRecentLogs({ port: 50000 })[0].nodePort, 39999);
assert.strictEqual(manager.getRecentLogs({ port: 50000 })[0].target, '[2606:4700::1111]:443');
assert.strictEqual(manager.getTrafficSummary()[39999].todayConnections, 4, 'Do not count routing updates twice');
const countBefore = manager.getRecentLogs().length;
manager.feedKernelLogLine(real('5555', '10ms', 'connection: closed'));
manager.feedKernelLogLine('ERROR connection upload closed: raw-read');
manager.feedKernelLogLine(real('6666', '0ms', 'inbound/mixed[inbound-9]: inbound connection from 127.0.0.1:12345'));
assert.strictEqual(manager.getRecentLogs().length, countBefore, 'Unknown connection and inbound tags must not create port-zero records');
manager.configure({ inbounds: [{ type: 'mixed', tag: 'inbound-0', listen_port: 40000 }], route: { rules: [] } });
manager.feedKernelLogLine(real('2844055705', '0ms', 'inbound/mixed[inbound-0]: inbound connection from 127.0.0.1:58412'));
assert.strictEqual(manager.getRecentLogs({ port: 40000 }).length, 1, 'Core restarts must remap index tags and avoid connection ID collisions');
manager.trafficStats.get(40000).todayDate = '2000-01-01';
assert.strictEqual(manager.getTrafficSummary()[40000].todayConnections, 0, 'Daily counts must reset independently of lifetime counts');

console.log('[Test LogManager] 4. 过期文件与磁盘配额清理测试...');
// 伪造一个 35 天前的旧文件
const oldFile = path.join(TEST_DIR, 'access-2026-01-01.log');
fs.writeFileSync(oldFile, 'old data');
const thirtyFiveDaysAgo = Date.now() - (35 * 24 * 60 * 60 * 1000);
fs.utimesSync(oldFile, thirtyFiveDaysAgo / 1000, thirtyFiveDaysAgo / 1000);
assert.ok(fs.existsSync(oldFile));

manager.cleanExpiredLogs();
assert.ok(!fs.existsSync(oldFile), '超过30天的旧日志应被自动删除');

manager.destroy();
assert.ok(fs.existsSync(TEST_TRAFFIC_FILE), '流量统计数据应成功持久化落盘');

setTimeout(() => {
    const restored = new LogManager({ logDir: TEST_DIR, trafficFile: TEST_TRAFFIC_FILE });
    assert.strictEqual(restored.getRecentLogs({ keyword: 'googleapis' }).length, 1, 'Disk updates must restore as one connection');
    assert.strictEqual(restored.getRecentLogs({ keyword: 'googleapis' })[0].outbound, 'proxy-0');
    const previousDate = new Date(Date.now() - 86400000);
    const date = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, '0')}-${String(previousDate.getDate()).padStart(2, '0')}`;
    fs.writeFileSync(path.join(TEST_DIR, `access-${date}.log`), JSON.stringify({ timestamp: previousDate.toISOString(), listenPort: 40002, target: 'previous-day.example:443' }) + '\n');
    restored.loadRecentLogsFromDisk();
    assert.strictEqual(restored.getRecentLogs({ port: 40002 }).length, 1, 'Page reloads must retain previous-day records');
    restored.destroy();
    cleanup();
    console.log('✓ All LogManager tests passed successfully.');
}, 100);
