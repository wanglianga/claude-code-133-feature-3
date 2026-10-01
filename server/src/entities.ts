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
  status: 'idle' | 'running' | 'charging' | 'maintenance' | 'breakdown';
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
  @Column() createdAt: string;

  /* ---- 暴雨临时停运联动 ---- */
  @Column({ nullable: true }) stormSuspensionId: number | null;   // 被哪次停运锁定
  @Column({ default: false }) stormLocked: boolean;              // 停运锁定：不可检票/派用
  @Column({ default: '' })
  stormPhase: '' | 'onboard' | 'queuing' | 'unticketed';         // 在途车辆 / 站点排队 / 未检票
  @Column({ default: '' })
  stormOption: '' | 'transfer' | 'postpone' | 'refund' | 'keep'; // 游客选择：改乘 / 延期 / 退票
  @Column({ nullable: true }) stormOptionAt: string | null;
  @Column({ nullable: true }) postponedDate: string | null;      // 延期乘坐日期
  @Column({ nullable: true }) stormRefundId: number | null;      // 停运生成的退票单
  @Column({ default: '' }) stormNote: string;                    // 客服/调度处置备注
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
  status: 'waiting' | 'called' | 'boarded' | 'left' | 'skipped' | 'transferred';
  @Column() enqueueAt: string;
  @Column({ nullable: true }) boardAt: string | null;
  @Column({ nullable: true }) tripId: number | null;
  @Column('int', { default: 0 }) waitSeconds: number;
  @Column({ default: false }) stormLocked: boolean;   // 暴雨停运锁定排队
  @Column({ nullable: true }) stormSuspensionId: number | null;
}

/* ---------------- 事件中心（票 / 班车串联所有角色） ---------------- */

export type IncidentType =
  | 'long_queue' | 'skip_station' | 'wrong_direction' | 'priority_dispute'
  | 'vehicle_fault' | 'handover_delay' | 'storm_suspension'
  | 'refund_request' | 'charter' | 'info' | 'storm_reschedule';

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
  @Column('int') amount: number;            // 财务应退/已退金额（分）
  @Column({ default: '' }) reason: string;
  @Column({ default: '' }) faultTag: 'visitor' | 'storm' | 'vehicle' | 'schedule' | 'other';
  @Column({ default: 'pending' })
  status: 'pending' | 'approved' | 'rejected' | 'escalated' | 'paid';
  @Column({ default: 'visitor' }) applicantRole: 'visitor' | 'staff' | 'system';
  @Column({ default: '' }) serviceNote: string;
  @Column({ default: '' }) supervisorNote: string;
  /* ---- 暴雨停运按票种拆分核算 ---- */
  @Column({ nullable: true }) stormSuspensionId: number | null;
  @Column({ default: '' }) ticketType: string;                 // single/loop/parent_child/accessible_priority
  @Column('int', { default: 0 }) unitPrice: number;            // 票种单价（分/人）
  @Column('int', { default: 0 }) partySize: number;
  @Column({ default: '' })
  resolutionKind: '' | 'refund' | 'reschedule';               // 退票 / 改期
  @Column('int', { default: 0 }) rescheduleAmount: number;     // 改期补差（0=免费改期，>0 财务挂账）
  @Column('int', { default: 0 }) refundAmount: number;         // 退票金额（按票种全额，分）
  /* ---- 财务确认 + 归档 ---- */
  @Column({ default: false }) financeSynced: boolean;          // 金额已同步财务
  @Column({ nullable: true }) financeSyncedAt: string | null;
  @Column({ default: false }) financeConfirmed: boolean;       // 财务已确认
  @Column({ nullable: true }) financeConfirmedAt: string | null;
  @Column({ default: '' }) financeNote: string;
  @Column({ default: false }) archived: boolean;
  @Column({ nullable: true }) archivedAt: string | null;
  @Column({ nullable: true }) archiveNo: string | null;
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

export type StormPhase = 'onboard' | 'queuing' | 'unticketed'; // 在途车辆 / 站点排队 / 未检票订单
export type StormOption = 'transfer' | 'postpone' | 'refund' | 'keep'; // 改乘 / 延期 / 退票 / 暂未选择

@Entity('storm_suspensions')
export class StormSuspension {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;                    // SS20260925-001
  @Column() reason: string;                  // 停运原因（含预警/雨量）
  @Column({ nullable: true }) routeId: number | null; // null = 全线
  @Column('int') warningLevel: number;
  @Column({ default: '' }) warningLabel: string;
  @Column({ default: 'active' })
  status: 'active' | 'resumed';              // 停运中 / 已恢复
  @Column('int', { default: 0 }) affectedTrips: number;
  @Column('int', { default: 0 }) affectedOnboard: number;   // 在途车辆上的票
  @Column('int', { default: 0 }) affectedQueuing: number;   // 站点排队的票
  @Column('int', { default: 0 }) affectedUnticketed: number; // 未检票订单
  @Column({ default: '' }) serviceScript: string;           // 客服统一口径
  @Column() startedAt: string;
  @Column({ nullable: true }) resumedAt: string | null;
  @Column({ nullable: true }) resumeNote: string | null;
}

/** 停运期间每张受影响票的处置记录（锁定 → 三选一 → 处理结果/金额） */
@Entity('storm_affected_tickets')
export class StormAffectedTicket {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() stormSuspensionId: number;
  @Index() @Column() ticketId: number;
  @Column() phase: StormPhase;
  @Column() ticketType: string;
  @Column() visitorName: string;
  @Column('int') partySize: number;
  @Column('int') unitPrice: number;           // 票种单价（分/人）
  @Column('int') faceAmount: number;          // 票面金额（分）
  @Column({ nullable: true }) tripId: number | null;
  @Column({ nullable: true }) stationId: number | null;
  @Column({ default: 'pending' })
  status: 'pending' | 'transferred' | 'postponed' | 'refund_pending' | 'refunded' | 'closed';
  @Column({ default: 'keep' }) option: StormOption;
  @Column({ nullable: true }) optionAt: string | null;
  @Column({ nullable: true }) refundId: number | null;
  @Column('int', { default: 0 }) refundAmount: number;      // 按票种核算的退票金额
  @Column('int', { default: 0 }) rescheduleAmount: number;  // 改期金额（补差，分）
  @Column({ nullable: true }) postponedDate: string | null;
  @Column({ default: '' }) note: string;
  @Column() createdAt: string;
}

/** 调度中心记录：司机收车与车辆充电安排 */
@Entity('vehicle_garage_plans')
export class VehicleGaragePlan {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() stormSuspensionId: number;
  @Column() vehicleId: number;
  @Column() driverId: number;
  @Column({ nullable: true }) tripId: number | null;
  @Column({ default: 'pending' })
  collectStatus: 'pending' | 'returned';     // 收车：待收车 / 已收车回库
  @Column({ nullable: true }) collectedAt: string | null;
  @Column({ default: '' }) collectNote: string;
  @Column({ default: 'pending' })
  chargeStatus: 'pending' | 'scheduled' | 'charging' | 'done' | 'not_needed';
  @Column({ nullable: true }) chargeScheduledAt: string | null;
  @Column({ nullable: true }) chargeDoneAt: string | null;
  @Column('int', { default: 0 }) batteryAtSuspend: number;
  @Column('int', { default: 0 }) batteryAfterCharge: number;
  @Column({ default: '' }) chargeNote: string;
  @Column() createdAt: string;
}

/** 退票单财务出账后同步归档（票据/财务留痕） */
@Entity('refund_archives')
export class RefundArchive {
  @PrimaryGeneratedColumn() id: number;
  @Column() archiveNo: string;                // AR20260925-001
  @Column() refundId: number;
  @Column() ticketId: number;
  @Column() refundCode: string;
  @Column() ticketCode: string;
  @Column({ default: '' }) ticketType: string;
  @Column() visitorName: string;
  @Column('int') amount: number;
  @Column({ default: '' }) faultTag: string;
  @Column({ default: '' }) resolutionKind: string;
  @Column({ default: false }) stormRelated: boolean;
  @Column({ nullable: true }) stormSuspensionId: number | null;
  @Column() paidAt: string;
  @Column() archivedAt: string;
}

export const ALL_ENTITIES = [
  RouteLine, Station, Vehicle, Driver, SafetyCheck, Trip, Ticket, QueueEntry,
  Incident, Refund, Broadcast, Weather, RoadControl, GeofenceEvent, CharterOrder,
  StormSuspension, StormAffectedTicket, VehicleGaragePlan, RefundArchive,
];
