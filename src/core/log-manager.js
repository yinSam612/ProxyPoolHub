'use strict';

/**
 * @file log-manager.js
 * @description 节点连接审计、上下行流量统计与按天日志轮转管理器
 * 负责解析内核日志事件、统计节点传输流量、维护内存活跃连接与磁盘日志归档清理（默认30天）
 */

const fs = require('fs');
const path = require('path');

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
 * 获取当前北京时间日期字符串 YYYY-MM-DD
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
    const directMatch = text.match(/\[([0-9a-zA-Z_-]+)\]\s+(?:inbound|outbound|closed|connection)/i);
    if (directMatch) return directMatch[1];
    const allBrackets = [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const filtered = allBrackets.filter((b) => !['INFO', 'DEBUG', 'WARN', 'ERROR'].includes(b.toUpperCase()) && !/^\d{4}$/.test(b) && !b.startsWith('202'));
    return filtered.length > 0 ? filtered[0] : null;
}

class LogManager {
    /**
     * @param {object} options
     * @param {string} options.logDir - 日志持久化目录
     * @param {string} options.trafficFile - 流量统计持久化文件
     * @param {number} [options.retentionDays=30] - 日志保留最长天数
     * @param {number} [options.maxTotalMb=1024] - 日志目录软配额限制（MB）
     * @param {number} [options.maxMemoryLogs=500] - 内存保留最新连接记录数
     */
    constructor(options = {}) {
        this.logDir = path.resolve(String(options.logDir || path.join(process.cwd(), 'data', 'logs')));
        this.trafficFile = path.resolve(String(options.trafficFile || path.join(process.cwd(), 'data', 'traffic.json')));
        this.retentionDays = Math.max(1, Number(options.retentionDays || process.env.LOG_RETENTION_DAYS || 30));
        this.maxTotalMb = Math.max(50, Number(options.maxTotalMb || process.env.LOG_MAX_TOTAL_MB || 1024));
        this.maxMemoryLogs = Math.max(50, Number(options.maxMemoryLogs || 500));

        // 内存最近连接环形队列
        this.recentLogs = [];
        // 活跃连接追踪表 (按连接ID追踪): connectionId -> { id, startTime, inboundPort, clientIp, target, outbound, uploadBytes, downloadBytes }
        this.activeConnections = new Map();
        // 节点流量统计表: port -> { todayDate, todayUpload, todayDownload, totalUpload, totalDownload, connectionCount }
        this.trafficStats = new Map();

        this.currentLogDate = '';
        this.currentLogStream = null;

        this.initDirs();
        this.loadTrafficStats();
        this.cleanExpiredLogs();

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
     * 持久化流量数据到磁盘
     */
    saveTrafficStats() {
        try {
            const out = {};
            for (const [port, item] of this.trafficStats.entries()) {
                out[port] = item;
            }
            fs.writeFileSync(this.trafficFile, JSON.stringify(out, null, 2), 'utf8');
        } catch (error) {
            // 忽略写入异常
        }
    }

    /**
     * 日期变更时轮转每日流量统计
     */
    rotateTodayTraffic() {
        const today = getTodayDateString();
        for (const item of this.trafficStats.values()) {
            if (item.todayDate !== today) {
                item.todayDate = today;
                item.todayUpload = 0;
                item.todayDownload = 0;
            }
        }
        this.saveTrafficStats();
    }

    /**
     * 获取指定日期的文件写入流（按天自动分文件）
     * @returns {fs.WriteStream}
     */
    getWriteStream() {
        const today = getTodayDateString();
        if (this.currentLogStream && this.currentLogDate === today) {
            return this.currentLogStream;
        }

        if (this.currentLogStream) {
            try { this.currentLogStream.end(); } catch (e) {}
        }

        this.currentLogDate = today;
        const filePath = path.join(this.logDir, `access-${today}.log`);
        this.currentLogStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
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
        // 放入内存环形队列
        this.recentLogs.unshift(record);
        if (this.recentLogs.length > this.maxMemoryLogs) {
            this.recentLogs.length = this.maxMemoryLogs;
        }

        // 写入文件
        try {
            const stream = this.getWriteStream();
            stream.write(`${JSON.stringify(record)}\n`);
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
    addTraffic(port, upload = 0, download = 0) {
        if (!port) return;
        const today = getTodayDateString();
        let stat = this.trafficStats.get(port);
        if (!stat) {
            stat = {
                todayDate: today,
                todayUpload: 0,
                todayDownload: 0,
                totalUpload: 0,
                totalDownload: 0,
                connections: 0
            };
            this.trafficStats.set(port, stat);
        }

        if (stat.todayDate !== today) {
            stat.todayDate = today;
            stat.todayUpload = 0;
            stat.todayDownload = 0;
        }

        stat.todayUpload += upload;
        stat.todayDownload += download;
        stat.totalUpload += upload;
        stat.totalDownload += download;
        stat.connections += 1;
    }

    /**
     * 核心方法: 解析内核输出的单行文本
     * 支持匹配连接创建、目标路由与连接关闭流量事件
     * @param {string} line - 内核标准输出的一行
     */
    feedKernelLogLine(line) {
        if (!line || typeof line !== 'string') return;
        const text = line.trim();
        if (!text) return;

        // 提取连接唯一ID
        const connId = extractConnId(text);

        // 1. 匹配连接进入: inbound connection from 127.0.0.1:58412
        if (text.includes('inbound connection from')) {
            const portMatch = text.match(/inbound[a-zA-Z0-9/_-]*\[(?:inbound-)?([0-9]+)\]/i) || text.match(/inbound-([0-9]+)/i);
            const clientMatch = text.match(/from\s+([0-9a-fA-F.:]+:[0-9]+)/);
            const listenPort = portMatch ? Number(portMatch[1]) : 0;
            const clientAddress = clientMatch ? clientMatch[1] : '127.0.0.1';

            if (connId) {
                this.activeConnections.set(connId, {
                    id: connId,
                    startTime: Date.now(),
                    listenPort,
                    clientAddress,
                    target: '',
                    outbound: '',
                    uploadBytes: 0,
                    downloadBytes: 0
                });
            }
            return;
        }

        // 2. 匹配出站路由与目标域名: outbound connection to api.github.com:443
        if (text.includes('outbound connection to') || text.includes('connecting to')) {
            const targetMatch = text.match(/to\s+([a-zA-Z0-9.-]+:[0-9]+)/) || text.match(/to\s+([a-zA-Z0-9.-]+)/);
            const outboundMatch = text.match(/outbound[a-zA-Z0-9/_-]*\[([a-zA-Z0-9/_-]+)\]/);
            const target = targetMatch ? targetMatch[1] : '';
            const outbound = outboundMatch ? outboundMatch[1] : '';

            if (connId && this.activeConnections.has(connId)) {
                const conn = this.activeConnections.get(connId);
                if (target) conn.target = target;
                if (outbound) conn.outbound = outbound;
            }
            return;
        }

        // 3. 匹配连接关闭与流量统计: closed, upload: 12.5 KB, download: 1.2 MB
        if (text.includes('closed') || text.includes('closed after')) {
            let conn = connId ? this.activeConnections.get(connId) : null;
            const uploadMatch = text.match(/upload:?\s*([0-9.]+\s*[KMGT]?B?)/i);
            const downloadMatch = text.match(/download:?\s*([0-9.]+\s*[KMGT]?B?)/i);

            const uploadBytes = uploadMatch ? parseBytes(uploadMatch[1]) : 0;
            const downloadBytes = downloadMatch ? parseBytes(downloadMatch[1]) : 0;
            const durationMs = conn ? Date.now() - conn.startTime : 0;

            const listenPort = conn ? conn.listenPort : (text.match(/inbound-([0-9]+)/) ? Number(text.match(/inbound-([0-9]+)/)[1]) : 0);
            const clientAddress = conn ? conn.clientAddress : '127.0.0.1';
            const target = (conn && conn.target) ? conn.target : (text.match(/to\s+([a-zA-Z0-9.-]+:[0-9]+)/) ? text.match(/to\s+([a-zA-Z0-9.-]+:[0-9]+)/)[1] : '-');

            // 统计流量
            if (listenPort > 0) {
                this.addTraffic(listenPort, uploadBytes, downloadBytes);
            }

            // 记录日志
            const record = {
                timestamp: new Date().toISOString(),
                listenPort,
                client: clientAddress,
                target: target || '-',
                outbound: conn?.outbound || '',
                uploadBytes,
                downloadBytes,
                uploadFormatted: formatBytes(uploadBytes),
                downloadFormatted: formatBytes(downloadBytes),
                durationMs
            };

            this.writeLog(record);

            if (connId) {
                this.activeConnections.delete(connId);
            }
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
    getRecentLogs({ port, keyword, limit = 100 } = {}) {
        let result = this.recentLogs;
        if (port) {
            result = result.filter((item) => Number(item.listenPort) === Number(port));
        }
        if (keyword) {
            const kw = String(keyword).toLowerCase();
            result = result.filter((item) => (
                (item.target && item.target.toLowerCase().includes(kw))
                || (item.client && item.client.includes(kw))
            ));
        }
        return result.slice(0, Math.min(limit, this.maxMemoryLogs));
    }

    /**
     * 获取所有节点的流量汇总统计信息
     * @returns {object}
     */
    getTrafficSummary() {
        const out = {};
        for (const [port, item] of this.trafficStats.entries()) {
            out[port] = {
                ...item,
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
                .filter((name) => name.startsWith('access-') && name.endsWith('.log'))
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
                if (now - file.mtime > maxAgeMs) {
                    try {
                        fs.unlinkSync(file.filePath);
                        console.log(`[log] 已清理过期日志文件: ${file.name}`);
                    } catch (e) {}
                } else {
                    remainingFiles.push(file);
                    totalSizeBytes += file.size;
                }
            }

            // 2. 检查软配额上限（默认 1024 MB），超限淘汰最旧文件
            const maxSizeBytes = this.maxTotalMb * 1024 * 1024;
            while (totalSizeBytes > maxSizeBytes && remainingFiles.length > 1) {
                const oldest = remainingFiles.shift();
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
                const files = fs.readdirSync(this.logDir).filter((name) => name.endsWith('.log'));
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

    /**
     * 释放资源与定时器
     */
    destroy() {
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
