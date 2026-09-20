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
    state.proxies = data.proxies || [];
    const currentVal = el.nodeSelect.value;
    const options = ['<option value="">全部节点 (全部端口)</option>'];
    for (const item of state.proxies) {
      const label = `${item.listenPort} · ${item.name || item.server || '未命名'} (${item.type})`;
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
        <td colspan="6" class="logs-empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-title">暂无连接记录</div>
          <div class="empty-desc">当前筛选条件下未捕获到客户端连接，新连接建立后将实时在此显现。</div>
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

    // 查找节点名称备注
    const matchedProxy = state.proxies.find((p) => Number(p.listenPort) === Number(log.listenPort));
    const nodeLabel = matchedProxy ? (matchedProxy.name || matchedProxy.server || '节点') : '节点';

    return `
      <tr class="log-row">
        <td class="col-time" title="${escapeHtml(fullDate)}">
          <span class="time-badge font-mono">${escapeHtml(timeStr)}</span>
        </td>
        <td class="col-node">
          <div class="node-badge-group">
            <span class="port-chip font-mono">:${log.listenPort || '-'}</span>
            <span class="node-name-tip" title="${escapeHtml(nodeLabel)}">${escapeHtml(nodeLabel)}</span>
          </div>
        </td>
        <td class="col-client font-mono">
          <span class="client-pill" title="客户端来源 IP 及端口">${escapeHtml(log.client || '-')}</span>
        </td>
        <td class="col-target font-mono">
          <span class="target-link" title="${escapeHtml(log.target || '-')}">${escapeHtml(log.target || '-')}</span>
        </td>
        <td class="col-traffic font-mono">
          <div class="traffic-dual-badge">
            <span class="up-tag" title="上行请求数据量">↑ ${escapeHtml(log.uploadFormatted || '0 B')}</span>
            <span class="down-tag" title="下行响应数据量">↓ ${escapeHtml(log.downloadFormatted || '0 B')}</span>
          </div>
        </td>
        <td class="col-duration font-mono">
          <span class="duration-chip">${durationText}</span>
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
  await loadNodes();
  await fetchLogs();
  resetPolling();
})();
