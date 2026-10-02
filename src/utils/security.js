'use strict';

const net = require('net');

function cidrs(value) {
    return String(value || '').split(/[\s,]+/).filter(Boolean).map((entry) => {
        const [address, prefix, extra] = entry.split('/');
        const version = net.isIP(address);
        const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix);
        if (!version || address.includes('%') || extra !== undefined || (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) || !Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) {
            throw new Error('invalid IP/CIDR allowlist');
        }
        return { address, bits, version, text: `${address}/${bits}` };
    });
}

function ipAllowlist(value) {
    const list = new net.BlockList();
    for (const item of cidrs(value)) list.addSubnet(item.address, item.bits, item.version === 4 ? 'ipv4' : 'ipv6');
    return (address) => {
        const version = net.isIP(address || '');
        return Boolean(version && list.check(address, version === 4 ? 'ipv4' : 'ipv6'));
    };
}

function clientIp(request, trustedProxy) {
    const peer = request.socket.remoteAddress || '';
    const forwarded = String(request.headers['x-real-ip'] || '').trim();
    return trustedProxy(peer) && net.isIP(forwarded) ? forwarded : peer;
}

// ponytail: one web process; use a shared limiter only if multiple workers are introduced.
class AuthLimiter {
    constructor() {
        this.ips = new Map();
        this.failures = 0;
        this.retryAt = 0;
        this.lastFailure = 0;
    }

    begin(ip, now = Date.now()) {
        for (const [key, value] of this.ips) if (value.expires <= now) this.ips.delete(key);
        const key = this.ips.has(ip) || this.ips.size < 5000 ? ip : '*';
        const value = this.ips.get(key) || { count: 0, expires: now + 600000 };
        const retryAt = value.count >= 10 ? value.expires : this.retryAt;
        if (retryAt > now) return Math.max(1, Math.ceil((retryAt - now) / 1000));
        value.count++;
        this.ips.set(key, value);
        return 0;
    }

    fail(now = Date.now()) {
        this.failures = now - this.lastFailure > 600000 ? 1 : this.failures + 1;
        this.lastFailure = now;
        this.retryAt = now + (this.failures < 5 ? 0 : Math.min(8000, 250 * 2 ** Math.min(this.failures - 5, 5)));
    }

    succeed(ip) {
        this.ips.delete(ip);
        this.failures = 0;
        this.retryAt = 0;
    }
}

function redactLogLine(line) {
    return String(line).replace(/(\bpassword\s*[=:]\s*)[^\r\n]*/gi, '$1[redacted]');
}

module.exports = { cidrs, ipAllowlist, clientIp, AuthLimiter, redactLogLine };
