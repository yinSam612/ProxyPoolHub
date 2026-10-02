'use strict';

/**
 * @file log-manager.js
 * @description 节点连接审计、上下行流量统计与按天日志轮转管理器
 * 负责解析内核日志事件、统计节点传输流量、维护内存活跃连接与磁盘日志归档清理（默认30天）
 */

const fs = require('fs');
const path = require('path');
const { stripVTControlCharacters } = require('util');
const { randomUUID } = require('crypto');
const net = require('net');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { redactLogLine } = require('../utils/security');
const StatsClient = grpc.loadPackageDefinition(protoLoader.loadSync(path.join(__dirname, 'singbox-stats.proto'), { longs: Number, defaults: true })).daemon.StartedService;
const AUDIT_FILE = /^access-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/;

/**
 * 将带单位的流量字符串（如 1.2 KB, 34.5 MB, 1024 B）转换为纯字节数
 * @param {string} text - 流量文本
 * @returns {number} 字节数
 */
function parseBytes(text) {
    if (!text) return 0;
    const clean = String(text).trim().toUpperCase();
    const match = clean.match(/^([0-9.]+)\s*([KMGT]?B?)$/);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    if (Number.isNaN(val)) return 0;
    const unit = match[2];
    if (unit.startsWith('K')) return Math.round(val * 1024);
    if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
    if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
    if (unit.startsWith('T')) return Math.round(val * 1024 * 1024 * 1024 * 1024);
    return Math.round(val);
}

/**
 * 将字节数格式化为易读的字符串（如 1.25 MB）
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的文本
 */
function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 获取服务器本地日期字符串 YYYY-MM-DD
 * @returns {string}
 */
function getTodayDateString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 从单行日志中准确提取连接唯一ID
 * @param {string} text - 日志行
 * @returns {string|null}
 */
function extractConnId(text) {
    const match = text.match(/\[([0-9a-zA-Z_-]+)(?:\s+[^\]]+)?\]\s+(?:inbound|outbound|closed|connection|router)\b/i);
    return match ? match[1] : null;
}

class LogManager {
    /**
     * @param {object} options
     * @param {string} options.logDir - 日志持久化目录
     * @param {string} options.trafficFile - 流量统计持久化文件
     * @param {number} [options.retentionDays=30] - 日志保留最长天数
     * @param {number} [options.maxTotalMb=50] - 日志目录软配额限制（MB）
     * @param {number} [options.maxMemoryLogs=500] - 内存保留最新连接记录数
     */
    constructor(options = {}) {
        this.logDir = path.resolve(String(options.logDir || path.join(process.cwd(), 'data', 'logs')));
        this.trafficFile = path.resolve(String(options.trafficFile || path.join(process.cwd(), 'data', 'traffic.json')));
        this.retentionDays = Math.max(1, Number(options.retentionDays || process.env.LOG_RETENTION_DAYS || 30));
        this.maxTotalMb = Math.max(1, Number(options.maxTotalMb || process.env.LOG_MAX_TOTAL_MB || 50));
        this.clearedBefore = Number(options.clearedBefore || 0);
        this.maxMemoryLogs = Math.max(50, Number(options.maxMemoryLogs || 500));

        // 内存最近连接环形队列
        this.recentLogs = [];
        // 活跃连接追踪表 (按连接ID追踪): connectionId -> { id, startTime, inboundPort, clientIp, target, outbound, uploadBytes, downloadBytes }
        this.activeConnections = new Map();
        this.inbounds = new Map();
        this.sessionId = randomUUID();
        this.accountingStatus = 'disabled';
        this.completedConnections = new Map();
        // 节点流量统计表: port -> { todayDate, todayUpload, todayDownload, totalUpload, totalDownload, connectionCount }
        this.trafficStats = new Map();
        this.trafficDirty = false;

        this.currentLogDate = '';
        this.currentLogStream = null;

        this.initDirs();
        this.loadTrafficStats();
        this.cleanExpiredLogs();
        this.loadRecentLogsFromDisk();
        this.trafficSaveTimer = setInterval(() => { if (this.trafficDirty) this.saveTrafficStats(); }, 5000);
        this.trafficSaveTimer.unref();

        // 每天凌晨定时轮转与清理
        this.cleanupTimer = setInterval(() => {
            this.cleanExpiredLogs();
            this.rotateTodayTraffic();
        }, 60 * 60 * 1000);
        if (typeof this.cleanupTimer.unref === 'function') {
            this.cleanupTimer.unref();
        }
    }

    /**
     * 初始化日志目录
     */
    initDirs() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    /**
     * 加载历史累计流量统计数据
     */
    loadTrafficStats() {
        try {
            if (fs.existsSync(this.trafficFile)) {
                const data = JSON.parse(fs.readFileSync(this.trafficFile, 'utf8'));
                if (data && typeof data === 'object') {
                    for (const [port, item] of Object.entries(data)) {
                        this.trafficStats.set(Number(port), item);
                    }
                }
            }
        } catch (error) {
            // 容错处理
        }
    }

    /**
     * 启动时从最新磁盘日志文件恢复最近记录到内存队列
     */
    loadRecentLogsFromDisk() {
        try {
            const loaded = [];
            const seen = new Set();
            const files = fs.readdirSync(this.logDir).filter(name => AUDIT_FILE.test(name))
                .sort((a, b) => fs.statSync(path.join(this.logDir, b)).mtimeMs - fs.statSync(path.join(this.logDir, a)).mtimeMs);
            for (const name of files) {
                const filePath = path.join(this.logDir, name);
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.trim().split('\n').filter(Boolean);
                for (let i = lines.length - 1; i >= 0 && loaded.length < this.maxMemoryLogs; i--) {
                    try {
                        const record = JSON.parse(lines[i]);
                        if (!(Number(record.listenPort) > 0)) continue;
                        if (record.id && seen.has(record.id)) continue;
                        if (record.id) seen.add(record.id);
                        loaded.push(record);
                    } catch (e) {}
                }
                if (loaded.length >= this.maxMemoryLogs) break;
            }
            this.recentLogs = loaded.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        } catch (error) {
            // 容错处理
        }
    }

    /**
     * 持久化流量数据到磁盘
     */
    saveTrafficStats() {
        try {
            const out = {};
            for (const [port, item] of this.trafficStats.entries()) {
                out[port] = item;
            }
            fs.writeFileSync(this.trafficFile, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
            this.trafficDirty = false;
        } catch (error) {
            // 忽略写入异常
        }
    }

    /**
     * 日期变更时轮转每日流量统计
     */
    rotateTodayTraffic() {
        const today = getTodayDateString();
        let changed = false;
        for (const item of this.trafficStats.values()) {
            if (item.todayDate !== today) {
                changed = true;
                item.todayDate = today;
                item.todayUpload = 0;
                item.todayDownload = 0;
                item.todayConnections = 0;
                item.todayUnmeasuredConnections = 0;
                item.todayMeasuredConnections = 0;
            }
        }
        if (changed) this.saveTrafficStats();
    }

    /**
     * 获取指定日期的文件写入流（按天自动分文件）
     * @returns {fs.WriteStream}
     */
    getWriteStream(bytes = 0) {
        const today = getTodayDateString();
        const chunkLimit = Math.min(5 * 1024 * 1024, this.maxTotalMb * 1024 * 1024 / 4);
        if (this.currentLogStream && this.currentLogDate === today && this.currentLogBytes + bytes <= chunkLimit) {
            return this.currentLogStream;
        }

        if (this.currentLogStream) {
            try { this.currentLogStream.end(() => this.cleanExpiredLogs()); } catch (e) {}
        }

        this.currentLogDate = today;
        this.partIndex = Math.max(Date.now(), (this.partIndex || 0) + 1);
        const filePath = path.join(this.logDir, `access-${today}-${this.partIndex}.log`);
        this.currentLogFile = filePath;
        this.currentLogBytes = 0;
        this.currentLogStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8', mode: 0o600 });
        this.currentLogStream.on('error', (err) => {
            // 防御写入异常
        });
        return this.currentLogStream;
    }

    /**
     * 写入一条连接明细记录
     * @param {object} record - 结构化日志对象
     */
    writeLog(record) {
        if (this.logsSuspended) return;
        // 放入内存环形队列
        const index = record.id ? this.recentLogs.findIndex((item) => item.id === record.id) : -1;
        if (index >= 0) this.recentLogs[index] = record;
        else this.recentLogs.unshift(record);
        if (this.recentLogs.length > this.maxMemoryLogs) {
            this.recentLogs.length = this.maxMemoryLogs;
        }

        // 写入文件
        try {
            const line = `${JSON.stringify(record)}\n`;
            const bytes = Buffer.byteLength(line);
            const stream = this.getWriteStream(bytes);
            this.currentLogBytes += bytes;
            stream.write(line);
        } catch (error) {
            // 忽略写日志错误
        }
    }

    /**
     * 累加指定端口节点的流量统计
     * @param {number} port - 节点本地监听端口
     * @param {number} upload - 上行字节
     * @param {number} download - 下行字节
     */
    addTraffic(port, upload = 0, download = 0, connections = 0) {
        if (!port) return;
        this.trafficDirty = true;
        const today = getTodayDateString();
        let stat = this.trafficStats.get(port);
        if (!stat) {
            stat = {
                todayDate: today,
                todayUpload: 0,
                todayDownload: 0,
                totalUpload: 0,
                totalDownload: 0,
                connections: 0,
                todayConnections: 0,
                todayUnmeasuredConnections: 0
            };
            this.trafficStats.set(port, stat);
        }

        if (stat.todayDate !== today) {
            stat.todayDate = today;
            stat.todayUpload = 0;
            stat.todayDownload = 0;
            stat.todayConnections = 0;
            stat.todayUnmeasuredConnections = 0;
            stat.todayMeasuredConnections = 0;
        }

        stat.todayUpload += upload;
        stat.todayDownload += download;
        stat.totalUpload += upload;
        stat.totalDownload += download;
        stat.connections += connections;
        stat.todayConnections = (stat.todayConnections || 0) + connections;
        stat.todayUnmeasuredConnections = (stat.todayUnmeasuredConnections || 0) + connections;
    }

    configure(config) {
        this.stopAccounting();
        this.activeConnections.clear();
        this.completedConnections.clear();
        this.sessionId = randomUUID();
        this.accounting = config.services?.find(item => item.tag === 'pph-accounting');
        this.inbounds.clear();
        const routes = new Map();
        for (const rule of config.route?.rules || []) {
            for (const tag of [].concat(rule.inbound || [])) routes.set(tag, rule.outbound);
        }
        const nodePorts = new Map((config.inbounds || []).filter((item) => item.type === 'mixed')
            .map((item) => [routes.get(item.tag), item.listen_port]));
        for (const item of config.inbounds || []) {
            this.inbounds.set(item.tag, {
                listenPort: item.listen_port,
                nodePort: nodePorts.get(routes.get(item.tag)) || item.listen_port,
                protocol: item.type
            });
        }
    }

    saveConnection(conn) {
        if (conn.startTime <= this.clearedBefore) return;
        this.writeLog({
            id: conn.id, timestamp: conn.timestamp, listenPort: conn.listenPort, nodePort: conn.nodePort,
            protocol: conn.protocol, network: conn.network, client: conn.clientAddress,
            target: conn.target || '-', outbound: conn.outbound,
            uploadBytes: conn.uploadBytes, downloadBytes: conn.downloadBytes,
            uploadFormatted: conn.uploadBytes == null ? null : formatBytes(conn.uploadBytes),
            downloadFormatted: conn.downloadBytes == null ? null : formatBytes(conn.downloadBytes),
            durationMs: conn.durationMs, status: conn.status
        });
    }

    async prepareAccounting() {
        const server = net.createServer();
        const port = await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                server.close(error => error ? reject(error) : resolve(port));
            });
        });
        return { type: 'api', tag: 'pph-accounting', listen: '127.0.0.1', listen_port: port, secret: randomUUID() + randomUUID(), dashboard: false };
    }

    startAccounting() {
        if (!this.accounting) return;
        const client = new StatsClient(`127.0.0.1:${this.accounting.listen_port}`, grpc.credentials.createInsecure());
        this.statsClient = client;
        this.accountingStatus = 'connecting';
        const retry = error => {
            if (this.statsClient !== client) return;
            this.accountingStatus = 'disconnected';
            this.accountingError = String(error?.details || error?.message || 'Statistics stream disconnected').slice(0, 160);
            this.statsClient = null;
            client.close();
            this.statsRetry = setTimeout(() => this.startAccounting(), 1000);
            this.statsRetry.unref();
        };
        client.waitForReady(Date.now() + 10000, error => {
            if (this.statsClient !== client) return;
            if (error) return retry(error);
            const metadata = new grpc.Metadata();
            metadata.set('authorization', `Bearer ${this.accounting.secret}`);
            const stream = client.subscribeConnections({ interval: 1000000000 }, metadata);
            this.statsStream = stream;
            stream.on('data', batch => {
                if (this.statsClient !== client) return;
                this.accountingStatus = 'connected';
                this.accountingError = '';
                for (const event of batch.events || []) this.feedAccountingEvent(event);
            });
            stream.on('error', retry);
            stream.on('end', () => retry());
        });
    }

    stopAccounting() {
        clearTimeout(this.statsRetry);
        const client = this.statsClient;
        this.statsClient = null;
        this.statsStream?.cancel();
        this.statsStream = null;
        client?.close();
        this.accountingStatus = 'disabled';
    }

    feedAccountingEvent(event) {
        const id = event.id || event.connection?.id;
        if (!id) return;
        let conn = this.activeConnections.get(id) || this.completedConnections.get(id);
        const first = !conn;
        const full = event.connection;
        if (first) {
            const inbound = this.inbounds.get(full?.inbound);
            if (!inbound || !Number.isFinite(full.createdAt)) return;
            conn = { ...inbound, id, startTime: full.createdAt, timestamp: new Date(full.createdAt).toISOString(),
                startDate: getTodayDateString(), clientAddress: full.source, network: full.network,
                target: full.domain ? `${full.domain}:${full.destination.slice(full.destination.lastIndexOf(':') + 1)}` : full.destination,
                outbound: full.outbound, uploadBytes: 0, downloadBytes: 0, durationMs: 0, status: 'active' };
        }
        const previousUp = conn.uploadBytes;
        const previousDown = conn.downloadBytes;
        const previousStatus = conn.status;
        const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        if (full) {
            // Full snapshots and close events carry authoritative totals, not deltas.
            conn.uploadBytes = bytes(full.uplinkTotal);
            conn.downloadBytes = bytes(full.downlinkTotal);
        } else if (event.type === 1) {
            conn.uploadBytes += bytes(event.uplinkDelta);
            conn.downloadBytes += bytes(event.downlinkDelta);
        }
        const closedAt = full?.closedAt || event.closedAt;
        conn.durationMs = Math.max(0, (closedAt || Date.now()) - conn.startTime);
        conn.status = closedAt ? 'closed' : 'active';
        this.addTraffic(conn.nodePort, conn.uploadBytes - previousUp, conn.downloadBytes - previousDown, first ? 1 : 0);
        const stat = this.trafficStats.get(conn.nodePort);
        if (first) {
            stat.todayUnmeasuredConnections = Math.max(0, stat.todayUnmeasuredConnections - 1);
            stat.todayMeasuredConnections = (stat.todayMeasuredConnections || 0) + 1;
            stat.measuredSince ||= new Date().toISOString();
        }
        if (closedAt) {
            this.activeConnections.delete(id);
            this.completedConnections.set(id, conn);
            // Matches the native API's 1000-connection replay window.
            if (this.completedConnections.size > 1000) this.completedConnections.delete(this.completedConnections.keys().next().value);
        } else this.activeConnections.set(id, conn);
        if (first || conn.uploadBytes !== previousUp || conn.downloadBytes !== previousDown || conn.status !== previousStatus) this.saveConnection(conn);
    }

    /**
     * 核心方法: 解析内核输出的单行文本
     * 支持匹配连接创建、目标路由与连接关闭流量事件
     * @param {string} line - 内核标准输出的一行
     */
    feedKernelLogLine(line) {
        if (this.accounting) return;
        if (!line || typeof line !== 'string') return;
        const text = redactLogLine(stripVTControlCharacters(line)).trim();
        if (!text) return;

        // 提取连接唯一ID
        const connId = extractConnId(text);

        const source = text.match(/inbound (packet )?connection from\s+(\S+)/);
        if (source) {
            const inboundTag = text.match(/inbound\/[^\s[]+\[([^\]]+)\]/)?.[1];
            const inbound = this.inbounds.get(inboundTag);
            if (!connId || !inbound || this.activeConnections.has(connId)) return;
            const time = text.match(/^([+-]\d{2})(\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
            const timestamp = time ? new Date(`${time[3]}T${time[4]}${time[1]}:${time[2]}`).toISOString() : new Date().toISOString();
            const conn = {
                ...inbound, id: `${this.sessionId}:${connId}`, timestamp, startTime: Date.now(), startDate: getTodayDateString(),
                clientAddress: source[2], network: source[1] ? 'udp' : 'tcp',
                target: '', outbound: '', uploadBytes: null, downloadBytes: null, durationMs: null
            };
            this.activeConnections.set(connId, conn);
            // ponytail: retain only recent connections; native core accounting is needed for complete lifetime/byte tracking.
            if (this.activeConnections.size > this.maxMemoryLogs) this.activeConnections.delete(this.activeConnections.keys().next().value);
            this.addTraffic(conn.nodePort, 0, 0, 1);
            this.saveConnection(conn);
            return;
        }

        const conn = connId ? this.activeConnections.get(connId) : null;
        if (!conn) return;
        const target = text.match(/(?:inbound|outbound) (?:packet )?connection to\s+(\S+)/)?.[1];
        const outbound = text.match(/outbound\/[^\s[]+\[([^\]]+)\]/)?.[1];
        if (target || (outbound && /outbound (?:packet )?connection\b/.test(text))) {
            const changed = (target && target !== conn.target) || (outbound && outbound !== conn.outbound);
            if (target) conn.target = target;
            if (outbound) conn.outbound = outbound;
            if (changed) this.saveConnection(conn);
            return;
        }

        // 3. 匹配连接关闭与流量统计: closed, upload: 12.5 KB, download: 1.2 MB
        if (/\bclosed(?:,| after|$)/.test(text)) {
            const uploadMatch = text.match(/upload:?\s*([0-9.]+\s*[KMGT]?B?)/i);
            const downloadMatch = text.match(/download:?\s*([0-9.]+\s*[KMGT]?B?)/i);
            conn.uploadBytes = uploadMatch ? parseBytes(uploadMatch[1]) : null;
            conn.downloadBytes = downloadMatch ? parseBytes(downloadMatch[1]) : null;
            conn.durationMs = Date.now() - conn.startTime;
            this.addTraffic(conn.nodePort, conn.uploadBytes || 0, conn.downloadBytes || 0);
            const stat = this.trafficStats.get(conn.nodePort);
            if (uploadMatch && downloadMatch && conn.startDate === getTodayDateString()) {
                stat.todayUnmeasuredConnections = Math.max(0, stat.todayUnmeasuredConnections - 1);
            }
            this.saveConnection(conn);
            this.activeConnections.delete(connId);
        }
    }

    /**
     * 获取最近的连接流水列表（支持按节点端口或目标域名过滤）
     * @param {object} filter
     * @param {number} [filter.port] - 筛选端口
     * @param {string} [filter.keyword] - 筛选关键词（域名或IP）
     * @param {number} [filter.limit=100] - 最多返回条数
     * @returns {Array<object>}
     */
    getRecentLogs({ port, keyword, limit = 100, sort = '', order = 'desc' } = {}) {
        if (sort && !['uploadBytes', 'downloadBytes', 'durationMs'].includes(sort)) throw new Error('invalid log sort');
        if (!['asc', 'desc'].includes(order)) throw new Error('invalid log sort order');
        let result = this.recentLogs;
        if (port) {
            result = result.filter((item) => Number(item.nodePort || item.listenPort) === Number(port) || Number(item.listenPort) === Number(port));
        }
        if (keyword) {
            const kw = String(keyword).toLowerCase();
            result = result.filter((item) => (
                (item.target && item.target.toLowerCase().includes(kw))
                || (item.client && item.client.includes(kw))
            ));
        }
        const now = Date.now();
        result = result.map(item => item.status === 'active' ? { ...item, durationMs: Math.max(0, now - Date.parse(item.timestamp)) } : item);
        if (sort) result.sort((a, b) => {
            const knownA = Number.isFinite(a[sort]);
            const knownB = Number.isFinite(b[sort]);
            if (!knownA || !knownB) return Number(knownB) - Number(knownA);
            return (a[sort] - b[sort]) * (order === 'asc' ? 1 : -1);
        });
        return result.slice(0, Math.min(limit, this.maxMemoryLogs));
    }

    /**
     * 获取所有节点的流量汇总统计信息
     * @returns {object}
     */
    getTrafficSummary() {
        this.rotateTodayTraffic();
        const out = {};
        for (const [port, item] of this.trafficStats.entries()) {
            out[port] = {
                ...item,
                trafficMeasured: this.accountingStatus === 'connected' || item.todayMeasuredConnections > 0 || item.todayUpload > 0 || item.todayDownload > 0 || (item.todayConnections > 0 && item.todayUnmeasuredConnections === 0),
                trafficPartial: item.todayUnmeasuredConnections > 0,
                todayUploadFormatted: formatBytes(item.todayUpload),
                todayDownloadFormatted: formatBytes(item.todayDownload),
                totalUploadFormatted: formatBytes(item.totalUpload),
                totalDownloadFormatted: formatBytes(item.totalDownload)
            };
        }
        return out;
    }

    /**
     * 自动清理超过最长保留天数（默认30天）的旧日志文件
     * 并在总存储超过软配额时自动从最旧文件开始淘汰
     */
    cleanExpiredLogs() {
        try {
            if (!fs.existsSync(this.logDir)) return;
            const files = fs.readdirSync(this.logDir)
                .filter((name) => AUDIT_FILE.test(name))
                .map((name) => {
                    const filePath = path.join(this.logDir, name);
                    const stat = fs.statSync(filePath);
                    return { name, filePath, mtime: stat.mtimeMs, size: stat.size };
                })
                .sort((a, b) => a.mtime - b.mtime);

            const now = Date.now();
            const maxAgeMs = this.retentionDays * 24 * 60 * 60 * 1000;
            const remainingFiles = [];
            let totalSizeBytes = 0;

            // 1. 删除超过保留天数的文件
            for (const file of files) {
                if (now - file.mtime > maxAgeMs && file.filePath !== this.currentLogFile) {
                    try {
                        fs.unlinkSync(file.filePath);
                        console.log(`[log] 已清理过期日志文件: ${file.name}`);
                    } catch (e) {}
                } else {
                    remainingFiles.push(file);
                    totalSizeBytes += file.size;
                }
            }

            // Leave the currently written segment open; each segment is at most one quarter of the quota.
            const maxSizeBytes = this.maxTotalMb * 1024 * 1024;
            while (totalSizeBytes > maxSizeBytes && remainingFiles.length) {
                const oldest = remainingFiles.shift();
                if (oldest.filePath === this.currentLogFile) continue;
                try {
                    fs.unlinkSync(oldest.filePath);
                    totalSizeBytes -= oldest.size;
                    console.log(`[log] 日志超出配额上限 (${this.maxTotalMb}MB)，已淘汰旧日志: ${oldest.name}`);
                } catch (e) {}
            }
        } catch (error) {
            // 忽略扫描失败
        }
    }

    /**
     * 查询当前日志文件占用的磁盘空间与配额信息
     * @returns {{ retentionDays: number, maxTotalMb: number, usedBytes: number, usedFormatted: string, fileCount: number }}
     */
    getStorageInfo() {
        let usedBytes = 0;
        let fileCount = 0;
        try {
            if (fs.existsSync(this.logDir)) {
                const files = fs.readdirSync(this.logDir).filter(name => AUDIT_FILE.test(name));
                fileCount = files.length;
                for (const name of files) {
                    try {
                        const stat = fs.statSync(path.join(this.logDir, name));
                        usedBytes += stat.size;
                    } catch (e) {}
                }
            }
        } catch (e) {}
        return {
            retentionDays: this.retentionDays,
            maxTotalMb: this.maxTotalMb,
            usedBytes,
            usedFormatted: formatBytes(usedBytes),
            fileCount
        };
    }

    validateStoragePolicy(policy) {
        const maxTotalMb = Number(policy.maxTotalMb);
        const retentionDays = Number(policy.retentionDays);
        if (!Number.isInteger(maxTotalMb) || maxTotalMb < 1 || maxTotalMb > 4096) throw new Error('invalid log space: use 1-4096 MB');
        if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error('invalid log retention: use 1-365 days');
        return { maxTotalMb, retentionDays };
    }

    async flushLogs() {
        const stream = this.currentLogStream;
        this.currentLogStream = null;
        this.currentLogFile = '';
        if (stream && !stream.destroyed) await new Promise(resolve => { stream.once('error', resolve); stream.end(resolve); });
    }

    async setStoragePolicy(policy) {
        const validated = this.validateStoragePolicy(policy);
        this.logsSuspended = true;
        try {
            await this.flushLogs();
            Object.assign(this, validated);
            this.cleanExpiredLogs();
            this.loadRecentLogsFromDisk();
        } finally { this.logsSuspended = false; }
    }

    async clearLogs() {
        this.logsSuspended = true;
        try {
            await this.flushLogs();
            this.clearedBefore = Date.now();
            for (const name of fs.readdirSync(this.logDir).filter(name => AUDIT_FILE.test(name))) fs.unlinkSync(path.join(this.logDir, name));
            this.recentLogs = [];
            return this.getStorageInfo();
        } finally { this.logsSuspended = false; }
    }

    /**
     * 释放资源与定时器
     */
    destroy() {
        this.stopAccounting();
        clearInterval(this.trafficSaveTimer);
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        if (this.currentLogStream) {
            try { this.currentLogStream.end(); } catch (e) {}
        }
        this.saveTrafficStats();
    }
}

module.exports = LogManager;
module.exports.parseBytes = parseBytes;
module.exports.formatBytes = formatBytes;
