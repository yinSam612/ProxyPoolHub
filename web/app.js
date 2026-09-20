/**
 * @file app.js
 * @description Relay Control Web 前端核心交互逻辑
 * 支持局部快速更新、后台智能感知自动轮询、扩大复选框热区、及标准 SVG Google 身份验证器 (TOTP)
 */

// DOM 元素引用
const rows = document.querySelector('#rows');
const message = document.querySelector('#message');
const addForm = document.querySelector('#addForm');
const importForm = document.querySelector('#importForm');
const editForm = document.querySelector('#editForm');
const settingsForm = document.querySelector('#settingsForm');
const totpBindForm = document.querySelector('#totpBindForm');

const addDialog = document.querySelector('#addDialog');
const importDialog = document.querySelector('#importDialog');
const editDialog = document.querySelector('#editDialog');
const settingsDialog = document.querySelector('#settingsDialog');
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
const INTERNAL_PROXY_HOST = '127.0.0.1';

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
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
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
  return new Set(
    Array.from(document.querySelectorAll('.row-select:checked'))
      .map((checkbox) => checkbox.dataset.id)
  );
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
  if (batchDeleteBtn) {
    batchDeleteBtn.style.display = count > 0 ? 'inline-flex' : 'none';
    if (batchDeleteText) {
      batchDeleteText.textContent = `批量删除 (${count})`;
    }
  }
  if (batchDeleteDivider) {
    batchDeleteDivider.style.display = count > 0 ? 'inline-block' : 'none';
  }
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
  const status = item.status === 'online'
    ? '在线'
    : item.status === 'offline'
      ? '离线'
      : item.status === 'disabled'
        ? '已禁用'
        : '检测中';

  const toggleAction = item.enabled
    ? `<button class="btn-action danger" data-action="disable" data-id="${item.id}" title="禁用此节点并释放转发">禁用</button>`
    : `<button class="btn-action success" data-action="enable" data-id="${item.id}" title="启用此节点">启用</button>`;

  const checked = isChecked && item.enabled ? ' checked' : '';
  const disabled = item.enabled ? '' : ' disabled';
  const statusTitle = escapeHtml(item.lastError || item.lastCheckedAt || status);

  return `
    <tr class="node-row ${item.enabled ? '' : 'disabled-row'}" id="row-${item.id}" data-id="${item.id}">
      <td class="col-select">
        <label class="checkbox-hitbox" title="选择节点 ${name}">
          <input class="row-select" type="checkbox" data-id="${item.id}" aria-label="选择 ${name}"${checked}${disabled}>
        </label>
      </td>
      <td class="col-node">
        <div class="node-title-cell">
          <strong class="node-name" title="${name}">${name}</strong>
          <span class="node-target font-mono">${escapeHtml(item.server)}:${item.upstreamPort}</span>
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
        <span class="port-chip font-mono">${item.listenPort}</span>
        ${renderTrafficMiniTag(item.traffic)}
      </td>
      <td class="col-status">
        <span class="status-chip ${item.status}" title="${statusTitle}">
          <i class="status-dot-sm"></i>
          <span>${status}</span>
        </span>
      </td>
      <td class="col-actions">
        <div class="actions-group">
          <button class="btn-action" data-action="copy-http" data-id="${item.id}" title="复制该节点 HTTP 代理"${disabled}>HTTP</button>
          <button class="btn-action" data-action="copy-socks" data-id="${item.id}" title="复制该节点 SOCKS5 代理"${disabled}>S5</button>
          <button class="btn-action" data-action="test" data-id="${item.id}" title="测试该节点连通性">测速</button>
          <button class="btn-action" data-action="edit" data-id="${item.id}" title="编辑节点信息">编辑</button>
          ${toggleAction}
          <button class="btn-action danger" data-action="remove" data-id="${item.id}" title="删除节点">删除</button>
        </div>
      </td>
    </tr>
  `;
}

/**
 * 局部更新单行 DOM，避免全表重新渲染造成的卡顿和焦点丢失
 * @param {object} item - 最新的节点数据
 */
function updateSingleRowDom(item) {
  const rowElement = document.querySelector(`#row-${item.id}`);
  if (!rowElement) return;

  const checkbox = rowElement.querySelector('.row-select');
  const wasChecked = checkbox ? checkbox.checked : false;
  rowElement.outerHTML = renderRowHtml(item, wasChecked);
  updateSelectionText();
}

/**
 * 智能自动轮询检查：只要有处于 testing 状态的节点，自动每 1.5 秒更新一次
 * 一旦所有节点测试完成（变为 online 或 offline），自动终止轮询，零多余网络开销
 */
function checkAutoPolling() {
  const hasTesting = items.some((it) => it.enabled && it.status === 'testing');
  if (hasTesting && !autoPollerTimer) {
    autoPollerTimer = setInterval(async () => {
      try {
        const [nextItems, status] = await Promise.all([
          api('/api/proxies'),
          api('/api/status')
        ]);
        items = nextItems;
        items.forEach(updateSingleRowDom);
        updateOverviewCards(status);

        // 如果没有处于 testing 状态的节点了，停止轮询
        const stillTesting = items.some((it) => it.enabled && it.status === 'testing');
        if (!stillTesting) {
          clearInterval(autoPollerTimer);
          autoPollerTimer = null;
        }
      } catch (e) {
        clearInterval(autoPollerTimer);
        autoPollerTimer = null;
      }
    }, 1500);
  } else if (!hasTesting && autoPollerTimer) {
    clearInterval(autoPollerTimer);
    autoPollerTimer = null;
  }
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
  const enabledItems = targetItems.filter((item) => item.enabled);
  if (!enabledItems.length) {
    throw new Error('请先选择至少一个已启用的节点');
  }
  const text = enabledItems.map((item) => endpoint(item, scheme, host)).join('\n');
  await copyText(text);
  showMessage(`已复制 ${enabledItems.length} 个 ${label} 代理节点地址`);
}

/**
 * 刷新所有数据（节点、服务状态、配置信息）
 */
async function refresh() {
  const [nextItems, status, nextSettings] = await Promise.all([
    api('/api/proxies'),
    api('/api/status'),
    api('/api/settings')
  ]);
  items = nextItems;
  settings = nextSettings;
  render(items);

  // 同步设置表单
  settingsForm.proxyUsername.value = settings.proxyUsername || '';
  settingsForm.proxyPassword.value = settings.proxyPassword || '';
  settingsForm.publicHost.value = settings.publicHost || '';
  document.querySelector('#subscriptionSocks').value = settings.subscriptions?.socks5 || '';
  document.querySelector('#subscriptionHttp').value = settings.subscriptions?.http || '';

  updateOverviewCards(status);

  // 入口地址展示
  const firstEnabled = items.find((it) => it.enabled);
  document.querySelector('#endpoint').textContent =
    `${settings.proxyUsername}@${settings.publicHost || location.hostname}:${firstEnabled ? firstEnabled.listenPort : '40000+'}`;

  updateTotpBadge();
  if (settings.authDisabled) {
    const logoutForm = document.querySelector('.logout-form');
    if (logoutForm) logoutForm.style.display = 'none';
  }
  checkAutoPolling();
  return status;
}

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
document.querySelector('#openTotpDialog').addEventListener('click', () => openTotpModal());

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
    updateSingleRowDom(updated);
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
async function waitForHealthCheck(button, spinner, label, attempt = 0) {
  try {
    const status = await refresh();
    if (!status.healthCheck?.running) {
      button.disabled = false;
      if (spinner) spinner.style.display = 'none';
      button.querySelector('#testAllText').textContent = label;
      showMessage(status.healthCheck?.lastError || '节点状态已全部刷新完成', Boolean(status.healthCheck?.lastError));
      return;
    }
    if (attempt >= 45) {
      button.disabled = false;
      if (spinner) spinner.style.display = 'none';
      button.querySelector('#testAllText').textContent = label;
      showMessage('检测仍在后台执行，您可以继续其他操作', false);
      return;
    }
    setTimeout(() => waitForHealthCheck(button, spinner, label, attempt + 1), 1000);
  } catch (error) {
    button.disabled = false;
    if (spinner) spinner.style.display = 'none';
    button.querySelector('#testAllText').textContent = label;
    showMessage(error.message, true);
  }
}

document.querySelector('#testAll').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const spinner = button.querySelector('#testAllSpinner');
  const textEl = button.querySelector('#testAllText');
  const label = textEl.textContent;

  button.disabled = true;
  if (spinner) spinner.style.display = 'inline-block';
  textEl.textContent = '检测中...';

  try {
    const result = await api('/api/proxies/test-all', { method: 'POST' });
    showMessage(result.alreadyRunning ? '检测已在后台运行中' : '已触发全量连通性检测');
    setTimeout(() => waitForHealthCheck(button, spinner, label), 600);
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
  });
  updateSelectionText();
});

rows.addEventListener('change', (event) => {
  if (event.target.classList.contains('row-select')) {
    updateSelectionText();
  }
});

function getSelectedItems() {
  const selected = selectedIds();
  return items.filter((item) => selected.has(item.id));
}

// 批量快捷复制
document.querySelector('#copyHttp').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'http').catch((error) => showMessage(error.message, true));
});
document.querySelector('#copySocks').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'socks5').catch((error) => showMessage(error.message, true));
});
document.querySelector('#copyInternalHttp').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'http', INTERNAL_PROXY_HOST, '内网 HTTP')
    .catch((error) => showMessage(error.message, true));
});
document.querySelector('#copyInternalSocks').addEventListener('click', () => {
  copyItems(getSelectedItems(), 'socks5', INTERNAL_PROXY_HOST, '内网 SOCKS5')
    .catch((error) => showMessage(error.message, true));
});

// 批量删除选中的节点（原子事务批量清除并轻量重载）
const batchDeleteBtn = document.querySelector('#batchDelete');
if (batchDeleteBtn) {
  batchDeleteBtn.addEventListener('click', async () => {
    const ids = Array.from(selectedIds());
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
      if (selectAll) selectAll.checked = false;
      api('/api/status').then(updateOverviewCards).catch(() => {});
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

  // 1. 复制
  if (action === 'copy-http' || action === 'copy-socks') {
    try {
      await copyItems([item], action === 'copy-http' ? 'http' : 'socks5');
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
    button.textContent = '测试中...';
    showMessage(`正在探测 ${item.name || item.server} 连通性...`);
    try {
      const result = await api(`/api/proxies/${id}/test`, { method: 'POST' });
      const index = items.findIndex((it) => it.id === id);
      if (index >= 0) items[index] = result;
      updateSingleRowDom(result);
      const isOnline = result.status === 'online';
      showMessage(
        isOnline ? `${result.name} 在线，延迟 ${result.latencyMs} ms` : `${result.name} 离线：${result.lastError || '连接超时'}`,
        !isOnline
      );
    } catch (error) {
      showMessage(error.message, true);
      button.disabled = false;
      button.textContent = '测速';
    }
    return;
  }

  // 5. 启用 / 禁用 / 删除（毫秒级生效，启用后自动启动静默探测）
  const originalLabel = button.textContent;
  button.disabled = true;

  try {
    const isRemove = action === 'remove';
    const result = await api(`/api/proxies/${id}${isRemove ? '' : `/${action}`}`, {
      method: isRemove ? 'DELETE' : 'POST'
    });

    if (isRemove) {
      items = items.filter((it) => it.id !== id);
      const rowEl = document.querySelector(`#row-${id}`);
      if (rowEl) rowEl.remove();
      showMessage('节点已删除');
    } else {
      const index = items.findIndex((it) => it.id === id);
      if (index >= 0) items[index] = result;
      updateSingleRowDom(result);
      showMessage(action === 'enable' ? '节点已启用，后台正在自动测速...' : '节点已禁用');
      if (action === 'enable') {
        checkAutoPolling();
      }
    }

    api('/api/status').then(updateOverviewCards).catch(() => {});
  } catch (error) {
    showMessage(error.message, true);
    button.disabled = false;
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

// ==========================================
// 连接审计日志弹窗交互 (Logs Modal)
// ==========================================
const logsDialog = document.querySelector('#logsDialog');
const openLogsBtn = document.querySelector('#openLogsBtn');
const refreshLogsBtn = document.querySelector('#refreshLogsBtn');
const logNodeFilter = document.querySelector('#logNodeFilter');
const logKeywordFilter = document.querySelector('#logKeywordFilter');
const logsTableBody = document.querySelector('#logsTableBody');
let logsAutoTimer = null;

async function fetchAndRenderLogs() {
  if (!logsDialog || !logsDialog.open) return;
  const port = logNodeFilter ? logNodeFilter.value : '';
  const keyword = logKeywordFilter ? logKeywordFilter.value.trim() : '';
  const params = new URLSearchParams();
  if (port) params.set('port', port);
  if (keyword) params.set('keyword', keyword);
  params.set('limit', '100');

  try {
    const res = await api(`/api/logs?${params.toString()}`);
    const list = res.logs || [];
    if (!list.length) {
      logsTableBody.innerHTML = '<tr><td colspan="6" class="logs-empty">暂无匹配的连接审计记录</td></tr>';
      return;
    }
    logsTableBody.innerHTML = list.map((log) => {
      const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
      const duration = log.durationMs ? `${log.durationMs}ms` : '<1ms';
      return `
        <tr>
          <td class="col-log-time">${timeStr}</td>
          <td class="col-log-port"><span class="port-chip font-mono">${log.listenPort || '-'}</span></td>
          <td class="col-log-client log-client">${escapeHtml(log.client || '-')}</td>
          <td class="col-log-target log-target" title="${escapeHtml(log.target)}">${escapeHtml(log.target || '-')}</td>
          <td class="col-log-traffic">
            <span class="traffic-tag">
              <span class="up">↑ ${log.uploadFormatted || '0 B'}</span>
              <span class="down">↓ ${log.downloadFormatted || '0 B'}</span>
            </span>
          </td>
          <td class="col-log-duration">${duration}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    logsTableBody.innerHTML = `<tr><td colspan="6" class="logs-empty" style="color:#ef4444">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function updateLogNodeSelectOptions() {
  if (!logNodeFilter) return;
  const currentVal = logNodeFilter.value;
  const options = ['<option value="">全部节点</option>'];
  for (const item of items) {
    const label = `${item.listenPort} - ${item.name || item.server}`;
    options.push(`<option value="${item.listenPort}"${currentVal === String(item.listenPort) ? ' selected' : ''}>${escapeHtml(label)}</option>`);
  }
  logNodeFilter.innerHTML = options.join('');
}

if (openLogsBtn && logsDialog) {
  openLogsBtn.addEventListener('click', () => {
    updateLogNodeSelectOptions();
    logsDialog.showModal();
    fetchAndRenderLogs();
    if (!logsAutoTimer) {
      logsAutoTimer = setInterval(fetchAndRenderLogs, 3000);
    }
  });

  logsDialog.addEventListener('close', () => {
    if (logsAutoTimer) {
      clearInterval(logsAutoTimer);
      logsAutoTimer = null;
    }
  });
}

if (refreshLogsBtn) {
  refreshLogsBtn.addEventListener('click', fetchAndRenderLogs);
}

if (logNodeFilter) {
  logNodeFilter.addEventListener('change', fetchAndRenderLogs);
}

if (logKeywordFilter) {
  let searchDebounce = null;
  logKeywordFilter.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(fetchAndRenderLogs, 250);
  });
}

// 初始化刷新
refresh().catch((error) => showMessage(error.message, true));
