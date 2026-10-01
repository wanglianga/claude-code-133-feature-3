import { useState } from 'react';
import {
  Card, Select, Button, Tag, Space, Checkbox, Alert, Table, Statistic, Row, Col,
  Modal, Input, message, Descriptions, Empty, Progress,
} from 'antd';
import { SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import { api, TRIP_STATUS } from '../api';
import { useApi } from '../hooks';

const CHECK_ITEMS = [
  { key: 'brake', label: '刹车系统' },
  { key: 'lights', label: '灯光/喇叭' },
  { key: 'doors', label: '车门与安全扶手' },
  { key: 'wheelchair_lock', label: '轮椅固定装置' },
  { key: 'extinguisher', label: '灭火器/急救包' },
  { key: 'battery', label: '动力电池与充电口' },
];

export default function DriverPage() {
  const { data: vehicles } = useApi<any[]>('/vehicles');
  const { data: driversRaw, reload: reloadDrivers } = useApi<any[]>('/drivers');
  const { data: tripsRaw, reload: reloadTrips } = useApi<any[]>('/dispatch/dashboard');
  const [driverId, setDriverId] = useState<number>(2);
  const [vehicleId, setVehicleId] = useState<number>(2);
  const [tick, setTick] = useState(0);
  const { data: board, reload: reloadBoard } = useApi<any>(`/dispatch/dashboard?t=${tick}`, [tick]);

  const drivers = driversRaw || [];
  const driver = drivers.find(d => d.id === driverId);
  const vehicle = (vehicles || []).find((v: any) => v.id === vehicleId);
  const myTrips = (board?.trips || []).filter((t: any) => t.driverName === driver?.name);
  const activeTrip = myTrips.find((t: any) => ['boarding', 'running', 'delayed'].includes(t.status))
    || myTrips.find((t: any) => t.status === 'scheduled');

  const refresh = async () => { setTick(t => t + 1); reloadDrivers(); reloadTrips(); reloadBoard(); };

  const dutyAction = async (action: string, label: string) => {
    try { await api.post(`/drivers/${driverId}/duty`, { action }); message.success(label); refresh(); }
    catch (e: any) { message.error(e.message); }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <span>司机：</span>
        <Select style={{ width: 160 }} value={driverId} onChange={setDriverId}
          options={drivers.map(d => ({ value: d.id, label: `${d.name}（${driverStatus(d.status)}）` }))} />
        <span style={{ marginLeft: 16 }}>车辆：</span>
        <Select style={{ width: 220 }} value={vehicleId} onChange={setVehicleId}
          options={(vehicles || []).map((v: any) => ({
            value: v.id,
            label: `${v.code} ${v.plate} ${v.accessible ? '♿' : ''} 电量${v.battery}%`,
          }))} />
      </Space>

      {driver && (
        <Row gutter={12}>
          <Col xs={12} md={6}><Card><Statistic title="今日工时" value={driver.workMinutesToday} suffix={`/ ${driver.maxWorkMinutes} 分`} /></Card></Col>
          <Col xs={12} md={6}><Card><Statistic title="连续驾驶" value={driver.continuousDrivingMinutes} suffix="分钟"
            valueStyle={{ color: driver.restRequired ? '#cf1322' : undefined }} /></Card></Col>
          <Col xs={12} md={6}>
            <Card>
              <div className="muted">强制休息（满 240 分钟）</div>
              <Progress percent={Math.min(100, Math.round(driver.continuousDrivingMinutes / 240 * 100))}
                status={driver.restRequired ? 'exception' : 'active'} showInfo={false} />
              {driver.restRequired
                ? <Tag color="red">必须休息 20 分钟</Tag>
                : <Tag color="green">状态正常</Tag>}
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <div className="muted">车辆电量</div>
              <Progress percent={vehicle?.battery || 0}
                status={(vehicle?.battery || 0) < 20 ? 'exception' : (vehicle?.battery || 0) < 35 ? 'active' : 'normal'} />
              <Tag color={vehicle?.status === 'breakdown' ? 'red' : vehicle?.status === 'maintenance' ? 'orange' : 'blue'}>
                {vehicleStatus(vehicle?.status)}
              </Tag>
            </Card>
          </Col>
        </Row>
      )}

      <Space wrap>
        <Button type="primary" onClick={() => dutyAction('on', '已签到上岗')}>签到上岗</Button>
        <Button onClick={() => dutyAction('rest', '开始休息登记')}>登记休息 20 分钟</Button>
        <Button onClick={() => dutyAction('finish_rest', '休息结束')}>休息结束</Button>
        <Button onClick={() => dutyAction('off', '已签退')}>签退</Button>
        <Button danger onClick={() => Modal.confirm({
          title: '上报交班异常（将影响下一班发车）',
          content: <Space direction="vertical" style={{ marginTop: 8 }}>
            <Input id="ho-min" type="number" addonBefore="延误分钟" defaultValue={20} style={{ width: 300 }} />
            <Input.TextArea id="ho-reason" rows={2} placeholder="原因，如：接班司机未到、车辆交接单未签字" />
          </Space>,
          onOk: async () => {
            const minutes = Number((document.getElementById('ho-min') as HTMLInputElement)?.value || 20);
            const reason = (document.getElementById('ho-reason') as HTMLTextAreaElement)?.value || '交班延误';
            const r = await api.post(`/drivers/${driverId}/handover-delay`, { minutes, reason });
            message.success(`已上报，受影响班次：${r.delayedTrips.join('、') || '无计划班'}`);
            refresh();
          },
        })}>交班延误上报</Button>
        <Button danger ghost icon={<WarningOutlined />} onClick={() => Modal.confirm({
          title: `上报车辆故障（${vehicle?.code}）`,
          content: <Input.TextArea id="fault-detail" rows={3} placeholder="故障现象，如：行驶中电池过热报警" />,
          onOk: async () => {
            const detail = (document.getElementById('fault-detail') as HTMLTextAreaElement)?.value || '车辆故障';
            await api.post(`/vehicles/${vehicleId}/fault`, { detail });
            message.success('故障已上报，调度与客服同步联动');
            refresh();
          },
        })}>车辆故障上报</Button>
      </Space>

      <Card title={<Space><SafetyCertificateOutlined />发车前安全检查（六项不合格则车辆转维保，不能派班）</Space>}>
        <SafetyCheck driverId={driverId} vehicleId={vehicleId} onDone={refresh} />
      </Card>

      <Card title="我的当前班次">
        {activeTrip ? <TripPanel trip={activeTrip} onEvent={refresh} /> : <Empty description="当前没有已派班次，请等待调度派班" />}
      </Card>
    </Space>
  );
}

function SafetyCheck({ driverId, vehicleId, onDone }: { driverId: number; vehicleId: number; onDone: () => void }) {
  const [items, setItems] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Checkbox.Group
        value={Object.entries(items).filter(([, v]) => v).map(([k]) => k)}
        onChange={vals => setItems(Object.fromEntries((vals as string[]).map(k => [k, true])))}
        options={CHECK_ITEMS.map(c => ({ value: c.key, label: c.label }))}
      />
      <Space wrap>
        <Input style={{ width: 360 }} placeholder="备注（可选）" value={note} onChange={e => setNote(e.target.value)} />
        <Button type="primary" onClick={async () => {
          try {
            const r = await api.post('/safety-checks', { driverId, vehicleId, items, note });
            if (r.passed) message.success('安检合格，可以派班');
            else message.error(`安检不合格：${r.note}，车辆已转维保`);
            onDone();
          } catch (e: any) { message.error(e.message); }
        }}>提交安检</Button>
        <span className="muted">全部勾选=合格；任一未勾=不合格并自动登记事件</span>
      </Space>
    </Space>
  );
}

function TripPanel({ trip, onEvent }: { trip: any; onEvent: () => void }) {
  const { data: routes } = useApi<any[]>('/routes');
  const route = (routes || []).find(r => r.stations.some((s: any) => s.name === trip.originName));
  const routeStations: any[] = route ? route.stations : [];

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {trip.status === 'delayed' && <Alert type="warning" showIcon message={`本班延误：${trip.delayReason}`} />}
      {trip.status === 'suspended' && <Alert type="error" showIcon message={`本班已停运：${trip.suspendReason}`} />}
      <Descriptions bordered size="small" column={3}>
        <Descriptions.Item label="班次">{trip.code}</Descriptions.Item>
        <Descriptions.Item label="状态"><Tag color={TRIP_STATUS[trip.status]?.color}>{TRIP_STATUS[trip.status]?.text}</Tag></Descriptions.Item>
        <Descriptions.Item label="方向">{trip.direction === 'forward' ? '上行' : trip.direction === 'backward' ? '下行' : '环线'}</Descriptions.Item>
        <Descriptions.Item label="车辆">{trip.vehicleCode} {trip.vehicleAccessible && <Tag color="cyan">♿无障碍</Tag>}</Descriptions.Item>
        <Descriptions.Item label="区间">{trip.originName} → {trip.destName}</Descriptions.Item>
        <Descriptions.Item label="上座">{trip.seatsTotal - trip.seatsLeft}/{trip.seatsTotal}（余 {trip.seatsLeft} 座）</Descriptions.Item>
      </Descriptions>

      <Space wrap>
        {trip.status === 'scheduled' && (
          <Button type="primary" onClick={async () => { await api.post(`/trips/${trip.id}/start-boarding`, {}); message.success('已开始上客'); onEvent(); }}>
            到达起点 · 开始上客
          </Button>
        )}
        <Select
          style={{ width: 260 }} placeholder="电子围栏：选择到站（自动判定满载跳站）"
          disabled={!['boarding', 'running'].includes(trip.status)}
          onChange={async (sid) => {
            const r = await api.post(`/trips/${trip.id}/arrive`, { stationId: sid });
            if (r.skipped) {
              Modal.warning({
                title: '车辆满载，已自动跳站',
                content: `本站 ${r.waitingGroups} 组游客未能上车，事件已同步调度加车，站台已自动广播`,
              });
            } else {
              message.success(`已到站：余 ${r.seatsLeft} 座，轮椅位 ${r.wheelchairLeft}，站台 ${r.waitingPeople || 0} 人等候`);
            }
            onEvent();
          }}
          options={routeStations.map((s: any) => ({ value: s.id, label: s.name }))}
        />
        <Select style={{ width: 200 }} placeholder="离站"
          disabled={!['boarding', 'running'].includes(trip.status)}
          onChange={async (sid) => { await api.post(`/trips/${trip.id}/leave`, { stationId: sid }); message.success('电子围栏：已离站'); onEvent(); }}
          options={routeStations.map((s: any) => ({ value: s.id, label: s.name }))} />
        <Button type="primary" ghost disabled={!['boarding', 'running', 'delayed'].includes(trip.status)}
          onClick={() => Modal.confirm({
            title: '确认到达终点完班？',
            content: '系统将结算工时/电量并核销车上车票；连续驾驶满 4 小时将自动要求休息',
            onOk: async () => {
              const r = await api.post(`/trips/${trip.id}/complete`, {});
              message.success(`完班完成，核销 ${r.settledTickets} 张票，当前电量 ${r.vehicle.battery}%`);
              onEvent();
            },
          })}>到达终点 · 完班</Button>
      </Space>
      {trip.skippedStations?.length > 0 && (
        <Alert type="error" showIcon message={`本班已跳过站点 ID：${trip.skippedStations.join('、')}（满载跳站，调度已收到预警）`} />
      )}
      <div className="muted">电子围栏由车辆 GPS 进出站自动触发；此处为演示用手动上报入口。</div>
    </Space>
  );
}

function driverStatus(s: string) {
  return ({ off: '休息/未上岗', on_duty: '在岗待命', driving: '驾驶中', rest: '强制休息', handover: '交班延误' } as any)[s] || s;
}
function vehicleStatus(s?: string) {
  return ({ idle: '待命', running: '在运', returning: '暴雨待收车', charging: '充电中', maintenance: '维保', breakdown: '故障' } as any)[s || ''] || s;
}
