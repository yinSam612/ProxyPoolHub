'use strict';

const assert = require('assert');
const ProxyManager = require('../src/core/proxy-manager');
const { buildSubscription, firstAvailablePort, normalizeProxyLink, wasSystemResumed } = require('../server');

const text = buildSubscription([
    { enabled: true, listenPort: 41000 },
    { enabled: false, listenPort: 41001 }
], 'socks5', { username: 'proxy user', password: 'p@ss', host: 'proxy-socks5' });

assert.strictEqual(text, 'socks5://proxy%20user:p%40ss@proxy-socks5:41000');
assert.strictEqual(firstAvailablePort([{ listenPort: 40000 }, { listenPort: 40002 }], 40000, 40003), 40001);
assert.throws(() => firstAvailablePort([{ listenPort: 40000 }], 40000, 40000), /no available/);

const imported = normalizeProxyLink(String.raw`vless\://11111111-1111-4111-8111-111111111111\@192.0.2.20:443?security=tls&sni=proxy.example.com&type=ws&host=proxy.example.com&path=%2F%3Fed%3D2048#移动`);
assert.strictEqual(imported.startsWith('vless://11111111-1111-4111-8111-111111111111@'), true);
const parsed = new ProxyManager().parseProxyLink(imported, 0);
assert.deepStrictEqual(
    { type: parsed.type, server: parsed.server, port: parsed.server_port, path: parsed.transport.path, host: parsed.transport.headers.Host },
    { type: 'vless', server: '192.0.2.20', port: 443, path: '/?ed=2048', host: 'proxy.example.com' }
);
assert.strictEqual(ProxyManager.extractIpAddress('2001:db8:28e0:840::3d9:45'), '2001:db8:28e0:840::3d9:45');
assert.strictEqual(ProxyManager.extractIpAddress('{"ip":"198.51.100.20"}'), '198.51.100.20');
assert.strictEqual(wasSystemResumed(1000, 66000, 60000), false);
assert.strictEqual(wasSystemResumed(1000, 67000, 60000), true);
