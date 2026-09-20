/**
 * @file logs.js
 * @description 连接审计与流量监控独立大盘客户端交互逻辑
 * 支持多维筛选、指标大盘统计、自适应轮询与 CSV 格式导出
 */

// 状态对象
const state = {
  port: '',
  keyword: '',
  limit: 100,
  autoRefreshMs: 2000,
  timer: null,
  isFetching: false,
  proxies: [],
  currentLogs: []
};

// DOM 元素引用缓存
const el = {
  nodeSelect: document.querySelector('#nodeSelect'),
  searchInput: document.querySelector('#searchInput'),
  clearSearchBtn: document.querySelector('#clearSearchBtn'),
  limitSelect: document.querySelector('#limitSelect'),
  autoRefreshSelect: document.querySelector('#autoRefreshSelect'),
  refreshBtn: document.querySelector('#refreshBtn'),
  exportCsvBtn: document.querySelector('#exportCsvBtn'),
  logsTableBody: document.querySelector('#logsTableBody'),
  matchedCount: document.querySelector('#matchedCount'),
  metricTotalConns: document.querySelector('#metricTotalConns'),
  metricTodayDown: document.querySelector('#metricTodayDown'),
  metricTodayUp: document.querySelector('#metricTodayUp'),
  metricStorageUsed: document.querySelector('#metricStorageUsed'),
  storageBarFill: document.querySelector('#storageBarFill'),
  metricStorageMeta: document.querySelector('#metricStorageMeta'),
  liveBadge: document.querySelector('#liveBadge')
};

/**
 * 格式化字节大小为可读字符串
 * @param {number} bytes - 字节数
 * @returns {string} 可读字符串 (如 12.5 MB)
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const val = n / Math.pow(1024, i);
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i] || 'TB'}`;
}

/**
 * 转义 HTML 特殊字符防止 XSS
 * @param {string} str - 待转义原始字符串
 * @returns {string} 转义后安全字符串
 */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 发起统一 API 请求封装
 * @param {string} url - 接口地址
 * @param {object} options - Fetch 配置
 * @returns {Promise<any>}
 */
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...options.headers
    },
    ...options
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('未授权，请登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `请求失败 (${res.status})`);
  }
  return data;
}

/**
 * 初始化节点下拉框列表
 */
async function loadNodes() {
  try {
    const data = await api('/api/proxies');
    state.proxies = Array.isArray(data) ? data : (data.proxies || []);
    const currentVal = el.nodeSelect.value;
    const options = ['<option value="">全部节点 (全部端口)</option>'];
    for (const item of state.proxies) {
      const loc = item.location ? ` [${item.location.split(' / ').slice(-1)[0] || item.location}]` : '';
      const name = item.name || item.server || '节点';
      const label = `${item.listenPort} · ${name}${loc}`;
      options.push(`<option value="${item.listenPort}"${currentVal === String(item.listenPort) ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    el.nodeSelect.innerHTML = options.join('');
  } catch (err) {
    console.error('加载节点列表失败:', err);
  }
}

/**
 * 刷新流量大盘与连接审计日志数据
 */
async function fetchLogs() {
  if (state.isFetching) return;
  state.isFetching = true;

  try {
    const params = new URLSearchParams();
    if (state.port) params.set('port', state.port);
    if (state.keyword) params.set('keyword', state.keyword);
    params.set('limit', String(state.limit));

    const res = await api(`/api/logs?${params.toString()}`);
    const logs = res.logs || [];
    const traffic = res.traffic || {};
    const storage = res.storage || {};

    state.currentLogs = logs;

    // 1. 渲染指标统计卡片
    renderMetrics(traffic, storage);

    // 2. 渲染日志表格
    renderTable(logs);

    // 3. 更新记录匹配条数
    if (el.matchedCount) {
      el.matchedCount.textContent = String(logs.length);
    }
  } catch (err) {
    console.error('获取日志失败:', err);
    el.logsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="logs-error">
          <span class="error-badge">⚠️ 异常</span>
          <span>加载日志失败: ${escapeHtml(err.message)}</span>
        </td>
      </tr>
    `;
  } finally {
    state.isFetching = false;
  }
}

/**
 * 渲染大盘核心指标统计数据
 * @param {object} traffic - 各端口流量统计对象
 * @param {object} storage - 存储配额与使用详情
 */
function renderMetrics(traffic, storage) {
  let totalConns = 0;
  let totalTodayDown = 0;
  let totalTodayUp = 0;

  // 针对全部节点或指定节点过滤汇总
  for (const [portStr, stat] of Object.entries(traffic)) {
    if (state.port && String(state.port) !== String(portStr)) {
      continue;
    }
    totalConns += Number(stat.connections || 0);
    totalTodayDown += Number(stat.todayDownload || 0);
    totalTodayUp += Number(stat.todayUpload || 0);
  }

  if (el.metricTotalConns) {
    el.metricTotalConns.textContent = totalConns.toLocaleString();
  }
  if (el.metricTodayDown) {
    el.metricTodayDown.textContent = formatBytes(totalTodayDown);
  }
  if (el.metricTodayUp) {
    el.metricTodayUp.textContent = formatBytes(totalTodayUp);
  }

  if (el.metricStorageUsed && storage) {
    const usedMb = (storage.usedBytes || 0) / (1024 * 1024);
    const maxMb = storage.maxTotalMb || 1024;
    const percent = Math.min(100, Math.max(0, (usedMb / maxMb) * 100));

    el.metricStorageUsed.textContent = storage.usedFormatted || formatBytes(storage.usedBytes);
    if (el.storageBarFill) {
      el.storageBarFill.style.width = `${percent.toFixed(1)}%`;
      el.storageBarFill.style.backgroundColor = percent > 85 ? 'var(--color-danger)' : (percent > 60 ? 'var(--color-warning)' : 'var(--accent-cyan)');
    }
    if (el.metricStorageMeta) {
      el.metricStorageMeta.textContent = `最长保留 ${storage.retentionDays || 30} 天 / 配额 ${maxMb} MB (${storage.fileCount || 0} 个切片)`;
    }
  }
}

/**
 * 渲染连接审计日志数据表格
 * @param {Array<object>} logs - 日志列表
 */
function renderTable(logs) {
  if (!logs.length) {
    el.logsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="logs-empty-cell">
          <div class="logs-empty-box">
            <div class="icon">📭</div>
            <div class="title">暂无匹配的连接记录</div>
            <div class="desc">当前节点或过滤条件下未捕获到客户端连接，新连接建立后将实时在此显现。</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  el.logsTableBody.innerHTML = logs.map((log) => {
    // 时间处理
    let timeStr = '-';
    let fullDate = '';
    if (log.timestamp) {
      const d = new Date(log.timestamp);
      fullDate = d.toLocaleString('zh-CN', { hour12: false });
      timeStr = d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    // 耗时处理
    let durationText = '< 1ms';
    if (log.durationMs) {
      if (log.durationMs >= 1000) {
        durationText = `${(log.durationMs / 1000).toFixed(1)}s`;
      } else {
        durationText = `${log.durationMs}ms`;
      }
    }

    // 查找节点名称备注与地理归属
    const hasPort = Boolean(log.listenPort && Number(log.listenPort) > 0);
    const matchedProxy = hasPort ? state.proxies.find((p) => Number(p.listenPort) === Number(log.listenPort)) : null;
    const locationText = matchedProxy && matchedProxy.location ? matchedProxy.location : '';
    const nodeName = matchedProxy ? (matchedProxy.name || matchedProxy.server || '节点') : '';
    const displayTag = locationText ? locationText.split(' / ').slice(-1)[0] : (nodeName || '通用节点');
    const fullTooltip = locationText ? `${nodeName} · 出口归属: ${locationText}` : (nodeName || '代理节点');

    const nodeCellHtml = hasPort
      ? `<span class="log-port-chip font-mono">:${log.listenPort}</span>
         <span class="log-node-label" title="${escapeHtml(fullTooltip)}">${escapeHtml(displayTag)}</span>`
      : `<span class="log-direct-chip">系统直连</span>
         <span class="log-node-label" style="color:var(--text-muted)" title="统一网关/核心直接转发">核心网关</span>`;

    return `
      <tr class="log-row">
        <td title="${escapeHtml(fullDate)}">
          <span class="log-time-chip font-mono">${escapeHtml(timeStr)}</span>
        </td>
        <td>
          <div class="log-node-cell">
            ${nodeCellHtml}
          </div>
        </td>
        <td>
          <span class="log-client-pill font-mono" title="客户端来源 IP 及端口">${escapeHtml(log.client || '-')}</span>
        </td>
        <td>
          <span class="log-target-cell font-mono" title="${escapeHtml(log.target || '-')}">${escapeHtml(log.target || '-')}</span>
        </td>
        <td>
          <div class="log-traffic-group font-mono">
            <span class="up" title="上行请求数据量">↑ ${escapeHtml(log.uploadFormatted || '0 B')}</span>
            <span class="down" title="下行响应数据量">↓ ${escapeHtml(log.downloadFormatted || '0 B')}</span>
          </div>
        </td>
        <td>
          <span class="log-duration-tag font-mono">${durationText}</span>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * 导出当前筛选日志为 CSV 文件
 */
function exportCsv() {
  if (!state.currentLogs.length) {
    alert('当前没有可导出的日志记录');
    return;
  }

  const headers = ['时间', '入口端口', '客户端来源', '目标地址/域名', '上行数据', '下行数据', '耗时(毫秒)'];
  const rows = state.currentLogs.map((log) => [
    `"${log.timestamp ? new Date(log.timestamp).toISOString() : ''}"`,
    `"${log.listenPort || ''}"`,
    `"${log.client || ''}"`,
    `"${(log.target || '').replace(/"/g, '""')}"`,
    `"${log.uploadFormatted || '0 B'}"`,
    `"${log.downloadFormatted || '0 B'}"`,
    `"${log.durationMs || 0}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `proxypoolhub-access-logs-${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 设置自动轮询定时器
 */
function resetPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.autoRefreshMs > 0) {
    state.timer = setInterval(fetchLogs, state.autoRefreshMs);
    if (el.liveBadge) {
      el.liveBadge.innerHTML = '<span class="status-dot online"></span> 实时监听';
      el.liveBadge.className = 'brand-version pulse-badge';
    }
  } else {
    if (el.liveBadge) {
      el.liveBadge.innerHTML = '<span class="status-dot offline"></span> 轮询暂停';
      el.liveBadge.className = 'brand-version paused-badge';
    }
  }
}

/**
 * 事件绑定与初始化入口
 */
function initEvents() {
  // 节点选择变更
  el.nodeSelect.addEventListener('change', (e) => {
    state.port = e.target.value;
    fetchLogs();
  });

  // 搜索框防抖输入
  let debounce = null;
  el.searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (el.clearSearchBtn) {
      el.clearSearchBtn.style.display = val ? 'block' : 'none';
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.keyword = val;
      fetchLogs();
    }, 250);
  });

  // 清除搜索
  if (el.clearSearchBtn) {
    el.clearSearchBtn.addEventListener('click', () => {
      el.searchInput.value = '';
      el.clearSearchBtn.style.display = 'none';
      state.keyword = '';
      fetchLogs();
    });
  }

  // 条数限制变更
  el.limitSelect.addEventListener('change', (e) => {
    state.limit = Number(e.target.value) || 100;
    fetchLogs();
  });

  // 轮询速率变更
  el.autoRefreshSelect.addEventListener('change', (e) => {
    state.autoRefreshMs = Number(e.target.value);
    resetPolling();
  });

  // 手动刷新按钮
  el.refreshBtn.addEventListener('click', () => {
    fetchLogs();
  });

  // 导出 CSV
  el.exportCsvBtn.addEventListener('click', exportCsv);
}

// 启动逻辑
(async function bootstrap() {
  initEvents();

  // 读取 URL 参数预设筛选条件
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('port')) {
    state.port = urlParams.get('port');
  }
  if (urlParams.has('keyword')) {
    state.keyword = urlParams.get('keyword');
    if (el.searchInput) el.searchInput.value = state.keyword;
  }

  await loadNodes();
  if (state.port && el.nodeSelect) {
    el.nodeSelect.value = state.port;
  }

  await fetchLogs();
  resetPolling();
})();
