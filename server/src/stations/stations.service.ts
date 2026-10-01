import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  Station, RouteLine, QueueEntry, Ticket, Trip, Vehicle, Weather,
  Broadcast, RoadControl, Incident, StormSuspension,
} from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { now, waitSeconds } from '../common';

const LONG_QUEUE_RATIO = 1.2; // 排队人数超站台容量 1.2 倍判定过长

@Injectable()
export class StationsService {
  constructor(
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(RouteLine) private readonly routes: Repository<RouteLine>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Weather) private readonly weather: Repository<Weather>,
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
    @InjectRepository(RoadControl) private readonly controls: Repository<RoadControl>,
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(StormSuspension) private readonly suspensions: Repository<StormSuspension>,
    private readonly incidentSvc: IncidentsService,
  ) {}

  /* ---------------- 线路 / 站点 / 天气 ---------------- */

  async overview() {
    const [stations, routes, weatherRow, controls] = await Promise.all([
      this.stations.find({ order: { routeId: 'ASC', seq: 'ASC' } }),
      this.routes.find(),
      this.weather.find({ order: { id: 'DESC' }, take: 1 }),
      this.controls.find({ where: { status: 'active' } }),
    ]);
    const waiting = await this.queue.find({ where: { status: In(['waiting', 'called']) } });
    const activeTrips = await this.trips.find({ where: { status: In(['boarding', 'running']) } });
    const vehicles = await this.vehicles.find();

    const map = stations.map(s => {
      const qs = waiting.filter(q => q.stationId === s.id);
      const waitingPeople = qs.reduce((a, q) => a + q.partySize, 0);
      const priorityPeople = qs.filter(q => q.priority).reduce((a, q) => a + q.partySize, 0);
      return {
        ...s,
        routeName: routes.find(r => r.id === s.routeId)?.name || '',
        waitingPeople,
        waitingGroups: qs.length,
        priorityPeople,
        congestion: this.congestionLevel(s, waitingPeople),
        activeControl: controls.find(c => c.stationId === s.id) || null,
      };
    });
    return {
      stations: map,
      routes,
      weather: weatherRow[0] || null,
      activeTrips: activeTrips.length,
      activeVehicles: vehicles.filter(v => v.status === 'running').length,
    };
  }

  private congestionLevel(s: Station, people: number): 'smooth' | 'busy' | 'overloaded' {
    if (people >= s.platformCapacity * LONG_QUEUE_RATIO) return 'overloaded';
    if (people >= s.platformCapacity * 0.6) return 'busy';
    return 'smooth';
  }

  /** 站务平板看板：排队/已检票/车辆位置/座位余量/轮椅位/天气/管制 */
  async board(stationId: number) {
    const station = await this.stations.findOne({ where: { id: stationId } });
    if (!station) throw new NotFoundException('站点不存在');
    const route = await this.routes.findOne({ where: { id: station.routeId } });

    const entries = await this.queue.find({
      where: { stationId, status: In(['waiting', 'called']) },
      order: { id: 'ASC' },
    });
    const ticketRows = await this.tickets.find({
      where: { id: In(entries.map(e => e.ticketId)) },
    });
    const ticketMap = new Map(ticketRows.map(t => [t.id, t]));

    // 优先组在前，其余按入队时间
    const queue = entries
      .map(e => ({ ...e, ticket: ticketMap.get(e.ticketId), waitSeconds: waitSeconds(e.enqueueAt) }))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority ? -1 : 1;
        return a.id - b.id;
      });

    const waitingPeople = entries.reduce((a, e) => a + e.partySize, 0);
    const priorityPeople = entries.filter(e => e.priority).reduce((a, e) => a + e.partySize, 0);

    // 本站相关在途班次
    const trips = await this.trips.find({ status: In(['boarding', 'running', 'scheduled']) } as any);
    const relatedTrips = trips.filter(t => t.routeId === station.routeId);
    const vehRows = await this.vehicles.find({
      where: { id: In(relatedTrips.map(t => t.vehicleId)) },
    });
    const vehMap = new Map(vehRows.map(v => [v.id, v]));
    const tripCards = relatedTrips
      .map(t => {
        const v = vehMap.get(t.vehicleId);
        return {
          ...t,
          vehicle: v ? {
            id: v.id, code: v.code, plate: v.plate, accessible: v.accessible,
            battery: v.battery, lat: v.lat, lng: v.lng, status: v.status,
          } : null,
          seatsLeft: (v?.capacity || t.seatsTotal) - t.seatsSold,
          wheelchairLeft: (v?.wheelchairSeats || 0) - t.wheelchairHeld,
          skippedHere: (t.skippedStations || []).includes(stationId),
        };
      })
      .sort((a, b) => a.id - b.id);

    const [weatherRow] = await this.weather.find({ order: { id: 'DESC' }, take: 1 });
    const controls = await this.controls.find({ where: { status: 'active' } });
    const broadcasts = await this.broadcasts.find({
      where: [{ stationId: 0 }, { stationId }],
      order: { id: 'DESC' },
      take: 8,
    });
    const checkedToday = await this.queue.count({
      where: { stationId, status: 'boarded' },
    });

    // 暴雨停运期间被锁定的本站队列（保留顺位，不可检票）
    const stormLockedEntries = await this.queue.find({
      where: { stationId, status: In(['storm_locked', 'storm_postponed']) },
      order: { id: 'ASC' },
    });
    const stormLockedRows = await this.tickets.find({
      where: { id: In(stormLockedEntries.map(e => e.ticketId)) },
    });
    const stormTicketMap = new Map(stormLockedRows.map(t => [t.id, t]));
    const stormLockedQueue = stormLockedEntries.map(e => ({
      ...e, ticket: stormTicketMap.get(e.ticketId),
    }));

    return {
      station,
      route,
      weather: weatherRow || null,
      controls,
      stormActive: await this.suspensions.findOne({ where: { status: 'active' } }),
      queue,
      stormLockedQueue,
      waitingPeople,
      priorityPeople,
      congestion: this.congestionLevel(station, waitingPeople),
      trips: tripCards,
      broadcasts,
      checkedToday,
      flowLimitPerHour: station.flowLimitPerHour,
    };
  }

  /* ---------------- 入队 ---------------- */

  async enqueue(stationId: number, ticketCode: string) {
    const station = await this.stations.findOne({ where: { id: stationId } });
    if (!station) throw new NotFoundException('站点不存在');
    if (station.status === 'closed') throw new BadRequestException('该站点已关闭');
    const suspension = await this.suspensions.findOne({ where: { status: 'active' } });
    if (suspension) throw new BadRequestException('暴雨临时停运中，全线暂停排队检票，请按客服口径引导游客改乘/延期/退票');
    const ticket = await this.tickets.findOne({ where: { code: ticketCode.trim() } });
    if (!ticket) throw new NotFoundException('车票号无效');
    if (ticket.originStationId !== stationId) {
      throw new BadRequestException(
        `票面始发站不符：本票应在「${await this.stationName(ticket.originStationId)}」入队`,
      );
    }
    if (!['valid', 'queued'].includes(ticket.status)) {
      throw new BadRequestException(`车票当前状态「${ticket.status}」不可排队`);
    }
    const exist = await this.queue.findOne({
      where: { ticketId: ticket.id, status: In(['waiting', 'called']) },
    });
    if (exist) throw new BadRequestException('已在排队中，请勿重复入队');

    const entry = await this.queue.save(this.queue.create({
      stationId,
      ticketId: ticket.id,
      partySize: ticket.partySize,
      priority: ticket.priority,
      expectedDirection: ticket.expectedDirection,
      status: 'waiting',
      enqueueAt: now(),
      waitSeconds: 0,
    }));
    ticket.status = 'queued';
    await this.tickets.save(ticket);

    // 热门站点排队过长 → 自动生成事件通知调度加车
    const waitingPeople = await this.waitingPeople(stationId);
    if (waitingPeople >= station.platformCapacity * LONG_QUEUE_RATIO) {
      const openAlert = await this.incidents.findOne({
        where: { stationId, type: 'long_queue', status: In(['open', 'processing']) },
      });
      if (!openAlert) {
        await this.incidentSvc.create({
          type: 'long_queue',
          severity: waitingPeople >= station.platformCapacity * 2 ? 'critical' : 'warn',
          title: `${station.name} 排队过长（${waitingPeople} 人等候）`,
          detail: `站台容量 ${station.platformCapacity} 人，当前等候 ${waitingPeople} 人，建议增发区间车`,
          stationId,
          raisedByRole: 'system',
          ownerRole: 'dispatch',
          firstNote: '系统自动预警，请调度评估加车/限流',
        });
      }
    }
    return { entry, waitingPeople, congestion: this.congestionLevel(station, waitingPeople) };
  }

  async waitingPeople(stationId: number): Promise<number> {
    const rows = await this.queue.find({
      where: { stationId, status: In(['waiting', 'called']) },
    });
    return rows.reduce((a, r) => a + r.partySize, 0);
  }

  /* ---------------- 检票上车（含反方向拦截 / 轮椅位 / 满载） ---------------- */

  async boardEntry(entryId: number, tripId: number, opts: { force?: boolean } = {}) {
    const entry = await this.queue.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('排队记录不存在');
    if (entry.status === 'storm_locked') {
      throw new BadRequestException('暴雨临时停运锁定中，停止检票；请引导游客完成改乘/延期/退票');
    }
    if (entry.status === 'storm_postponed') {
      throw new BadRequestException('该游客已选择延期，按登记改期日乘车');
    }
    if (!['waiting', 'called'].includes(entry.status)) {
      throw new BadRequestException('该游客已不在候乘状态');
    }
    const ticket = await this.tickets.findOne({ where: { id: entry.ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');
    if (ticket.stormLocked) {
      throw new BadRequestException('该票在暴雨停运锁定中，待游客完成改乘/延期/退票处理');
    }
    const trip = await this.trips.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('班次不存在');
    if (!['boarding', 'running'].includes(trip.status)) {
      throw new BadRequestException(`班次当前「${trip.status}」，不可检票`);
    }
    const vehicle = await this.vehicles.findOne({ where: { id: trip.vehicleId } });

    // 反方向误乘拦截（环线票/环线班不限制）
    const dirMismatch = trip.direction !== 'loop'
      && ticket.expectedDirection !== 'loop'
      && trip.direction !== ticket.expectedDirection;
    if (dirMismatch && !opts.force) {
      await this.incidentSvc.create({
        type: 'wrong_direction',
        severity: 'warn',
        title: `反方向误乘拦截：${ticket.visitorName} 险些乘上 ${trip.code}`,
        detail: `票面方向 ${ticket.expectedDirection === 'forward' ? '上行' : '下行'}，本班方向 ${trip.direction === 'forward' ? '上行' : '下行'}，已请游客留在站台等候对向班车`,
        ticketId: ticket.id, tripId: trip.id, stationId: entry.stationId,
        raisedByRole: 'staff', ownerRole: 'staff',
        firstNote: '检票口方向校验未通过，游客暂留站台',
      });
      throw new BadRequestException(
        `方向不符：本班为${trip.direction === 'forward' ? '上行' : '下行'}，游客目的地在反方向，已拦截并提示等候对向车`,
      );
    }

    const seatsLeft = (vehicle?.capacity || trip.seatsTotal) - trip.seatsSold;
    if (seatsLeft < entry.partySize) {
      throw new BadRequestException(`本班座位不足：仅剩 ${seatsLeft} 座，游客一行 ${entry.partySize} 人`);
    }
    if (ticket.needWheelchair) {
      const wLeft = (vehicle?.wheelchairSeats || 0) - trip.wheelchairHeld;
      if (wLeft < 1) throw new BadRequestException('本班轮椅位已满，请等候下一班无障碍车');
    }

    // 检票成功
    trip.seatsSold += entry.partySize;
    trip.boardedCount += 1;
    if (ticket.needWheelchair) trip.wheelchairHeld += 1;
    await this.trips.save(trip);

    entry.status = 'boarded';
    entry.boardAt = now();
    entry.tripId = trip.id;
    entry.waitSeconds = waitSeconds(entry.enqueueAt);
    await this.queue.save(entry);

    ticket.status = 'boarded';
    ticket.tripId = trip.id;
    await this.tickets.save(ticket);

    if (dirMismatch && opts.force) {
      await this.incidentSvc.create({
        type: 'wrong_direction',
        severity: 'critical',
        title: `${ticket.visitorName} 确认乘上反方向班车 ${trip.code}`,
        detail: '站务已二次确认并强制放行，需通知司机/下一站协助换乘返回',
        ticketId: ticket.id, tripId: trip.id, stationId: entry.stationId,
        raisedByRole: 'staff', ownerRole: 'dispatch',
        firstNote: '站务强制放行反方向乘车，调度安排返程衔接',
      });
    }
    return { ok: true, entry, trip, waitSeconds: entry.waitSeconds };
  }

  /** 一键叫下一位：优先组优先，同组按 FIFO */
  async boardNext(stationId: number, tripId: number) {
    const entries = await this.queue.find({
      where: { stationId, status: In(['waiting', 'called']) },
      order: { id: 'ASC' },
    });
    const sorted = entries.sort((a, b) => (a.priority !== b.priority ? (a.priority ? -1 : 1) : a.id - b.id));
    const trip = await this.trips.findOne({ where: { id: tripId } });
    const vehicle = trip ? await this.vehicles.findOne({ where: { id: trip.vehicleId } }) : null;
    const seatsLeft = vehicle ? vehicle.capacity - (trip?.seatsSold || 0) : 0;

    // 先排除方向不符
    for (const e of sorted) {
      const ticket = await this.tickets.findOne({ where: { id: e.ticketId } });
      if (!ticket) continue;
      const dirMismatch = trip && trip.direction !== 'loop' && ticket.expectedDirection !== 'loop'
        && trip.direction !== ticket.expectedDirection;
      if (dirMismatch) continue;
      if (e.partySize > seatsLeft) continue;
      if (ticket.needWheelchair && (vehicle.wheelchairSeats - trip.wheelchairHeld) < 1) continue;
      return this.boardEntry(e.id, tripId);
    }
    return {
      ok: false,
      reason: seatsLeft === 0 ? '本班满载，剩余游客等候下一班' : '候乘队列中没有方向/座位匹配的游客',
      seatsLeft,
    };
  }

  /** 老人优先引发争议：站务记录，客服主管同步 */
  async raisePriorityDispute(entryId: number, detail: string) {
    const entry = await this.queue.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('排队记录不存在');
    const ticket = await this.tickets.findOne({ where: { id: entry.ticketId } });
    return this.incidentSvc.create({
      type: 'priority_dispute',
      severity: 'warn',
      title: `优先乘车争议：${ticket?.visitorName || '游客'}（${entry.priority ? '优先组' : '普通组'}）`,
      detail,
      ticketId: entry.ticketId, stationId: entry.stationId,
      raisedByRole: 'staff', ownerRole: 'service',
      firstNote: `站务上报：${detail}`,
    });
  }

  async leaveQueue(entryId: number) {
    const entry = await this.queue.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('排队记录不存在');
    entry.status = 'left';
    await this.queue.save(entry);
    const ticket = await this.tickets.findOne({ where: { id: entry.ticketId } });
    if (ticket && ticket.status === 'queued') {
      ticket.status = 'valid';
      await this.tickets.save(ticket);
    }
    return { ok: true };
  }

  /* ---------------- 广播 / 限流 / 站点状态 ---------------- */

  async broadcast(stationId: number, content: string, spokenByRole = 'staff') {
    const b = await this.broadcasts.save(this.broadcasts.create({
      stationId, content, spokenByRole, createdAt: now(),
    }));
    await this.incidentSvc.create({
      type: 'info', severity: 'info',
      title: stationId === 0 ? '全线广播' : `站点广播：${await this.stationName(stationId)}`,
      detail: content, stationId: stationId || null,
      raisedByRole: spokenByRole as any, ownerRole: 'staff', status: 'closed',
    });
    return b;
  }

  async listBroadcasts(stationId?: number) {
    if (stationId) {
      return this.broadcasts.find({
        where: [{ stationId: 0 }, { stationId: Number(stationId) }],
        order: { id: 'DESC' }, take: 20,
      });
    }
    return this.broadcasts.find({ order: { id: 'DESC' }, take: 20 });
  }

  async updateStation(id: number, patch: Partial<Station>) {
    const s = await this.stations.findOne({ where: { id } });
    if (!s) throw new NotFoundException('站点不存在');
    Object.assign(s, patch);
    return this.stations.save(s);
  }

  async listRoutes() {
    const routes = await this.routes.find();
    const stations = await this.stations.find({ order: { seq: 'ASC' } });
    return routes.map(r => ({
      ...r,
      stations: stations.filter(s => s.routeId === r.id),
    }));
  }

  private async stationName(id: number) {
    return (await this.stations.findOne({ where: { id } }))?.name || `#${id}`;
  }
}
