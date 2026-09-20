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

const imported = normalizeProxyLink(String.raw`vless\://426681b4-651f-416f-912d-0fa3907ef588\@104.20.62.136:443?security=tls&sni=cf.xx66.dpdns.org&type=ws&host=cf.xx66.dpdns.org&path=%2F%3Fed%3D2048#移动`);
assert.strictEqual(imported.startsWith('vless://426681b4-651f-416f-912d-0fa3907ef588@'), true);
const parsed = new ProxyManager().parseProxyLink(imported, 0);
assert.deepStrictEqual(
    { type: parsed.type, server: parsed.server, port: parsed.server_port, path: parsed.transport.path, host: parsed.transport.headers.Host },
    { type: 'vless', server: '104.20.62.136', port: 443, path: '/?ed=2048', host: 'cf.xx66.dpdns.org' }
);
assert.strictEqual(ProxyManager.extractIpAddress('2a09:bac1:28e0:840::3d9:45'), '2a09:bac1:28e0:840::3d9:45');
assert.strictEqual(ProxyManager.extractIpAddress('{"ip":"43.163.199.247"}'), '43.163.199.247');
assert.strictEqual(wasSystemResumed(1000, 66000, 60000), false);
assert.strictEqual(wasSystemResumed(1000, 67000, 60000), true);
