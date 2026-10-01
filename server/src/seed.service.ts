import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RouteLine, Station, Vehicle, Driver, Weather, Ticket, QueueEntry,
  RoadControl, Trip,
} from './entities';
import { now, seqCode, ticketPrice } from './common';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(RouteLine) private readonly routes: Repository<RouteLine>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(Weather) private readonly weather: Repository<Weather>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(RoadControl) private readonly controls: Repository<RoadControl>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
  ) {}

  async onApplicationBootstrap() {
    const stationCount = await this.stations.count();
    if (stationCount > 0) return;
    await this.seed();
  }

  private async seed() {
    /* ---- 线路 ---- */
    const loop = await this.routes.save(this.routes.create({
      name: '环山观光线', code: 'R1', kind: 'loop', color: '#1677ff', intervalMinutes: 10,
    }));
    const shuttle = await this.routes.save(this.routes.create({
      name: '湖滨往返线', code: 'R2', kind: 'shuttle', color: '#52c41a', intervalMinutes: 12,
    }));

    /* ---- 站点 ---- */
    const loopDefs = [
      ['东门枢纽', 'ST1', 24.440, 118.100, 40, 0, true],
      ['百花园', 'ST2', 24.445, 118.108, 18, 300, false],
      ['山顶观景台', 'ST3', 24.452, 118.112, 16, 200, true],
      ['玻璃栈道', 'ST4', 24.450, 118.120, 14, 150, true],
      ['索道换乘', 'ST5', 24.444, 118.118, 20, 0, false],
      ['南门服务区', 'ST6', 24.438, 118.110, 30, 0, false],
    ] as const;
    const loopStations: Station[] = [];
    for (let i = 0; i < loopDefs.length; i++) {
      const [name, code, lat, lng, cap, limit, hot] = loopDefs[i];
      loopStations.push(await this.stations.save(this.stations.create({
        name, code: `${loop.code}-${code}`, routeId: loop.id, seq: i + 1,
        lat, lng, platformCapacity: cap, flowLimitPerHour: limit, isHot: !!hot,
      })));
    }
    const shuttleDefs = [
      ['湖滨码头', 'SB1', 24.435, 118.095, 24, 0, false],
      ['湿地栈道', 'SB2', 24.436, 118.088, 14, 180, false],
      ['湖心岛', 'SB3', 24.439, 118.080, 16, 220, true],
      ['西大门', 'SB4', 24.442, 118.074, 30, 0, false],
    ] as const;
    const shuttleStations: Station[] = [];
    for (let i = 0; i < shuttleDefs.length; i++) {
      const [name, code, lat, lng, cap, limit, hot] = shuttleDefs[i];
      shuttleStations.push(await this.stations.save(this.stations.create({
        name, code: `${shuttle.code}-${code}`, routeId: shuttle.id, seq: i + 1,
        lat, lng, platformCapacity: cap, flowLimitPerHour: limit, isHot: !!hot,
      })));
    }

    /* ---- 车辆（含无障碍车） ---- */
    const vehDefs = [
      ['V01', '闽D·8A001', 14, 2, true, 86, 'idle'],
      ['V02', '闽D·8A002', 14, 2, true, 72, 'running'],
      ['V03', '闽D·8A003', 10, 1, true, 41, 'idle'],
      ['V04', '闽D·8A004', 14, 0, false, 95, 'idle'],
      ['V05', '闽D·8A005', 20, 3, true, 58, 'idle'],
      ['V06', '闽D·8A006', 14, 2, true, 18, 'charging'],
    ] as const;
    const vehicles: Vehicle[] = [];
    for (const [code, plate, cap, wl, acc, bat, st] of vehDefs) {
      vehicles.push(await this.vehicles.save(this.vehicles.create({
        code, plate, capacity: cap, wheelchairSeats: wl, accessible: acc,
        battery: bat, status: st as any, lat: loopStations[0].lat, lng: loopStations[0].lng,
        currentStationId: loopStations[0].id,
      })));
    }

    /* ---- 司机 ---- */
    const driverDefs = [
      ['王建国', '13900000001', 'A1-2001-01', 'on_duty', 150, 120, false],
      ['陈志强', '13900000002', 'A1-2002-02', 'driving', 235, 235, false],
      ['李海燕', '13900000003', 'A1-2003-03', 'on_duty', 300, 300, true],
      ['赵师傅', '13900000004', 'A1-2004-04', 'off', 0, 0, false],
    ] as const;
    const drivers: Driver[] = [];
    for (const [name, phone, lic, status, workMin, contMin, rest] of driverDefs) {
      drivers.push(await this.drivers.save(this.drivers.create({
        name, phone, licenseNo: lic, status: status as any,
        workMinutesToday: workMin, continuousDrivingMinutes: contMin, restRequired: rest,
        maxWorkMinutes: 480,
        shiftStart: workMin > 0 ? new Date(Date.now() - workMin * 60000).toISOString() : null,
      })));
    }

    /* ---- 天气 ---- */
    await this.weather.save(this.weather.create({
      condition: '多云', tempC: 27, warning: '', warningLevel: 0, rainfallMmH: 0,
      updatedAt: now(),
    }));

    /* ---- 道路管制（示例一条软管制） ---- */
    await this.controls.save(this.controls.create({
      stationId: loopStations[3].id,
      segment: '玻璃栈道—索道换乘 北支路',
      reason: '边坡施工，减速慢行（未封闭）',
      status: 'active', startAt: now(),
    }));

    /* ---- 一列正在上客的班车（V02 + 陈志强，环山线上行） ---- */
    const trip = await this.trips.save(this.trips.create({
      code: seqCode('TR'),
      routeId: loop.id, vehicleId: vehicles[1].id, driverId: drivers[1].id,
      direction: 'forward', status: 'boarding',
      originStationId: loopStations[0].id, destStationId: loopStations[3].id,
      departAt: now(), seatsTotal: 14, seatsSold: 2, wheelchairHeld: 0,
      boardedCount: 1, skippedStations: [],
    }));
    vehicles[1].currentTripId = trip.id;
    vehicles[1].lat = loopStations[0].lat;
    vehicles[1].lng = loopStations[0].lng;
    await this.vehicles.save(vehicles[1]);
    drivers[1].currentVehicleId = vehicles[1].id;
    await this.drivers.save(drivers[1]);

    /* ---- 示例车票 + 排队 ---- */
    const mkTicket = async (partial: Partial<Ticket>) => {
      const t = await this.tickets.save(this.tickets.create({
        code: seqCode('T'),
        type: 'single', visitorName: '游客', partySize: 1,
        hasStroller: false, hasElder: false, hasChild: false,
        priority: false, needWheelchair: false,
        originStationId: loopStations[0].id, destStationId: loopStations[2].id,
        expectedDirection: 'forward', plannedRoute: '',
        price: 0, status: 'valid', createdAt: now(), enterParkAt: now(),
        ...partial,
      }));
      return t;
    };

    const t1 = await mkTicket({
      visitorName: '张敏', type: 'single', partySize: 2,
      price: ticketPrice('single', 2),
    });
    const t2 = await mkTicket({
      visitorName: '刘芳（亲子）', type: 'parent_child', partySize: 3,
      hasChild: true, hasStroller: true,
      price: ticketPrice('parent_child', 3),
    });
    const t3 = await mkTicket({
      visitorName: '孙老先生', type: 'accessible_priority', partySize: 2,
      hasElder: true, priority: true, needWheelchair: true,
      price: ticketPrice('accessible_priority', 2),
    });
    const t4 = await mkTicket({
      visitorName: '周杰', type: 'loop', partySize: 4,
      destStationId: loopStations[5].id, expectedDirection: 'loop',
      price: ticketPrice('loop', 4),
    });
    // 一张已检票的票（在车上）
    const t5 = await mkTicket({
      visitorName: '吴迪', partySize: 2, status: 'boarded', tripId: trip.id,
      price: ticketPrice('single', 2),
    });

    // 东门枢纽排队（热门站，制造拥堵场景）
    const mkQueue = async (ticketId: number, priority: boolean, dir: string, agoMin: number) => {
      const enqueueAt = new Date(Date.now() - agoMin * 60000).toISOString();
      return this.queue.save(this.queue.create({
        stationId: loopStations[0].id, ticketId,
        partySize: (await this.tickets.findOne({ where: { id: ticketId } }))!.partySize,
        priority, expectedDirection: dir, status: 'waiting',
        enqueueAt, waitSeconds: 0,
      }));
    };
    await mkQueue(t1.id, false, 'forward', 9);
    await mkQueue(t2.id, false, 'forward', 7);
    await mkQueue(t3.id, true, 'forward', 3);
    await mkQueue(t4.id, false, 'loop', 2);
    // 已检票记录（用于等待时长统计）
    await this.queue.save(this.queue.create({
      stationId: loopStations[0].id, ticketId: t5.id, partySize: 2,
      priority: false, expectedDirection: 'forward',
      status: 'boarded', enqueueAt: new Date(Date.now() - 16 * 60000).toISOString(),
      boardAt: now(), tripId: trip.id, waitSeconds: 16 * 60,
    }));
    for (const id of [t1.id, t2.id, t3.id, t4.id]) {
      const t = await this.tickets.findOne({ where: { id } });
      t.status = 'queued';
      await this.tickets.save(t);
    }

    // 湖心岛（热门站）也放一队
    const t6 = await mkTicket({
      visitorName: '郑爽', type: 'single', partySize: 2,
      originStationId: shuttleStations[0].id, destStationId: shuttleStations[2].id,
      price: ticketPrice('single', 2),
      plannedRoute: '湖滨码头 → 湖心岛',
    });
    await this.queue.save(this.queue.create({
      stationId: shuttleStations[0].id, ticketId: t6.id, partySize: 2,
      priority: false, expectedDirection: 'forward',
      status: 'waiting', enqueueAt: new Date(Date.now() - 5 * 60000).toISOString(),
    }));
    t6.status = 'queued';
    await this.tickets.save(t6);

    // 一张已购票、尚未到站排队的票（停运时归入“未检票订单”）
    const t7 = await mkTicket({
      visitorName: '冯雨（刚入园）', type: 'single', partySize: 1,
      price: ticketPrice('single', 1),
      plannedRoute: '东门枢纽 → 山顶观景台',
    });

    // eslint-disable-next-line no-console
    console.log('[seed] 演示数据已写入：2 条线路 / 10 个站点 / 6 辆车 / 4 名司机 / 7 张票（含 1 张未检票）');
  }
}
