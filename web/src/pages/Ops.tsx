import { Card, Space, Table, Tag, Row, Col, Statistic, Divider } from 'antd';
import { api, fen, waitText } from '../api';
import { useApi } from '../hooks';

export default function OpsPage() {
  const { data: r, loading } = useApi<any>('/ops/report');
  if (!r) return <Card loading={loading} />;
  const k = r.kpi;

  const maxWait = Math.max(1, ...r.stationWait.map((s: any) => s.avgWaitSeconds));
  const maxComplaint = Math.max(1, ...r.complaintReasons.map((c: any) => c.count));
  const maxRefund = Math.max(1, ...r.refundByFault.map((f: any) => f.approvedAmount));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="stat-row">
        <div className="stat-card"><div className="l">售票数</div><div className="v">{k.ticketsSold}</div></div>
        <div className="stat-card"><div className="l">已完成核销</div><div className="v">{k.ticketsUsed}</div></div>
        <div className="stat-card"><div className="l">完班班次</div><div className="v">{k.tripsCompleted}</div></div>
        <div className="stat-card"><div className="l">平均上座率</div><div className="v">{k.avgLoadFactor}%</div></div>
        <div className="stat-card"><div className="l">平均等待</div><div className="v">{waitText(k.avgWaitSeconds)}</div></div>
        <div className="stat-card"><div className="l">退票率</div><div className="v" style={{ color: k.refundRate > 10 ? '#cf1322' : undefined }}>{k.refundRate}%</div></div>
        <div className="stat-card"><div className="l">退票成本(已付)</div><div className="v" style={{ color: '#cf1322' }}>{fen(k.refundPaidTotal)}</div></div>
        <div className="stat-card"><div className="l">已归档单据</div><div className="v">{k.archivedCount ?? 0}</div></div>
        <div className="stat-card"><div className="l">未闭环事件</div><div className="v">{k.openIncidents}</div></div>
      </div>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title="站点等待时长（热门站治理依据）">
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              {r.stationWait.map((s: any) => (
                <div key={s.stationId}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <span>{s.stationName}{s.isHot && <Tag color="red" style={{ marginLeft: 6 }}>热门</Tag>}</span>
                    <span className="muted">平均 {waitText(s.avgWaitSeconds)} · 最长 {waitText(s.maxWaitSeconds)}
                      {s.skippedGroups > 0 && <Tag color="red" style={{ marginLeft: 8 }}>被跳 {s.skippedGroups} 组</Tag>}
                    </span>
                  </Space>
                  <div className="bar-track" style={{ marginTop: 4 }}>
                    <div className={`bar-fill ${s.avgWaitSeconds > 300 ? 'red' : s.avgWaitSeconds > 120 ? 'gold' : ''}`}
                      style={{ width: `${(s.avgWaitSeconds / maxWait) * 100}%` }} />
                  </div>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="车辆利用率（上座率）">
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              {r.vehicleUtil.map((v: any) => (
                <div key={v.vehicleId}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <span>{v.vehicleCode}{v.accessible && <Tag color="cyan" style={{ marginLeft: 6 }}>♿无障碍</Tag>}
                      {v.breakdownTrips > 0 && <Tag color="red" style={{ marginLeft: 6 }}>停运班 {v.breakdownTrips}</Tag>}</span>
                    <span className="muted">完班 {v.completedTrips} 次 · 里程 {v.mileageKm}km · 电量 {v.battery}%</span>
                  </Space>
                  <div className="bar-wrap" style={{ marginTop: 4 }}>
                    <div className="bar-track">
                      <div className={`bar-fill ${v.loadFactor < 30 ? 'gold' : ''}`} style={{ width: `${v.loadFactor}%` }} />
                    </div>
                    <b className="bar-num">{v.loadFactor}%</b>
                  </div>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title="投诉/异常原因分布">
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              {r.complaintReasons.length === 0 && <span className="muted">暂无投诉</span>}
              {r.complaintReasons.map((c: any) => (
                <div key={c.type}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <span>{c.label}</span>
                    <span className="muted">{c.count} 起{c.critical > 0 && <Tag color="red" style={{ marginLeft: 8 }}>紧急 {c.critical}</Tag>}
                      <Tag style={{ marginLeft: 8 }}>已闭环 {c.resolved}</Tag></span>
                  </Space>
                  <div className="bar-track" style={{ marginTop: 4 }}>
                    <div className={`bar-fill ${c.critical > 0 ? 'red' : 'gold'}`} style={{ width: `${(c.count / maxComplaint) * 100}%` }} />
                  </div>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="退票成本（按责任归类）">
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              {r.refundByFault.length === 0 && <span className="muted">暂无退票</span>}
              {r.refundByFault.map((f: any) => (
                <div key={f.fault}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <span>{f.label}</span>
                    <span className="muted">{f.count} 笔 · 已付 {fen(f.paidAmount)} · 核准 {fen(f.approvedAmount)}</span>
                  </Space>
                  <div className="bar-track" style={{ marginTop: 4 }}>
                    <div className="bar-fill red" style={{ width: `${(f.approvedAmount / maxRefund) * 100}%` }} />
                  </div>
                </div>
              ))}
            </Space>
            <Divider style={{ margin: '12px 0' }} />
            <Statistic title="票款收入（未退款票面）" value={fen(k.ticketRevenue)} />
          </Card>
        </Col>
      </Row>

      <Card title="站点明细">
        <Table rowKey="stationId" size="small" pagination={false} dataSource={r.stationWait}
          columns={[
            { title: '站点', dataIndex: 'stationName' },
            { title: '热门', dataIndex: 'isHot', render: (v: boolean) => v ? <Tag color="red">热门</Tag> : '—' },
            { title: '排队组数', dataIndex: 'queueGroups' },
            { title: '已上车组', dataIndex: 'boardedGroups' },
            { title: '平均等待', dataIndex: 'avgWaitSeconds', render: (v: number) => waitText(v) },
            { title: '最长等待', dataIndex: 'maxWaitSeconds', render: (v: number) => waitText(v) },
            { title: '满载被跳', dataIndex: 'skippedGroups', render: (v: number) => v ? <Tag color="red">{v} 组</Tag> : 0 },
          ]} />
      </Card>
    </Space>
  );
}
