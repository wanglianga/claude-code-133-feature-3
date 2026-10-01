import { useState } from 'react';
import { Card, Table, Tag, Space, Button, Statistic, Row, Col, Input, Modal, message, Empty, Tabs } from 'antd';
import { api, fen, TICKET_TYPE, REFUND_KIND } from '../api';
import { useApi } from '../hooks';

export default function FinancePage() {
  const [tick, setTick] = useState(0);
  const { data: refunds } = useApi<any[]>(`/tickets/refunds?t=${tick}`, [tick]);
  const refresh = () => setTick(t => t + 1);

  const rows = refunds || [];
  // 退票单流程：待客服审核 / 待财务确认 / 待出账 / 已出账待归档
  const toConfirm = rows.filter(r => r.kind === 'refund' && r.status === 'approved' && !r.financeConfirmedAt);
  const toPay = rows.filter(r => r.kind === 'refund' && r.status === 'approved' && r.financeConfirmedAt);
  const paid = rows.filter(r => r.kind === 'refund' && r.status === 'paid');
  const archived = rows.filter(r => r.status === 'archived');
  const changes = rows.filter(r => r.kind !== 'refund' && r.status !== 'archived');
  const pending = rows.filter(r => r.status === 'pending');

  const confirm = (r: any) => Modal.confirm({
    title: `财务确认退票 ${fen(r.amount)}`,
    content: <Space direction="vertical" style={{ marginTop: 8 }}>
      <div>退票单 {r.code}｜{r.ticket?.visitorName}｜{r.ticket?.code}（{TICKET_TYPE[r.ticket?.type]} × {r.ticket?.partySize} 人）</div>
      <Input id="fc-channel" defaultValue="原路退回" addonBefore="退款渠道" style={{ width: 380 }} />
      <Input id="fc-note" defaultValue="金额按票种核对无误" addonBefore="复核备注" style={{ width: 380 }} />
    </Space>,
    onOk: async () => {
      const channel = (document.getElementById('fc-channel') as HTMLInputElement)?.value || '原路退回';
      const note = (document.getElementById('fc-note') as HTMLInputElement)?.value || '金额核对无误';
      await api.post(`/refunds/${r.id}/finance-confirm`, { channel, note });
      message.success('退票金额已确认，可出账');
      refresh();
    },
  });

  const pay = (r: any) => Modal.confirm({
    title: `出账退款 ${fen(r.amount)}`,
    content: <Space direction="vertical" style={{ marginTop: 8 }}>
      <div>退票单 {r.code}｜渠道：{r.financePayChannel || '原路退回'}</div>
      <Input id="pay-note" defaultValue="原路退回付款账户" style={{ width: 380 }} />
    </Space>,
    onOk: async () => {
      const note = (document.getElementById('pay-note') as HTMLInputElement)?.value || '原路退回';
      await api.post(`/refunds/${r.id}/pay`, { note });
      message.success('退款已出账，可归档');
      refresh();
    },
  });

  const archive = (r: any) => Modal.confirm({
    title: `退票单同步归档（${r.code}）`,
    content: <Space direction="vertical" style={{ marginTop: 8 }}>
      <div>{r.kind === 'refund' ? `退票已出账 ${fen(r.amount)}` : `${REFUND_KIND[r.kind]?.text}票款结转 ${fen(r.carriedAmount)}`}，归档后生成归档单号。</div>
      <Input id="ar-note" defaultValue="电子凭证与支付凭证齐全" style={{ width: 380 }} />
    </Space>,
    onOk: async () => {
      const note = (document.getElementById('ar-note') as HTMLInputElement)?.value;
      const x = await api.post(`/refunds/${r.id}/archive`, { note });
      message.success(`已归档，归档号 ${x.archiveNo}`);
      refresh();
    },
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="stat-row">
        <div className="stat-card"><div className="l">待财务确认</div>
          <div className="v" style={{ color: '#d46b08' }}>{toConfirm.length} 笔 / {fen(toConfirm.reduce((a, r) => a + r.amount, 0))}</div></div>
        <div className="stat-card"><div className="l">待出账（已确认）</div>
          <div className="v" style={{ color: '#1677ff' }}>{toPay.length} 笔 / {fen(toPay.reduce((a, r) => a + r.amount, 0))}</div></div>
        <div className="stat-card"><div className="l">已出款待归档</div>
          <div className="v" style={{ color: '#389e0d' }}>{paid.length} 笔 / {fen(paid.reduce((a, r) => a + r.amount, 0))}</div></div>
        <div className="stat-card"><div className="l">客服审核中 / 已归档</div>
          <div className="v">{pending.length} 笔 / {archived.length} 笔</div></div>
      </div>

      <Tabs
        items={[
          {
            key: 'confirm', label: `① 退票确认（${toConfirm.length}）`,
            children: <Table rowKey="id" size="small" pagination={false} dataSource={toConfirm}
              locale={{ emptyText: <Empty description="暂无待确认退票（暴雨退票经客服核准后到达此处）" /> }}
              columns={refundCols(r => <Button type="primary" size="small" onClick={() => confirm(r)}>财务确认</Button>)} />,
          },
          {
            key: 'pay', label: `② 出账（${toPay.length}）`,
            children: <Table rowKey="id" size="small" pagination={false} dataSource={toPay}
              locale={{ emptyText: <Empty description="无已确认待出账单据" /> }}
              columns={refundCols(r => <Button type="primary" danger size="small" onClick={() => pay(r)}>出账退款</Button>)} />,
          },
          {
            key: 'paid', label: `③ 归档（${paid.length}）`,
            children: <Table rowKey="id" size="small" pagination={false} dataSource={paid}
              locale={{ emptyText: <Empty description="无待归档退票" /> }}
              columns={refundCols(r => <Button size="small" type="primary" ghost onClick={() => archive(r)}>同步归档</Button>)} />,
          },
          {
            key: 'changes', label: `改乘/延期结转（${changes.length}）`,
            children: <Table rowKey="id" size="small" pagination={false} dataSource={changes}
              locale={{ emptyText: <Empty description="无改乘/延期结转单" /> }}
              columns={refundCols(r => <Button size="small" onClick={() => archive(r)}>结转归档</Button>)} />,
          },
          {
            key: 'all', label: `全部单据（${rows.length}）`,
            children: <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={rows}
              columns={refundCols()} />,
          },
        ]}
      />
    </Space>
  );
}

function refundCols(action?: (r: any) => React.ReactNode) {
  return [
    { title: '单号', dataIndex: 'code', width: 150 },
    { title: '类型', dataIndex: 'kind', width: 80, render: (k: string) =>
      <Tag color={REFUND_KIND[k]?.color}>{REFUND_KIND[k]?.text}</Tag> },
    { title: '游客', key: 'v', render: (_: any, r: any) =>
      <Space direction="vertical" size={0}><b>{r.ticket?.visitorName}</b>
        <span className="muted">{r.ticket?.code} · {TICKET_TYPE[r.ticket?.type]} × {r.ticket?.partySize}人</span></Space> },
    { title: '退款/手续费', dataIndex: 'amount', width: 100, render: (n: number, r: any) =>
      r.kind === 'refund' ? <b style={{ color: '#cf1322' }}>{fen(n)}</b> : <span className="muted">¥0.00</span> },
    { title: '结转票款', dataIndex: 'carriedAmount', width: 100, render: (n: number) =>
      n ? <b>{fen(n)}</b> : '—' },
    { title: '责任', dataIndex: 'faultTag', width: 80, render: (f: string) =>
      <Tag color={f === 'storm' ? 'blue' : f === 'vehicle' ? 'red' : f === 'visitor' ? 'default' : 'orange'}>
        {({ visitor: '游客', storm: '暴雨', vehicle: '车辆', schedule: '调度', other: '其他', '': '—' } as any)[f]}
      </Tag> },
    { title: '渠道', dataIndex: 'financePayChannel', width: 90, render: (v: string) => v || '—' },
    { title: '状态', dataIndex: 'status', width: 110, render: (s: string) =>
      <Tag color={({
        pending: 'orange', approved: 'blue', rejected: 'red', escalated: 'purple', paid: 'green', archived: 'default',
      } as any)[s]}>
        {({ pending: '待审核', approved: '已核准', rejected: '已驳回', escalated: '主管中', paid: '已出账', archived: '已归档' } as any)[s]}
      </Tag> },
    { title: '归档号', dataIndex: 'archiveNo', width: 140, render: (v: string) => v || '—' },
    { title: '出账时间', dataIndex: 'paidAt', width: 160, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '—' },
    ...(action ? [{ title: '操作', key: 'op', width: 110, render: (_: any, r: any) => action(r) }] : []),
  ];
}
