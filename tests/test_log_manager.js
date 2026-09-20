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

// 模拟连接接入
manager.feedKernelLogLine('INFO[0001] [998877] inbound/mixed[inbound-40001]: inbound connection from 127.0.0.1:58421');
assert.strictEqual(manager.activeConnections.size, 1);
const active = manager.activeConnections.get('998877');
assert.strictEqual(active.listenPort, 40001);
assert.strictEqual(active.clientAddress, '127.0.0.1:58421');

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
    cleanup();
    console.log('✓ All LogManager tests passed successfully.');
    process.exit(0);
}, 100);
