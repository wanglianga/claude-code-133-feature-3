export function now(): string {
  return new Date().toISOString();
}

export function todayCode(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

let seqMap: Record<string, number> = {};
export function seqCode(prefix: string): string {
  const key = `${prefix}-${todayCode()}`;
  seqMap[key] = (seqMap[key] || 0) + 1;
  return `${prefix}${todayCode()}-${String(seqMap[key]).padStart(3, '0')}`;
}

export const YUAN = 100;

export const TICKET_UNIT_PRICE: Record<string, number> = {
  single: 20 * YUAN,
  loop: 35 * YUAN,
  parent_child: 30 * YUAN,
  accessible_priority: 20 * YUAN,
};

export const TICKET_TYPE_LABEL: Record<string, string> = {
  single: '单程票',
  loop: '环线票',
  parent_child: '亲子票',
  accessible_priority: '无障碍优先票',
};

export function ticketPrice(type: string, partySize: number): number {
  return (TICKET_UNIT_PRICE[type] || 20 * YUAN) * partySize;
}

export function fen(n: number): string {
  return (n / 100).toFixed(2);
}

export function waitSeconds(a: string, b: string = now()): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}

/* ---------------- 暴雨停运财务政策（按票种生成改期/退票金额） ---------------- */

export interface StormPolicy {
  /** 退票退款比例（暴雨为景区责任，各票种全额） */
  refundRatio: number;
  /** 改乘手续费（分/人），停运无责一律 0 */
  transferFeePerHead: number;
  /** 延期/改期手续费（分/人），停运无责一律 0 */
  postponeFeePerHead: number;
  note: string;
}

export const STORM_POLICY: Record<string, StormPolicy> = {
  single: {
    refundRatio: 1, transferFeePerHead: 0, postponeFeePerHead: 0,
    note: '单程票：停运无责全额退款；改乘接驳/延期免手续费，原票款保留',
  },
  loop: {
    refundRatio: 1, transferFeePerHead: 0, postponeFeePerHead: 0,
    note: '环线票：停运无责全额退款；改乘/延期免手续费，当日不限乘次资格顺延',
  },
  parent_child: {
    refundRatio: 1, transferFeePerHead: 0, postponeFeePerHead: 0,
    note: '亲子票：停运无责全额退款（按同行人数）；改乘/延期免手续费，儿童权益同步顺延',
  },
  accessible_priority: {
    refundRatio: 1, transferFeePerHead: 0, postponeFeePerHead: 0,
    note: '无障碍优先票：停运无责全额退款；改乘/延期免手续费并保留优先组与轮椅位资格',
  },
};

/** 暴雨退票金额：按票种单价 × 同行人数 × 退款比例 */
export function stormRefundAmount(type: string, partySize: number): number {
  const base = ticketPrice(type, partySize);
  const ratio = STORM_POLICY[type]?.refundRatio ?? 1;
  return Math.round(base * ratio);
}

/** 暴雨改乘/延期金额：手续费（停运为 0）+ 结转保留的原票款 */
export function stormChangeAmounts(type: string, partySize: number, option: 'transfer' | 'postpone') {
  const policy = STORM_POLICY[type] || STORM_POLICY.single;
  const feePerHead = option === 'transfer' ? policy.transferFeePerHead : policy.postponeFeePerHead;
  return {
    fee: feePerHead * partySize,           // 向游客收取的手续费
    carriedAmount: ticketPrice(type, partySize), // 不退款、结转到改乘/改期后的票款
  };
}

/** 默认延期日期：次日 */
export function nextDayDate(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
