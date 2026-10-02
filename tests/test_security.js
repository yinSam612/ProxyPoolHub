'use strict';

const assert = require('assert');
const { cidrs, ipAllowlist, clientIp, AuthLimiter, redactLogLine } = require('../src/utils/security');
const { firewallRules } = require('../src/utils/firewall');
const ProxyManager = require('../src/core/proxy-manager');

const allowed = ipAllowlist('127.0.0.1/32,172.18.0.0/16,::1/128');
assert.strictEqual(redactLogLine('authentication failed, username=test, password=Secret,With:Symbols!'), 'authentication failed, username=test, password=[redacted]');
assert.ok(allowed('127.0.0.1') && allowed('::ffff:127.0.0.1') && allowed('::1') && allowed('172.18.0.2'));
assert.ok(!allowed('198.51.100.1') && !allowed('172.19.0.1'));
for (const value of ['0.0.0.0/33', '::/129', 'example.com', '127.0.0.1/x', '127.0.0.1/1/2']) assert.throws(() => cidrs(value), /invalid/);
const request = { socket: { remoteAddress: '198.51.100.1' }, headers: { 'x-real-ip': '127.0.0.1' } };
assert.strictEqual(clientIp(request, allowed), '198.51.100.1');
request.socket.remoteAddress = '172.18.0.2';
assert.strictEqual(clientIp(request, allowed), '127.0.0.1');
request.headers['x-real-ip'] = '127.0.0.1,198.51.100.2';
assert.strictEqual(clientIp(request, allowed), '172.18.0.2');
const limiter = new AuthLimiter();
for (let i = 0; i < 10; i++) { assert.strictEqual(limiter.begin('one', i * 10000), 0); limiter.fail(i * 10000); }
assert.ok(limiter.begin('one', 100000) > 0);
assert.ok(limiter.begin('two', 90001) > 0, 'account backoff applies across IP addresses');
assert.strictEqual(limiter.begin('one', 600001), 0);
limiter.succeed('one');
assert.strictEqual(limiter.begin('one', 600002), 0);
const options = { webPort: 3100, firstPort: 40000, lastPort: 40100, localPort: 39999, webCidrs: '127.0.0.1/32,::1/128,172.18.0.2/32', proxyCidrs: '127.0.0.1/32,::1/128,172.17.0.0/16' };
const rules = firewallRules({ inbounds: [{ type: 'hysteria2', listen_port: 39999 }, { type: 'vless', listen_port: 50000 }] }, options);
assert.ok(rules.includes('tcp dport 3100 counter drop'));
assert.ok(rules.includes('ip6 saddr { ::1/128 } return'));
assert.ok(rules.includes('udp dport { 39999 } return'));
assert.ok(rules.includes('tcp dport { 50000 } return'));
assert.ok(rules.includes('tcp dport 50000-50100 counter drop'));
assert.ok(!rules.includes('2222') && !rules.includes('flush ruleset') && !rules.includes('policy drop'));
assert.throws(() => firewallRules({ inbounds: [] }, { ...options, firstPort: 2000, lastPort: 2300 }), /invalid/);
const manager = new ProxyManager({ proxyUsername: '', proxyPassword: '' });
try { assert.throws(() => manager.generateConfig([{ type: 'direct', tag: 'test', listenPort: 39999 }]), /unauthenticated/); }
finally { manager.logManager.destroy(); }
console.log('Security passed: trusted proxy IPs, IPv4/IPv6 allowlists, bounded shared throttling, scoped firewall rules and fail-closed proxy authentication.');
