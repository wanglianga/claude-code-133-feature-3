import { useState } from 'react';
import {
  Card, Button, Tag, Space, Table, Select, Alert, Row, Col, Statistic, Modal,
  Input, InputNumber, message, Tabs, Badge, Popconfirm, Typography, Empty,
} from 'antd';
import {
  CloudServerOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons';
import { api, TRIP_STATUS } from '../api';
import { useApi } from '../hooks';

export default function DispatchPage() {
  const [tick, setTick] = useState(0);
  const { data: dash, loading } = useApi<any>(`/dispatch/dashboard?t=${tick}`, [tick]);
  const { data: geo } = useApi<any[]>('/geofence-events');
  const refresh = () => setTick(t => t + 1);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Button onClick={refresh}>刷新看板</Button>
        {dash?.stormActive ? (
          <Popconfirm title="确认预警解除、恢复运营？未选择游客将解锁并恢复排队顺位（退票流程中的票保持锁定）"
            onConfirm={async () => {
              const r = await api.post('/dispatch/resume', { note: '调度确认预警解除，踏勘完成' });
              message.success(`停运单 ${r.suspensionCode} 已恢复，解锁车票 ${r.unlockedTickets} 张；记得同步更新天气`);
              refresh();
            }}>
            <Button type="primary" ghost danger>恢复运营（停运单 {dash.stormActive.code}）</Button>
          </Popconfirm>
        ) : null}
      </Space>

      <Row gutter={12}>
        <Col xs={12} md={6}>
          <Card><Statistic title="在运/上客班车"
            value={dash?.trips?.filter((t: any) => ['boarding', 'running'].includes(t.status)).length || 0} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="拥堵站点"
            value={dash?.stations?.filter((s: any) => s.congestion === 'overloaded').length || 0}
            valueStyle={{ color: '#cf1322' }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="故障/维保车"
            value={dash?.vehicles?.filter((v: any) => ['breakdown', 'maintenance'].includes(v.status)).length || 0}
            valueStyle={{ color: '#d46b08' }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="待处理包车"
            value={dash?.charters?.filter((c: any) => c.status === 'pending').length || 0} /></Card>
        </Col>
      </Row>

      {dash?.suggestions?.length > 0 && (
        <Card title={<Space><ThunderboltOutlined />智能调度建议（客流 · 电量 · 工时 · 管制 · 天气）</Space>}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {dash.suggestions.map((s: any, i: number) => (
              <Alert key={i} showIcon type={s.level === 'critical' ? 'error' : 'warning'}
                icon={<WarningOutlined />} message={s.text} />
            ))}
          </Space>
        </Card>
      )}

      <Tabs
        items={[
          { key: 'board', label: '站点与车辆', children: <BoardTab dash={dash} loading={loading} geo={geo} refresh={refresh} /> },
          { key: 'dispatch', label: '派班发车', children: <DispatchTab dash={dash} refresh={refresh} /> },
          { key: 'storm', label: <Badge count={dash?.stormActive ? 1 : 0} size="small" offset={[6, -2]}>暴雨停运处置</Badge>,
            children: <StormTab refresh={refresh} /> },
          { key: 'charter', label: '团队包车', children: <CharterTab dash={dash} refresh={refresh} /> },
          { key: 'weather', label: '天气与道路管制', children: <WeatherTab dash={dash} refresh={refresh} /> },
        ]}
      />
    </Space>
  );
}

function BoardTab({ dash, loading, geo, refresh }: any) {
  const stations = dash?.stations || [];
  const vehicles = dash?.vehicles || [];
  const drivers = dash?.drivers || [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="站点客流与拥堵（热门站超站台容量自动预警并推送加车建议）">
        <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={stations}
          columns={[
            { title: '站点', key: 'n', render: (_: any, r: any) =>
              <Space>{r.name}{r.isHot && <Tag color="red">热门</Tag>}</Space> },
            { title: '线路', key: 'rn' },
            { title: '容量', dataIndex: 'platformCapacity', width: 80 },
            { title: '限流(人/时)', dataIndex: 'flowLimitPerHour', width: 100,
              render: (n: number) => n || '—' },
            {
              title: '排队/拥堵', key: 'q',
              render: (_: any, r: any) => (
                <Space>
                  <b>{r.waitingPeople}</b> 人
                  <div className="bar-wrap" style={{ width: 110 }}>
                    <div className="bar-track">
                      <div className={`bar-fill ${r.congestion === 'overloaded' ? 'red' : r.congestion === 'busy' ? 'gold' : ''}`}
                        style={{ width: `${Math.min(100, Math.round(r.waitingPeople / r.platformCapacity * 100))}%` }} />
                    </div>
                  </div>
                  {r.congestion === 'overloaded' ? <Tag color="red">过载</Tag>
                    : r.congestion === 'busy' ? <Tag color="orange">繁忙</Tag> : <Tag color="green">畅通</Tag>}
                </Space>
              ),
            },
            { title: '状态', dataIndex: 'status', render: (s: string) =>
              ({ normal: <Tag>正常</Tag>, restricted: <Tag color="orange">限流</Tag>, closed: <Tag color="red">关闭</Tag> } as any)[s] },
          ]} />
      </Card>

      <Card title="车辆实时状态（位置 · 电量 · 轮椅位 · 司机）">
        <Table rowKey="id" size="small" pagination={false} dataSource={vehicles}
          columns={[
            { title: '车号', dataIndex: 'code', width: 80 },
            { title: '车牌', dataIndex: 'plate', width: 110 },
            { title: '座位/轮椅', key: 'cap', render: (_: any, r: any) =>
              <Space>{r.capacity} 座{r.accessible && <Tag color="cyan">♿{r.wheelchairSeats}</Tag>}</Space> },
            {
              title: '电量', dataIndex: 'battery', width: 150,
              render: (n: number) => (
                <div className="bar-wrap">
                  <div className="bar-track" style={{ width: 80 }}>
                    <div className={`bar-fill ${n < 20 ? 'red' : n < 35 ? 'gold' : ''}`} style={{ width: `${n}%` }} />
                  </div>
                  <b style={{ color: n < 20 ? '#cf1322' : undefined }}>{n}%</b>
                </div>
              ),
            },
            { title: '司机', key: 'drv', render: (_: any, r: any) => r.driverName || '—' },
            { title: '当前站/班次', key: 'loc', render: (_: any, r: any) =>
              stations.find((s: any) => s.id === r.currentStationId)?.name || '—',
            },
            {
              title: '状态', dataIndex: 'status',
              render: (s: string) => <Tag color={
                s === 'breakdown' ? 'red' : s === 'maintenance' ? 'orange'
                : s === 'running' ? 'blue' : s === 'returning' ? 'red'
                : s === 'charging' ? 'gold' : 'default'}>
                {({ idle: '待命', running: '在运', returning: '暴雨待收车', charging: '充电中', maintenance: '维保', breakdown: '故障' } as any)[s]}
              </Tag>,
            },
            { title: '包车预留', dataIndex: 'reservedForCharter', render: (v: boolean) => v ? <Tag color="purple">已预留</Tag> : '—' },
            {
              title: '操作', key: 'op',
              render: (_: any, r: any) => (
                <Space>
                  {r.status !== 'charging' && r.status !== 'running' && !r.stormReturnPending &&
                    <Button size="small" onClick={async () => { await api.post(`/vehicles/${r.id}/charge`, { target: 100 }); message.success('已充电至 100%，转待命'); refresh(); }}>充满电</Button>}
                  {r.stormReturnPending && <Tag color="red">停运待收车（见「暴雨停运处置」）</Tag>}
                  {['breakdown', 'maintenance'].includes(r.status) &&
                    <Button size="small" type="primary" ghost onClick={async () => { await api.post(`/vehicles/${r.id}/repair`, {}); message.success('维修/复检通过，转待命'); refresh(); }}>修复复检</Button>}
                </Space>
              ),
            },
          ]} />
      </Card>

      <Card title="司机工时与休息">
        <Table rowKey="id" size="small" pagination={false} dataSource={drivers}
          columns={[
            { title: '姓名', dataIndex: 'name' },
            { title: '状态', dataIndex: 'status', render: (s: string) =>
              <Tag color={s === 'rest' ? 'red' : s === 'handover' ? 'orange' : s === 'driving' ? 'blue' : 'default'}>
                {({ off: '未上岗', on_duty: '待命', driving: '驾驶中', rest: '强制休息', handover: '交班延误' } as any)[s]}
              </Tag> },
            { title: '今日工时', key: 'w', render: (_: any, r: any) => `${r.workMinutesToday}/${r.maxWorkMinutes} 分` },
            { title: '连续驾驶', key: 'c', render: (_: any, r: any) =>
              <Space><span>{r.continuousDrivingMinutes} 分</span>{r.restRequired && <Tag color="red">须休息20分</Tag>}</Space> },
            { title: '交班截止', dataIndex: 'handoverDueAt', render: (v: string) => v ? new Date(v).toLocaleTimeString('zh-CN') : '—' },
          ]} />
      </Card>

      <Card title="电子围栏最近事件（车辆进出站自动记录）">
        <Table rowKey="id" size="small" pagination={{ pageSize: 6 }} dataSource={geo || []}
          columns={[
            { title: '时间', dataIndex: 'at', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '车辆', key: 'v', render: (_: any, r: any) => vehicles.find((v: any) => v.id === r.vehicleId)?.code || r.vehicleId },
            { title: '站点', key: 's', render: (_: any, r: any) => stations.find((s: any) => s.id === r.stationId)?.name || r.stationId },
            { title: '事件', dataIndex: 'kind', render: (k: string) =>
              <Badge status={k === 'enter' ? 'success' : 'default'} text={k === 'enter' ? '进入围栏（到站）' : '离开围栏（离站）'} /> },
          ]} />
      </Card>
    </Space>
  );
}

function DispatchTab({ dash, refresh }: any) {
  const stations: any[] = dash?.stations || [];
  const [vehicleId, setVehicleId] = useState<number>();
  const [driverId, setDriverId] = useState<number>();
  const [origin, setOrigin] = useState<number>();
  const [dest, setDest] = useState<number>();
  const [departNow, setDepartNow] = useState(true);

  const dispatch = async () => {
    if (!vehicleId || !driverId || !origin || !dest) return message.warning('请选择车辆、司机和起终站');
    try {
      const r = await api.post('/trips', { vehicleId, driverId, originStationId: origin, destStationId: dest, departNow });
      message.success(`派班成功：${r.trip.code}${r.warnings.length ? `；提示：${r.warnings.join('；')}` : ''}`);
      refresh();
    } catch (e: any) { message.error(e.message); }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="安排发车（系统校验：电量≥20% · 安检合格 · 工时/休息/交班 · 道路封闭 · 暴雨预警）">
        <Space wrap align="end">
          <div><div className="muted">车辆</div>
            <Select style={{ width: 240 }} placeholder="选择车辆" value={vehicleId} onChange={setVehicleId}
              options={(dash?.vehicles || []).map((v: any) => ({
                value: v.id,
                label: `${v.code} ${v.capacity}座♿${v.wheelchairSeats} 电量${v.battery}% ${vehicleStatus(v.status)}`,
              }))} /></div>
          <div><div className="muted">司机</div>
            <Select style={{ width: 200 }} placeholder="选择司机" value={driverId} onChange={setDriverId}
              options={(dash?.drivers || []).map((d: any) => ({
                value: d.id,
                label: `${d.name} 工时${d.workMinutesToday}分${d.restRequired ? '(须休息)' : ''}`,
              }))} /></div>
          <div><div className="muted">起点站</div>
            <Select showSearch style={{ width: 180 }} placeholder="起点" value={origin} onChange={setOrigin}
              options={stations.map(s => ({ value: s.id, label: s.name }))} /></div>
          <div><div className="muted">终点站</div>
            <Select showSearch style={{ width: 180 }} placeholder="终点" value={dest} onChange={setDest}
              options={stations.map(s => ({ value: s.id, label: s.name }))} /></div>
          <div><div className="muted">发车方式</div>
            <Select style={{ width: 140 }} value={departNow ? 'now' : 'plan'}
              onChange={v => setDepartNow(v === 'now')}
              options={[{ value: 'now', label: '立即开始上客' }, { value: 'plan', label: '计划班（稍后上客）' }]} /></div>
          <Button type="primary" size="large" onClick={dispatch}>确认派班</Button>
        </Space>
        <Alert style={{ marginTop: 12 }} type="info" showIcon
          message="派班规则：车辆故障/维保/充电/低电量/包车预留、司机未签到/休息中/交班延误/超时未休/达工时上限、安检未过、道路封闭、暴雨橙色及以上预警，任一不满足都将阻断并一次性返回全部原因。" />
      </Card>

      <Card title="最近班次">
        <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} dataSource={dash?.trips || []}
          columns={[
            { title: '班次', dataIndex: 'code' },
            { title: '状态', dataIndex: 'status', render: (s: string) =>
              <Tag color={TRIP_STATUS[s]?.color}>{TRIP_STATUS[s]?.text}</Tag> },
            { title: '区间', key: 'r', render: (_: any, r: any) => `${r.originName} → ${r.destName}` },
            { title: '车/司机', key: 'vd', render: (_: any, r: any) => `${r.vehicleCode} / ${r.driverName}` },
            { title: '上座', key: 's', render: (_: any, r: any) => `${r.seatsTotal - r.seatsLeft}/${r.seatsTotal}` },
            {
              title: '操作', key: 'op',
              render: (_: any, r: any) => (
                <Space direction="vertical" size={2}>
                  {r.status === 'scheduled' &&
                    <Button size="small" type="primary" onClick={async () => { await api.post(`/trips/${r.id}/start-boarding`, {}); message.success('已开始上客'); refresh(); }}>开始上客</Button>}
                  {(r.status === 'delayed') && <Typography.Text type="warning">{r.delayReason}</Typography.Text>}
                  {r.status === 'suspended' && <Typography.Text type="danger">{r.suspendReason}</Typography.Text>}
                </Space>
              ),
            },
          ]} />
      </Card>
    </Space>
  );
}

function CharterTab({ dash, refresh }: any) {
  const [assignFor, setAssignFor] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <Card title="团队包车（座位/轮椅位校验，配车后自动预留车辆）"
      extra={<Button type="primary" onClick={() => setCreateOpen(true)}>代客登记包车申请</Button>}>
      <Table rowKey="id" size="small" pagination={false} dataSource={dash?.charters || []}
        columns={[
          { title: '单号', dataIndex: 'code' },
          { title: '团队', key: 't', render: (_: any, r: any) =>
            <Space direction="vertical" size={0}><b>{r.teamName}</b><span className="muted">{r.contact} {r.phone}</span></Space> },
          { title: '人数/轮椅', key: 'p', render: (_: any, r: any) => `${r.peopleCount} 人 / ♿${r.needWheelchair}` },
          { title: '用车日', dataIndex: 'useDate' },
          { title: '路线', dataIndex: 'routePlan' },
          { title: '费用', dataIndex: 'amount', render: (n: number) => `¥${(n / 100).toFixed(2)}` },
          { title: '状态', dataIndex: 'status', render: (s: string) =>
            <Tag color={s === 'confirmed' ? 'blue' : s === 'completed' ? 'green' : s === 'cancelled' ? 'default' : 'orange'}>
              {({ pending: '待配车', confirmed: '已确认', ongoing: '用车中', completed: '已完成', cancelled: '已取消' } as any)[s]}
            </Tag> },
          { title: '配车', key: 'v', render: (_: any, r: any) =>
            r.vehicleId ? (dash?.vehicles.find((v: any) => v.id === r.vehicleId)?.code || r.vehicleId) : '—' },
          {
            title: '操作', key: 'op',
            render: (_: any, r: any) => (
              <Space>
                {r.status === 'pending' && <Button size="small" type="primary" onClick={() => setAssignFor(r)}>配车</Button>}
                {r.status === 'confirmed' &&
                  <Button size="small" onClick={async () => { await api.post(`/charters/${r.id}/status`, { status: 'ongoing' }); refresh(); }}>开始用车</Button>}
                {r.status === 'ongoing' &&
                  <Button size="small" onClick={async () => { await api.post(`/charters/${r.id}/status`, { status: 'completed' }); message.success('已完单，车辆预留解除'); refresh(); }}>完单释放</Button>}
              </Space>
            ),
          },
        ]} />
      <AssignCharterModal order={assignFor} dash={dash}
        onClose={() => setAssignFor(null)}
        onDone={() => { setAssignFor(null); refresh(); }} />
      <CreateCharterModal open={createOpen} stations={dash?.stations || []}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); refresh(); }} />
    </Card>
  );
}

function CreateCharterModal({ open, stations, onClose, onDone }: any) {
  const [f, setF] = useState<any>({
    teamName: '', contact: '', phone: '', peopleCount: 10, needWheelchair: 0,
    startStationId: stations[0]?.id, routePlan: '', useDate: '',
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  return (
    <Modal open={open} title="团队包车申请" onCancel={onClose} width={560}
      onOk={async () => {
        if (!f.teamName || !f.useDate) return message.warning('团队名称与用车日期必填');
        await api.post('/charters', f);
        message.success('包车申请已提交调度配车');
        onDone();
      }}>
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        <Space wrap>
          <Input addonBefore="团队" style={{ width: 240 }} value={f.teamName} onChange={e => set('teamName', e.target.value)} />
          <Input addonBefore="联系人" style={{ width: 240 }} value={f.contact} onChange={e => set('contact', e.target.value)} />
        </Space>
        <Space wrap>
          <Input addonBefore="电话" style={{ width: 240 }} value={f.phone} onChange={e => set('phone', e.target.value)} />
          <Input addonBefore="用车时间" style={{ width: 240 }} placeholder="2026-09-26 09:00"
            value={f.useDate} onChange={e => set('useDate', e.target.value)} />
        </Space>
        <Space wrap>
          <InputNumber addonBefore="人数" min={1} value={f.peopleCount} onChange={v => set('peopleCount', v)} />
          <InputNumber addonBefore="轮椅数" min={0} value={f.needWheelchair} onChange={v => set('needWheelchair', v)} />
          <Select style={{ width: 200 }} placeholder="上车站" value={f.startStationId} onChange={v => set('startStationId', v)}
            options={stations.map((s: any) => ({ value: s.id, label: s.name }))} />
        </Space>
        <Input.TextArea rows={2} placeholder="包车游览路线" value={f.routePlan} onChange={e => set('routePlan', e.target.value)} />
      </Space>
    </Modal>
  );
}

function AssignCharterModal({ order, dash, onClose, onDone }: any) {
  const [vehicleId, setVehicleId] = useState<number>();
  const [driverId, setDriverId] = useState<number>();
  if (!order) return null;
  return (
    <Modal open={!!order} title={`包车配车：${order.teamName}`} onCancel={onClose}
      onOk={async () => {
        try {
          await api.post(`/charters/${order.id}/assign`, { vehicleId, driverId });
          message.success('配车成功，车辆已预留');
          onDone();
        } catch (e: any) { message.error(e.message); }
      }}>
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        <div>需要 <b>{order.peopleCount}</b> 座、轮椅位 <b>{order.needWheelchair}</b> 个</div>
        <Select style={{ width: '100%' }} placeholder="选择车辆" onChange={setVehicleId}
          options={(dash?.vehicles || []).map((v: any) => ({
            value: v.id,
            label: `${v.code} ${v.capacity}座 ♿${v.wheelchairSeats} 电量${v.battery}% ${v.reservedForCharter ? '(已预留)' : ''}`,
          }))} />
        <Select style={{ width: '100%' }} placeholder="选择司机" onChange={setDriverId}
          options={(dash?.drivers || []).map((d: any) => ({ value: d.id, label: d.name }))} />
      </Space>
    </Modal>
  );
}

function WeatherTab({ dash, refresh }: any) {
  const w = dash?.weather;
  const [condition, setCondition] = useState(w?.condition || '多云');
  const [tempC, setTempC] = useState(w?.tempC || 26);
  const [warning, setWarning] = useState(w?.warning || '');
  const [level, setLevel] = useState(w?.warningLevel || 0);
  const [rain, setRain] = useState(w?.rainfallMmH || 0);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={<Space><CloudServerOutlined />天气与预警（橙色及以上自动触发停运预案入口）</Space>}>
        <Space wrap align="end">
          <div><div className="muted">天气</div><Input value={condition} onChange={e => setCondition(e.target.value)} style={{ width: 120 }} /></div>
          <div><div className="muted">温度℃</div><InputNumber value={tempC} onChange={v => setTempC(v || 0)} /></div>
          <div><div className="muted">预警</div><Input value={warning} onChange={e => setWarning(e.target.value)} style={{ width: 180 }} placeholder="如 暴雨橙色预警" /></div>
          <div><div className="muted">等级 0-4</div><InputNumber min={0} max={4} value={level} onChange={v => setLevel(v || 0)} /></div>
          <div><div className="muted">降雨 mm/h</div><InputNumber min={0} value={rain} onChange={v => setRain(v || 0)} /></div>
          <Button type="primary" onClick={async () => {
            await api.post('/weather', { condition, tempC, warning, warningLevel: level, rainfallMmH: rain });
            message.success('天气已更新，站务平板与派班规则同步生效');
            refresh();
          }}>更新天气</Button>
        </Space>
        {level >= 3 && (
          <Alert style={{ marginTop: 12 }} type="error" showIcon
            message={`${warning || '高级别气象预警'}：可执行全线临时停运`}
            action={<Popconfirm title="确认全线临时停运？在途车辆待收车、站点队列与车票锁定，游客进入改乘/延期/退票通道"
              onConfirm={async () => {
                const r = await api.post('/dispatch/storm-suspend', { reason: `${warning}，降雨量 ${rain}mm/h` });
                const a = r.affected || {};
                message.success(`停运单 ${r.code} 已生效：在途 ${a.onboardTicketIds?.length || 0}、排队 ${a.queuedTicketIds?.length || 0}、未检票 ${a.uncheckedTicketIds?.length || 0}，请到「暴雨停运处置」登记收车与充电`);
                refresh();
              }}>
              <Button danger type="primary">一键临时停运</Button>
            </Popconfirm>} />
        )}
      </Card>

      <Card title="道路管制（封闭=阻断派班；其他=提醒绕行）">
        <AddControl stations={dash?.stations || []} onDone={refresh} />
        <Table style={{ marginTop: 12 }} rowKey="id" size="small" pagination={false}
          dataSource={dash?.controls || []}
          columns={[
            { title: '路段', dataIndex: 'segment' },
            { title: '关联站点', key: 's', render: (_: any, r: any) =>
              (dash?.stations.find((s: any) => s.id === r.stationId)?.name) || '全线' },
            { title: '原因', dataIndex: 'reason' },
            { title: '状态', dataIndex: 'status', render: (s: string) =>
              s === 'active' ? <Tag color="orange">生效中</Tag> : <Tag>已解除</Tag> },
            {
              title: '操作', key: 'op',
              render: (_: any, r: any) => r.status === 'active' &&
                <Button size="small" onClick={async () => { await api.post(`/road-controls/${r.id}/lift`, {}); message.success('管制已解除'); refresh(); }}>解除</Button>,
            },
          ]} />
      </Card>
    </Space>
  );
}

function AddControl({ stations, onDone }: { stations: any[]; onDone: () => void }) {
  const [stationId, setStationId] = useState<number | undefined>();
  const [segment, setSegment] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Space wrap>
      <Select allowClear style={{ width: 180 }} placeholder="关联站点（可空=全线）" value={stationId} onChange={setStationId}
        options={stations.map(s => ({ value: s.id, label: s.name }))} />
      <Input style={{ width: 220 }} placeholder="路段，如 百花园—山顶 陡坡段" value={segment} onChange={e => setSegment(e.target.value)} />
      <Input style={{ width: 300 }} placeholder="原因（含“封闭”将阻断派班）" value={reason} onChange={e => setReason(e.target.value)} />
      <Button type="primary" onClick={async () => {
        if (!segment || !reason) return message.warning('请填写路段与原因');
        await api.post('/road-controls', { stationId, segment, reason });
        message.success('管制已发布');
        setSegment(''); setReason(''); onDone();
      }}>发布管制</Button>
    </Space>
  );
}

function vehicleStatus(s: string) {
  return ({ idle: '待命', running: '在运', returning: '待收车', charging: '充电', maintenance: '维保', breakdown: '故障' } as any)[s] || s;
}

/* ================= 暴雨临时停运处置 ================= */

function StormTab({ refresh }: { refresh: () => void }) {
  const [tick, setTick] = useState(0);
  const { data: ov } = useApi<any>(`/dispatch/storm-overview?t=${tick}`, [tick]);
  const reload = () => { setTick(t => t + 1); refresh(); };
  const [returnFor, setReturnFor] = useState<any>(null);
  const [chargeFor, setChargeFor] = useState<any>(null);

  if (!ov?.active) {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="info" showIcon message="当前没有进行中的暴雨停运单"
          description="在「天气与道路管制」中将预警等级调到 ≥3（橙色），即可一键启动全线临时停运。" />
        <Card title="历史停运单">
          <Table rowKey="id" size="small" pagination={false} dataSource={ov?.history || []}
            columns={[
              { title: '停运单', dataIndex: 'code' },
              { title: '预警', dataIndex: 'warning' },
              { title: '原因', dataIndex: 'reason' },
              { title: '开始', dataIndex: 'startedAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
              { title: '状态', dataIndex: 'status', render: (s: string) =>
                s === 'active' ? <Tag color="red">停运中</Tag> : <Tag color="green">已恢复</Tag> },
            ]} />
        </Card>
      </Space>
    );
  }

  const a = ov.active;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="error" showIcon
        message={<Space><b>停运单 {a.code} 生效中</b><Tag color="red">{a.warning}</Tag></Space>}
        description={`${a.reason}｜开始 ${new Date(a.startedAt).toLocaleString('zh-CN')}｜派班、排队、检票均已锁定`}
        action={<Popconfirm title="确认恢复运营？" onConfirm={async () => {
          const r = await api.post('/dispatch/resume', { note: '预警解除，道路踏勘完成' });
          message.success(`已恢复，解锁 ${r.unlockedTickets} 张票`); reload();
        }}><Button danger type="primary">恢复运营</Button></Popconfirm>} />

      <Row gutter={12}>
        <Col xs={12} md={6}><Card><Statistic title="在途待选择" value={ov.pending.onboard} valueStyle={{ color: '#cf1322' }} suffix="张" /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="排队待选择" value={ov.pending.queued} valueStyle={{ color: '#d46b08' }} suffix="张" /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="未检票待选择" value={ov.pending.unchecked} suffix="张" /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="待收车车辆" value={ov.pendingReturnVehicles?.length || 0}
          valueStyle={{ color: '#cf1322' }} suffix="辆" /></Card></Col>
      </Row>

      <Card title="游客选择进度（改乘 / 延期 / 退票）">
        <Space size={32}>
          <Statistic title="改乘" value={ov.optionStats.transfer} valueStyle={{ color: '#1677ff' }} />
          <Statistic title="延期" value={ov.optionStats.postpone} valueStyle={{ color: '#722ed1' }} />
          <Statistic title="退票" value={ov.optionStats.refund} valueStyle={{ color: '#cf1322' }} />
          <Statistic title="已锁定总数" value={ov.lockedCount} />
        </Space>
      </Card>

      <Card title="① 在途车辆·司机收车登记（停运后车辆就近停靠，登记后方可安排充电）">
        <Table rowKey="id" size="small" pagination={false} dataSource={ov.pendingReturnVehicles || []}
          locale={{ emptyText: <Empty description="全部在途车辆已完成收车登记" /> }}
          columns={[
            { title: '车号', dataIndex: 'code', width: 80 },
            { title: '车牌', dataIndex: 'plate', width: 110 },
            { title: '司机', key: 'd', render: (_: any, r: any) => r.driverName || '—' },
            { title: '中断班次', key: 't', render: (_: any, r: any) => r.tripCode || '—' },
            { title: '当前位置', dataIndex: 'currentStationId', render: (id: number) => `站点#${id}` },
            { title: '操作', key: 'op', render: (_: any, r: any) =>
              <Button size="small" type="primary" danger onClick={() => setReturnFor(r)}>登记司机收车</Button> },
          ]} />
      </Card>

      <Card title="收车记录">
        <Table rowKey="id" size="small" pagination={false} dataSource={ov.returnLogs || []}
          columns={[
            { title: '时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleTimeString('zh-CN') },
            { title: '车辆', dataIndex: 'vehicleCode' },
            { title: '司机', dataIndex: 'driverName' },
            { title: '班次', dataIndex: 'tripCode' },
            { title: '停靠点', dataIndex: 'returnStation' },
            { title: '收车时在车人数', dataIndex: 'onboardPeople' },
            { title: '备注', dataIndex: 'note' },
          ]} />
      </Card>

      <Card title="② 车辆充电安排（收车登记后安排，完成后电量自动补满转待命）"
        extra={<Button type="primary" disabled={!ov.returnLogs?.length}
          onClick={() => setChargeFor(ov)}>新增充电安排</Button>}>
        <Table rowKey="id" size="small" pagination={false} dataSource={ov.chargePlans || []}
          columns={[
            { title: '车辆', key: 'v', render: (_: any, r: any) =>
              <Space>{r.vehicleCode}<Tag>{r.vehicleStatus === 'charging' ? '充电中' : r.vehicleStatus}</Tag></Space> },
            { title: '桩位', dataIndex: 'slot', render: (v: string) => v || '—' },
            { title: '当前电量', dataIndex: 'battery', render: (n: number) => `${n}%` },
            { title: '目标电量', dataIndex: 'targetBattery', render: (n: number) => `${n}%` },
            { title: '状态', dataIndex: 'status', render: (s: string) =>
              <Tag color={s === 'done' ? 'green' : s === 'charging' ? 'blue' : 'orange'}>
                {({ planned: '待充电', charging: '充电中', done: '已完成' } as any)[s]}</Tag> },
            { title: '操作', key: 'op', render: (_: any, r: any) => (
              <Space>
                {r.status === 'planned' && <Button size="small" onClick={async () => {
                  await api.post(`/dispatch/storm-charge-plan/${r.id}/status`, { status: 'charging' }); reload();
                }}>开始充电</Button>}
                {r.status === 'charging' && <Button size="small" type="primary" onClick={async () => {
                  await api.post(`/dispatch/storm-charge-plan/${r.id}/status`, { status: 'done' });
                  message.success(`${r.vehicleCode} 充电完成，已转待命`); reload();
                }}>充电完成</Button>}
              </Space>
            ) },
          ]} />
      </Card>

      <Card title="受影响班次">
        <Table rowKey="id" size="small" pagination={false} dataSource={ov.suspendedTrips || []}
          columns={[
            { title: '班次', dataIndex: 'code' },
            { title: '停运原因', dataIndex: 'suspendReason' },
            { title: '收车', dataIndex: 'stormReturned', render: (v: boolean) =>
              v ? <Tag color="green">已收车</Tag> : <Tag color="red">待收车</Tag> },
          ]} />
      </Card>

      <Card title="客服统一口径（同步客服端，各渠道按此答复，不做超口径承诺）">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{a.serviceScript}</Typography.Paragraph>
      </Card>

      <ReturnModal suspensionId={a.id} vehicle={returnFor} onClose={() => setReturnFor(null)}
        onDone={() => { setReturnFor(null); reload(); }} />
      <ChargePlanModal suspensionId={a.id} ov={chargeFor} onClose={() => setChargeFor(null)}
        onDone={() => { setChargeFor(null); reload(); }} />
    </Space>
  );
}

function ReturnModal({ suspensionId, vehicle, onClose, onDone }: any) {
  const [station, setStation] = useState('就近避雨停靠点');
  const [people, setPeople] = useState(2);
  const [note, setNote] = useState('');
  return (
    <Modal open={!!vehicle} title={`登记司机收车：${vehicle?.code}（${vehicle?.tripCode || ''}）`}
      onCancel={onClose}
      onOk={async () => {
        if (!vehicle?.driverId) return message.error('未找到该班次司机');
        await api.post('/dispatch/storm-return', {
          suspensionId, tripId: vehicle?.tripId, vehicleId: vehicle?.id,
          driverId: vehicle.driverId, returnStation: station, onboardPeople: people, note,
        });
        message.success('收车已登记，可安排充电'); onDone();
      }}>
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        <div className="muted">司机：{vehicle?.driverName || '—'}</div>
        <Input addonBefore="停靠点" value={station} onChange={e => setStation(e.target.value)} />
        <InputNumber addonBefore="收车时在车人数" min={0} value={people} onChange={v => setPeople(v || 0)} />
        <Input.TextArea rows={2} placeholder="备注：如游客接驳疏散情况、车辆外观检查"
          value={note} onChange={e => setNote(e.target.value)} />
      </Space>
    </Modal>
  );
}

function ChargePlanModal({ suspensionId, ov, onClose, onDone }: any) {
  const [vehicleId, setVehicleId] = useState<number>();
  const [target, setTarget] = useState(100);
  const [slot, setSlot] = useState('');
  const [note, setNote] = useState('');
  const returnedIds = new Set((ov?.returnLogs || []).map((l: any) => l.vehicleId));
  const options = (ov?.returnLogs || [])
    .map((l: any) => ({ value: l.vehicleId, label: `${l.vehicleCode}（${l.driverName} 收车于 ${l.returnStation}）` }));
  void returnedIds;
  return (
    <Modal open={!!ov} title="安排停运后车辆充电" onCancel={onClose}
      onOk={async () => {
        if (!vehicleId) return message.warning('请选择车辆');
        try {
          await api.post('/dispatch/storm-charge-plan', {
            suspensionId, vehicleId, targetBattery: target, slot, note,
          });
          message.success('充电安排已登记'); onDone();
        } catch (e: any) { message.error(e.message); }
      }}>
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        <Select style={{ width: '100%' }} placeholder="选择已收车车辆" value={vehicleId} onChange={setVehicleId}
          options={options} />
        <InputNumber addonBefore="目标电量%" min={20} max={100} value={target} onChange={v => setTarget(v || 100)} />
        <Input addonBefore="充电桩位" placeholder="如 A区3号桩" value={slot} onChange={e => setSlot(e.target.value)} />
        <Input.TextArea rows={2} placeholder="备注" value={note} onChange={e => setNote(e.target.value)} />
      </Space>
    </Modal>
  );
}
