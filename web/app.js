/**
 * @file app.js
 * @description Relay Control Web 前端核心交互逻辑
 * 节点选择、状态同步、代理复制及身份验证管理
 */

// DOM 元素引用
const rows = document.querySelector('#rows');
const message = document.querySelector('#message');
const addForm = document.querySelector('#addForm');
const importForm = document.querySelector('#importForm');
const editForm = document.querySelector('#editForm');
const settingsForm = document.querySelector('#settingsForm');
const relayTlsForm = document.querySelector('#relayTlsForm');
const realityForm = document.querySelector('#realityForm');
const passwordForm = document.querySelector('#passwordForm');
const totpBindForm = document.querySelector('#totpBindForm');

const addDialog = document.querySelector('#addDialog');
const importDialog = document.querySelector('#importDialog');
const editDialog = document.querySelector('#editDialog');
const settingsDialog = document.querySelector('#settingsDialog');
const relayDialog = document.querySelector('#relayDialog');
const realityDialog = document.querySelector('#realityDialog');
const passwordDialog = document.querySelector('#passwordDialog');
const totpDialog = document.querySelector('#totpDialog');
const confirmDialog = document.querySelector('#confirmDialog');

const nodeFilter = document.querySelector('#nodeFilter');
const selectAll = document.querySelector('#selectAll');

// 运行时状态
let settings = { proxyUsername: '', proxyPassword: '', publicHost: '', subscriptions: {}, totpEnabled: false, totpConfigured: false };
let items = [];
let toastTimer = null;
let currentTotpSetup = null;
let autoPollerTimer = null;
let refreshPromise = null;
let serviceStatus = null;
let manualHealthCheck = false;
const selectedNodeIds = new Set();
const autoRefresh = document.querySelector('#autoRefresh');
const INTERNAL_PROXY_HOST = '127.0.0.1';
const DOCKER_PROXY_HOST = 'host';

function icon(name) {
  return `<svg class="tool-icon" aria-hidden="true"><use href="/lucide.svg#${name}"></use></svg>`;
}

/**
 * 弹出高质感异步确认对话框，取代原生 confirm()
 * @param {object} options
 * @param {string} [options.title='确认操作'] - 弹窗标题
 * @param {string} options.message - 描述内容
 * @param {string} [options.confirmText='确定'] - 确定按钮文本
 * @param {string} [options.cancelText='取消'] - 取消按钮文本
 * @param {boolean} [options.danger=true] - 是否为危险操作
 * @returns {Promise<boolean>}
 */
function showConfirm({ title = '确认操作', message, confirmText = '确定', cancelText = '取消', danger = true }) {
  return new Promise((resolve) => {
    if (!confirmDialog) {
      return resolve(window.confirm(message));
    }
    const titleEl = document.querySelector('#confirmTitle');
    const descEl = document.querySelector('#confirmMessage');
    const okBtn = document.querySelector('#confirmOkBtn');
    const cancelBtn = document.querySelector('#confirmCancelBtn');
    const iconWrap = document.querySelector('#confirmIconWrap');

    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = message;
    if (okBtn) {
      okBtn.textContent = confirmText;
      okBtn.className = danger ? 'button danger' : 'button primary';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (iconWrap) {
      iconWrap.className = danger ? 'confirm-icon-wrap' : 'confirm-icon-wrap warning';
    }

    let settled = false;
    const cleanup = () => {
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      confirmDialog.removeEventListener('close', onClose);
    };

    const onOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      confirmDialog.close();
      resolve(true);
    };

    const onCancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      confirmDialog.close();
      resolve(false);
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };

    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
    confirmDialog.addEventListener('close', onClose);

    confirmDialog.showModal();
  });
}

/**
 * HTML 转义工具函数，防御 XSS
 * @param {string} value - 待转义字符
 * @returns {string} 转义后字符串
 */
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

/**
 * 弹出现代悬浮 Toast 消息
 * @param {string} text - 提示文本
 * @param {boolean} [error=false] - 是否为错误提示
 * @param {number} [duration=3500] - 显示时长（毫秒）
 */
function showMessage(text, error = false, duration = 3500) {
  clearTimeout(toastTimer);
  message.textContent = text || '';
  message.className = `toast-card visible${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => {
    message.className = 'toast-card';
  }, duration);
}

/**
 * 异步复制文本到剪贴板，支持现代 API 与降级方案
 * @param {string} text - 待复制文本
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) { /* use the focused fallback below */ }
  }
  const focused = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  (focused?.closest('dialog[open]') || document.body).appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('复制失败，请检查浏览器剪贴板权限');
  } finally {
    textarea.remove();
    focused?.focus();
  }
}

/**
 * 统一封装的轻量 HTTP 请求工具
 * @param {string} url - 请求地址
 * @param {object} [options={}] - fetch 配置选项
 * @returns {Promise<any>} 解析后的 JSON 结果
 */
async function api(url, options = {}) {
  const requestUrl = new URL(url, location.href);
  requestUrl.username = '';
  requestUrl.password = '';
  const response = await fetch(requestUrl, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return body;
}

/**
 * 获取当前选中的节点 ID 集合
 * @returns {Set<string>} 选中的节点 ID 集合
 */
function selectedIds() {
  return new Set(selectedNodeIds);
}

/**
 * 更新选中数量文案与批量操作按钮显隐
 */
function updateSelectionText() {
  const count = selectedIds().size;
  const target = document.querySelector('#selectionText');
  if (target) {
    target.textContent = count ? `已选择 ${count} 个` : '未选择';
    target.classList.toggle('has-selection', count > 0);
  }
  const batchDeleteBtn = document.querySelector('#batchDelete');
  const batchDeleteDivider = document.querySelector('#batchDeleteDivider');
  const batchDeleteText = document.querySelector('#batchDeleteText');
  const deletableCount = getSelectedItems().filter((item) => !item.isLocal).length;
  if (batchDeleteBtn) {
    batchDeleteBtn.style.display = deletableCount > 0 ? 'inline-flex' : 'none';
    if (batchDeleteText) {
      batchDeleteText.textContent = `批量删除 (${deletableCount})`;
    }
  }
  if (batchDeleteDivider) {
    batchDeleteDivider.style.display = deletableCount > 0 ? 'inline-block' : 'none';
  }
  const visible = Array.from(rows.querySelectorAll('.row-select'));
  const checkedCount = visible.filter((checkbox) => selectedNodeIds.has(checkbox.dataset.id)).length;
  selectAll.checked = visible.length > 0 && checkedCount === visible.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < visible.length;
  selectAll.disabled = visible.length === 0;
  const mobileSelectAll = document.querySelector('#mobileSelectAll');
  mobileSelectAll.checked = selectAll.checked;
  mobileSelectAll.indeterminate = selectAll.indeterminate;
  mobileSelectAll.disabled = selectAll.disabled;
}

/**
 * 根据延迟数值返回对应的样式类
 * @param {number} ms - 延迟毫秒数
 * @returns {string} CSS 样式类
 */
function latencyClass(ms) {
  if (!ms || ms <= 0) return 'text-muted';
  if (ms < 500) return 'latency-low';
  if (ms < 1500) return 'latency-medium';
  return 'latency-high';
}

function renderTrafficMiniTag(traffic) {
  if (!traffic) return '';
  const up = traffic.todayUploadFormatted || '0 B';
  const down = traffic.todayDownloadFormatted || '0 B';
  return `
    <div class="node-traffic-cell" title="今日流量: 上行 ${up} / 下行 ${down} | 累计下行: ${traffic.totalDownloadFormatted || '0 B'}">
      <span class="traffic-mini-text"><span class="up">↑</span>${up} <span class="down">↓</span>${down}</span>
    </div>
  `;
}

/**
 * 构造生成单行 HTML，采用大面积点击热区的 checkbox
 * @param {object} item - 节点数据对象
 * @param {boolean} isChecked - 是否处于选中状态
 * @returns {string} 表格行 HTML
 */
function renderRowHtml(item, isChecked) {
  const name = escapeHtml(item.name || item.server);
  const state = !item.enabled ? 'disabled' : serviceStatus?.core === 'stopped' ? 'stopped' : item.status;
  const status = { online: '可达', offline: '不可达', disabled: '已禁用', stopped: '核心停止', testing: '检测中' }[state] || '未检测';
  const checked = isChecked ? ' checked' : '';
  const disabled = item.enabled ? '' : ' disabled';
  const coreDisabled = !item.enabled || serviceStatus?.core === 'stopped' ? ' disabled' : '';
  const hy2Configured = item.hy2?.status === 'enabled';
  const hy2Enabled = hy2Configured && serviceStatus?.core !== 'stopped';
  const realityConfigured = Boolean(item.reality?.enabled);
  const realityEnabled = realityConfigured && item.enabled && serviceStatus?.core !== 'stopped';
  const checkedTime = item.lastCheckedAt ? new Date(item.lastCheckedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '未检测';
  const statusTitle = escapeHtml([item.lastError, item.lastCheckedAt && `检测时间 ${new Date(item.lastCheckedAt).toLocaleString('zh-CN')}`, '本机 SOCKS5 / TLS 探测，不代表外部 HY2/VLESS 可达'].filter(Boolean).join('\n'));

  return `
    <tr class="node-row ${item.enabled ? '' : 'disabled-row'}" id="row-${item.id}" data-id="${item.id}">
      <td class="col-select">
        <label class="checkbox-hitbox" title="选择节点 ${name}">
          <input class="row-select" type="checkbox" data-id="${item.id}" aria-label="选择 ${name}"${checked}>
        </label>
      </td>
      <td class="col-node">
        <div class="node-title-cell">
          <strong class="node-name" title="${name}">${name}</strong>
          <span class="node-target font-mono">${item.isLocal ? '自身 VPS · 直连' : `${escapeHtml(item.server)}:${item.upstreamPort}`}</span>
        </div>
      </td>
      <td class="col-proto">
        <span class="protocol-badge proto-${String(item.protocol || '').toLowerCase()}">${escapeHtml(item.protocol)}</span>
      </td>
      <td class="col-exit">
        <div class="exit-cell">
          <strong class="exit-ip font-mono">${escapeHtml(item.exitIp || '未检测')}</strong>
          <span class="exit-location">${escapeHtml(item.location || '—')}</span>
        </div>
      </td>
      <td class="col-latency">
        <span class="latency-val ${latencyClass(item.latencyMs)}">${item.latencyMs ? `${item.latencyMs} ms` : '—'}</span>
      </td>
      <td class="col-port">
        <span class="port-chip font-mono${coreDisabled ? ' port-inactive' : ''}" title="HTTP / SOCKS5 · 本机、Docker 或公网 · ${coreDisabled ? '未监听' : '已启用'}">TCP ${item.listenPort}</span>
        <span class="port-chip hy2-port-chip font-mono${hy2Enabled ? '' : ' port-inactive'}" title="HY2 · 外部使用 · UDP · ${hy2Enabled ? '已启用，公网 UDP 尚未检测' : hy2Configured ? '已配置，但核心已停止' : '未启用'}">${hy2Configured ? `HY2 ${item.listenPort}${hy2Enabled ? '' : ' 停止'}` : 'HY2 未启用'}</span>
        ${item.reality ? `<span class="port-chip reality-port-chip font-mono${realityEnabled ? '' : ' port-inactive'}" title="VLESS + RAW + Reality · 外部使用 · TCP">VLESS ${item.reality.listenPort}${realityEnabled ? '' : ' 停止'}</span>` : ''}
        ${renderTrafficMiniTag(item.traffic)}
      </td>
      <td class="col-status">
        <span class="status-chip ${escapeHtml(state)}" title="${statusTitle}">
          <i class="status-dot-sm"></i>
          <span>${status}</span>
        </span>
        <span class="node-check-time" title="${statusTitle}">${checkedTime}</span>
      </td>
      <td class="col-actions">
        <div class="actions-group">
          <div class="copy-actions" aria-label="复制代理地址">
            <button class="btn-action" data-action="copy-http" data-id="${item.id}" title="复制本机 HTTP 地址：127.0.0.1"${disabled}>HTTP</button>
            <button class="btn-action" data-action="copy-socks" data-id="${item.id}" title="复制本机 SOCKS5 地址：127.0.0.1"${disabled}>SOCKS5</button>
            <button class="btn-action" data-action="${hy2Configured ? 'copy-hy2' : 'hy2'}" data-id="${item.id}" title="${hy2Configured ? '复制公网 HY2 连接' : '启用公网 HY2'}"${disabled}>${hy2Configured ? 'HY2' : 'HY2 +'}</button>
            <button class="btn-action" data-action="${realityConfigured ? 'copy-reality' : 'reality'}" data-id="${item.id}" title="${realityConfigured ? '复制 VLESS + RAW + Reality 链接' : '配置 VLESS + RAW + Reality'}"${disabled}>${realityConfigured ? 'VLESS' : 'VLESS +'}</button>
          </div>
          <button class="btn-action action-icon" data-action="test" data-id="${item.id}" title="检测上游连通性" aria-label="检测 ${name}"${coreDisabled}>${icon('refresh-cw')}</button>
          <button class="node-toggle" role="switch" aria-checked="${Boolean(item.enabled)}" data-action="${item.enabled ? 'disable' : 'enable'}" data-id="${item.id}" title="${item.enabled ? '禁用' : '启用'} ${name}" aria-label="启用 ${name}"><span></span></button>
          <details class="tool-menu row-menu">
            <summary class="btn-action action-icon" title="更多操作" aria-label="${name} 更多操作">${icon('ellipsis')}</summary>
            <div class="menu-items">
              <button data-action="copy-docker-http" data-id="${item.id}"${disabled}>Docker HTTP</button>
              <button data-action="copy-docker-socks" data-id="${item.id}"${disabled}>Docker SOCKS5</button>
              <button data-action="copy-public-http" data-id="${item.id}"${disabled}>公网 HTTP</button>
              <button data-action="copy-public-socks" data-id="${item.id}"${disabled}>公网 SOCKS5</button>
              ${item.isLocal ? '' : `<button data-action="edit" data-id="${item.id}">编辑节点</button>`}
              ${item.hy2 ? `<button data-action="${hy2Configured ? 'disable-hy2' : 'hy2'}" data-id="${item.id}"${disabled}>${hy2Configured ? '停用' : '启用'} HY2</button>` : ''}
              <button data-action="reality" data-id="${item.id}">Reality 设置</button>
              ${item.isLocal ? '<span class="menu-note">本机节点不可删除</span>' : `<button class="danger" data-action="remove" data-id="${item.id}">删除节点</button>`}
            </div>
          </details>
        </div>
      </td>
    </tr>
  `;
}

/**
 * 局部更新单行 DOM，避免全表重新渲染造成的卡顿和焦点丢失
 * @param {object} item - 最新的节点数据
 */
function updateSingleRowDom(item, force = false) {
  const rowElement = document.querySelector(`#row-${item.id}`);
  if (!rowElement) return;

  const markup = renderRowHtml(item, selectedNodeIds.has(item.id));
  if (rowElement.dataset.markup === markup) return;
  // Keep menus and in-flight actions stable; preserve focus during passive updates.
  if (!force && rowElement.querySelector('details[open], [data-busy="true"]')) return;
  const focused = rowElement.contains(document.activeElement) ? document.activeElement : null;
  const focusSelector = focused?.matches('.row-select') ? '.row-select' : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]` : focused?.matches('summary') ? 'summary' : null;
  rowElement.outerHTML = markup;
  const nextRow = document.querySelector(`#row-${item.id}`);
  nextRow.dataset.markup = markup;
  if (!force && focusSelector) nextRow.querySelector(focusSelector)?.focus({ preventScroll: true });
  updateSelectionText();
}

/**
 * 检测中快速同步，其余时间低频同步；隐藏页面暂停请求
 */
function checkAutoPolling() {
  clearTimeout(autoPollerTimer);
  autoPollerTimer = null;
  if (document.hidden || (!autoRefresh.checked && !manualHealthCheck)) return;
  const testing = manualHealthCheck || items.some((it) => it.enabled && it.status === 'testing');
  autoPollerTimer = setTimeout(() => refresh(false).catch(() => {}), testing ? 1500 : 15000);
}

/**
 * 更新概览数据看板
 * @param {object} status - 服务状态数据
 */
function updateOverviewCards(status) {
  if (!status) return;
  document.querySelector('#total').textContent = status.total || 0;
  document.querySelector('#enabled').textContent = status.enabled || 0;
  document.querySelector('#online').textContent = status.online || 0;

  const rate = status.enabled > 0 ? Math.round((status.online / status.enabled) * 100) : 0;
  const onlineRateEl = document.querySelector('#onlineRate');
  if (onlineRateEl) {
    onlineRateEl.textContent = `连通率 ${rate}%`;
  }

  const serviceText = document.querySelector('#serviceText');
  const serviceDot = document.querySelector('#serviceDot');
  if (serviceText && serviceDot) {
    serviceText.textContent = status.core === 'running' ? '核心运行中' : '核心已停止';
    serviceDot.className = `status-dot ${status.core === 'running' ? 'online' : 'offline'}`;
  }
}

/**
 * 渲染或重绘整个节点列表
 * @param {Array<object>} listItems - 待渲染节点列表
 */
function render(listItems) {
  const existingIds = new Set(listItems.map((item) => item.id));
  for (const id of selectedNodeIds) if (!existingIds.has(id)) selectedNodeIds.delete(id);
  const selected = selectedIds();
  const filterKeyword = (nodeFilter ? nodeFilter.value : '').trim().toLowerCase();

  const filtered = filterKeyword
    ? listItems.filter((it) => {
        const text = `${it.name || ''} ${it.server || ''} ${it.listenPort || ''} ${it.protocol || ''} ${it.exitIp || ''} ${it.location || ''}`.toLowerCase();
        return text.includes(filterKeyword);
      })
    : listItems;

  if (!filtered.length) {
    rows.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">
          <div class="empty-wrap">
            <span class="empty-icon">${filterKeyword ? '🔍' : '📭'}</span>
            <p>${filterKeyword ? '未找到符合条件的节点' : '还没有代理节点，先添加一个代理地址。'}</p>
          </div>
        </td>
      </tr>`;
  } else {
    rows.innerHTML = filtered.map((item) => renderRowHtml(item, selected.has(item.id))).join('');
    filtered.forEach((item) => { document.querySelector(`#row-${item.id}`).dataset.markup = renderRowHtml(item, selected.has(item.id)); });
  }
  updateSelectionText();
  checkAutoPolling();
}

/**
 * 获取当前节点复制时使用的有效域名或 IP
 * 若设置为空或为默认占位符 proxy.example.com，则自适应读取当前浏览器访问地址
 * @param {string} [hostOverride] - 手动指定的主机名
 * @returns {string} 有效的主机地址
 */
function getEffectiveHost(hostOverride) {
  if (hostOverride) return hostOverride;
  const configured = String(settings.publicHost || '').trim();
  if (configured && configured !== 'proxy.example.com') {
    return configured;
  }
  return location.hostname || '127.0.0.1';
}

/**
 * 生成节点的公网或内网代理连接字符串
 * @param {object} item - 节点
 * @param {string} scheme - 协议 scheme
 * @param {string} [host] - 主机名
 * @returns {string} 代理字符串
 */
function endpoint(item, scheme, host) {
  const effectiveHost = getEffectiveHost(host);
  const user = encodeURIComponent(settings.proxyUsername);
  const password = encodeURIComponent(settings.proxyPassword);
  return `${scheme}://${user}:${password}@${effectiveHost}:${item.listenPort}`;
}

/**
 * 批量复制节点代理地址
 * @param {Array<object>} targetItems - 目标节点集合
 * @param {string} scheme - 代理协议
 * @param {string} [host] - 目标主机
 * @param {string} [label] - 提示文案标签
 */
async function copyItems(targetItems, scheme, host, label = scheme.toUpperCase()) {
  const relayField = { hy2: 'hy2', vless: 'reality' }[scheme];
  const enabledItems = targetItems.filter((item) => item.enabled && (!relayField || (item[relayField]?.status === 'enabled' && item[relayField].link)));
  if (!enabledItems.length) {
    throw new Error(relayField ? `请选择至少一个已启用 ${label} 的节点` : '请先选择至少一个已启用的节点');
  }
  const text = enabledItems.map((item) => relayField ? item[relayField].link : endpoint(item, scheme, host)).join('\n');
  await copyText(text);
  showMessage(`已复制 ${enabledItems.length} 个 ${label} 代理节点地址`);
}

/**
 * 刷新所有数据（节点、服务状态、配置信息）
 */
async function refresh(includeSettings = true) {
  if (refreshPromise) {
    if (!includeSettings) return refreshPromise;
    await refreshPromise;
    return refresh(includeSettings);
  }
  refreshPromise = refreshData(includeSettings);
  try { return await refreshPromise; }
  finally { refreshPromise = null; checkAutoPolling(); }
}

async function refreshData(includeSettings) {
  let nextItems, status, nextSettings;
  try { [nextItems, status, nextSettings] = await Promise.all([
    api('/api/proxies'),
    api('/api/status'),
    includeSettings ? api('/api/settings') : Promise.resolve(settings)
  ]); } catch (error) {
    document.querySelector('#syncTime').textContent = '同步失败';
    throw error;
  }
  const previousIds = items.map((item) => item.id).join(',');
  items = nextItems;
  settings = nextSettings;
  serviceStatus = status;
  if (includeSettings || nodeFilter.value.trim() || previousIds !== items.map((item) => item.id).join(',')) render(items);
  else items.forEach((item) => updateSingleRowDom(item));

  // 同步设置表单
  if (includeSettings && !settingsDialog.open) {
  settingsForm.proxyUsername.value = settings.proxyUsername || '';
  settingsForm.proxyPassword.value = settings.proxyPassword || '';
  settingsForm.publicHost.value = settings.publicHost || '';
  document.querySelector('#subscriptionSocks').value = settings.subscriptions?.socks5 || '';
  document.querySelector('#subscriptionHttp').value = settings.subscriptions?.http || '';
  }

  updateOverviewCards(status);

  // 入口地址展示
  document.querySelector('#endpoint').textContent = getEffectiveHost();
  document.querySelector('#syncTime').textContent = `同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (manualHealthCheck && !status.healthCheck?.running) {
    manualHealthCheck = false;
    showMessage(status.healthCheck?.lastError || '上游连通性检测完成', Boolean(status.healthCheck?.lastError));
  }
  document.querySelector('#testAll').disabled = Boolean(status.healthCheck?.running);
  document.querySelector('#testAllSpinner').style.display = status.healthCheck?.running ? 'inline-block' : 'none';
  document.querySelector('#testAllText').textContent = status.healthCheck?.running ? '检测中...' : '检测上游';

  updateTotpBadge();
  if (settings.authDisabled) {
    const logoutForm = document.querySelector('.logout-form');
    if (logoutForm) logoutForm.style.display = 'none';
  }
  checkAutoPolling();
  return status;
}

autoRefresh.addEventListener('change', checkAutoPolling);
document.addEventListener('visibilitychange', () => {
  checkAutoPolling();
  if (!document.hidden && (autoRefresh.checked || manualHealthCheck)) refresh(false).catch(() => {});
});
document.addEventListener('click', (event) => {
  document.querySelectorAll('.tool-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target) || (!menu.classList.contains('docker-menu') && event.target.closest('button, a'))) menu.open = false;
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelectorAll('.tool-menu[open]').forEach((menu) => { menu.open = false; });
});

/**
 * 更新顶部导航栏的身份验证器徽章状态
 */
function updateTotpBadge() {
  const badge = document.querySelector('#totpBadge');
  if (!badge) return;
  if (settings.totpEnabled) {
    badge.textContent = '已启用';
    badge.className = 'mini-badge badge-success';
  } else {
    badge.textContent = '未配置';
    badge.className = 'mini-badge badge-warning';
  }
}

// 弹窗控制
document.querySelector('#openAddDialog').addEventListener('click', () => addDialog.showModal());
document.querySelector('#openImportDialog').addEventListener('click', () => importDialog.showModal());
document.querySelector('#openSettingsDialog').addEventListener('click', () => settingsDialog.showModal());
document.querySelector('#openPasswordDialog').addEventListener('click', () => passwordDialog.showModal());
passwordDialog.addEventListener('close', () => {
  passwordForm.reset();
  dialogFeedback(passwordDialog, '');
});
async function openRelayModal() {
  relayDialog.showModal();
  dialogFeedback(relayDialog, '');
  try {
    await refreshRelays();
  } catch (error) {
    dialogFeedback(relayDialog, error.message, true);
  }
}
document.querySelector('#openRelayDialog').addEventListener('click', () => openRelayModal());
document.querySelector('#openTotpDialog').addEventListener('click', () => openTotpModal());

let relayItems = [];

function openRealityModal(item) {
  realityForm.dataset.id = item.id;
  realityForm.elements.host.value = item.reality?.host || settings.publicHost || window.location.hostname;
  realityForm.elements.serverName.value = item.reality?.serverName || 'www.apple.com';
  realityForm.elements.enabled.checked = item.reality?.enabled ?? item.enabled;
  document.querySelector('#realityNodeName').textContent = item.name;
  document.querySelector('#realityPort').textContent = item.reality ? `TCP ${item.reality.listenPort}` : 'TCP 50000+ · 自动分配';
  document.querySelector('#copyRealityLink').disabled = !item.reality;
  document.querySelector('#removeReality').hidden = !item.reality;
  dialogFeedback(realityDialog, '');
  realityDialog.showModal();
}

realityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = realityForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(`/api/proxies/${realityForm.dataset.id}/reality`, {
      method: 'PUT', body: JSON.stringify({
        host: realityForm.elements.host.value, serverName: realityForm.elements.serverName.value,
        enabled: realityForm.elements.enabled.checked
      })
    });
    await refresh();
    document.querySelector('#realityPort').textContent = `TCP ${result.listenPort}`;
    document.querySelector('#copyRealityLink').disabled = false;
    document.querySelector('#removeReality').hidden = false;
    dialogFeedback(realityDialog, result.enabled ? 'Reality 已启用' : 'Reality 已停用');
  } catch (error) { dialogFeedback(realityDialog, error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector('#copyRealityLink').addEventListener('click', async () => {
  try {
    const item = items.find((entry) => entry.id === realityForm.dataset.id);
    await copyText(item.reality.link);
    dialogFeedback(realityDialog, 'VLESS Reality 链接已复制');
  } catch (error) { dialogFeedback(realityDialog, error.message, true); }
});

document.querySelector('#removeReality').addEventListener('click', async (event) => {
  if (!await showConfirm({ title: '删除 Reality 入口', message: '原 VLESS 链接将失效；HTTP、SOCKS5 和 HY2 不受影响。', confirmText: '删除' })) return;
  event.target.disabled = true;
  try {
    await api(`/api/proxies/${realityForm.dataset.id}/reality`, { method: 'DELETE' });
    await refresh();
    realityDialog.close();
    showMessage('Reality 入口已删除');
  } catch (error) { dialogFeedback(realityDialog, error.message, true); }
  finally { event.target.disabled = false; }
});

function setRelayMode() {
  const auto = relayTlsForm.elements['mode'].value === 'auto';
  relayTlsForm.querySelectorAll('[data-relay-manual]').forEach((label) => { label.hidden = auto; });
  for (const name of ['certificatePath', 'keyPath']) relayTlsForm.elements[name].required = !auto;
  document.querySelector('#relayAcmeHint').hidden = !auto;
}

relayTlsForm.addEventListener('change', (event) => {
  if (event.target.name === 'mode') setRelayMode();
});

function renderRelayCertificateStatus(data) {
  const status = document.querySelector('#relayCertificateStatus');
  if (data.tls.mode === 'manual') status.textContent = '使用已有证书';
  else if (data.tls.status === 'ready') status.textContent = `证书已签发，有效期至 ${new Date(data.tls.expiresAt).toLocaleDateString()}；运行期间自动续期`;
  else if (data.tls.status === 'not_requested') status.textContent = '尚未申请证书；新增出口后自动申请';
  else if (data.tls.status === 'error') status.textContent = '签发未完成，sing-box 未运行；请检查服务日志、域名解析及 TCP 443';
  else status.textContent = '证书申请中；如长时间未完成，请检查服务日志、域名解析及 TCP 443';
}

let relayStatusPending = false;
setInterval(async () => {
  if (document.hidden || relayStatusPending || !relayDialog.open || !relayItems.some((item) => item.enabled)) return;
  relayStatusPending = true;
  try { renderRelayCertificateStatus(await api('/api/relays')); } catch (error) { /* next refresh */ }
  finally { relayStatusPending = false; }
}, 5000);

function dialogFeedback(dialog, text, error = false) {
  const feedback = dialog.querySelector('.dialog-feedback');
  feedback.textContent = text;
  feedback.classList.toggle('error', error);
}

async function refreshRelays() {
  const data = await api('/api/relays');
  relayItems = data.relays;
  relayTlsForm.querySelector(`[name="mode"][value="${data.tls.mode}"]`).checked = true;
  setRelayMode();
  relayTlsForm.elements['host'].value = data.tls.host;
  relayTlsForm.elements['certificatePath'].value = data.tls.certificatePath;
  relayTlsForm.elements['keyPath'].value = data.tls.keyPath;
  renderRelayCertificateStatus(data);
  document.querySelector('#relayCoreStatus').textContent =
    `本项目 sing-box：${data.managedCore ? '运行中' : '未运行'}；VPS sing-box：${data.cores.singBox ? '已检测到' : '未检测到'}；xray：${data.cores.xray ? '已检测到' : '未检测到'}`;
  document.querySelector('#relayList').innerHTML = relayItems.length
    ? relayItems.map((item) => `
      <div class="relay-row">
        <div class="relay-row-info"><strong>UDP ${item.listenPort} · ${{ enabled: '已启用', disabled: '已停用', node_disabled: '关联节点已停用', unbound: '未关联节点' }[item.status]}</strong>
          <code>${escapeHtml(item.proxyName || '未关联节点')}</code>
          <code>${escapeHtml(data.tls.host)}:${item.listenPort}</code></div>
        <div class="relay-actions">
          <button class="button secondary btn-sm" type="button" data-relay-action="copy" data-relay-id="${item.id}" title="复制 HY2 连接链接" aria-label="复制 UDP ${item.listenPort} 的连接链接"${item.status === 'unbound' ? ' disabled' : ''}>⧉</button>
          <button class="button secondary btn-sm" type="button" data-relay-action="${item.enabled ? 'disable' : 'enable'}" data-relay-id="${item.id}"${item.status === 'unbound' ? ' disabled' : ''}>${item.enabled ? '停用' : '启用'}</button>
          <button class="button danger btn-sm" type="button" data-relay-action="delete" data-relay-id="${item.id}" title="删除 HY2 入口" aria-label="删除 UDP ${item.listenPort} 入口">×</button>
        </div>
      </div>`).join('')
    : '<p class="form-hint">暂无 HY2 出口</p>';
}

relayTlsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = relayTlsForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/relays/tls', {
      method: 'PUT',
      body: JSON.stringify({
        mode: relayTlsForm.elements['mode'].value,
        host: relayTlsForm.elements['host'].value,
        certificatePath: relayTlsForm.elements['certificatePath'].value,
        keyPath: relayTlsForm.elements['keyPath'].value
      })
    });
    await refreshRelays();
    dialogFeedback(relayDialog, relayTlsForm.elements['mode'].value === 'auto' ? '域名已保存；新增出口后开始申请证书' : 'HY2 TLS 配置已保存');
  } catch (error) {
    dialogFeedback(relayDialog, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#relayList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-relay-action]');
  if (!button) return;
  const item = relayItems.find((entry) => entry.id === button.dataset.relayId);
  if (!item) return;
  const action = button.dataset.relayAction;
  if (action === 'copy') {
    try {
      await copyText(item.link);
      dialogFeedback(relayDialog, `UDP ${item.listenPort} 的 HY2 链接已复制`);
    } catch (error) { dialogFeedback(relayDialog, error.message, true); }
    return;
  }
  if (action === 'delete' && !await showConfirm({ title: '删除 HY2 出口', message: `删除 UDP ${item.listenPort} 后原连接将立即失效。`, confirmText: '删除' })) return;
  button.disabled = true;
  try {
    await api(`/api/relays/${item.id}${action === 'delete' ? '' : `/${action}`}`, {
      method: action === 'delete' ? 'DELETE' : 'POST'
    });
    await Promise.all([refreshRelays(), refresh()]);
    dialogFeedback(relayDialog, 'HY2 出口已更新');
  } catch (error) {
    button.disabled = false;
    dialogFeedback(relayDialog, error.message, true);
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dialogFeedback(passwordDialog, '');
  const currentPassword = passwordForm.elements['currentPassword'].value;
  const newPassword = passwordForm.elements['newPassword'].value;
  if (newPassword !== passwordForm.elements['confirmPassword'].value) {
    return dialogFeedback(passwordDialog, '两次输入的新密码不一致', true);
  }
  const button = passwordForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    passwordForm.reset();
    if (settings.authDisabled) {
      passwordDialog.close();
      showMessage('管理员密码已更新');
    } else {
      location.assign('/login');
    }
  } catch (error) {
    dialogFeedback(passwordDialog, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => {
    const dialog = document.querySelector(`#${button.dataset.close}`);
    if (dialog) dialog.close();
  });
});

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});

// 密码显示/隐藏切换
document.querySelector('#togglePassword').addEventListener('click', (event) => {
  const input = settingsForm.proxyPassword;
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  event.currentTarget.textContent = visible ? '显示' : '隐藏';
});

// 复制订阅链接
document.querySelectorAll('[data-copy-subscription]').forEach((button) => {
  button.addEventListener('click', async () => {
    const scheme = button.dataset.copySubscription;
    const url = settings.subscriptions?.[scheme];
    if (!url) return showMessage('订阅地址尚未生成', true);
    try {
      await copyText(url);
      showMessage(`已复制 ${scheme.toUpperCase()} 内网订阅地址`);
    } catch (error) {
      showMessage(error.message, true);
    }
  });
});

// 轮换订阅密钥
document.querySelector('#rotateSubscription').addEventListener('click', async (event) => {
  const confirmed = await showConfirm({
    title: '轮换订阅 Token',
    message: '轮换 Token 后，旧订阅地址将立即失效。确定继续吗？',
    confirmText: '确认轮换',
    danger: true
  });
  if (!confirmed) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    settings = await api('/api/subscriptions/rotate', { method: 'POST' });
    document.querySelector('#subscriptionSocks').value = settings.subscriptions.socks5;
    document.querySelector('#subscriptionHttp').value = settings.subscriptions.http;
    showMessage('内网订阅密钥已成功轮换');
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

// 实时搜索过滤
nodeFilter.addEventListener('input', () => {
  render(items);
});

// 添加节点表单提交（毫秒级响应 + 后台自动静默测速）
addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = addForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = '添加中...';
  try {
    const created = await api('/api/proxies', {
      method: 'POST',
      body: JSON.stringify({ link: addForm.link.value, name: addForm.name.value })
    });
    addForm.reset();
    addDialog.close();
    items.push(created);
    render(items);
    showMessage(`节点已添加并分配端口 ${created.listenPort}，后台正在自动测速...`);
    checkAutoPolling();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '立即添加';
  }
});

document.querySelector('#importFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 120 * 1024) return showMessage('节点文件不能超过 120 KB', true);
  try { importForm.links.value = await file.text(); }
  catch (error) { showMessage(`读取节点文件失败: ${error.message}`, true); }
});

// 批量导入表单提交（毫秒级响应 + 后台自动静默测速）
importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = importForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = '正在导入...';
  try {
    const result = await api('/api/proxies/import', {
      method: 'POST',
      body: JSON.stringify({ links: importForm.links.value })
    });
    if (result.added) {
      importForm.reset();
      importDialog.close();
      await refresh();
    }
    const parts = [];
    if (result.added) parts.push(`成功导入 ${result.added} 个节点`);
    if (result.skipped) parts.push(`跳过 ${result.skipped} 个重复`);
    if (result.invalid?.length) parts.push(`第 ${result.invalid[0].line} 行格式错误`);
    showMessage((parts.join('，') || '未发现可导入的链接') + (result.added ? '，后台正在自动测速...' : ''), Boolean(result.invalid?.length));
    checkAutoPolling();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '开始批量导入';
  }
});

// 编辑节点表单提交
editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = editForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = '保存中...';
  const id = editForm.dataset.id;
  try {
    const updated = await api(`/api/proxies/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ link: editForm.link.value, name: editForm.name.value })
    });
    editDialog.close();
    const index = items.findIndex((it) => it.id === id);
    if (index >= 0) items[index] = updated;
    updateSingleRowDom(updated, true);
    showMessage(`节点已更新，端口 ${updated.listenPort} 保持不变`);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '保存更改';
  }
});

// 访问设置表单提交
settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = settingsForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = '保存中...';
  try {
    settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        proxyUsername: settingsForm.proxyUsername.value,
        proxyPassword: settingsForm.proxyPassword.value,
        publicHost: settingsForm.publicHost.value
      })
    });
    settingsDialog.close();
    await refresh();
    showMessage('访问设置已保存，核心端口已平滑重载');
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '保存并重载';
  }
});

// 全量手动健康检测
document.querySelector('#testAll').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const spinner = button.querySelector('#testAllSpinner');
  const textEl = button.querySelector('#testAllText');
  const label = '检测上游';

  button.disabled = true;
  if (spinner) spinner.style.display = 'inline-block';
  textEl.textContent = '检测中...';

  try {
    const result = await api('/api/proxies/test-all', { method: 'POST' });
    manualHealthCheck = true;
    showMessage(result.alreadyRunning ? '检测已在后台运行中' : '已触发全量连通性检测');
    await refresh(false);
  } catch (error) {
    showMessage(error.message, true);
    button.disabled = false;
    if (spinner) spinner.style.display = 'none';
    textEl.textContent = label;
  }
});

// 全选操作联动
selectAll.addEventListener('change', (event) => {
  document.querySelectorAll('.row-select:not(:disabled)').forEach((checkbox) => {
    checkbox.checked = event.currentTarget.checked;
    if (checkbox.checked) selectedNodeIds.add(checkbox.dataset.id);
    else selectedNodeIds.delete(checkbox.dataset.id);
  });
  updateSelectionText();
});
document.querySelector('#mobileSelectAll').addEventListener('change', (event) => {
  selectAll.checked = event.currentTarget.checked;
  selectAll.dispatchEvent(new Event('change'));
});

rows.addEventListener('change', (event) => {
  if (event.target.classList.contains('row-select')) {
    if (event.target.checked) selectedNodeIds.add(event.target.dataset.id);
    else selectedNodeIds.delete(event.target.dataset.id);
    updateSelectionText();
  }
});

function getSelectedItems() {
  const selected = selectedIds();
  return items.filter((item) => selected.has(item.id));
}

// 批量快捷复制
document.querySelector('#copyHttp').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'http', undefined, '公网 HTTP').catch((error) => showMessage(error.message, true));
});
document.querySelector('#copySocks').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'socks5', undefined, '公网 SOCKS5').catch((error) => showMessage(error.message, true));
});
document.querySelector('#copyHy2').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'hy2').catch((error) => showMessage(error.message, true));
});
document.querySelector('#copyVless').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'vless', undefined, 'VLESS Reality').catch((error) => showMessage(error.message, true));
});
document.querySelector('#copyInternalHttp').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'http', INTERNAL_PROXY_HOST, '本机 HTTP')
    .catch((error) => showMessage(error.message, true));
});
document.querySelector('#copyInternalSocks').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'socks5', INTERNAL_PROXY_HOST, '本机 SOCKS5')
    .catch((error) => showMessage(error.message, true));
});
for (const [id, scheme] of [['copyDockerHttp', 'http'], ['copyDockerSocks', 'socks5']]) {
  document.querySelector(`#${id}`).addEventListener('click', () => {
    copyItems(getSelectedItems(), scheme, DOCKER_PROXY_HOST, `Docker ${scheme.toUpperCase()}`)
      .catch((error) => showMessage(error.message, true));
  });
}
document.querySelector('#copyDockerCompose').addEventListener('click', async () => {
  try {
    await copyText(document.querySelector('#dockerComposeSnippet').textContent);
    showMessage('Compose 服务配置已复制');
  } catch (error) { showMessage(error.message, true); }
});

// 批量删除选中的节点（原子事务批量清除并轻量重载）
const batchDeleteBtn = document.querySelector('#batchDelete');
if (batchDeleteBtn) {
  batchDeleteBtn.addEventListener('click', async () => {
    const ids = getSelectedItems().filter((item) => !item.isLocal).map((item) => item.id);
    if (!ids.length) {
      showMessage('请先勾选需要删除的节点', true);
      return;
    }
    const confirmed = await showConfirm({
      title: '批量删除节点',
      message: `确定要批量删除选中的 ${ids.length} 个节点吗？此操作不可撤销。`,
      confirmText: '确认批量删除',
      danger: true
    });
    if (!confirmed) {
      return;
    }
    batchDeleteBtn.disabled = true;
    try {
      const res = await api('/api/proxies/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      showMessage(`成功批量删除 ${res.deleted || ids.length} 个节点`);
      const deletedSet = new Set(ids);
      items = items.filter((it) => !deletedSet.has(it.id));
      render(items);
      updateSelectionText();
      await refresh(false);
    } catch (error) {
      showMessage(`批量删除失败: ${error.message}`, true);
    } finally {
      batchDeleteBtn.disabled = false;
    }
  });
}

// 表格行动作委托（局部更新 + 后台自动静默测速）
rows.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const { action, id } = button.dataset;
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return;

  if (action === 'reality') { openRealityModal(item); return; }
  if (action === 'copy-reality') {
    try { await copyText(item.reality.link); showMessage(`已复制 ${item.name} 的 VLESS Reality 出口`); }
    catch (error) { showMessage(error.message, true); }
    return;
  }

  if (action === 'hy2' || action === 'disable-hy2') {
    button.disabled = true;
    try {
      await api(item.hy2 ? `/api/relays/${item.hy2.id}/${action === 'disable-hy2' ? 'disable' : 'enable'}` : '/api/relays', {
        method: 'POST', body: item.hy2 ? undefined : JSON.stringify({ proxyId: item.id })
      });
      await refresh();
      showMessage(`${item.name} HY2 已${action === 'disable-hy2' ? '停用' : '启用'}，端口 ${item.listenPort}`);
    } catch (error) {
      await openRelayModal();
      dialogFeedback(relayDialog, error.message, true);
    } finally { button.disabled = false; }
    return;
  }

  if (action === 'copy-hy2') {
    try {
      await copyText(item.hy2.link);
      showMessage(`已复制 ${item.name || item.server} 的 HY2 出口`);
    } catch (error) { showMessage(error.message, true); }
    return;
  }

  // 1. 复制
  if (['copy-http', 'copy-socks', 'copy-docker-http', 'copy-docker-socks', 'copy-public-http', 'copy-public-socks'].includes(action)) {
    try {
      const docker = action.startsWith('copy-docker-');
      const external = action.startsWith('copy-public-');
      const scheme = action.endsWith('http') ? 'http' : 'socks5';
      await copyItems([item], scheme, docker ? DOCKER_PROXY_HOST : external ? undefined : INTERNAL_PROXY_HOST,
        `${docker ? 'Docker' : external ? '公网' : '本机'} ${scheme.toUpperCase()}`);
    } catch (error) {
      showMessage(error.message, true);
    }
    return;
  }

  // 2. 编辑
  if (action === 'edit') {
    editForm.dataset.id = item.id;
    editForm.link.value = item.link || '';
    editForm.name.value = item.name || '';
    editForm.listenPort.value = item.listenPort;
    editDialog.showModal();
    return;
  }

  // 3. 删除
  if (action === 'remove') {
    const nodeName = item.name || item.server || '指定节点';
    const confirmed = await showConfirm({
      title: '删除节点',
      message: `确定删除节点“${nodeName}”？此操作不可逆。`,
      confirmText: '确认删除',
      danger: true
    });
    if (!confirmed) return;
  }

  // 4. 手动单节点测速
  if (action === 'test') {
    button.disabled = true;
    button.dataset.busy = 'true';
    button.classList.add('testing-action');
    showMessage(`正在探测 ${item.name || item.server} 连通性...`);
    try {
      const result = await api(`/api/proxies/${id}/test`, { method: 'POST' });
      const index = items.findIndex((it) => it.id === id);
      if (index >= 0) items[index] = result;
      button.disabled = false;
      button.blur();
      updateSingleRowDom(result, true);
      await refresh(false);
      const isOnline = result.status === 'online';
      showMessage(
        isOnline ? `${result.name} 在线，延迟 ${result.latencyMs} ms` : `${result.name} 离线：${result.lastError || '连接超时'}`,
        !isOnline
      );
    } catch (error) {
      showMessage(error.message, true);
      button.disabled = false;
      delete button.dataset.busy;
      button.classList.remove('testing-action');
    }
    return;
  }

  // 5. 启用 / 禁用 / 删除（毫秒级生效，启用后自动启动静默探测）
  const originalLabel = button.textContent;
  button.disabled = true;
  button.dataset.busy = 'true';

  try {
    const isRemove = action === 'remove';
    const result = await api(`/api/proxies/${id}${isRemove ? '' : `/${action}`}`, {
      method: isRemove ? 'DELETE' : 'POST'
    });

    if (isRemove) {
      items = items.filter((it) => it.id !== id);
      selectedNodeIds.delete(id);
      const rowEl = document.querySelector(`#row-${id}`);
      if (rowEl) rowEl.remove();
      updateSelectionText();
      showMessage('节点已删除');
    } else {
      const index = items.findIndex((it) => it.id === id);
      if (index >= 0) items[index] = result;
      button.disabled = false;
      button.blur();
      updateSingleRowDom(result, true);
      showMessage(action === 'enable' ? '节点已启用，后台正在自动测速...' : '节点已禁用');
      if (action === 'enable') {
        checkAutoPolling();
      }
    }

    await refresh(false);
  } catch (error) {
    showMessage(error.message, true);
    button.disabled = false;
    delete button.dataset.busy;
    button.textContent = originalLabel;
  }
});

// ==========================================
// Google 身份验证器 (TOTP) 管理逻辑（标准 SVG 矢量渲染）
// ==========================================

/**
 * 打开身份验证器管理弹窗
 */
async function openTotpModal() {
  totpDialog.showModal();
  const statusBanner = document.querySelector('#totpStatusBanner');
  const statusText = document.querySelector('#totpStatusText');
  const setupArea = document.querySelector('#totpSetupArea');
  const manageArea = document.querySelector('#totpManageArea');

  try {
    const data = await api('/api/totp/setup');
    currentTotpSetup = data;

    if (data.enabled) {
      statusBanner.className = 'status-banner active';
      statusText.textContent = 'Google 身份验证器：已激活';
      setupArea.style.display = 'none';
      manageArea.style.display = 'block';
    } else {
      statusBanner.className = 'status-banner warning';
      statusText.textContent = 'Google 身份验证器：未绑定';
      setupArea.style.display = 'grid';
      manageArea.style.display = 'none';

      document.querySelector('#totpSecretText').textContent = data.secret;
      // 插入标准 ISO/IEC 18004 规范的高清矢量 SVG 二维码
      const qrContainer = document.querySelector('#totpQrContainer');
      if (qrContainer) {
        qrContainer.innerHTML = data.qrSvg || '';
      }
    }
  } catch (error) {
    showMessage(`获取身份验证器状态失败: ${error.message}`, true);
  }
}

// 复制 TOTP 密钥
document.querySelector('#copyTotpSecret').addEventListener('click', async () => {
  if (currentTotpSetup?.secret) {
    await copyText(currentTotpSetup.secret);
    showMessage('TOTP 密钥已复制到剪贴板');
  }
});

// 验证并启用 TOTP
totpBindForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#totpVerifyInput');
  const btn = document.querySelector('#btnVerifyBind');
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) {
    return showMessage('请输入 6 位数字验证码', true);
  }

  btn.disabled = true;
  btn.textContent = '验证中...';
  try {
    await api('/api/totp/verify-bind', {
      method: 'POST',
      body: JSON.stringify({ code, secret: currentTotpSetup.secret })
    });
    settings.totpEnabled = true;
    updateTotpBadge();
    showMessage('Google 身份验证器已成功激活！下次可使用 6 位验证码秒级登录。');
    input.value = '';
    await openTotpModal();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '验证并启用';
  }
});

// 停用 TOTP
document.querySelector('#btnDisableTotp').addEventListener('click', async () => {
  const confirmed = await showConfirm({
    title: '停用身份验证器',
    message: '停用后将不能使用 6 位动态验证码登录，只能使用静态密码。确定停用？',
    confirmText: '确定停用',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api('/api/totp/disable', { method: 'POST' });
    settings.totpEnabled = false;
    updateTotpBadge();
    showMessage('Google 身份验证器已停用');
    await openTotpModal();
  } catch (error) {
    showMessage(error.message, true);
  }
});

// 重新绑定 TOTP
document.querySelector('#btnRebindTotp').addEventListener('click', async () => {
  const setupArea = document.querySelector('#totpSetupArea');
  const manageArea = document.querySelector('#totpManageArea');
  setupArea.style.display = 'grid';
  manageArea.style.display = 'none';

  const data = await api('/api/totp/setup');
  currentTotpSetup = data;
  document.querySelector('#totpSecretText').textContent = data.secret;
  const qrContainer = document.querySelector('#totpQrContainer');
  if (qrContainer) {
    qrContainer.innerHTML = data.qrSvg || '';
  }
});

// 初始化刷新
refresh().catch((error) => showMessage(error.message, true));

