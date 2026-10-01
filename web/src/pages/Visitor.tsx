import { useMemo, useState } from 'react';
import {
  Card, Form, Select, InputNumber, Input, Button, Switch, Tag, Timeline, Typography,
  Space, Alert, Divider, Descriptions, Modal, Empty,
} from 'antd';
import { api, fen, TICKET_TYPE, TICKET_STATUS, STORM_CATEGORY, STORM_OPTION } from '../api';
import { useAction, useApi } from '../hooks';

export default function VisitorPage() {
  const { data: routesData } = useApi<any[]>('/routes');
  const [form] = Form.useForm();
  const [bought, setBought] = useState<any>(null);
  const [queryCode, setQueryCode] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const run = useAction();

  const flatStations = useMemo(
    () => (routesData || []).flatMap(r => r.stations.map((s: any) => ({ ...s, routeName: r.name }))),
    [routesData],
  );

  const buy = async () => {
    const v = await form.validateFields();
    const t = await run(() => api.post('/tickets', v), '购票成功，已记录入园信息');
    setBought(t);
    setQueryCode(t.code);
    search(t.code);
    form.resetFields();
  };

  const search = async (code?: string) => {
    const c = (code ?? queryCode).trim();
    if (!c) return;
    try {
      setDetail(await api.get(`/tickets/code/${c}`));
    } catch (e: any) {
      setDetail({ error: e.message });
    }
  };

  const requestRefund = () => {};
  void requestRefund;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="stat-row">
        <div className="stat-card"><div className="l">单程票</div><div className="v">¥20/人</div></div>
        <div className="stat-card"><div className="l">环线票（当日不限乘次）</div><div className="v">¥35/人</div></div>
        <div className="stat-card"><div className="l">亲子票（含儿童）</div><div className="v">¥30/人</div></div>
        <div className="stat-card"><div className="l">无障碍优先票（老人/轮椅优先进站）</div><div className="v">¥20/人</div></div>
      </div>

      <Card title="① 购票（入园时间、起终点站、同行与游览路线自动记录）">
        <Form form={form} layout="vertical" initialValues={{
          type: 'single', partySize: 1, hasStroller: false, hasElder: false,
          hasChild: false, needWheelchair: false,
        }}>
          <Space wrap align="start">
            <Form.Item name="type" label="票种" rules={[{ required: true }]}>
              <Select style={{ width: 180 }} options={Object.entries(TICKET_TYPE).map(([k, v]) => ({ value: k, label: v }))} />
            </Form.Item>
            <Form.Item name="visitorName" label="游客姓名" rules={[{ required: true }]}>
              <Input placeholder="如：张敏" style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="phone" label="手机号">
              <Input placeholder="可选" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="partySize" label="同行人数" rules={[{ required: true }]}>
              <InputNumber min={1} max={20} style={{ width: 110 }} addonAfter="人" />
            </Form.Item>
          </Space>
          <Space wrap align="start">
            <Form.Item name="originStationId" label="起点站" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" style={{ width: 200 }}
                options={flatStations.map(s => ({ value: s.id, label: `${s.routeName} · ${s.name}` }))}
                placeholder="选择上车站" />
            </Form.Item>
            <Form.Item name="destStationId" label="终点站" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" style={{ width: 200 }}
                options={flatStations.map(s => ({ value: s.id, label: `${s.routeName} · ${s.name}` }))}
                placeholder="环线票可与起点相同" />
            </Form.Item>
            <Form.Item name="plannedRoute" label="预计游览路线">
              <Input placeholder="如：东门→山顶→玻璃栈道" style={{ width: 240 }} />
            </Form.Item>
          </Space>
          <Space wrap size={24}>
            <Form.Item name="hasStroller" label="携带婴儿车" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="hasElder" label="同行老人" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="hasChild" label="同行儿童" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="needWheelchair" label="需要轮椅位" valuePropName="checked"><Switch /></Form.Item>
            <Button type="primary" size="large" onClick={buy}>确认购票</Button>
          </Space>
        </Form>
        {bought && (
          <Alert
            style={{ marginTop: 8 }}
            type="success" showIcon
            message={`购票成功：${bought.code}（${TICKET_TYPE[bought.type]}），金额 ${fen(bought.price)}`}
            description="请在上车站扫码排队；无障碍/老人票自动进入优先组。可在下方输入票号查看全程动态。"
          />
        )}
      </Card>

      <Card title="② 我的车票 · 全程时间线（排队 / 检票 / 事件 / 退票围绕同一张票）"
        extra={
          <Space>
            <Input value={queryCode} onChange={e => setQueryCode(e.target.value)}
              placeholder="输入票号，如 T20260925-001" style={{ width: 220 }} onPressEnter={() => search()} />
            <Button onClick={() => search()}>查询</Button>
          </Space>
        }>
        {!detail ? (
          <Empty description="输入票号查询。种子示例：T20260925-001 ~ T20260925-006" />
        ) : detail.error ? (
          <Alert type="error" showIcon message={detail.error} />
        ) : (
          <TicketDetail detail={detail} onRefund={requestRefund} onChanged={() => search()} />
        )}
      </Card>
    </Space>
  );
}

function RefundForm({ setValues }: { setValues?: (v: any) => void }) {
  const [reason, setReason] = useState('游客个人原因申请退票');
  const [faultTag, setFaultTag] = useState('visitor');
  // 挂载时通过自定义事件把值传出
  if (setValues) setTimeout(() => setValues({ reason, faultTag }), 0);
  return (
    <Space direction="vertical" style={{ marginTop: 12, width: '100%' }}>
      <Select value={faultTag} onChange={setFaultTag} style={{ width: '100%' }}
        options={[
          { value: 'visitor', label: '游客自身原因' },
          { value: 'storm', label: '暴雨停运' },
          { value: 'vehicle', label: '车辆故障' },
          { value: 'schedule', label: '调度/排队延误' },
          { value: 'other', label: '其他' },
        ]} />
      <Input.TextArea rows={3} value={reason} onChange={e => setReason(e.target.value)} />
    </Space>
  );
}

function TicketDetail({ detail, onRefund, onChanged }: { detail: any; onRefund: () => void; onChanged: () => void }) {
  const { ticket, origin, dest, incidents, typeLabel } = detail;
  const st = TICKET_STATUS[ticket.status];
  const canRefund = ['valid', 'queued'].includes(ticket.status);

  const refund = () => {
    let values: any = { reason: '游客个人原因申请退票', faultTag: 'visitor' };
    Modal.confirm({
      title: `申请退票（${fen(ticket.price)}）`,
      width: 480,
      content: <RefundForm setValues={v => { values = v; }} />,
      onOk: async () => {
        await api.post(`/tickets/${ticket.id}/refund`, values);
        onChanged();
      },
    });
  };

  return (
    <div>
      <Descriptions column={3} bordered size="small">
        <Descriptions.Item label="票号">{ticket.code}</Descriptions.Item>
        <Descriptions.Item label="票种">{typeLabel}</Descriptions.Item>
        <Descriptions.Item label="状态"><Tag color={st.color}>{st.text}</Tag></Descriptions.Item>
        <Descriptions.Item label="游客">{ticket.visitorName}（{ticket.partySize} 人）</Descriptions.Item>
        <Descriptions.Item label="行程">{origin.name} → {dest.name}</Descriptions.Item>
        <Descriptions.Item label="方向">{ticket.expectedDirection === 'forward' ? '上行' : ticket.expectedDirection === 'backward' ? '下行' : '环线'}</Descriptions.Item>
        <Descriptions.Item label="特殊需求" span={3}>
          {[
            ticket.hasStroller && '婴儿车', ticket.hasElder && '老人',
            ticket.hasChild && '儿童', ticket.needWheelchair && '轮椅位', ticket.priority && '优先组',
          ].filter(Boolean).map(x => <Tag key={x} color="green">{x}</Tag>) || '无'}
          <Typography.Text type="secondary"> ｜路线：{ticket.plannedRoute}</Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      <Divider orientation="left" style={{ fontSize: 13 }}>事件时间线（游客 / 站务 / 司机 / 调度 / 客服 / 财务）</Divider>
      <Timeline
        items={incidents.flatMap((inc: any) => {
          const notes = inc.timeline?.length ? inc.timeline : [{ at: inc.createdAt, role: inc.raisedByRole, text: inc.title }];
          return notes.map((n: any, i: number) => ({
            color: inc.severity === 'critical' ? 'red' : inc.severity === 'warn' ? 'orange' : 'green',
            children: (
              <div key={`${inc.id}-${i}`}>
                <Typography.Text strong>{i === 0 ? inc.title : '处理记录'}</Typography.Text>
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(n.at).toLocaleString('zh-CN')} · {roleName(n.role)}</span>
                <div>{n.text}{inc.resolution ? `｜结论：${inc.resolution}` : ''}</div>
              </div>
            ),
          }));
        })}
      />
      {detail.storm && <StormChoiceCard detail={detail} onChanged={onChanged} />}
      {!detail.storm && (
        <Space>
          <Button danger disabled={!canRefund} onClick={refund}>
            {canRefund ? '申请退票' : '当前状态不可直接退票（如已上车请联系客服争议处理）'}
          </Button>
        </Space>
      )}
    </div>
  );
}

/** 暴雨停运：游客对锁定车票三选一（改乘/延期/退票），金额按票种实时展示 */
function StormChoiceCard({ detail, onChanged }: { detail: any; onChanged: () => void }) {
  const { ticket, storm } = detail;
  const [date, setDate] = useState(ticket.postponeDate || '');
  const chosen = ticket.stormOption;
  const f = storm.finance;
  const choose = (option: 'transfer' | 'postpone' | 'refund') => {
    const label = STORM_OPTION[option].text;
    Modal.confirm({
      title: `暴雨停运：确认选择「${label}」？`,
      width: 460,
      content: option === 'refund'
        ? <div>按票种<b>全额退款 {fen(f.refundAmount)}</b>，免手续费；客服核准后由财务确认出账，1-3 个工作日原路退回。</div>
        : option === 'transfer'
          ? <div>免手续费，原票款 <b>{fen(f.transfer.carriedAmount)}</b> 结转；恢复运营后优先安排接驳/首班，排队顺位保留。</div>
          : <div>免手续费，原票款 <b>{fen(f.postpone.carriedAmount)}</b> 结转至改期日；可在下方填写改期日期（默认次日）。</div>,
      onOk: async () => {
        await api.post(`/tickets/${ticket.id}/storm-option`,
          option === 'postpone' ? { option, postponeDate: date || undefined } : { option });
        onChanged();
      },
    });
  };

  return (
    <Alert
      style={{ marginTop: 12 }}
      type="error" showIcon
      message={<Space wrap>
        <b>暴雨临时停运 · 车票已锁定（{storm.categoryLabel}）</b>
        {chosen
          ? <Tag color={STORM_OPTION[chosen]?.color}>已选择：{STORM_OPTION[chosen]?.text}{ticket.postponeDate ? ` · ${ticket.postponeDate}` : ''}</Tag>
          : <Tag color="red">待选择</Tag>}
      </Space>}
      description={
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={10}>
          <Typography.Text type="secondary">{f.policy.note}</Typography.Text>
          {!chosen ? (
            <Space wrap>
              <Button type="primary" onClick={() => choose('transfer')}>
                改乘（免手续费，优先接驳/首班）
              </Button>
              <span>
                <Button onClick={() => choose('postpone')}>延期（票款结转）</Button>
                <Input style={{ width: 150, marginLeft: 8 }} type="date"
                  value={date} onChange={e => setDate(e.target.value)} placeholder="改期日期" />
              </span>
              <Button danger onClick={() => choose('refund')}>
                退票（全额 {fen(f.refundAmount)}）
              </Button>
            </Space>
          ) : chosen === 'refund' ? (
            <Typography.Text>退票单已提交：客服核准 → 财务确认出账 → 同步归档，进度见上方时间线。</Typography.Text>
          ) : chosen === 'postpone' ? (
            <Typography.Text>已登记延期至 <b>{ticket.postponeDate}</b>，票款 {fen(f.postpone.carriedAmount)} 结转，优先/轮椅资格保留，客服与财务已同步备案。</Typography.Text>
          ) : (
            <Typography.Text>已登记改乘：运营恢复后优先安排接驳/首班，原排队顺位保留，票款 {fen(f.transfer.carriedAmount)} 结转。</Typography.Text>
          )}
        </Space>
      }
    />
  );
}

function roleName(r: string) {
  return ({
    visitor: '游客', staff: '站务', driver: '司机', dispatch: '调度',
    service: '客服', service_supervisor: '客服主管', finance: '财务', system: '系统',
  } as Record<string, string>)[r] || r;
}
