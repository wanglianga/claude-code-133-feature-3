import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, Index,
} from 'typeorm';

/* ---------------- 线路与站点 ---------------- */

@Entity('route_lines')
export class RouteLine {
  @PrimaryGeneratedColumn() id: number;
  @Column() name: string;
  @Column() code: string;            // LOOP / SHUTTLE
  @Column({ default: 'loop' }) kind: 'loop' | 'shuttle'; // 环线 / 往返线
  @Column({ default: '#1677ff' }) color: string;
  @Column({ default: 12 }) intervalMinutes: number;      // 计划发车间隔
}

@Entity('stations')
export class Station {
  @PrimaryGeneratedColumn() id: number;
  @Column() name: string;
  @Column() code: string;
  @Column() routeId: number;
  @Column() seq: number;            // 线路上的顺序
  @Column('float', { default: 0 }) lat: number;
  @Column('float', { default: 0 }) lng: number;
  @Column({ default: 20 }) platformCapacity: number;    // 站台容量（人）
  @Column({ default: 0 }) flowLimitPerHour: number;     // 景点限流：0 不限
  @Column({ default: false }) isHot: boolean;           // 热门站点
  @Column({ default: 'normal' }) status: 'normal' | 'restricted' | 'closed';
}

/* ---------------- 车辆与司机 ---------------- */

@Entity('vehicles')
export class Vehicle {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;           // V01
  @Column() plate: string;
  @Column({ default: 14 }) capacity: number;
  @Column({ default: 2 }) wheelchairSeats: number;
  @Column({ default: true }) accessible: boolean;       // 无障碍车辆
  @Column('int', { default: 100 }) battery: number;     // 电量 %
  @Column({ default: 'idle' })
  status: 'idle' | 'running' | 'returning' | 'charging' | 'maintenance' | 'breakdown';
  @Column({ default: false }) stormReturnPending: boolean; // 暴雨停运后等待调度登记收车
  @Column('float', { default: 0 }) lat: number;
  @Column('float', { default: 0 }) lng: number;
  @Column({ nullable: true }) currentStationId: number | null;
  @Column({ nullable: true }) currentTripId: number | null;
  @Column({ default: 0 }) mileageKm: number;
  @Column({ default: false }) reservedForCharter: boolean;
}

@Entity('drivers')
export class Driver {
  @PrimaryGeneratedColumn() id: number;
  @Column() name: string;
  @Column() phone: string;
  @Column() licenseNo: string;
  @Column({ default: 'off' })
  status: 'off' | 'on_duty' | 'driving' | 'rest' | 'handover';
  @Column({ nullable: true }) currentVehicleId: number | null;
  @Column('int', { default: 0 }) workMinutesToday: number;
  @Column('int', { default: 0 }) continuousDrivingMinutes: number;
  @Column('int', { default: 480 }) maxWorkMinutes: number;
  @Column({ default: false }) restRequired: boolean;    // 连续驾驶 4h 需休息 20min
  @Column({ nullable: true }) shiftStart: string | null;
  @Column({ nullable: true }) handoverDueAt: string | null; // 交班截止时间
}

@Entity('safety_checks')
export class SafetyCheck {
  @PrimaryGeneratedColumn() id: number;
  @Column() vehicleId: number;
  @Column() driverId: number;
  @Column('simple-json') items: Record<string, boolean>; // 刹车/灯光/车门/轮椅固定/灭火器/电池
  @Column({ default: true }) passed: boolean;
  @Column({ default: '' }) note: string;
  @Column() checkedAt: string;
}

/* ---------------- 班次 ---------------- */

@Entity('trips')
export class Trip {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;            // TR20260925-001
  @Column() routeId: number;
  @Column() vehicleId: number;
  @Column() driverId: number;
  @Column({ default: 'forward' }) direction: 'forward' | 'backward' | 'loop';
  @Column({ default: 'scheduled' })
  status: 'scheduled' | 'boarding' | 'running' | 'completed' | 'cancelled' | 'suspended' | 'delayed';
  @Column() originStationId: number;
  @Column() destStationId: number;
  @Column({ nullable: true }) departAt: string | null;
  @Column({ nullable: true }) arriveAt: string | null;
  @Column('int', { default: 0 }) seatsTotal: number;
  @Column('int', { default: 0 }) seatsSold: number;     // 已检票座位（含同行人数）
  @Column('int', { default: 0 }) wheelchairHeld: number;
  @Column('int', { default: 0 }) boardedCount: number;
  @Column('simple-json', { nullable: true }) skippedStations: number[] | null;
  @Column({ default: '' }) suspendReason: string;
  @Column({ default: '' }) delayReason: string;
  @Column({ nullable: true }) suspensionId: number | null; // 暴雨停运单
  @Column({ default: false }) stormReturned: boolean;      // 司机已收车登记
}

/* ---------------- 车票与排队 ---------------- */

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;            // T20260925-xxxx
  @Column({ default: 'single' })
  type: 'single' | 'loop' | 'parent_child' | 'accessible_priority';
  @Column() visitorName: string;
  @Column({ default: '' }) phone: string;
  @Column('int', { default: 1 }) partySize: number;     // 同行人数
  @Column({ default: false }) hasStroller: boolean;     // 婴儿车
  @Column({ default: false }) hasElder: boolean;
  @Column({ default: false }) hasChild: boolean;
  @Column({ default: false }) priority: boolean;        // 无障碍/老人优先
  @Column({ default: false }) needWheelchair: boolean;
  @Column({ nullable: true }) enterParkAt: string | null;
  @Column() originStationId: number;
  @Column() destStationId: number;
  @Column({ default: 'forward' }) expectedDirection: 'forward' | 'backward' | 'loop';
  @Column({ default: '' }) plannedRoute: string;        // 预计游览路线
  @Column('int', { default: 0 }) price: number;         // 分
  @Column({ default: 'valid' })
  status: 'valid' | 'queued' | 'boarded' | 'used'
        | 'refund_pending' | 'refunded' | 'refund_rejected' | 'cancelled';
  @Column({ nullable: true }) tripId: number | null;
  /* ---- 暴雨临时停运联动 ---- */
  @Column({ default: false }) stormLocked: boolean;       // 停运期间平台锁定
  @Column({ nullable: true }) suspensionId: number | null;
  @Column({ default: '' })
  stormCategory: '' | 'onboard' | 'queued' | 'unchecked'; // 在途/排队/未检票 三类分别处理
  @Column({ default: '' })
  stormOption: '' | 'transfer' | 'postpone' | 'refund';   // 游客选择：改乘/延期/退票
  @Column({ nullable: true }) stormOptionAt: string | null;
  @Column({ nullable: true }) postponeDate: string | null;
  @Column() createdAt: string;
}

@Entity('queue_entries')
export class QueueEntry {
  @PrimaryGeneratedColumn() id: number;
  @Column() stationId: number;
  @Index() @Column() ticketId: number;
  @Column('int', { default: 1 }) partySize: number;
  @Column({ default: false }) priority: boolean;
  @Column({ default: '' }) expectedDirection: string;
  @Column({ default: 'waiting' })
  status: 'waiting' | 'called' | 'boarded' | 'left' | 'skipped'
          | 'transferred' | 'storm_locked' | 'storm_postponed';
  @Column() enqueueAt: string;
  @Column({ nullable: true }) boardAt: string | null;
  @Column({ nullable: true }) tripId: number | null;
  @Column('int', { default: 0 }) waitSeconds: number;
  @Column({ nullable: true }) suspensionId: number | null; // 暴雨停运锁定批次
}

/* ---------------- 事件中心（票 / 班车串联所有角色） ---------------- */

export type IncidentType =
  | 'long_queue' | 'skip_station' | 'wrong_direction' | 'priority_dispute'
  | 'vehicle_fault' | 'handover_delay' | 'storm_suspension'
  | 'refund_request' | 'charter' | 'info';

@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;
  @Column() type: IncidentType;
  @Column({ default: 'warn' }) severity: 'info' | 'warn' | 'critical';
  @Column() title: string;
  @Column({ default: '' }) detail: string;
  @Column({ nullable: true }) ticketId: number | null;
  @Column({ nullable: true }) tripId: number | null;
  @Column({ nullable: true }) stationId: number | null;
  @Column({ nullable: true }) vehicleId: number | null;
  @Column({ nullable: true }) refundId: number | null;
  @Column({ default: 'dispatch' })
  raisedByRole: 'visitor' | 'staff' | 'driver' | 'dispatch' | 'service' | 'finance' | 'system';
  @Column({ default: 'open' }) status: 'open' | 'processing' | 'escalated' | 'resolved' | 'closed';
  @Column({ default: 'dispatch' })
  ownerRole: 'staff' | 'dispatch' | 'driver' | 'service' | 'service_supervisor' | 'finance' | 'system';
  @Column({ default: '' }) resolution: string;
  @Column('simple-json', { nullable: true })
  timeline: { at: string; role: string; text: string }[] | null;
  @Column() createdAt: string;
}

/* ---------------- 退票 ---------------- */

@Entity('refunds')
export class Refund {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;
  @Column() ticketId: number;
  @Column('int') amount: number;            // 分（退票=退款金额；改乘/改期=手续费）
  @Column('int', { default: 0 }) carriedAmount: number; // 改乘/改期结转保留的原票款（分）
  @Column({ default: 'refund' })
  kind: 'refund' | 'transfer' | 'postpone'; // 退票 / 改乘 / 延期改期
  @Column({ default: '' }) reason: string;
  @Column({ default: '' }) faultTag: 'visitor' | 'storm' | 'vehicle' | 'schedule' | 'other';
  @Column({ default: 'pending' })
  status: 'pending' | 'approved' | 'rejected' | 'escalated' | 'paid' | 'archived';
  @Column({ default: 'visitor' }) applicantRole: 'visitor' | 'staff' | 'system';
  @Column({ default: '' }) serviceNote: string;
  @Column({ default: '' }) supervisorNote: string;
  @Column({ nullable: true }) suspensionId: number | null; // 来源：暴雨停运单
  /* ---- 财务确认与归档 ---- */
  @Column({ default: '' }) financeNote: string;
  @Column({ default: '' }) financePayChannel: string;       // 原路退回/线下现金/对公
  @Column({ nullable: true }) financeConfirmedAt: string | null;
  @Column({ default: false }) archived: boolean;
  @Column({ nullable: true }) archivedAt: string | null;
  @Column({ nullable: true }) archiveNo: string | null;     // 归档单号 AR20260925-xxx
  @Column() createdAt: string;
  @Column({ nullable: true }) processedAt: string | null;
  @Column({ nullable: true }) paidAt: string | null;
}

/* ---------------- 广播 / 天气 / 管制 / 围栏 ---------------- */

@Entity('broadcasts')
export class Broadcast {
  @PrimaryGeneratedColumn() id: number;
  @Column({ default: 0 }) stationId: number; // 0 = 全线
  @Column() content: string;
  @Column({ default: 'staff' }) spokenByRole: string;
  @Column() createdAt: string;
}

@Entity('weather')
export class Weather {
  @PrimaryGeneratedColumn() id: number;
  @Column({ default: '多云' }) condition: string;
  @Column('int', { default: 26 }) tempC: number;
  @Column({ default: '' }) warning: string;          // 无 / 暴雨橙色 / ...
  @Column({ default: 0 }) warningLevel: number;       // 0 无 1 蓝 2 黄 3 橙 4 红
  @Column('int', { default: 0 }) rainfallMmH: number;
  @Column() updatedAt: string;
}

@Entity('road_controls')
export class RoadControl {
  @PrimaryGeneratedColumn() id: number;
  @Column({ nullable: true }) stationId: number | null;
  @Column() segment: string;
  @Column({ default: '' }) reason: string;
  @Column({ default: 'active' }) status: 'active' | 'lifted';
  @Column() startAt: string;
  @Column({ nullable: true }) endAt: string | null;
}

@Entity('geofence_events')
export class GeofenceEvent {
  @PrimaryGeneratedColumn() id: number;
  @Column() vehicleId: number;
  @Column() stationId: number;
  @Column() kind: 'enter' | 'leave';
  @Column('float', { default: 0 }) lat: number;
  @Column('float', { default: 0 }) lng: number;
  @Column() at: string;
}

/* ---------------- 团队包车 ---------------- */

@Entity('charter_orders')
export class CharterOrder {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;            // CH20260925-001
  @Column() teamName: string;
  @Column() contact: string;
  @Column() phone: string;
  @Column('int') peopleCount: number;
  @Column({ default: 0 }) needWheelchair: number;
  @Column({ nullable: true }) vehicleId: number | null;
  @Column({ nullable: true }) driverId: number | null;
  @Column() startStationId: number;
  @Column({ default: '' }) routePlan: string;
  @Column() useDate: string;
  @Column('int', { default: 0 }) amount: number;
  @Column({ default: 'pending' })
  status: 'pending' | 'confirmed' | 'ongoing' | 'completed' | 'cancelled';
  @Column({ default: '' }) note: string;
  @Column() createdAt: string;
}

/* ---------------- 暴雨临时停运 ---------------- */

@Entity('storm_suspensions')
export class StormSuspension {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;              // SS20260925-001
  @Column({ nullable: true }) routeId: number | null;  // null = 全线
  @Column({ default: '暴雨橙色预警' }) warning: string;
  @Column() reason: string;
  @Column({ default: 'active' }) status: 'active' | 'resumed'; // 停运中 / 已恢复
  @Column() startedAt: string;
  @Column({ nullable: true }) resumedAt: string | null;
  @Column({ default: '' }) resumeNote: string;
  // 三类受影响对象统计（simple-json）
  @Column('simple-json', { nullable: true })
  affected: {
    trips: string[];             // 受影响班次号
    onboardTicketIds: number[];  // 在途车辆上已检票车票
    queuedTicketIds: number[];   // 站点排队车票
    uncheckedTicketIds: number[];// 未检票有效车票
    vehicleIds: number[];
    driverIds: number[];
  } | null;
  @Column({ default: '' }) serviceScript: string;      // 客服统一口径
}

/** 停运期间司机收车记录（调度中心登记） */
@Entity('storm_return_logs')
export class StormReturnLog {
  @PrimaryGeneratedColumn() id: number;
  @Column() suspensionId: number;
  @Column() tripId: number;
  @Column() vehicleId: number;
  @Column() driverId: number;
  @Column({ default: '' }) returnStation: string;      // 就近停靠点
  @Column('int', { default: 0 }) onboardPeople: number; // 收车时在车人数
  @Column({ default: '' }) note: string;
  @Column() createdAt: string;
}

/** 停运后车辆充电安排（调度中心登记） */
@Entity('storm_charge_plans')
export class StormChargePlan {
  @PrimaryGeneratedColumn() id: number;
  @Column() suspensionId: number;
  @Column() vehicleId: number;
  @Column({ default: 'planned' }) status: 'planned' | 'charging' | 'done';
  @Column('int', { default: 100 }) targetBattery: number;
  @Column({ nullable: true }) plannedAt: string | null;
  @Column({ default: '' }) slot: string;               // 充电车位/桩位
  @Column({ default: '' }) note: string;
  @Column() createdAt: string;
  @Column({ nullable: true }) finishedAt: string | null;
}

export const ALL_ENTITIES = [
  RouteLine, Station, Vehicle, Driver, SafetyCheck, Trip, Ticket, QueueEntry,
  Incident, Refund, Broadcast, Weather, RoadControl, GeofenceEvent, CharterOrder,
  StormSuspension, StormReturnLog, StormChargePlan,
];
