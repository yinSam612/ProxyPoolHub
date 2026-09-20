'use strict';

/**
 * @file test_totp.js
 * @description 验证 RFC 6238 标准测试矢量及 TOTP 模块功能
 */

const assert = require('assert');
const {
    base32Encode,
    base32Decode,
    generateSecret,
    generateTotp,
    verifyTotp,
    buildOtpauthUrl
} = require('../src/utils/totp');

// 1. 测试 Base32 编解码
const sample = Buffer.from('Hello, World!');
const encoded = base32Encode(sample);
const decoded = base32Decode(encoded);
assert.strictEqual(decoded.toString('utf8'), 'Hello, World!');

// 2. RFC 6238 官方测试矢量验证
// RFC 6238 Appendix B 规范测试密钥: ASCII "12345678901234567890"
// Base32 编码为: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// 测试矢量 (时间戳以毫秒计)
const rfcVectors = [
    { timestamp: 59 * 1000, expected: '287082' },
    { timestamp: 1111111109 * 1000, expected: '081804' },
    { timestamp: 1111111111 * 1000, expected: '050471' },
    { timestamp: 1234567890 * 1000, expected: '005924' },
    { timestamp: 2000000000 * 1000, expected: '279037' }
];

for (const vector of rfcVectors) {
    const code = generateTotp(rfcSecret, vector.timestamp);
    assert.strictEqual(code, vector.expected, `RFC 6238 vector failed at ${vector.timestamp}`);
}

// 3. 动态验证测试
const testSecret = generateSecret();
assert.strictEqual(typeof testSecret, 'string');
assert.strictEqual(testSecret.length >= 32, true);

const currentCode = generateTotp(testSecret);
assert.strictEqual(/^\d{6}$/.test(currentCode), true);

// 校验正确代码
assert.strictEqual(verifyTotp(currentCode, testSecret), true);

// 校验错误代码
assert.strictEqual(verifyTotp('000000' === currentCode ? '111111' : '000000', testSecret), false);
assert.strictEqual(verifyTotp('invalid', testSecret), false);

// 4. 测试 otpauth URL 格式
const url = buildOtpauthUrl('RelayControl', 'admin', testSecret);
assert.strictEqual(url.startsWith('otpauth://totp/RelayControl:admin?secret='), true);
assert.strictEqual(url.includes('issuer=RelayControl'), true);

console.log('✓ All TOTP tests passed successfully.');
