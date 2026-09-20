'use strict';

/**
 * @file totp.js
 * @description 基于 RFC 6238 (TOTP) 与 RFC 4226 (HOTP) 标准的原生零依赖身份验证器模块
 * 支持 Google Authenticator、Microsoft Authenticator 等应用
 */

const crypto = require('crypto');

// RFC 4648 标准 Base32 字符表
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 将二进制 Buffer 编码为 Base32 字符串
 * @param {Buffer} buffer - 待编码的二进制数据
 * @returns {string} Base32 编码字符串
 */
function base32Encode(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        buffer = Buffer.from(buffer || '');
    }
    let bits = 0;
    let value = 0;
    let output = '';

    for (let i = 0; i < buffer.length; i++) {
        value = (value << 8) | buffer[i];
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
}

/**
 * 将 Base32 字符串解码为二进制 Buffer
 * @param {string} text - 待解码的 Base32 字符串（自动过滤空格、连字符并转大写）
 * @returns {Buffer} 解码后的二进制数据
 */
function base32Decode(text) {
    const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];

    for (let i = 0; i < clean.length; i++) {
        const index = BASE32_ALPHABET.indexOf(clean[i]);
        if (index === -1) {
            continue;
        }
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }

    return Buffer.from(bytes);
}

/**
 * 生成随机的 TOTP 密钥 (Base32 格式)
 * @param {number} [byteLength=20] - 密钥随机字节长度，默认为 20 字节 (160-bit)，符合 RFC 建议
 * @returns {string} Base32 格式的随机密钥
 */
function generateSecret(byteLength = 20) {
    const randomBuffer = crypto.randomBytes(byteLength);
    return base32Encode(randomBuffer);
}

/**
 * 生成基于时间的一次性验证码 (TOTP)
 * @param {string} secret - Base32 格式密钥
 * @param {number} [timestamp=Date.now()] - 时间戳（毫秒）
 * @param {number} [stepSeconds=30] - 时间步长，标准为 30 秒
 * @param {number} [digits=6] - 动态码位数，标准为 6 位
 * @returns {string} 格式化后的 6 位数字验证码
 */
function generateTotp(secret, timestamp = Date.now(), stepSeconds = 30, digits = 6) {
    const key = base32Decode(secret);
    if (!key.length) {
        return '';
    }

    const counter = Math.floor(timestamp / 1000 / stepSeconds);
    const counterBuffer = Buffer.alloc(8);
    // 写入 64 位大端计数器
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const hmac = crypto.createHmac('sha1', key);
    hmac.update(counterBuffer);
    const digest = hmac.digest();

    // 动态截断 (Dynamic Truncation)
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);

    const otp = binary % (10 ** digits);
    return String(otp).padStart(digits, '0');
}

/**
 * 校验客户端输入的 TOTP 验证码
 * @param {string} token - 用户输入的 6 位动态验证码
 * @param {string} secret - Base32 格式密钥
 * @param {object} [options={}] - 校验配置
 * @param {number} [options.window=1] - 时钟容差步长（默认 ±1，即允许前后 30 秒的时钟偏差）
 * @param {number} [options.stepSeconds=30] - 时间步长（秒）
 * @param {number} [options.digits=6] - 动态码位数
 * @returns {boolean} 校验是否通过
 */
function verifyTotp(token, secret, options = {}) {
    const cleanToken = String(token || '').trim();
    if (!/^\d{6}$/.test(cleanToken) || !secret) {
        return false;
    }

    const window = Math.max(0, Number(options.window ?? 1));
    const stepSeconds = Number(options.stepSeconds || 30);
    const digits = Number(options.digits || 6);
    const now = Date.now();

    for (let i = -window; i <= window; i++) {
        const checkTime = now + (i * stepSeconds * 1000);
        const expected = generateTotp(secret, checkTime, stepSeconds, digits);
        if (expected && crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(expected))) {
            return true;
        }
    }

    return false;
}

/**
 * 生成符合 Authenticator 规范的 otpauth:// 协议链接
 * @param {string} issuer - 发行机构/系统名称 (如 "RelayControl")
 * @param {string} accountName - 账号名称 (如 "admin")
 * @param {string} secret - Base32 格式密钥
 * @returns {string} otpauth://totp/... 链接
 */
function buildOtpauthUrl(issuer, accountName, secret) {
    const cleanIssuer = encodeURIComponent(String(issuer || 'RelayControl').trim());
    const cleanAccount = encodeURIComponent(String(accountName || 'admin').trim());
    const cleanSecret = String(secret || '').trim().replace(/\s+/g, '');
    return `otpauth://totp/${cleanIssuer}:${cleanAccount}?secret=${cleanSecret}&issuer=${cleanIssuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
    base32Encode,
    base32Decode,
    generateSecret,
    generateTotp,
    verifyTotp,
    buildOtpauthUrl
};
