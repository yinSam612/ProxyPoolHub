'use strict';

const assert = require('assert');
const ProxyManager = require('../src/core/proxy-manager');

const manager = new ProxyManager({ listenAddress: '0.0.0.0' });
try {
    const proxies = [
        { proxyId: 'node-a', tag: 'proxy-0', type: 'trojan', server: 'one.example.com', server_port: 443, password: 'one', listenPort: 40000 },
        { proxyId: 'node-b', tag: 'proxy-1', type: 'trojan', server: 'two.example.com', server_port: 443, password: 'two', listenPort: 40001 }
    ];
    const relays = [{
        id: 'example',
        proxyId: 'node-b',
        listenPort: 50000,
        password: 'secret',
        certificatePath: '/etc/tls/fullchain.pem',
        keyPath: '/etc/tls/privkey.pem'
    }];
    const config = manager.generateConfig(proxies, relays);
    assert.deepStrictEqual(config.inbounds[2], {
        type: 'hysteria2',
        tag: 'hy2-relay-example',
        listen: '0.0.0.0',
        listen_port: 40001,
        users: [{ password: 'secret' }],
        tls: {
            enabled: true,
            certificate_path: '/etc/tls/fullchain.pem',
            key_path: '/etc/tls/privkey.pem'
        }
    });
    assert.deepStrictEqual(config.route.rules[2], { inbound: ['hy2-relay-example'], outbound: 'proxy-1' });
    assert.ok(config.outbounds.every((outbound) => !Object.hasOwnProperty.call(outbound, 'proxyId')));
    const reordered = manager.generateConfig(proxies.slice().reverse(), relays);
    assert.strictEqual(reordered.route.rules[2].outbound, 'proxy-1');
    assert.throws(() => manager.generateConfig(proxies, [{ ...relays[0], proxyId: undefined }]), /invalid HY2 target/);
    assert.throws(() => manager.generateConfig(proxies, [{ ...relays[0], proxyId: 'missing' }]), /invalid HY2 target/);
    assert.throws(() => manager.generateConfig(proxies, [relays[0], { ...relays[0], id: 'duplicate' }]), /one listener per proxy/);
    assert.strictEqual(config.inbounds[1].listen_port, config.inbounds[2].listen_port);
    const automatic = manager.generateConfig(proxies, [{
        id: 'automatic', proxyId: 'node-a', listenPort: 50001, password: 'secret', mode: 'auto', host: 'relay.example.com'
    }]);
    assert.deepStrictEqual(automatic.inbounds[2].tls, {
        enabled: true,
        acme: {
            domain: ['relay.example.com'],
            data_directory: require('path').join(manager.moduleConfig.runtimeDir, 'acme'),
            disable_http_challenge: true
        }
    });
} finally {
    manager.logManager.destroy();
}
