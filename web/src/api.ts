const BASE = '/api';

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? options.body : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join('；') : data?.message || `请求失败 ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  get: <T = any>(path: string) => request<T>(path),
  post: <T = any>(path: string, body?: any) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body || {}) }),
  patch: <T = any>(path: string, body?: any) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body || {}) }),
};

export const fen = (n: number) => `¥${(n / 100).toFixed(2)}`;

export const waitText = (sec: number) => {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分 ${sec % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
};

export const TICKET_TYPE: Record<string, string> = {
  single: '单程票',
  loop: '环线票',
  parent_child: '亲子票',
  accessible_priority: '无障碍优先票',
};

export const TICKET_STATUS: Record<string, { text: string; color: string }> = {
  valid: { text: '待乘车', color: 'blue' },
  queued: { text: '排队中', color: 'gold' },
  boarded: { text: '已检票', color: 'cyan' },
  used: { text: '已完成', color: 'green' },
  refund_pending: { text: '退票审核中', color: 'orange' },
  refunded: { text: '已退款', color: 'default' },
  refund_rejected: { text: '退票驳回', color: 'red' },
  cancelled: { text: '已取消', color: 'default' },
};

export const TRIP_STATUS: Record<string, { text: string; color: string }> = {
  scheduled: { text: '计划中', color: 'default' },
  boarding: { text: '上客中', color: 'blue' },
  running: { text: '行驶中', color: 'processing' },
  completed: { text: '已完班', color: 'green' },
  cancelled: { text: '已取消', color: 'default' },
  suspended: { text: '已停运', color: 'red' },
  delayed: { text: '延误', color: 'orange' },
};

export const STORM_PHASE: Record<string, { text: string; color: string }> = {
  onboard: { text: '在途车辆', color: 'red' },
  queuing: { text: '站点排队', color: 'orange' },
  unticketed: { text: '未检票订单', color: 'gold' },
};

export const STORM_OPTION: Record<string, { text: string; color: string }> = {
  keep: { text: '待选择', color: 'default' },
  transfer: { text: '改乘', color: 'blue' },
  postpone: { text: '延期', color: 'purple' },
  refund: { text: '退票', color: 'cyan' },
};

export const STORM_AFFECTED_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: '待游客选择', color: 'orange' },
  transferred: { text: '已改乘', color: 'blue' },
  postponed: { text: '已延期', color: 'purple' },
  refund_pending: { text: '待财务出账', color: 'gold' },
  refunded: { text: '已退款归档', color: 'green' },
  closed: { text: '已关闭（恢复有效）', color: 'default' },
};
