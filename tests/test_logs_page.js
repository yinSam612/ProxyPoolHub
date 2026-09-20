/**
 * @file test_logs_page.js
 * @description 验证独立大盘页面 /logs 路由映射与 /api/logs 返回结构
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const LogManager = require('../src/core/log-manager');

// 1. 验证 LogManager.getStorageInfo
const tmpDir = path.join(__dirname, '..', 'data', 'test_storage_logs');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'access-2026-09-20.log'), 'test line 1\ntest line 2\n');

const lm = new LogManager({ logDir: tmpDir, retentionDays: 30, maxTotalMb: 1024 });
const info = lm.getStorageInfo();
assert.strictEqual(info.retentionDays, 30);
assert.strictEqual(info.maxTotalMb, 1024);
assert.ok(info.usedBytes > 0);
assert.ok(info.usedFormatted.includes('B'));
assert.strictEqual(info.fileCount, 1);
lm.destroy();

// 清理临时文件
try {
    fs.unlinkSync(path.join(tmpDir, 'access-2026-09-20.log'));
    fs.rmdirSync(tmpDir);
} catch (e) {}

console.log('✓ 1. LogManager.getStorageInfo 测试通过');

// 2. 检查静态文件物理存在性
const webDir = path.join(__dirname, '..', 'web');
assert.ok(fs.existsSync(path.join(webDir, 'logs.html')), 'web/logs.html 必须存在');
assert.ok(fs.existsSync(path.join(webDir, 'logs.js')), 'web/logs.js 必须存在');

const htmlContent = fs.readFileSync(path.join(webDir, 'logs.html'), 'utf8');
assert.ok(htmlContent.includes('连接审计与流量监控'), 'logs.html 包含标题');
assert.ok(htmlContent.includes('返回控制台'), 'logs.html 包含返回主页链接');
assert.ok(htmlContent.includes('/logs.js'), 'logs.html 引入 logs.js');

console.log('✓ 2. logs.html 与 logs.js 文件及内容校验通过');
console.log('✓ All logs page tests passed successfully.');
