'use strict';

const { execFileSync } = require('child_process');
const { cidrs } = require('./security');

function firewallRules(config, options) {
    const port = (value) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error('invalid managed firewall port');
        return number;
    };
    const web = port(options.webPort);
    const first = port(options.firstPort);
    const last = port(options.lastPort);
    const local = port(options.localPort);
    if (web === 2222 || (web >= 50000 && web <= 50100) || last < first || last - first > 1000
        || (first <= 50100 && last >= 50000) || (local >= 50000 && local <= 50100)
        || [2222, web].some((p) => p === local || (p >= first && p <= last))) {
        throw new Error('invalid managed firewall port range');
    }
    const allowed = cidrs(options.webCidrs);
    const internal = cidrs(options.proxyCidrs);
    const sources = (items, version) => items.filter((x) => x.version === version).map((x) => x.text).join(', ');
    const publicPorts = (type) => [...new Set(config.inbounds.filter((x) => x.type === type).map((x) => port(x.listen_port)))];
    const lines = ['table inet pph_security {', 'chain input { type filter hook input priority -10; policy accept;', 'iifname "lo" return'];
    for (const version of [4, 6]) {
        const source = sources(allowed, version);
        if (source) lines.push(`tcp dport ${web} ${version === 4 ? 'ip' : 'ip6'} saddr { ${source} } return`);
    }
    lines.push(`tcp dport ${web} counter drop`);
    const mixed = `{ ${local}, ${first}-${last} }`;
    for (const version of [4, 6]) {
        const source = sources(internal, version);
        if (source) lines.push(`tcp dport ${mixed} ${version === 4 ? 'ip' : 'ip6'} saddr { ${source} } return`);
    }
    lines.push(`tcp dport ${mixed} counter drop`);
    const hy2 = publicPorts('hysteria2');
    if (hy2.length) lines.push(`udp dport { ${hy2.join(', ')} } return`);
    lines.push(`udp dport ${mixed} counter drop`);
    const reality = publicPorts('vless');
    if (reality.length) lines.push(`tcp dport { ${reality.join(', ')} } return`);
    lines.push('tcp dport 50000-50100 counter drop', '}', '}');
    return lines.join('\n') + '\n';
}

function syncFirewall(config) {
    if (process.env.MANAGE_FIREWALL !== 'true') return;
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('managed firewall requires Linux root');
    let dockerCidrs = '';
    try {
        const ids = execFileSync('docker', ['network', 'ls', '-q'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/).filter(Boolean);
        if (ids.length) dockerCidrs = JSON.parse(execFileSync('docker', ['network', 'inspect', ...ids], { encoding: 'utf8', timeout: 5000 }))
            .filter((x) => x.Driver === 'bridge').flatMap((x) => x.IPAM.Config || []).map((x) => x.Subnet || '').join(',');
    } catch (error) {
        // No Docker installation is a valid native VPS deployment.
        if (error.code !== 'ENOENT') throw new Error('cannot discover Docker firewall subnets');
    }
    const rules = firewallRules(config, {
        webPort: process.env.WEB_PORT || 3100,
        firstPort: process.env.PROXY_START_PORT || 40000,
        lastPort: process.env.PROXY_PUBLISHED_LAST_PORT || Number(process.env.PROXY_START_PORT || 40000) + 100,
        localPort: process.env.PROXY_LOCAL_PORT || 39999,
        webCidrs: `${process.env.WEB_ALLOWED_CIDRS || '127.0.0.1/32,::1/128'},${process.env.TRUSTED_PROXY_CIDRS || ''}`,
        proxyCidrs: `127.0.0.1/32,::1/128,${dockerCidrs},${process.env.PROXY_EXTERNAL_CIDRS || ''}`
    });
    let exists = false;
    try { execFileSync('nft', ['list', 'table', 'inet', 'pph_security'], { stdio: 'pipe' }); exists = true; }
    catch (error) { if (error.code === 'ENOENT') throw new Error('nftables is required for managed firewall'); }
    const batch = (exists ? 'delete table inet pph_security\n' : '') + rules;
    execFileSync('nft', ['--check', '-f', '-'], { input: batch, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('nft', ['-f', '-'], { input: batch, stdio: ['pipe', 'pipe', 'pipe'] });
}

module.exports = { firewallRules, syncFirewall };
