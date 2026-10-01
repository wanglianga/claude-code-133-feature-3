import { useState } from 'react';
import {
  Card, Table, Tag, Space, Button, Tabs, Badge, Modal, Input, message, Typography, Alert, Empty,
} from 'antd';
import { api, fen, TICKET_TYPE, STORM_PHASE, STORM_AFFECTED_STATUS } from '../api';
import { useApi } from '../hooks';

const FAULT_LABEL: Record<string, string> = {
  visitor: '游客自身', storm: '暴雨停运', vehicle: '车辆故障', schedule: '调度延误', other: '其他',
};
const REFUND_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: '待审核', color: 'orange' },
  approved: { text: '已核准待付款', color: 'blue' },
  rejected: { text: '已驳回', color: 'red' },
  escalated: { text: '主管处理中', color: 'purple' },
  paid: { text: '已退款', color: 'green' },
};

export default function ServicePage() {
  const [tick, setTick] = useState(0);
  const { data: wb } = useApi<any>(`/service/workbench?t=${tick}`, [tick]);
  const { data: incidents } = useApi<any[]>(`/incidents?t=${tick}`, [tick]);
  const refresh = () => setTick(t => t + 1);

  const pending = wb?.pendingRefunds || [];
  const escalated = wb?.escalatedRefunds || [];

  const refundCols = (mode: 'agent' | 'supervisor') => [
    { title: '退票单', dataIndex: 'code', width: 150 },
    {
      title: '车票/游客', key: 't',
      render: (_: any, r: any) => (
        <Space direction="vertical" size={0}>
          <b>{r.ticket?.visitorName}（{r.ticket?.partySize}人）</b>
          <span className="muted">{r.ticket?.code} · {TICKET_TYPE[r.ticket?.type]}</span>
        </Space>
      ),
    },
    { title: '金额', dataIndex: 'amount', width: 100, render: (n: number) => <b>{fen(n)}</b> },
    { title: '原因', key: 'r', render: (_: any, r: any) =>
      <Space direction="vertical" size={0}><span>{r.reason}</span><Tag>{FAULT_LABEL[r.faultTag]}</Tag></Space> },
    { title: '状态', dataIndex: 'status', width: 110,
      render: (s: string) => <Tag color={REFUND_STATUS[s]?.color}>{REFUND_STATUS[s]?.text}</Tag> },
    {
      title: mode === 'agent' ? '客服处理' : '客服主管裁决', key: 'op', width: 320,
      render: (_: any, r: any) => mode === 'agent' ? (
        <Space wrap>
          <Button size="small" type="primary" onClick={() => decideModal(r, true, refresh)}>同意退款</Button>
          <Button size="small" danger onClick={() => decideModal(r, false, refresh)}>驳回</Button>
          <Button size="small" ghost onClick={() => escalateModal(r, refresh)}>争议升级主管</Button>
        </Space>
      ) : (
        <Space wrap>
          <Button size="small" type="primary" onClick={() => supervisorModal(r, true, refresh)}>裁决同意</Button>
          <Button size="small" danger onClick={() => supervisorModal(r, false, refresh)}>维持驳回</Button>
        </Space>
      ),
    },
  ];

  const openIncidents = (incidents || []).filter(i => ['open', 'processing', 'escalated'].includes(i.status));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon
        message="客服工作台：游客退票、优先乘车争议、误乘与跳站投诉在此受理；责任不清的退票争议一键升级客服主管；同一张票/同一班车的全部沟通都沉淀在事件时间线。" />
      <div className="stat-row">
        <div className="stat-card"><div className="l">待审退票</div><div className="v" style={{ color: '#d46b08' }}>{wb?.counts?.pendingRefund ?? 0}</div></div>
        <div className="stat-card"><div className="l">主管处理中</div><div className="v" style={{ color: '#722ed1' }}>{wb?.counts?.escalated ?? 0}</div></div>
        <div className="stat-card"><div className="l">待处理事件</div><div className="v">{wb?.counts?.openIncident ?? 0}</div></div>
        <div className="stat-card"><div className="l">停运待游客选择</div><div className="v" style={{ color: '#cf1322' }}>{wb?.counts?.stormPendingChoice ?? 0}</div></div>
        <div className="stat-card"><div className="l">停运退票待财务</div><div className="v" style={{ color: '#d48806' }}>{wb?.counts?.stormRefundPending ?? 0}</div></div>
      </div>

      <Tabs
        items={[
          {
            key: 'storm',
            label: '🌧 暴雨停运口径',
            children: <StormServicePanel storm={wb?.storm} refresh={refresh} />,
          },
          {
            key: 'pending',
            label: <Badge count={pending.length} size="small">退票审核</Badge>,
            children: <Table rowKey="id" size="small" pagination={false} dataSource={pending}
              columns={refundCols('agent')} locale={{ emptyText: <Empty description="没有待审退票" /> }} />,
          },
          {
            key: 'escalated',
            label: <Badge count={escalated.length} size="small">主管争议裁决</Badge>,
            children: <Table rowKey="id" size="small" pagination={false} dataSource={escalated}
              columns={refundCols('supervisor')} locale={{ emptyText: <Empty description="没有升级争议" /> }} />,
          },
          {
            key: 'incidents',
            label: <Badge count={openIncidents.length} size="small">事件协同（票/班车）</Badge>,
            children: <IncidentTable incidents={openIncidents} refresh={refresh} />,
          },
        ]}
      />
    </Space>
  );
}

/** 客服端：暴雨停运统一口径 + 处置进度（只读跟踪，退票由财务确认） */
function StormServicePanel({ storm, refresh }: { storm: any; refresh: () => void }) {
  if (!storm || !storm.suspension) {
    return <Alert type="info" showIcon message="当前没有进行中的暴雨停运" description="停运发起后，客服在此查看统一答复口径，并跟踪每张受影响票的改乘/延期/退票进度。" />;
  }
  const sus = storm.suspension;
  const c = storm.counts;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type={sus.status === 'active' ? 'error' : 'success'} showIcon
        message={<Space wrap><b>{sus.code}</b><Tag color={sus.status === 'active' ? 'red' : 'green'}>{sus.status === 'active' ? '停运中' : '已恢复'}</Tag>{sus.warningLabel}</Space>}
        description={sus.serviceScript} />

      <div className="stat-row">
        <div className="stat-card"><div className="l">在途车辆票</div><div className="v">{c.onboard}</div></div>
        <div className="stat-card"><div className="l">站点排队票</div><div className="v">{c.queuing}</div></div>
        <div className="stat-card"><div className="l">未检票订单</div><div className="v">{c.unticketed}</div></div>
        <div className="stat-card"><div className="l">改乘 / 延期</div><div className="v" style={{ color: '#1677ff' }}>{c.transferred} / {c.postponed}</div></div>
        <div className="stat-card"><div className="l">退票待财务 / 已退</div><div className="v">{c.refundPending} / {c.refunded}</div></div>
      </div>

      <Card title="按票种退票/改期金额口径（答复游客用）" size="small">
        <Table rowKey="ticketType" size="small" pagination={false} dataSource={storm.byType}
          columns={[
            { title: '票种', dataIndex: 'ticketTypeLabel' },
            { title: '单价', dataIndex: 'unitPrice', render: (n: number) => fen(n) },
            { title: '受影响', dataIndex: 'count' },
            { title: '退票金额', dataIndex: 'refundAmount', render: (n: number) => <b style={{ color: '#cf1322' }}>{fen(n)}</b> },
            { title: '改期挂账', dataIndex: 'rescheduleAmount', render: (n: number) => fen(n) },
          ]} />
      </Card>

      <Card title="受影响票处置进度（与游客答复保持同一口径）" size="small"
        extra={<Button size="small" onClick={refresh}>刷新进度</Button>}>
        <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={storm.affected}
          columns={[
            { title: '游客', key: 'v', render: (_: any, r: any) =>
              <Space direction="vertical" size={0}><b>{r.visitorName}（{r.partySize}人）</b><span className="muted">{r.ticketTypeLabel}</span></Space> },
            { title: '分类', dataIndex: 'phase', render: (p: string) => <Tag color={STORM_PHASE[p]?.color}>{STORM_PHASE[p]?.text}</Tag> },
            { title: '选择', dataIndex: 'option', render: (o: string, r: any) =>
              o && o !== 'keep' ? <Tag>{({ transfer: '改乘', postpone: '延期', refund: '退票' } as any)[o]}{r.postponedDate ? ` ${r.postponedDate}` : ''}</Tag> : <Tag>待选择</Tag> },
            { title: '退票金额', dataIndex: 'refundAmount', render: (n: number) => n ? fen(n) : '—' },
            { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={STORM_AFFECTED_STATUS[s]?.color}>{STORM_AFFECTED_STATUS[s]?.text}</Tag> },
            { title: '退票单/财务', key: 'rf', render: (_: any, r: any) =>
              r.refund ? <Space direction="vertical" size={0}>
                <span className="muted">{r.refund.code}</span>
                <Tag color={r.refund.status === 'paid' ? 'green' : r.refund.financeConfirmed ? 'blue' : 'gold'}>
                  {r.refund.status === 'paid' ? '财务已出账归档' : r.refund.financeConfirmed ? '财务已确认待出账' : '待财务确认'}
                </Tag>
              </Space> : '—' },
          ]} />
      </Card>
    </Space>
  );
}

function IncidentTable({ incidents, refresh }: { incidents: any[]; refresh: () => void }) {
  return (
    <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} dataSource={incidents}
      columns={[
        { title: '编号', dataIndex: 'code', width: 140 },
        { title: '类型', dataIndex: 'type', width: 110, render: (t: string) => <Tag>{incidentType(t)}</Tag> },
        {
          title: '标题/详情', key: 'title',
          render: (_: any, r: any) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{r.title}</Typography.Text>
              <span className="muted">{r.detail}</span>
            </Space>
          ),
        },
        { title: '级别', dataIndex: 'severity', width: 80, render: (s: string) =>
          <Tag color={s === 'critical' ? 'red' : s === 'warn' ? 'orange' : 'default'}>
            {s === 'critical' ? '紧急' : s === 'warn' ? '预警' : '信息'}</Tag> },
        { title: '当前归属', dataIndex: 'ownerRole', width: 100, render: (r: string) => roleName(r) },
        { title: '状态', dataIndex: 'status', width: 90, render: (s: string) =>
          <Tag color={s === 'escalated' ? 'purple' : s === 'open' ? 'orange' : 'blue'}>
            {s === 'open' ? '待处理' : s === 'processing' ? '处理中' : '已升级'}</Tag> },
        {
          title: '操作', key: 'op', width: 220,
          render: (_: any, r: any) => (
            <Space wrap>
              <Button size="small" onClick={async () => { await api.post(`/incidents/${r.id}/take`, { role: 'service' }); message.success('已领取'); refresh(); }}>领取</Button>
              <Button size="small" type="primary" ghost
                onClick={() => Modal.confirm({
                  title: '处理结果',
                  content: <Input.TextArea id="resolve-text" rows={3} placeholder="记录处置结论，将同步给游客/站务/调度/财务" />,
                  onOk: async () => {
                    const text = (document.getElementById('resolve-text') as HTMLTextAreaElement)?.value || '已处理';
                    await api.post(`/incidents/${r.id}/resolve`, { role: 'service', resolution: text });
                    message.success('事件已闭环'); refresh();
                  },
                })}>闭环处理</Button>
              <Button size="small" type="link" onClick={() => timelineModal(r)}>时间线</Button>
            </Space>
          ),
        },
      ]} />
  );
}

function decideModal(r: any, approve: boolean, refresh: () => void) {
  Modal.confirm({
    title: approve ? `同意退款 ${fen(r.amount)}` : `驳回退票（${r.ticket?.visitorName}）`,
    width: 500,
    content: <Input.TextArea id="decide-note" rows={3}
      defaultValue={approve ? defaultApproveNote(r) : '经核实不满足退改规则，驳回'} />,
    onOk: async () => {
      const note = (document.getElementById('decide-note') as HTMLTextAreaElement)?.value || '';
      if (approve) await api.post(`/refunds/${r.id}/approve`, { note });
      else await api.post(`/refunds/${r.id}/reject`, { note });
      message.success(approve ? '已核准，流转财务付款' : '已驳回');
      refresh();
    },
  });
}

function escalateModal(r: any, refresh: () => void) {
  Modal.confirm({
    title: '升级客服主管裁决',
    width: 500,
    content: <Input.TextArea id="esc-note" rows={3}
      defaultValue="游客与站务对优先规则/责任界定存在争议，申请主管裁决" />,
    onOk: async () => {
      const note = (document.getElementById('esc-note') as HTMLTextAreaElement)?.value || '';
      await api.post(`/refunds/${r.id}/escalate`, { note });
      message.success('已升级，主管可在“主管争议裁决”页处理');
      refresh();
    },
  });
}

function supervisorModal(r: any, approve: boolean, refresh: () => void) {
  Modal.confirm({
    title: `客服主管裁决：${approve ? '同意退款' : '维持驳回'}（${r.ticket?.visitorName}）`,
    width: 500,
    content: <Input.TextArea id="sup-note" rows={3}
      defaultValue={approve ? '主管裁决：同意全额退款，站点加强优先乘车规则说明' : '主管裁决：维持驳回'} />,
    onOk: async () => {
      const note = (document.getElementById('sup-note') as HTMLTextAreaElement)?.value || '';
      await api.post(`/refunds/${r.id}/supervisor-decide`, { approve, note });
      message.success('裁决已生效'); refresh();
    },
  });
}

function timelineModal(r: any) {
  Modal.info({
    title: `${r.code} 事件时间线`,
    width: 600,
    content: (
      <div className="timeline-box">
        {(r.timeline || []).map((t: any, i: number) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <b>{new Date(t.at).toLocaleString('zh-CN')} · {roleName(t.role)}</b>
            <div>{t.text}</div>
          </div>
        ))}
      </div>
    ),
  });
}

function defaultApproveNote(r: any) {
  if (r.faultTag === 'storm') return '暴雨停运无责退票，全额';
  if (r.faultTag === 'vehicle') return '车辆故障无责退票，全额';
  if (r.faultTag === 'schedule') return '调度延误，协商全额退款';
  return '核实后同意退款';
}

function incidentType(t: string) {
  return ({
    long_queue: '排队过长', skip_station: '满载跳站', wrong_direction: '误乘反方向',
    priority_dispute: '优先争议', vehicle_fault: '车辆故障', handover_delay: '交班延误',
    storm_suspension: '暴雨停运', refund_request: '退票诉求', charter: '包车', info: '信息',
  } as Record<string, string>)[t] || t;
}
function roleName(r: string) {
  return ({
    visitor: '游客', staff: '站务', driver: '司机', dispatch: '调度',
    service: '客服', service_supervisor: '客服主管', finance: '财务', system: '系统',
  } as Record<string, string>)[r] || r;
}
