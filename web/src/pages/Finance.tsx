import { useState } from 'react';
import { Card, Table, Tag, Space, Button, Statistic, Row, Col, Input, Modal, message, Empty, Tabs, Alert } from 'antd';
import { api, fen, TICKET_TYPE } from '../api';
import { useApi } from '../hooks';

export default function FinancePage() {
  const [tick, setTick] = useState(0);
  const { data: ledger } = useApi<any>(`/finance/ledger?t=${tick}`, [tick]);
  const refresh = () => setTick(t => t + 1);

  const rows: any[] = ledger?.refunds || [];
  const archives: any[] = ledger?.archives || [];
  const totals = ledger?.totals;
  const toConfirm = rows.filter(r => r.status === 'approved' && !r.financeConfirmed);
  const toPay = rows.filter(r => r.status === 'approved' && r.financeConfirmed);
  const paid = rows.filter(r => r.status === 'paid');
  const pending = rows.filter(r => r.status === 'pending');

  const confirmRefund = (r: any) => Modal.confirm({
    title: `财务确认退票 ${fen(r.amount)}`,
    content: <Space direction="vertical" style={{ marginTop: 8 }}>
      <div>退票单 {r.code}｜{r.ticket?.visitorName}｜{r.ticket?.code}</div>
      <div className="muted">票种 {TICKET_TYPE[r.ticketType || r.ticket?.type] || r.ticketType || '—'}
        ｜{r.unitPrice ? `${fen(r.unitPrice)}/人 × ${r.partySize || r.ticket?.partySize || 1}人` : ''}
        ｜合计 <b style={{ color: '#cf1322' }}>{fen(r.amount)}</b></div>
      <Input id="fc-note" defaultValue="金额与票种核对无误，确认退票" style={{ width: 380 }} />
    </Space>,
    okText: '确认无误',
    onOk: async () => {
      const note = (document.getElementById('fc-note') as HTMLInputElement)?.value || '金额核对无误，确认退票';
      await api.post(`/refunds/${r.id}/finance-confirm`, { note });
      message.success('财务已确认，可出账退款');
      refresh();
    },
  });

  const pay = (r: any) => Modal.confirm({
    title: `出账退款 ${fen(r.amount)}`,
    content: <Space direction="vertical" style={{ marginTop: 8 }}>
      <div>退票单 {r.code}｜{r.ticket?.visitorName}｜{r.ticket?.code}</div>
      <Input id="pay-note" defaultValue="原路退回付款账户" style={{ width: 380 }} />
    </Space>,
    onOk: async () => {
      const note = (document.getElementById('pay-note') as HTMLInputElement)?.value || '原路退回';
      await api.post(`/refunds/${r.id}/pay`, { note });
      message.success('退款已出账，退票单已同步归档');
      refresh();
    },
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon
        message="暴雨停运退票：客服/政策核准后金额按票种自动同步本台 → 财务确认票种与金额 → 出账退款 → 退票单自动归档（票据/财务留痕）。未确认的退票单不能出账。" />
      <div className="stat-row">
        <div className="stat-card"><div className="l">待财务确认</div>
          <div className="v" style={{ color: '#d48806' }}>{totals?.toConfirm ?? toConfirm.length} 笔 / {fen(totals?.toConfirmAmount ?? toConfirm.reduce((a, r) => a + r.amount, 0))}</div></div>
        <div className="stat-card"><div className="l">已确认待出账</div>
          <div className="v" style={{ color: '#1677ff' }}>{totals?.toPay ?? toPay.length} 笔 / {fen(totals?.toPayAmount ?? toPay.reduce((a, r) => a + r.amount, 0))}</div></div>
        <div className="stat-card"><div className="l">今日已退款出账</div>
          <div className="v" style={{ color: '#389e0d' }}>{fen(totals?.paidAmount ?? paid.reduce((a, r) => a + r.amount, 0))}</div></div>
        <div className="stat-card"><div className="l">客服审核中</div>
          <div className="v">{pending.length} 笔</div></div>
        <div className="stat-card"><div className="l">已归档退票单</div>
          <div className="v">{totals?.archivedCount ?? archives.length}</div></div>
      </div>

      <Card title="按票种核算退票金额（财务口径）" size="small">
        <Table rowKey="ticketType" size="small" pagination={false} dataSource={ledger?.byType || []}
          locale={{ emptyText: <Empty description="暂无已核准退票" /> }}
          columns={[
            { title: '票种', dataIndex: 'ticketTypeLabel' },
            { title: '单价(分/人)', dataIndex: 'unitPrice', render: (n: number) => fen(n) },
            { title: '笔数', dataIndex: 'count', width: 90 },
            { title: '应退/已核准金额', dataIndex: 'amount', render: (n: number) => <b>{fen(n)}</b> },
            { title: '其中已出账', dataIndex: 'paidAmount', render: (n: number) => <span style={{ color: '#389e0d' }}>{fen(n)}</span> },
          ]} />
      </Card>

      <Tabs
        items={[
          {
            key: 'confirm', label: `① 待确认（${toConfirm.length}）`,
            children: (
              <Table rowKey="id" size="small" pagination={false} dataSource={toConfirm}
                locale={{ emptyText: <Empty description="暂无待确认退票（金额已由客服/政策同步）" /> }}
                columns={refundCols(r => <Button type="primary" ghost size="small" onClick={() => confirmRefund(r)}>财务确认</Button>)} />
            ),
          },
          {
            key: 'pay', label: `② 待出账（${toPay.length}）`,
            children: (
              <Table rowKey="id" size="small" pagination={false} dataSource={toPay}
                locale={{ emptyText: <Empty description="暂无已确认待出账退票" /> }}
                columns={refundCols(r => <Button type="primary" size="small" onClick={() => pay(r)}>出账退款</Button>)} />
            ),
          },
          {
            key: 'all', label: '全部退票单',
            children: <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={rows}
              columns={refundCols()} />,
          },
          {
            key: 'archive', label: `📁 退票归档（${archives.length}）`,
            children: (
              <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={archives}
                locale={{ emptyText: <Empty description="出账后自动归档，暂无记录" /> }}
                columns={[
                  { title: '归档号', dataIndex: 'archiveNo', width: 160 },
                  { title: '退票单', dataIndex: 'refundCode', width: 150 },
                  { title: '车票', dataIndex: 'ticketCode', width: 150 },
                  { title: '游客', dataIndex: 'visitorName' },
                  { title: '票种', dataIndex: 'ticketType', width: 120, render: (t: string) => TICKET_TYPE[t] || t || '—' },
                  { title: '金额', dataIndex: 'amount', width: 100, render: (n: number) => <b>{fen(n)}</b> },
                  { title: '责任/方式', key: 'f', width: 130, render: (_: any, r: any) =>
                    <Space size={4}>
                      <Tag color={r.stormRelated ? 'blue' : 'default'}>{({ storm: '暴雨停运', vehicle: '车辆故障', schedule: '调度', visitor: '游客', other: '其他' } as any)[r.faultTag] || r.faultTag}</Tag>
                      {r.resolutionKind === 'reschedule' && <Tag color="purple">改期</Tag>}
                    </Space> },
                  { title: '出账时间', dataIndex: 'paidAt', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '—' },
                  { title: '归档时间', dataIndex: 'archivedAt', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '—' },
                ]} />
            ),
          },
        ]}
      />
    </Space>
  );
}

function refundCols(action?: (r: any) => React.ReactNode) {
  return [
    { title: '退票单', dataIndex: 'code', width: 150 },
    { title: '游客', key: 'v', render: (_: any, r: any) =>
      <Space direction="vertical" size={0}><b>{r.ticket?.visitorName}</b>
        <span className="muted">{r.ticket?.code} · {TICKET_TYPE[r.ticketType || r.ticket?.type]}</span></Space> },
    { title: '票种核算', key: 'calc', width: 170, render: (_: any, r: any) =>
      <Space direction="vertical" size={0}>
        <span className="muted">{r.unitPrice ? `${fen(r.unitPrice)}/人×${r.partySize || r.ticket?.partySize || 1}` : '—'}</span>
        <b>{fen(r.amount)}</b>
      </Space> },
    { title: '责任归类', dataIndex: 'faultTag', width: 100, render: (f: string) =>
      <Tag color={f === 'visitor' ? 'default' : f === 'storm' ? 'blue' : f === 'vehicle' ? 'red' : 'orange'}>
        {({ visitor: '游客', storm: '暴雨', vehicle: '车辆', schedule: '调度', other: '其他' } as any)[f]}
      </Tag> },
    { title: '金额同步', dataIndex: 'financeSynced', width: 100, render: (v: boolean, r: any) =>
      v ? <Tag color="blue">已同步{new Date(r.financeSyncedAt).toLocaleDateString('zh-CN')}</Tag> : <Tag>未同步</Tag> },
    { title: '财务确认', dataIndex: 'financeConfirmed', width: 110, render: (v: boolean, r: any) =>
      v ? <Tag color="green">已确认</Tag> : <Tag color="gold">待确认</Tag> },
    { title: '状态', dataIndex: 'status', width: 100, render: (s: string) =>
      <Tag color={({
        pending: 'orange', approved: 'blue', rejected: 'red', escalated: 'purple', paid: 'green',
      } as any)[s]}>
        {({ pending: '待审核', approved: '已核准', rejected: '已驳回', escalated: '主管中', paid: '已退款' } as any)[s]}
      </Tag> },
    { title: '归档号', dataIndex: 'archiveNo', width: 150, render: (v: string) => v || '—' },
    { title: '出账时间', dataIndex: 'paidAt', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '—' },
    ...(action ? [{ title: '操作', key: 'op', width: 120, render: (_: any, r: any) => action(r) }] : []),
  ];
}
