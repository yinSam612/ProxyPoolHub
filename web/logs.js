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
  sort: '',
  order: 'desc',
  nodesReady: null,
  autoRefreshMs: 2000,
  timer: null,
  isFetching: false,
  refreshPending: false,
  renderedFilter: '',
  auditGeneration: 0,
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
  refreshStatus: document.querySelector('#refreshStatus'),
  tableWrap: document.querySelector('.logs-table-wrap'),
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
    throw new Error(data.error || data.message || `请求失败 (${res.status})`);
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
    const currentVal = state.port;
    const options = ['<option value="">全部节点 (全部端口)</option>'];
    for (const item of state.proxies) {
      const loc = item.location ? ` [${item.location.split(' / ').slice(-1)[0] || item.location}]` : '';
      const name = item.name || item.server || '节点';
      const label = `${item.listenPort} · ${name}${loc}`;
      options.push(`<option value="${item.listenPort}"${currentVal === String(item.listenPort) ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    el.nodeSelect.innerHTML = options.join('');
    el.nodeSelect.value = state.port;
  } catch (err) {
    console.error('加载节点列表失败:', err);
  }
}

/**
 * 刷新流量大盘与连接审计日志数据
 */
async function fetchLogs(force = true) {
  if (state.isFetching) {
    if (force) state.refreshPending = true;
    return;
  }
  state.isFetching = true;
  el.refreshBtn.setAttribute('aria-busy', 'true');
  if (force) {
    el.refreshBtn.classList.add('is-refreshing');
    el.refreshStatus.textContent = '正在刷新';
  }
  const filter = { port: state.port, keyword: state.keyword, limit: state.limit, sort: state.sort, order: state.order };
  const generation = state.auditGeneration;
  const stale = () => generation !== state.auditGeneration || Object.keys(filter).some(key => filter[key] !== state[key]);
  const params = new URLSearchParams();
  if (filter.port) params.set('port', filter.port);
  if (filter.keyword) params.set('keyword', filter.keyword);
  params.set('limit', String(filter.limit));
  if (filter.sort) {
    params.set('sort', filter.sort);
    params.set('order', filter.order);
  }
  const filterKey = params.toString();

  try {
    const res = await api(`/api/logs?${filterKey}`);
    await state.nodesReady;
    if (stale()) {
      state.refreshPending = true;
      return;
    }
    const logs = res.logs || [];
    const traffic = res.traffic || {};
    const storage = res.storage || {};

    const selection = window.getSelection();
    const reading = el.tableWrap.scrollTop > 0 || (selection && !selection.isCollapsed && el.logsTableBody.contains(selection.anchorNode));
    const preserveRows = !force && state.renderedFilter === filterKey && reading;
    if (preserveRows) {
      const updates = new Map(logs.map(log => [logKey(log), log]));
      state.currentLogs = state.currentLogs.map(log => updates.get(logKey(log)) || log);
    } else {
      state.currentLogs = logs;
    }
    state.renderedFilter = filterKey;

    // 1. 渲染指标统计卡片
    renderMetrics(traffic, storage, res.accounting);

    // 2. 渲染日志表格
    renderTable(state.currentLogs);

    // 3. 更新记录匹配条数
    if (el.matchedCount) {
      el.matchedCount.textContent = String(state.currentLogs.length);
    }
    el.refreshStatus.textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    el.refreshStatus.title = '';
  } catch (err) {
    if (stale()) {
      state.refreshPending = true;
      return;
    }
    console.error('获取日志失败:', err);
    el.refreshStatus.textContent = '刷新失败';
    el.refreshStatus.title = err.message;
    if (state.renderedFilter !== filterKey) {
      state.currentLogs = [];
      el.matchedCount.textContent = '0';
    }
    if (!state.currentLogs.length) el.logsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="logs-error">
          <span class="error-badge">⚠️ 异常</span>
          <span>加载日志失败: ${escapeHtml(err.message)}</span>
        </td>
      </tr>
    `;
  } finally {
    state.isFetching = false;
    el.refreshBtn.setAttribute('aria-busy', 'false');
    el.refreshBtn.classList.remove('is-refreshing');
    if (state.refreshPending) {
      state.refreshPending = false;
      await fetchLogs();
    }
  }
}

/**
 * 渲染大盘核心指标统计数据
 * @param {object} traffic - 各端口流量统计对象
 * @param {object} storage - 存储配额与使用详情
 */
function renderMetrics(traffic, storage, accounting = {}) {
  let totalConns = 0;
  let totalTodayDown = 0;
  let totalTodayUp = 0;
  let trafficMeasured = accounting.status === 'connected';
  let partial = false;

  // 针对全部节点或指定节点过滤汇总
  for (const [portStr, stat] of Object.entries(traffic)) {
    if (state.port && String(state.port) !== String(portStr)) {
      continue;
    }
    totalConns += Number(stat.todayConnections || 0);
    totalTodayDown += Number(stat.todayDownload || 0);
    totalTodayUp += Number(stat.todayUpload || 0);
    if (stat.trafficMeasured) trafficMeasured = true;
    if (stat.trafficPartial || (stat.todayConnections > 0 && !stat.trafficMeasured)) partial = true;
  }

  if (el.metricTotalConns) {
    el.metricTotalConns.textContent = totalConns < 1000000 ? totalConns.toLocaleString() : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(totalConns);
    el.metricTotalConns.title = totalConns.toLocaleString();
  }
  if (el.metricTodayDown) {
    el.metricTodayDown.textContent = trafficMeasured ? formatBytes(totalTodayDown) : '未采集';
  }
  if (el.metricTodayUp) {
    el.metricTodayUp.textContent = trafficMeasured ? formatBytes(totalTodayUp) : '未采集';
  }
  for (const [id, label] of [['metricDownMeta', '下发至客户端数据总量'], ['metricUpMeta', '上行转发至目标站点总量']]) {
    const meta = document.getElementById(id);
    meta.textContent = partial && trafficMeasured ? '仅含已采集流量' : label;
    meta.title = accounting.error || (partial ? '旧连接未采集的流量无法补回' : '');
  }

  if (el.metricStorageUsed && storage) {
    const usedMb = (storage.usedBytes || 0) / (1024 * 1024);
    const maxMb = storage.maxTotalMb || 50;
    const percent = Math.min(100, Math.max(0, (usedMb / maxMb) * 100));

    el.metricStorageUsed.textContent = storage.usedFormatted || formatBytes(storage.usedBytes);
    if (el.storageBarFill) {
      el.storageBarFill.style.width = `${percent.toFixed(1)}%`;
      el.storageBarFill.style.backgroundColor = percent > 85 ? 'var(--color-danger)' : (percent > 60 ? 'var(--color-warning)' : 'var(--accent-cyan)');
    }
    if (el.metricStorageMeta) {
      el.metricStorageMeta.textContent = `${storage.retentionDays || 30} 天 / ${formatBytes(maxMb * 1024 * 1024)} / ${storage.fileCount || 0} 个文件`;
      el.metricStorageMeta.title = `最长保留 ${storage.retentionDays || 30} 天 / 配额 ${maxMb} MB (${storage.fileCount || 0} 个切片)`;
    }
    document.querySelector('#storagePolicyNote').textContent = `${storage.retentionDays || 30} 天 / ${maxMb} MB`;
  }
}

function initLogSettings() {
  const settings = document.querySelector('#logSettingsDialog');
  const confirmation = document.querySelector('#clearLogsDialog');
  const settingsForm = document.querySelector('#logSettingsForm');
  const clearForm = document.querySelector('#clearLogsForm');
  const feedback = (id, text, error = false) => {
    const element = document.getElementById(id);
    element.textContent = text;
    element.classList.toggle('error', error);
  };
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'clearLogsDialog') clearForm.reset();
      document.getElementById(button.dataset.close).close();
    });
  }
  confirmation.addEventListener('cancel', () => clearForm.reset());
  confirmation.addEventListener('close', () => clearForm.reset());
  document.querySelector('#logSettingsBtn').addEventListener('click', async () => {
    settingsForm.reset();
    feedback('logSettingsFeedback', '正在读取');
    settings.showModal();
    settingsForm.querySelectorAll('input, button').forEach(element => { element.disabled = true; });
    try {
      const policy = await api('/api/log-settings');
      settingsForm.elements.maxTotalMb.value = policy.maxTotalMb;
      settingsForm.elements.retentionDays.value = policy.retentionDays;
      document.querySelector('#clearLogsTotpLabel').hidden = !policy.totpEnabled;
      clearForm.elements.totpCode.required = Boolean(policy.totpEnabled);
      feedback('logSettingsFeedback', '缩小上限会自动删除最旧记录。');
    } catch (error) {
      feedback('logSettingsFeedback', error.message, true);
    } finally {
      settingsForm.querySelectorAll('input, button').forEach(element => { element.disabled = false; });
    }
  });
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = settingsForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/log-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        maxTotalMb: Number(settingsForm.elements.maxTotalMb.value), retentionDays: Number(settingsForm.elements.retentionDays.value)
      }) });
      state.auditGeneration++;
      feedback('logSettingsFeedback', '已保存');
      await fetchLogs();
    } catch (error) { feedback('logSettingsFeedback', error.message, true); }
    finally { submit.disabled = false; }
  });
  document.querySelector('#clearLogsBtn').addEventListener('click', () => {
    settings.close();
    feedback('clearLogsFeedback', '');
    confirmation.showModal();
  });
  clearForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = clearForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(clearForm))) });
      state.auditGeneration++;
      state.currentLogs = [];
      renderTable([]);
      el.matchedCount.textContent = '0';
      clearForm.reset();
      confirmation.close();
      await fetchLogs();
    } catch (error) { feedback('clearLogsFeedback', error.message, true); }
    finally { submit.disabled = false; }
  });
}

/**
 * 渲染连接审计日志数据表格
 * @param {Array<object>} logs - 日志列表
 */
function renderTable(logs) {
  if (!logs.length) {
    if (el.logsTableBody.querySelector('.logs-empty-cell')) return;
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

  const html = logs.map((log) => {
    // 时间处理
    let timeStr = '-';
    let fullDate = '';
    if (log.timestamp) {
      const d = new Date(log.timestamp);
      fullDate = d.toLocaleString('zh-CN', { hour12: false });
      timeStr = d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    // 耗时处理
    let durationText = '-';
    if (log.durationMs != null) {
      if (log.durationMs >= 1000) {
        durationText = `${(log.durationMs / 1000).toFixed(1)}s`;
      } else {
        durationText = `${log.durationMs}ms`;
      }
    }

    // 查找节点名称备注与地理归属
    const hasPort = Boolean(log.listenPort && Number(log.listenPort) > 0);
    const matchedProxy = hasPort ? state.proxies.find((p) => Number(p.listenPort) === Number(log.nodePort || log.listenPort)) : null;
    const locationText = matchedProxy && matchedProxy.location ? matchedProxy.location : '';
    const nodeName = matchedProxy ? (matchedProxy.name || matchedProxy.server || '节点') : '';
    const displayTag = nodeName || '未知节点';
    const fullTooltip = locationText ? `${nodeName} · 出口归属: ${locationText}` : (nodeName || '代理节点');
    const protocol = { mixed: 'HTTP/SOCKS5', hysteria2: 'HY2', vless: 'VLESS' }[log.protocol] || '';

    const nodeCellHtml = hasPort
      ? `<span class="log-port-chip font-mono">${escapeHtml(protocol)} :${log.listenPort}</span>
         <span class="log-node-label" title="${escapeHtml(fullTooltip)}">${escapeHtml(displayTag)}</span>`
      : `<span class="log-direct-chip">系统直连</span>
         <span class="log-node-label log-direct-node" title="统一网关/核心直接转发">核心网关</span>`;

    return `
      <tr class="log-row" data-log-id="${escapeHtml(logKey(log))}">
        <td title="${escapeHtml(fullDate)}">
          <span class="log-time-chip font-mono">${escapeHtml(timeStr)}</span>
        </td>
        <td>
          <div class="log-node-cell">
            ${nodeCellHtml}
          </div>
        </td>
        <td>
          <span class="log-client-pill font-mono" title="${escapeHtml(log.client || '-')}">${escapeHtml(log.client || '-')}</span>
        </td>
        <td>
          <span class="log-target-cell font-mono" title="${escapeHtml(log.target || '-')}">${escapeHtml(log.target || '-')}</span>
        </td>
        <td>
          <div class="log-traffic-group font-mono">
            <span class="up" title="上行: ${escapeHtml(log.uploadFormatted || '未采集')}">↑ ${escapeHtml(log.uploadFormatted || '-')}</span>
            <span class="down" title="下行: ${escapeHtml(log.downloadFormatted || '未采集')}">↓ ${escapeHtml(log.downloadFormatted || '-')}</span>
          </div>
        </td>
        <td>
          <span class="log-duration-tag font-mono" title="${escapeHtml(durationText)}">${escapeHtml(durationText)}</span>
        </td>
      </tr>
    `;
  }).join('');
  const template = document.createElement('template');
  template.innerHTML = `<table><tbody>${html}</tbody></table>`;
  const existing = new Map([...el.logsTableBody.querySelectorAll('.log-row')].map(row => [row.dataset.logId, row]));
  const keep = new Set();
  const scrollTop = el.tableWrap.scrollTop;
  const scrollLeft = el.tableWrap.scrollLeft;
  for (const [index, fresh] of [...template.content.querySelector('tbody').children].entries()) {
    const id = fresh.dataset.logId;
    keep.add(id);
    let row = existing.get(id);
    if (row) {
      for (let i = 0; i < fresh.children.length; i++) {
        if (!row.children[i].isEqualNode(fresh.children[i])) row.children[i].replaceWith(fresh.children[i].cloneNode(true));
      }
    } else row = fresh;
    if (el.logsTableBody.children[index] !== row) el.logsTableBody.insertBefore(row, el.logsTableBody.children[index] || null);
  }
  for (const row of [...el.logsTableBody.children]) if (!keep.has(row.dataset.logId)) row.remove();
  el.tableWrap.scrollTop = scrollTop;
  el.tableWrap.scrollLeft = scrollLeft;
}

function logKey(log) {
  return log.id || `${log.timestamp}|${log.listenPort}|${log.protocol}|${log.client}|${log.target}`;
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
    `"${log.uploadFormatted || ''}"`,
    `"${log.downloadFormatted || ''}"`,
    `"${log.durationMs ?? ''}"`
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
    state.timer = setInterval(() => fetchLogs(false), state.autoRefreshMs);
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
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.addEventListener('click', () => {
      state.order = state.sort === button.dataset.sort && state.order === 'desc' ? 'asc' : 'desc';
      state.sort = button.dataset.sort;
      for (const control of document.querySelectorAll('[data-sort]')) {
        const selected = state.sort === control.dataset.sort;
        const next = selected && state.order === 'desc' ? '从小到大' : '从大到小';
        control.setAttribute('aria-pressed', String(selected));
        control.setAttribute('aria-label', `${control.dataset.label}：${next}排序`);
        control.title = `${control.dataset.label}：${next}排序`;
        control.querySelector('use').setAttribute('href', `/lucide.svg#${selected ? (state.order === 'desc' ? 'arrow-down' : 'arrow-up') : 'arrow-up-down'}`);
      }
      for (const header of el.logsTableBody.closest('table').querySelectorAll('th:has([data-sort])')) {
        const active = header.querySelector('[aria-pressed="true"]');
        header.setAttribute('aria-sort', active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
      }
      fetchLogs();
    });
  }

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
  initLogSettings();

  // 读取 URL 参数预设筛选条件
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('port')) {
    state.port = urlParams.get('port');
  }
  if (urlParams.has('keyword')) {
    state.keyword = urlParams.get('keyword');
    if (el.searchInput) el.searchInput.value = state.keyword;
  }

  state.nodesReady = loadNodes();
  await fetchLogs();
  resetPolling();
})();
