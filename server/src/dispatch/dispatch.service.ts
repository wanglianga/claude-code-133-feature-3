import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  Vehicle, Driver, Trip, Ticket, QueueEntry, Station, RouteLine, Weather,
  RoadControl, GeofenceEvent, SafetyCheck, CharterOrder, Incident, Refund,
  Broadcast, StormSuspension, StormReturnLog, StormChargePlan,
} from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { now, seqCode, waitSeconds } from '../common';

const MIN_BATTERY = 20;       // 低于 20% 禁止发车
const WARN_BATTERY = 35;      // 低于 35% 提醒
const MAX_CONTINUOUS_MIN = 240; // 连续驾驶 4 小时必须休息
const REST_MINUTES = 20;
const STORM_LEVEL = 3;        // 橙色及以上预警禁止发车/临时停运

@Injectable()
export class DispatchService {
  constructor(
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(RouteLine) private readonly routes: Repository<RouteLine>,
    @InjectRepository(Weather) private readonly weatherRepo: Repository<Weather>,
    @InjectRepository(RoadControl) private readonly controls: Repository<RoadControl>,
    @InjectRepository(GeofenceEvent) private readonly geofence: Repository<GeofenceEvent>,
    @InjectRepository(SafetyCheck) private readonly checks: Repository<SafetyCheck>,
    @InjectRepository(CharterOrder) private readonly charters: Repository<CharterOrder>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
    @InjectRepository(StormSuspension) private readonly suspensions: Repository<StormSuspension>,
    @InjectRepository(StormReturnLog) private readonly returnLogs: Repository<StormReturnLog>,
    @InjectRepository(StormChargePlan) private readonly chargePlans: Repository<StormChargePlan>,
    private readonly incidentSvc: IncidentsService,
  ) {}

  /* ================= 调度看板 ================= */

  async dashboard() {
    const [vehicles, drivers, trips, stations, weatherRow, controls, charters] = await Promise.all([
      this.vehicles.find({ order: { id: 'ASC' } }),
      this.drivers.find({ order: { id: 'ASC' } }),
      this.trips.find({ order: { id: 'DESC' }, take: 30 }),
      this.stations.find({ order: { routeId: 'ASC', seq: 'ASC' } }),
      this.weatherRepo.find({ order: { id: 'DESC' }, take: 1 }),
      this.controls.find({ where: { status: 'active' } }),
      this.charters.find({ order: { id: 'DESC' }, take: 10 }),
    ]);
    const waiting = await this.queue.find({ where: { status: In(['waiting', 'called']) } });

    const stationCards = stations.map(s => {
      const people = waiting.filter(q => q.stationId === s.id).reduce((a, q) => a + q.partySize, 0);
      return {
        ...s,
        waitingPeople: people,
        congestion: people >= s.platformCapacity * 1.2 ? 'overloaded'
          : people >= s.platformCapacity * 0.6 ? 'busy' : 'smooth',
      };
    });

    const vehicleCards = vehicles.map(v => {
      const driver = drivers.find(d => d.currentVehicleId === v.id) || null;
      const trip = trips.find(t => t.vehicleId === v.id && ['boarding', 'running', 'scheduled'].includes(t.status)) || null;
      return { ...v, driverName: driver?.name || null, driver: driver || null, activeTrip: trip };
    });

    const suggestions = this.buildSuggestions(vehicleCards, drivers, stationCards, weatherRow[0], controls);

    return {
      weather: weatherRow[0] || null,
      controls,
      stations: stationCards,
      vehicles: vehicleCards,
      drivers,
      trips: await this.decorateTrips(trips),
      charters,
      suggestions,
      stormActive: await this.suspensions.findOne({ where: { status: 'active' } }),
    };
  }

  private buildSuggestions(vehicles: any[], drivers: Driver[], stations: any[], weather: Weather | undefined, controls: RoadControl[]) {
    const out: { level: 'warn' | 'critical'; text: string }[] = [];
    for (const s of stations) {
      if (s.congestion === 'overloaded') {
        out.push({ level: 'critical', text: `${s.name} 排队 ${s.waitingPeople} 人超站台容量，建议增发${s.routeName ? '' : ''}区间车` });
      }
    }
    for (const v of vehicles) {
      if (v.battery <= MIN_BATTERY && v.status !== 'charging') {
        out.push({ level: 'critical', text: `${v.code} 电量 ${v.battery}%，立即回库充电，禁止再派班` });
      } else if (v.battery <= WARN_BATTERY && v.status === 'running') {
        out.push({ level: 'warn', text: `${v.code} 电量 ${v.battery}%，本班结束后安排充电` });
      }
      if (v.status === 'breakdown') out.push({ level: 'critical', text: `${v.code} 故障停驶，需安排备车顶班` });
    }
    for (const d of drivers) {
      if (d.restRequired) out.push({ level: 'critical', text: `司机 ${d.name} 连续驾驶超时，须休息 ${REST_MINUTES} 分钟` });
      if (d.workMinutesToday >= d.maxWorkMinutes - 30) {
        out.push({ level: 'warn', text: `司机 ${d.name} 今日工时 ${d.workMinutesToday} 分钟接近上限 ${d.maxWorkMinutes}` });
      }
      if (d.status === 'handover') {
        out.push({ level: 'critical', text: `司机 ${d.name} 交班延误中，其下一班已推迟，禁止再派班` });
      } else if (d.handoverDueAt && new Date(d.handoverDueAt).getTime() < Date.now() && d.status !== 'off') {
        out.push({ level: 'critical', text: `司机 ${d.name} 已超过交班时间，禁止再派班` });
      }
    }
    if (weather && weather.warningLevel >= STORM_LEVEL) {
      out.push({ level: 'critical', text: `${weather.warning}，全线暂停发车，在班车就近折返/停运` });
    }
    for (const c of controls) {
      const closed = c.reason.includes('封闭') && !c.reason.includes('未封闭');
      out.push({ level: closed ? 'critical' : 'warn', text: `道路管制：${c.segment}（${c.reason}），派班需绕行或改区间` });
    }
    return out;
  }

  private async decorateTrips(trips: Trip[]) {
    const vehicles = await this.vehicles.find();
    const drivers = await this.drivers.find();
    const stations = await this.stations.find();
    const vMap = new Map(vehicles.map(v => [v.id, v]));
    const dMap = new Map(drivers.map(d => [d.id, d]));
    const sMap = new Map(stations.map(s => [s.id, s]));
    return trips.map(t => ({
      ...t,
      vehicleCode: vMap.get(t.vehicleId)?.code || '',
      vehicleAccessible: vMap.get(t.vehicleId)?.accessible || false,
      driverName: dMap.get(t.driverId)?.name || '',
      originName: sMap.get(t.originStationId)?.name || '',
      destName: sMap.get(t.destStationId)?.name || '',
      seatsLeft: (vMap.get(t.vehicleId)?.capacity || t.seatsTotal) - t.seatsSold,
    }));
  }

  /* ================= 车辆 / 司机 ================= */

  async listVehicles() {
    const vehicles = await this.vehicles.find({ order: { id: 'ASC' } });
    const drivers = await this.drivers.find();
    const trips = await this.trips.find({ where: { status: In(['boarding', 'running', 'scheduled']) } });
    return vehicles.map(v => ({
      ...v,
      driver: drivers.find(d => d.currentVehicleId === v.id) || null,
      activeTrip: trips.find(t => t.vehicleId === v.id) || null,
    }));
  }

  async listDrivers() {
    return this.drivers.find({ order: { id: 'ASC' } });
  }

  async driverDuty(driverId: number, action: 'on' | 'off' | 'rest' | 'finish_rest') {
    const d = await this.drivers.findOne({ where: { id: driverId } });
    if (!d) throw new NotFoundException('司机不存在');
    if (action === 'on') {
      d.status = 'on_duty';
      d.shiftStart = d.shiftStart || now();
    } else if (action === 'off') {
      d.status = 'off';
      d.currentVehicleId = null;
    } else if (action === 'rest') {
      if (!d.restRequired && d.continuousDrivingMinutes < MAX_CONTINUOUS_MIN) {
        throw new BadRequestException('尚未达到强制休息时长，无需登记休息');
      }
      d.status = 'rest';
      await this.incidentSvc.create({
        type: 'info', severity: 'info',
        title: `司机 ${d.name} 开始休息`,
        detail: `连续驾驶 ${d.continuousDrivingMinutes} 分钟，按规定休息 ${REST_MINUTES} 分钟`,
        vehicleId: d.currentVehicleId || undefined,
        raisedByRole: 'driver', ownerRole: 'dispatch', status: 'closed',
      });
    } else if (action === 'finish_rest') {
      d.status = 'on_duty';
      d.restRequired = false;
      d.continuousDrivingMinutes = 0;
    }
    return this.drivers.save(d);
  }

  /** 司机交班异常：影响下一班发车 */
  async handoverDelay(driverId: number, body: { minutes: number; reason: string }) {
    const d = await this.drivers.findOne({ where: { id: driverId } });
    if (!d) throw new NotFoundException('司机不存在');
    d.status = 'handover';
    d.handoverDueAt = new Date(Date.now() + body.minutes * 60000).toISOString();
    await this.drivers.save(d);
    // 挂起该司机已计划的下一班
    const nextTrips = await this.trips.find({
      where: { driverId, status: 'scheduled' },
      order: { id: 'ASC' },
    });
    for (const t of nextTrips) {
      t.status = 'delayed';
      t.delayReason = `司机交班延误约 ${body.minutes} 分钟：${body.reason}`;
      await this.trips.save(t);
      await this.incidentSvc.create({
        type: 'handover_delay', severity: 'warn',
        title: `司机交班延误，${t.code} 推迟发车`,
        detail: `${d.name} 交班延误 ${body.minutes} 分钟（${body.reason}），已通知站务与候乘游客`,
        tripId: t.id, vehicleId: t.vehicleId,
        raisedByRole: 'driver', ownerRole: 'dispatch',
        firstNote: `司机上报：${body.reason}`,
      });
    }
    return { ok: true, delayedTrips: nextTrips.map(t => t.code) };
  }

  async charge(vehicleId: number, target = 100) {
    const v = await this.vehicles.findOne({ where: { id: vehicleId } });
    if (!v) throw new NotFoundException('车辆不存在');
    if (v.status === 'running') throw new BadRequestException('在运车辆不能直接充电');
    if (v.stormReturnPending) {
      throw new BadRequestException('暴雨停运待收车车辆，请先在“停运处置”中登记司机收车，再安排充电');
    }
    v.status = 'charging';
    v.battery = Math.min(100, target);
    if (v.battery >= 100) v.status = 'idle';
    return this.vehicles.save(v);
  }

  /* ================= 司机安全检查 ================= */

  async safetyCheck(body: {
    vehicleId: number; driverId: number;
    items: Record<string, boolean>; note?: string;
  }) {
    const [v, d] = await Promise.all([
      this.vehicles.findOne({ where: { id: body.vehicleId } }),
      this.drivers.findOne({ where: { id: body.driverId } }),
    ]);
    if (!v || !d) throw new NotFoundException('车辆或司机不存在');
    const items = body.items || {};
    const required = ['brake', 'lights', 'doors', 'wheelchair_lock', 'extinguisher', 'battery'];
    const missing = required.filter(k => !items[k]);
    const passed = missing.length === 0;
    const check = await this.checks.save(this.checks.create({
      vehicleId: v.id, driverId: d.id,
      items: { ...required.reduce((a, k) => ({ ...a, [k]: !!items[k] }), {}), ...items },
      passed,
      note: body.note || (passed ? '全部合格' : `不合格项：${missing.map(m => this.checkLabel(m)).join('、')}`),
      checkedAt: now(),
    }));
    if (!passed) {
      v.status = 'maintenance';
      await this.vehicles.save(v);
      await this.incidentSvc.create({
        type: 'vehicle_fault', severity: 'critical',
        title: `${v.code} 发车前安检不合格，暂停派班`,
        detail: `不合格项：${missing.map(m => this.checkLabel(m)).join('、')}；司机 ${d.name} 已上报维保`,
        vehicleId: v.id, raisedByRole: 'driver', ownerRole: 'dispatch',
        firstNote: body.note || '安检不合格，车辆转维保',
      });
    }
    return check;
  }

  async latestChecks() {
    const rows = await this.checks.find({ order: { id: 'DESC' }, take: 20 });
    return rows;
  }

  private checkLabel(k: string) {
    return ({
      brake: '刹车', lights: '灯光', doors: '车门',
      wheelchair_lock: '轮椅固定装置', extinguisher: '灭火器', battery: '电池',
    } as Record<string, string>)[k] || k;
  }

  private async todayPassedCheck(vehicleId: number, driverId: number): Promise<SafetyCheck | null> {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const rows = await this.checks.find({
      where: { vehicleId, driverId }, order: { id: 'DESC' }, take: 1,
    });
    const c = rows[0];
    if (c && c.passed && new Date(c.checkedAt) >= start) return c;
    return null;
  }

  /* ================= 派班发车 ================= */

  /** 派班：综合电量、司机工时/休息/交班、安检、道路管制、暴雨、站点状态 */
  async dispatchTrip(body: {
    vehicleId: number; driverId: number;
    originStationId: number; destStationId: number;
    direction?: 'forward' | 'backward' | 'loop';
    departNow?: boolean;
  }) {
    const warnings: string[] = [];
    const [v, d, origin, dest] = await Promise.all([
      this.vehicles.findOne({ where: { id: body.vehicleId } }),
      this.drivers.findOne({ where: { id: body.driverId } }),
      this.stations.findOne({ where: { id: body.originStationId } }),
      this.stations.findOne({ where: { id: body.destStationId } }),
    ]);
    if (!v) throw new NotFoundException('车辆不存在');
    if (!d) throw new NotFoundException('司机不存在');
    if (!origin || !dest) throw new NotFoundException('起终站不存在');

    // --- 阻断性校验（聚合一次返回，便于调度看清全部原因）---
    const blockers: string[] = [];
    if (['maintenance', 'breakdown'].includes(v.status)) blockers.push(`车辆 ${v.code} 状态为${v.status === 'breakdown' ? '故障' : '维保'}，不可派班`);
    if (v.status === 'charging') blockers.push(`车辆 ${v.code} 正在充电`);
    if (v.reservedForCharter) blockers.push(`车辆 ${v.code} 已被包车预留`);
    if (v.battery < MIN_BATTERY) blockers.push(`车辆电量 ${v.battery}% 低于 ${MIN_BATTERY}%`);

    if (d.status === 'off') blockers.push(`司机 ${d.name} 未签到上岗`);
    if (d.status === 'rest') blockers.push(`司机 ${d.name} 正在强制休息`);
    if (d.status === 'handover') blockers.push(`司机 ${d.name} 处于交班延误中`);
    if (d.restRequired) blockers.push(`司机 ${d.name} 连续驾驶超时未休息`);
    if (d.workMinutesToday >= d.maxWorkMinutes) blockers.push(`司机今日工时已达上限 ${d.maxWorkMinutes} 分钟`);
    if (d.handoverDueAt && new Date(d.handoverDueAt).getTime() < Date.now() && d.status !== 'off') {
      blockers.push(`司机 ${d.name} 已超过交班截止时间`);
    }
    if (origin.status === 'closed' || dest.status === 'closed') blockers.push('起/终站已关闭');
    if (origin.routeId !== dest.routeId) blockers.push('起终站不在同一线路');

    const check = await this.todayPassedCheck(v.id, d.id);
    if (!check) blockers.push('司机今日对该车的发车前安全检查未完成或未通过');

    const isClosed = (reason: string) => reason.includes('封闭') && !reason.includes('未封闭');
    const activeControls = await this.controls.find({ where: { status: 'active' } });
    const blockingControl = activeControls.find(c =>
      isClosed(c.reason) && (!c.stationId || c.stationId === origin.id || c.stationId === dest.id));
    if (blockingControl) blockers.push(`道路管制：${blockingControl.segment} 道路封闭`);

    const [weatherRow] = await this.weatherRepo.find({ order: { id: 'DESC' }, take: 1 });
    if (weatherRow && weatherRow.warningLevel >= STORM_LEVEL) {
      blockers.push(`${weatherRow.warning}，按预案暂停发车`);
    }
    const activeSuspension = await this.suspensions.findOne({ where: { status: 'active' } });
    if (activeSuspension) {
      blockers.push(`暴雨停运单 ${activeSuspension.code} 生效中，全线锁定，恢复运营后方可派班`);
    }
    if (blockers.length) throw new BadRequestException(blockers.join('；'));

    if (v.battery <= WARN_BATTERY) warnings.push(`电量仅 ${v.battery}%，本班结束后必须回库充电`);
    if (d.workMinutesToday >= d.maxWorkMinutes - 60) warnings.push('司机工时接近上限，本班为收班车');
    const softControl = activeControls.find(c => c !== blockingControl);
    if (softControl) warnings.push(`途经${softControl.segment}有管制（${softControl.reason}），请减速绕行`);

    const direction = body.direction
      || (origin.seq < dest.seq ? 'forward' : origin.seq > dest.seq ? 'backward' : 'loop');

    const trip = await this.trips.save(this.trips.create({
      code: seqCode('TR'),
      routeId: origin.routeId,
      vehicleId: v.id,
      driverId: d.id,
      direction,
      status: body.departNow === false ? 'scheduled' : 'boarding',
      originStationId: origin.id,
      destStationId: dest.id,
      departAt: body.departNow === false ? null : now(),
      seatsTotal: v.capacity,
      seatsSold: 0,
      wheelchairHeld: 0,
      boardedCount: 0,
      skippedStations: [],
    }));

    v.status = body.departNow === false ? 'idle' : 'running';
    v.currentTripId = trip.id;
    v.currentStationId = origin.id;
    await this.vehicles.save(v);
    d.status = 'driving';
    d.currentVehicleId = v.id;
    await this.drivers.save(d);

    await this.geofence.save(this.geofence.create({
      vehicleId: v.id, stationId: origin.id, kind: 'enter',
      lat: origin.lat, lng: origin.lng, at: now(),
    }));

    return { trip, warnings };
  }

  /** 计划班改为开始上客 */
  async startBoarding(tripId: number) {
    const t = await this.trips.findOne({ where: { id: tripId } });
    if (!t) throw new NotFoundException('班次不存在');
    if (t.status !== 'scheduled') throw new BadRequestException(`班次状态 ${t.status} 不可开始上客`);
    t.status = 'boarding';
    t.departAt = now();
    await this.trips.save(t);
    const v = await this.vehicles.findOne({ where: { id: t.vehicleId } });
    if (v) { v.status = 'running'; v.currentTripId = t.id; await this.vehicles.save(v); }
    const d = await this.drivers.findOne({ where: { id: t.driverId } });
    if (d) { d.status = 'driving'; await this.drivers.save(d); }
    return t;
  }

  /** 车辆到站（电子围栏进入）：自动判定满载跳站 */
  async arriveStation(tripId: number, stationId: number) {
    const trip = await this.trips.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('班次不存在');
    const [vehicle, station] = await Promise.all([
      this.vehicles.findOne({ where: { id: trip.vehicleId } }),
      this.stations.findOne({ where: { id: stationId } }),
    ]);
    if (!station) throw new NotFoundException('站点不存在');
    if (!['boarding', 'running'].includes(trip.status)) {
      throw new BadRequestException(`班次 ${trip.status}，不再接受到站`);
    }

    vehicle.lat = station.lat;
    vehicle.lng = station.lng;
    vehicle.currentStationId = station.id;
    await this.vehicles.save(vehicle);
    await this.geofence.save(this.geofence.create({
      vehicleId: vehicle.id, stationId, kind: 'enter',
      lat: station.lat, lng: station.lng, at: now(),
    }));

    const seatsLeft = vehicle.capacity - trip.seatsSold;
    const waiting = await this.queue.find({
      where: { stationId, status: In(['waiting', 'called']) },
    });
    const wheelchairLeft = vehicle.wheelchairSeats - trip.wheelchairHeld;
    const boardable = waiting.filter(e => {
      if (seatsLeft <= 0) return false;
      return true;
    });

    // 满载跳站
    if (seatsLeft <= 0 && waiting.length > 0) {
      const skipped = trip.skippedStations || [];
      if (!skipped.includes(stationId)) skipped.push(stationId);
      trip.skippedStations = skipped;
      await this.trips.save(trip);
      for (const e of waiting) e.status = 'skipped';
      await this.queue.save(waiting);
      const people = waiting.reduce((a, e) => a + e.partySize, 0);
      await this.incidentSvc.create({
        type: 'skip_station', severity: 'critical',
        title: `满载跳站：${trip.code} 越过 ${station.name}`,
        detail: `车上 ${trip.seatsSold}/${vehicle.capacity} 人已满载，站台 ${people} 人未能上车，已通知调度加车并向站台广播`,
        tripId: trip.id, stationId, vehicleId: vehicle.id,
        raisedByRole: 'system', ownerRole: 'dispatch',
        firstNote: `电子围栏识别到站，座位余量 0，自动登记跳站；${waiting.length} 组游客转回排队`,
      });
      return { arrived: true, skipped: true, seatsLeft: 0, waitingGroups: waiting.length };
    }

    // 非满载：把之前跳站状态仍在本站的游客转回等候
    const skippedHere = await this.queue.find({ where: { stationId, status: 'skipped' } });
    for (const e of skippedHere) { e.status = 'waiting'; await this.queue.save(e); }

    if (trip.status === 'boarding' || waiting.length > 0) trip.status = 'boarding';
    await this.trips.save(trip);
    return {
      arrived: true, skipped: false, seatsLeft,
      wheelchairLeft,
      waitingGroups: waiting.length,
      waitingPeople: waiting.reduce((a, e) => a + e.partySize, 0),
    };
  }

  /** 离站（电子围栏离开） */
  async leaveStation(tripId: number, stationId: number) {
    const trip = await this.trips.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('班次不存在');
    const v = await this.vehicles.findOne({ where: { id: trip.vehicleId } });
    const s = await this.stations.findOne({ where: { id: stationId } });
    await this.geofence.save(this.geofence.create({
      vehicleId: v.id, stationId, kind: 'leave', lat: s?.lat || 0, lng: s?.lng || 0, at: now(),
    }));
    if (trip.status === 'boarding') {
      trip.status = 'running';
      await this.trips.save(trip);
    }
    return { ok: true };
  }

  /** 完班：结算工时、电量，车上车票置为已使用 */
  async completeTrip(tripId: number) {
    const trip = await this.trips.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('班次不存在');
    if (!['boarding', 'running', 'delayed'].includes(trip.status)) {
      throw new BadRequestException(`班次 ${trip.status}，不能完班`);
    }
    const [v, d] = await Promise.all([
      this.vehicles.findOne({ where: { id: trip.vehicleId } }),
      this.drivers.findOne({ where: { id: trip.driverId } }),
    ]);

    const minutes = trip.departAt ? Math.max(5, Math.round(waitSeconds(trip.departAt) / 60)) : 20;
    const cappedMinutes = Math.min(minutes, 45); // 演示用单班最多计 45 分钟
    trip.status = 'completed';
    trip.arriveAt = now();
    await this.trips.save(trip);

    v.status = 'idle';
    v.currentTripId = null;
    v.currentStationId = trip.destStationId;
    v.lat = (await this.stations.findOne({ where: { id: trip.destStationId } }))?.lat || v.lat;
    v.battery = Math.max(0, v.battery - 6 - Math.round(cappedMinutes / 10));
    v.mileageKm += 8;
    await this.vehicles.save(v);

    d.workMinutesToday += cappedMinutes;
    d.continuousDrivingMinutes += cappedMinutes;
    d.currentVehicleId = null;
    d.status = 'on_duty';
    if (d.continuousDrivingMinutes >= MAX_CONTINUOUS_MIN) {
      d.restRequired = true;
      d.status = 'rest';
    }
    await this.drivers.save(d);

    // 车票核销
    const onboard = await this.tickets.find({ where: { tripId, status: 'boarded' } });
    for (const t of onboard) { t.status = 'used'; await this.tickets.save(t); }
    const boardedEntries = await this.queue.find({ where: { tripId, status: 'boarded' } });
    // queue 已在检票时记录 waitSeconds

    return { trip, vehicle: v, driver: d, settledTickets: onboard.length };
  }

  /* ================= 车辆故障（在运） ================= */

  async reportFault(vehicleId: number, detail: string) {
    const v = await this.vehicles.findOne({ where: { id: vehicleId } });
    if (!v) throw new NotFoundException('车辆不存在');
    v.status = 'breakdown';
    await this.vehicles.save(v);

    const trip = await this.trips.findOne({
      where: { vehicleId, status: In(['boarding', 'running']) },
    });
    if (trip) {
      trip.status = 'suspended';
      trip.suspendReason = `车辆故障：${detail}`;
      await this.trips.save(trip);
      await this.incidentSvc.create({
        type: 'vehicle_fault', severity: 'critical',
        title: `${v.code} 运营中故障，${trip.code} 停运救援`,
        detail: `${detail}；车上 ${trip.seatsSold} 人需换乘接驳，未上车游客转回排队，游客可申请无责退票`,
        tripId: trip.id, vehicleId: v.id,
        raisedByRole: 'driver', ownerRole: 'dispatch',
        firstNote: `司机上报故障：${detail}，车辆双闪停靠、等待救援`,
      });
    } else {
      await this.incidentSvc.create({
        type: 'vehicle_fault', severity: 'critical',
        title: `${v.code} 故障停驶`,
        detail, vehicleId: v.id,
        raisedByRole: 'driver', ownerRole: 'dispatch',
      });
    }
    const d = await this.drivers.findOne({ where: { currentVehicleId: v.id } });
    if (d) { d.currentVehicleId = null; d.status = 'on_duty'; await this.drivers.save(d); }
    return { ok: true };
  }

  /** 故障车修复 / 维保复检通过 */
  async repairVehicle(vehicleId: number) {
    const v = await this.vehicles.findOne({ where: { id: vehicleId } });
    if (!v) throw new NotFoundException('车辆不存在');
    v.status = 'idle';
    return this.vehicles.save(v);
  }

  /* ================= 暴雨临时停运 ================= */

  /** 停运期间在途/排队/未检票三类车票分别处理的统一客服口径 */
  private buildServiceScript(warning: string, counts: {
    onboard: number; queued: number; unchecked: number; trips: number;
  }) {
    return [
      `【${warning}临时停运·客服统一口径】`,
      `1. 在途车辆（${counts.trips} 班/在车 ${counts.onboard} 人）：由司机就近安全停靠，游客接驳避雨，车票已锁定，可在“改乘接驳车 / 延期 / 全额退票”中三选一。`,
      `2. 站点排队（${counts.queued} 组）：停止检票与叫号，队列已锁定保留顺位，游客可改乘恢复后首班、延期或全额退票；不退队的游客恢复后优先按原顺位乘车。`,
      `3. 未检票订单（${counts.unchecked} 张）：未入队车票已锁定，当日可免费改乘/改期，或申请全额退票，退票款项 1-3 个工作日原路退回。`,
      '4. 所有选项均为景区责任，免手续费；退票由客服核准、财务确认出账后统一归档。请各渠道按此口径答复，不做超口径承诺。',
    ].join('\n');
  }

  /**
   * 一键暴雨临时停运：
   * 锁定受影响车票（在途/站点排队/未检票三类分别标记）、锁定排队、中断班次，
   * 在途车辆置为待收车（不自动复位），推送客服统一口径与全线广播。
   */
  async stormSuspend(reason: string, routeId?: number) {
    const weather = (await this.weatherRepo.find({ order: { id: 'DESC' }, take: 1 }))[0];
    const label = weather?.warning || '暴雨';
    const active = await this.suspensions.findOne({ where: { status: 'active' } });
    if (active) throw new BadRequestException(`已存在进行中的停运单 ${active.code}，请先恢复运营`);

    const qb = this.trips.createQueryBuilder('t')
      .where('t.status IN (:...s)', { s: ['scheduled', 'boarding', 'running', 'delayed'] });
    if (routeId) qb.andWhere('t.routeId = :r', { r: routeId });
    const activeTrips = await qb.getMany();

    const affected = {
      trips: activeTrips.map(t => t.code),
      onboardTicketIds: [] as number[],
      queuedTicketIds: [] as number[],
      uncheckedTicketIds: [] as number[],
      vehicleIds: [...new Set(activeTrips.map(t => t.vehicleId))],
      driverIds: [...new Set(activeTrips.map(t => t.driverId))],
    };
    const routeIds = routeId ? [routeId] : (await this.routes.find()).map(r => r.id);
    const routeStations = await this.stations.find({ where: { routeId: In(routeIds) } });
    const stationIds = routeStations.map(s => s.id);

    const suspension = await this.suspensions.save(this.suspensions.create({
      code: seqCode('SS'),
      routeId: routeId || null,
      warning: label,
      reason,
      status: 'active',
      startedAt: now(),
      affected: null,
      serviceScript: '',
    }));

    // —— 第一类：在途车辆上的已检票车票（onboard）——
    for (const t of activeTrips) {
      t.status = 'suspended';
      t.suspendReason = `${label}临时停运：${reason}`;
      t.suspensionId = suspension.id;
      t.stormReturned = false;
      await this.trips.save(t);

      const onboard = await this.tickets.find({ where: { tripId: t.id, status: 'boarded' } });
      for (const tk of onboard) {
        tk.stormLocked = true;
        tk.suspensionId = suspension.id;
        tk.stormCategory = 'onboard';
        await this.tickets.save(tk);
        affected.onboardTicketIds.push(tk.id);
        await this.incidentSvc.create({
          type: 'storm_suspension', severity: 'critical',
          title: `${label}停运·在途：${tk.visitorName} 所乘 ${t.code} 中断`,
          detail: `车辆就近停靠、游客接驳避雨；车票已锁定，请游客在改乘/延期/退票中选择，票款按票种全额保障`,
          ticketId: tk.id, tripId: t.id, vehicleId: t.vehicleId,
          raisedByRole: 'dispatch', ownerRole: 'service',
          firstNote: `调度宣布停运：${reason}；在途车辆等待司机收车登记`,
        });
      }

      // 在途车辆：锁定为待收车，保留位置，等待调度登记司机收车与充电安排
      const v = await this.vehicles.findOne({ where: { id: t.vehicleId } });
      if (v) {
        v.status = 'returning';
        v.stormReturnPending = true;
        await this.vehicles.save(v);
      }
    }

    // —— 第二类：站点排队（queued），停止检票/叫号，锁定队列与顺位 ——
    const waitingEntries = await this.queue.find({
      where: { stationId: In(stationIds), status: In(['waiting', 'called', 'skipped']) },
    });
    for (const e of waitingEntries) {
      e.status = 'storm_locked';
      e.suspensionId = suspension.id;
      await this.queue.save(e);
      const tk = await this.tickets.findOne({ where: { id: e.ticketId } });
      if (tk && !tk.stormLocked) {
        tk.stormLocked = true;
        tk.suspensionId = suspension.id;
        tk.stormCategory = 'queued';
        tk.status = 'queued'; // 保留排队状态但被锁，检票/退票入口校验 stormLocked
        await this.tickets.save(tk);
        affected.queuedTicketIds.push(tk.id);
      }
    }

    // —— 第三类：未检票有效订单（unchecked）：未入队/已离队的有效票 ——
    const unchecked = await this.tickets.find({
      where: { status: In(['valid', 'queued']) },
    });
    for (const tk of unchecked) {
      if (tk.stormLocked) continue;
      const origin = await this.stations.findOne({ where: { id: tk.originStationId } });
      if (!origin || !routeIds.includes(origin.routeId)) continue;
      tk.stormLocked = true;
      tk.suspensionId = suspension.id;
      tk.stormCategory = 'unchecked';
      await this.tickets.save(tk);
      affected.uncheckedTicketIds.push(tk.id);
    }

    suspension.affected = affected;
    suspension.serviceScript = this.buildServiceScript(label, {
      trips: activeTrips.length,
      onboard: affected.onboardTicketIds.length,
      queued: affected.queuedTicketIds.length,
      unchecked: affected.uncheckedTicketIds.length,
    });
    await this.suspensions.save(suspension);

    // 全线广播
    await this.broadcasts.save(this.broadcasts.create({
      stationId: 0,
      content: `【${label}临时停运】因${reason}，观光车全线暂停运营：在途车辆就近停靠接驳，站点停止检票；请游客在工作人员指引下选择改乘、延期或全额退票，详询客服。`,
      spokenByRole: 'dispatch', createdAt: now(),
    }));

    // 汇总事件（客服接单，按统一口径答复）
    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'critical',
      title: `${label}临时停运：${activeTrips.length} 班中断，三类车票已锁定`,
      detail: `在途 ${affected.onboardTicketIds.length} 张、排队 ${affected.queuedTicketIds.length} 张、未检票 ${affected.uncheckedTicketIds.length} 张；车辆待收车 ${affected.vehicleIds.length} 辆。客服按统一口径处理改乘/延期/退票`,
      raisedByRole: 'dispatch', ownerRole: 'service',
      firstNote: '调度中心启动暴雨停运预案，客服统一口径已同步',
    });

    return suspension;
  }

  /** 停运看板汇总：进行中停运单 + 三类待处理车票 + 待收车车辆 + 充电安排 */
  async stormOverview() {
    const active = await this.suspensions.findOne({
      where: { status: 'active' }, order: { id: 'DESC' },
    });
    const history = await this.suspensions.find({ order: { id: 'DESC' }, take: 10 });
    if (!active) {
      return { active: null, history, pending: { onboard: 0, queued: 0, unchecked: 0 } };
    }
    const [lockedTickets, returnLogs, chargePlans, returningVehicles, suspendedTrips] = await Promise.all([
      this.tickets.find({ where: { suspensionId: active.id, stormLocked: true } }),
      this.returnLogs.find({ where: { suspensionId: active.id } }),
      this.chargePlans.find({ where: { suspensionId: active.id } }),
      this.vehicles.find({ where: { stormReturnPending: true } }),
      this.trips.find({ where: { suspensionId: active.id } }),
    ]);
    const pendingOption = lockedTickets.filter(t => !t.stormOption);
    const [vehicles, drivers, trips] = await Promise.all([
      this.vehicles.find(), this.drivers.find(), this.trips.find(),
    ]);
    const enrichVehicle = (vId: number) => vehicles.find(v => v.id === vId);
    const returnView = returnLogs.map(l => ({
      ...l,
      vehicleCode: enrichVehicle(l.vehicleId)?.code,
      driverName: drivers.find(d => d.id === l.driverId)?.name,
      tripCode: trips.find(t => t.id === l.tripId)?.code,
    }));
    const chargeView = chargePlans.map(p => ({
      ...p,
      vehicleCode: enrichVehicle(p.vehicleId)?.code,
      battery: enrichVehicle(p.vehicleId)?.battery,
      vehicleStatus: enrichVehicle(p.vehicleId)?.status,
    }));
    return {
      active,
      history,
      suspendedTrips,
      pendingReturnVehicles: returningVehicles.map(v => {
        const suspendedTrip = suspendedTrips.find(t => t.vehicleId === v.id && !t.stormReturned);
        const driver = drivers.find(d => d.currentVehicleId === v.id)
          || drivers.find(d => suspendedTrip?.driverId === d.id);
        return {
          ...v,
          driverId: driver?.id || suspendedTrip?.driverId || null,
          driverName: driver?.name,
          tripCode: suspendedTrip?.code,
          tripId: suspendedTrip?.id,
        };
      }),
      returnLogs: returnView,
      chargePlans: chargeView,
      lockedCount: lockedTickets.length,
      pending: {
        onboard: pendingOption.filter(t => t.stormCategory === 'onboard').length,
        queued: pendingOption.filter(t => t.stormCategory === 'queued').length,
        unchecked: pendingOption.filter(t => t.stormCategory === 'unchecked').length,
      },
      optionStats: {
        transfer: lockedTickets.filter(t => t.stormOption === 'transfer').length,
        postpone: lockedTickets.filter(t => t.stormOption === 'postpone').length,
        refund: lockedTickets.filter(t => t.stormOption === 'refund').length,
      },
    };
  }

  /** 调度登记司机收车：就近停靠点、在车人数、备注 */
  async stormReturnVehicle(body: {
    suspensionId: number; tripId?: number; vehicleId: number; driverId: number;
    returnStation: string; onboardPeople: number; note?: string;
  }) {
    const s = await this.suspensions.findOne({ where: { id: body.suspensionId } });
    if (!s) throw new NotFoundException('停运单不存在');
    const v = await this.vehicles.findOne({ where: { id: body.vehicleId } });
    if (!v) throw new NotFoundException('车辆不存在');
    const exist = await this.returnLogs.findOne({
      where: { suspensionId: s.id, vehicleId: v.id },
    });
    if (exist) throw new BadRequestException(`${v.code} 已登记收车`);

    const trip = body.tripId
      ? await this.trips.findOne({ where: { id: body.tripId } })
      : await this.trips.findOne({
        where: { suspensionId: s.id, vehicleId: v.id, stormReturned: false },
      });
    const log = await this.returnLogs.save(this.returnLogs.create({
      suspensionId: s.id,
      tripId: trip?.id || body.tripId || 0,
      vehicleId: v.id, driverId: body.driverId,
      returnStation: body.returnStation, onboardPeople: body.onboardPeople || 0,
      note: body.note || '', createdAt: now(),
    }));
    if (trip) { trip.stormReturned = true; await this.trips.save(trip); }

    // 车辆解除待收车 → 待命（是否充电由充电安排决定）；司机收车待命
    v.stormReturnPending = false;
    v.status = 'idle';
    v.currentTripId = null;
    await this.vehicles.save(v);
    const d = await this.drivers.findOne({ where: { id: body.driverId } });
    if (d) {
      d.status = 'on_duty';
      d.currentVehicleId = null;
      await this.drivers.save(d);
    }
    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'warn',
      title: `${v.code} 司机${d?.name || ''}已收车（${body.returnStation}）`,
      detail: `收车时在车 ${body.onboardPeople || 0} 人已接驳疏散；${body.note || '车辆等待充电安排'}`,
      vehicleId: v.id, tripId: trip?.id,
      raisedByRole: 'driver', ownerRole: 'dispatch', status: 'closed',
      firstNote: `调度登记收车：停靠点 ${body.returnStation}`,
    });
    return log;
  }

  /** 登记车辆充电安排 */
  async stormChargePlan(body: {
    suspensionId: number; vehicleId: number; targetBattery?: number;
    slot?: string; plannedAt?: string; note?: string;
  }) {
    const s = await this.suspensions.findOne({ where: { id: body.suspensionId } });
    if (!s) throw new NotFoundException('停运单不存在');
    const v = await this.vehicles.findOne({ where: { id: body.vehicleId } });
    if (!v) throw new NotFoundException('车辆不存在');
    if (v.stormReturnPending) throw new BadRequestException(`${v.code} 尚未登记收车，不能安排充电`);
    const exist = await this.chargePlans.findOne({
      where: { suspensionId: s.id, vehicleId: v.id, status: In(['planned', 'charging']) },
    });
    if (exist) throw new BadRequestException(`${v.code} 已有进行中的充电安排`);

    const plan = await this.chargePlans.save(this.chargePlans.create({
      suspensionId: s.id, vehicleId: v.id,
      targetBattery: body.targetBattery || 100,
      slot: body.slot || '', plannedAt: body.plannedAt || now(),
      note: body.note || '', status: 'planned', createdAt: now(),
    }));
    v.status = 'charging';
    await this.vehicles.save(v);
    await this.incidentSvc.create({
      type: 'info', severity: 'info',
      title: `${v.code} 已安排暴雨停运后充电`,
      detail: `桩位：${body.slot || '未指定'}，目标电量 ${body.targetBattery || 100}%，当前 ${v.battery}%`,
      vehicleId: v.id, raisedByRole: 'dispatch', ownerRole: 'dispatch', status: 'closed',
    });
    return plan;
  }

  /** 充电安排状态推进（开始/完成） */
  async stormChargeUpdate(id: number, status: 'charging' | 'done') {
    const plan = await this.chargePlans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('充电安排不存在');
    plan.status = status;
    if (status === 'done') {
      plan.finishedAt = now();
      const v = await this.vehicles.findOne({ where: { id: plan.vehicleId } });
      if (v) {
        v.battery = plan.targetBattery;
        v.status = 'idle';
        await this.vehicles.save(v);
      }
    }
    return this.chargePlans.save(plan);
  }

  /** 预警解除、恢复运营：解除未选择车票的锁定，可重新派班（已选退票/延期的不回滚） */
  async resumeOperation(note?: string) {
    const active = await this.suspensions.findOne({ where: { status: 'active' } });
    if (!active) return { ok: true, note: '当前无进行中的停运单' };
    active.status = 'resumed';
    active.resumedAt = now();
    active.resumeNote = note || '';
    await this.suspensions.save(active);

    // 仍未做选择的锁定票：解除锁定；已选改乘/延期的同步解锁以便恢复后乘车
    const locked = await this.tickets.find({
      where: { suspensionId: active.id, stormLocked: true },
    });
    let unlocked = 0;
    for (const tk of locked) {
      if (tk.stormOption === 'refund' && tk.status !== 'refund_rejected') {
        continue; // 退票仍在客服/财务流程中，保持锁定
      }
      tk.stormLocked = false;
      if (tk.stormCategory === 'unchecked' && tk.status === 'valid') tk.status = 'valid';
      await this.tickets.save(tk);
      unlocked++;
    }
    // 被锁队列：未选择者恢复排队顺位；改乘者已在选择时回队；延期者保留 storm_postponed
    const lockedQueue = await this.queue.find({
      where: { suspensionId: active.id, status: 'storm_locked' },
    });
    for (const e of lockedQueue) {
      const tk = await this.tickets.findOne({ where: { id: e.ticketId } });
      if (tk && tk.stormOption === 'refund' && tk.status === 'refund_pending') continue;
      e.status = 'waiting';
      await this.queue.save(e);
    }
    // 兜底：还有待收车车辆则释放为待命
    const pending = await this.vehicles.find({ where: { stormReturnPending: true } });
    for (const v of pending) { v.stormReturnPending = false; v.status = 'idle'; await this.vehicles.save(v); }

    await this.broadcasts.save(this.broadcasts.create({
      stationId: 0,
      content: '【运营恢复】暴雨预警解除，观光车恢复运营；停运期间选择延期/改乘的游客可按登记信息乘车，退票游客款项将由财务统一出账。',
      spokenByRole: 'dispatch', createdAt: now(),
    }));
    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'info',
      title: `暴雨停运单 ${active.code} 已恢复运营`,
      detail: note || '预警解除，恢复派班与检票',
      raisedByRole: 'dispatch', ownerRole: 'dispatch', status: 'closed',
      firstNote: `调度恢复运营；未选择游客解锁 ${unlocked} 张`,
    });
    return { ok: true, suspensionCode: active.code, unlockedTickets: unlocked };
  }

  async listSuspensions() {
    return this.suspensions.find({ order: { id: 'DESC' }, take: 20 });
  }

  /* ================= 天气 / 管制 ================= */

  async updateWeather(body: Partial<Weather>) {
    const w = await this.weatherRepo.save(this.weatherRepo.create({
      condition: body.condition || '多云',
      tempC: body.tempC ?? 26,
      warning: body.warning || '',
      warningLevel: body.warningLevel ?? 0,
      rainfallMmH: body.rainfallMmH ?? 0,
      updatedAt: now(),
    }));
    if (w.warningLevel >= STORM_LEVEL) {
      await this.incidentSvc.create({
        type: 'storm_suspension', severity: 'critical',
        title: `${w.warning}，调度中心收到气象预警`,
        detail: `降雨 ${w.rainfallMmH}mm/h，达停运阈值；调度可一键执行全线临时停运`,
        raisedByRole: 'system', ownerRole: 'dispatch',
        firstNote: '气象预警自动同步，请调度决策是否停运',
      });
    }
    return w;
  }

  async currentWeather() {
    return (await this.weatherRepo.find({ order: { id: 'DESC' }, take: 1 }))[0] || null;
  }

  async addRoadControl(body: { stationId?: number; segment: string; reason: string }) {
    return this.controls.save(this.controls.create({
      stationId: body.stationId || null,
      segment: body.segment,
      reason: body.reason,
      status: 'active',
      startAt: now(),
    }));
  }

  async liftControl(id: number) {
    const c = await this.controls.findOne({ where: { id } });
    if (!c) throw new NotFoundException('管制不存在');
    c.status = 'lifted';
    c.endAt = now();
    return this.controls.save(c);
  }

  async listControls() {
    return this.controls.find({ order: { id: 'DESC' }, take: 30 });
  }

  async listGeofence(vehicleId?: number) {
    return this.geofence.find({
      where: vehicleId ? { vehicleId } : {},
      order: { id: 'DESC' }, take: 30,
    });
  }

  /* ================= 团队包车 ================= */

  async createCharter(body: {
    teamName: string; contact: string; phone: string; peopleCount: number;
    needWheelchair?: number; startStationId: number; routePlan: string;
    useDate: string; amount?: number;
  }) {
    const order = await this.charters.save(this.charters.create({
      code: seqCode('CH'),
      teamName: body.teamName, contact: body.contact, phone: body.phone,
      peopleCount: body.peopleCount, needWheelchair: body.needWheelchair || 0,
      startStationId: body.startStationId, routePlan: body.routePlan,
      useDate: body.useDate, amount: body.amount || body.peopleCount * 1500,
      status: 'pending', createdAt: now(),
    }));
    await this.incidentSvc.create({
      type: 'charter', severity: 'info',
      title: `团队包车申请：${body.teamName}（${body.peopleCount} 人）`,
      detail: `联系人 ${body.contact}，${body.useDate} 用车，路线：${body.routePlan}`,
      raisedByRole: 'service', ownerRole: 'dispatch',
      firstNote: '客服受理包车申请，等待调度配车',
    });
    return order;
  }

  async listCharters() {
    return this.charters.find({ order: { id: 'DESC' } });
  }

  /** 调度配车：校验座位/轮椅位、车辆可用并预留 */
  async assignCharter(id: number, body: { vehicleId: number; driverId: number; note?: string }) {
    const [order, v, d] = await Promise.all([
      this.charters.findOne({ where: { id } }),
      this.vehicles.findOne({ where: { id: body.vehicleId } }),
      this.drivers.findOne({ where: { id: body.driverId } }),
    ]);
    if (!order) throw new NotFoundException('包车单不存在');
    if (!v || !d) throw new NotFoundException('车辆或司机不存在');
    if (order.peopleCount > v.capacity) {
      throw new BadRequestException(`该车 ${v.capacity} 座，少于团队 ${order.peopleCount} 人，请安排更大车辆或多车`);
    }
    if (order.needWheelchair > v.wheelchairSeats) {
      throw new BadRequestException(`轮椅位不足：需要 ${order.needWheelchair}，该车仅 ${v.wheelchairSeats}`);
    }
    if (v.status === 'breakdown' || v.status === 'maintenance') throw new BadRequestException('车辆不可用');
    if (v.reservedForCharter) throw new BadRequestException('车辆已被其他包车预留');

    order.vehicleId = v.id;
    order.driverId = d.id;
    order.note = body.note || '';
    order.status = 'confirmed';
    v.reservedForCharter = true;
    await Promise.all([this.charters.save(order), this.vehicles.save(v)]);
    await this.incidentSvc.create({
      type: 'charter', severity: 'info',
      title: `包车已配车：${order.teamName} → ${v.code}/${d.name}`,
      detail: `${v.capacity} 座，轮椅位 ${v.wheelchairSeats}；用车日 ${order.useDate}`,
      vehicleId: v.id, raisedByRole: 'dispatch', ownerRole: 'dispatch', status: 'closed',
    });
    return order;
  }

  async updateCharterStatus(id: number, status: CharterOrder['status']) {
    const order = await this.charters.findOne({ where: { id } });
    if (!order) throw new NotFoundException('包车单不存在');
    order.status = status;
    if (status === 'completed' || status === 'cancelled') {
      if (order.vehicleId) {
        const v = await this.vehicles.findOne({ where: { id: order.vehicleId } });
        if (v) { v.reservedForCharter = false; await this.vehicles.save(v); }
      }
    }
    return this.charters.save(order);
  }
}
