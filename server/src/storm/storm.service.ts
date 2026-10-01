import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  StormSuspension, StormAffectedTicket, VehicleGaragePlan, RefundArchive,
  Trip, Ticket, QueueEntry, Station, Vehicle, Driver, Weather, Refund,
} from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { now, seqCode, TICKET_UNIT_PRICE, TICKET_TYPE_LABEL } from '../common';

const STORM_LEVEL = 3;

const PHASE_LABEL: Record<string, string> = {
  onboard: '在途车辆', queuing: '站点排队', unticketed: '未检票订单',
};
const OPTION_LABEL: Record<string, string> = {
  transfer: '改乘', postpone: '延期', refund: '退票', keep: '待选择',
};

@Injectable()
export class StormService {
  constructor(
    @InjectRepository(StormSuspension) private readonly suspensions: Repository<StormSuspension>,
    @InjectRepository(StormAffectedTicket) private readonly affected: Repository<StormAffectedTicket>,
    @InjectRepository(VehicleGaragePlan) private readonly garagePlans: Repository<VehicleGaragePlan>,
    @InjectRepository(RefundArchive) private readonly archives: Repository<RefundArchive>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(Weather) private readonly weatherRepo: Repository<Weather>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    private readonly incidentSvc: IncidentsService,
  ) {}

  /** 当前生效中的停运单（全线优先；可按线路过滤） */
  async activeSuspension(routeId?: number): Promise<StormSuspension | null> {
    const rows = await this.suspensions.find({
      where: { status: 'active' }, order: { id: 'DESC' }, take: 1,
    });
    if (!rows[0]) return null;
    if (routeId && rows[0].routeId && rows[0].routeId !== routeId) return null;
    return rows[0];
  }

  /* ================= 一键停运 ================= */

  async suspend(body: { reason: string; routeId?: number }) {
    const reason = (body.reason || '').trim();
    if (!reason) throw new BadRequestException('请填写停运原因（预警与降雨情况）');
    if (await this.activeSuspension()) throw new BadRequestException('已有进行中的停运单，请先恢复运营后再发起');

    const weather = (await this.weatherRepo.find({ order: { id: 'DESC' }, take: 1 }))[0];
    if (!weather || weather.warningLevel < STORM_LEVEL) {
      throw new BadRequestException('气象预警未达橙色（等级≥3），不满足暴雨停运条件');
    }

    const routeStations = await this.stations.find({
      where: body.routeId ? { routeId: body.routeId } : {},
    });
    const stationIds = routeStations.map(s => s.id);

    const sus = await this.suspensions.save(this.suspensions.create({
      code: seqCode('SS'),
      reason,
      routeId: body.routeId || null,
      warningLevel: weather.warningLevel,
      warningLabel: weather.warning || '暴雨橙色预警',
      status: 'active',
      serviceScript: this.buildScript(weather, reason),
      startedAt: now(),
    }));

    /* 1) 锁定受影响班次（在运/计划） */
    const qb = this.trips.createQueryBuilder('t')
      .where('t.status IN (:...s)', { s: ['scheduled', 'boarding', 'running', 'delayed'] });
    if (body.routeId) qb.andWhere('t.routeId = :r', { r: body.routeId });
    const activeTrips = await qb.getMany();
    const tripVehicleIds = new Set<number>();
    for (const t of activeTrips) {
      t.status = 'suspended';
      t.suspendReason = `${weather.warning || '暴雨'}临时停运：${reason}`;
      await this.trips.save(t);
      tripVehicleIds.add(t.vehicleId);
    }

    /* 2) 在途车辆：锁定已上车票 */
    let nOnboard = 0;
    for (const t of activeTrips) {
      const onboard = await this.tickets.find({ where: { tripId: t.id, status: 'boarded' } });
      for (const tk of onboard) {
        await this.lockTicket(sus, tk, 'onboard', t.id, tk.originStationId);
        nOnboard += 1;
      }
    }

    /* 3) 站点排队：锁定队列与车票 */
    let nQueuing = 0;
    const entries = await this.queue.find({
      where: { stationId: In(stationIds), status: In(['waiting', 'called', 'skipped']) },
    });
    for (const e of entries) {
      const tk = await this.tickets.findOne({ where: { id: e.ticketId } });
      if (!tk || tk.stormLocked) continue;
      e.status = 'transferred';
      e.stormLocked = true;
      e.stormSuspensionId = sus.id;
      await this.queue.save(e);
      await this.lockTicket(sus, tk, 'queuing', e.tripId, e.stationId);
      nQueuing += 1;
    }

    /* 4) 未检票订单：已购票但尚未排队的游客（仅状态 valid） */
    let nUnticketed = 0;
    const unticketed = await this.tickets.find({
      where: { status: 'valid', originStationId: In(stationIds) },
    });
    for (const tk of unticketed) {
      if (tk.stormLocked) continue;
      await this.lockTicket(sus, tk, 'unticketed', null, tk.originStationId);
      nUnticketed += 1;
    }

    /* 5) 调度记录：司机收车与车辆充电安排 */
    for (const t of activeTrips) {
      const v = await this.vehicles.findOne({ where: { id: t.vehicleId } });
      const exists = await this.garagePlans.findOne({
        where: { stormSuspensionId: sus.id, vehicleId: t.vehicleId },
      });
      if (!v || exists) continue;
      await this.garagePlans.save(this.garagePlans.create({
        stormSuspensionId: sus.id,
        vehicleId: v.id,
        driverId: t.driverId,
        tripId: t.id,
        collectStatus: 'pending',
        chargeStatus: v.battery <= 35 ? 'pending' : 'not_needed',
        batteryAtSuspend: v.battery,
        batteryAfterCharge: 0,
        createdAt: now(),
      }));
    }

    sus.affectedTrips = activeTrips.length;
    sus.affectedOnboard = nOnboard;
    sus.affectedQueuing = nQueuing;
    sus.affectedUnticketed = nUnticketed;
    await this.suspensions.save(sus);

    /* 6) 事件串联（客服统一口径） */
    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'critical',
      title: `${weather.warning || '暴雨'}临时停运：${activeTrips.length} 个班次中断`,
      detail: `${reason}｜在途 ${nOnboard} 张、站点排队 ${nQueuing} 张、未检票 ${nUnticketed} 张已锁定；`
        + `游客可选择改乘/延期/退票，退票按票种全额、财务确认后原路退回；${tripVehicleIds.size} 台车等待司机收车登记`,
      raisedByRole: 'dispatch', ownerRole: 'dispatch',
      firstNote: `调度中心启动暴雨停运预案（${sus.code}）：车票/排队/在途车辆全部锁定，客服已同步统一口径`,
    });

    return this.board(sus.id);
  }

  /** 锁定一张票并生成受影响处置记录 + 客服事件（客服统一口径） */
  private async lockTicket(
    sus: StormSuspension, tk: Ticket,
    phase: 'onboard' | 'queuing' | 'unticketed',
    tripId: number | null, stationId: number | null,
  ) {
    const unit = TICKET_UNIT_PRICE[tk.type] || TICKET_UNIT_PRICE.single;
    const face = unit * tk.partySize;
    tk.stormLocked = true;
    tk.stormPhase = phase;
    tk.stormSuspensionId = sus.id;
    tk.stormOption = '';
    tk.stormNote = '';
    await this.tickets.save(tk);

    const row = await this.affected.save(this.affected.create({
      stormSuspensionId: sus.id,
      ticketId: tk.id,
      phase,
      ticketType: tk.type,
      visitorName: tk.visitorName,
      partySize: tk.partySize,
      unitPrice: unit,
      faceAmount: face,
      tripId,
      stationId,
      status: 'pending',
      option: 'keep',
      refundAmount: 0,
      rescheduleAmount: 0,
      createdAt: now(),
    }));

    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'critical',
      title: `暴雨停运处置：${tk.visitorName} 的${TICKET_TYPE_LABEL[tk.type] || tk.type}（${PHASE_LABEL[phase]}）`,
      detail: `${sus.serviceScript}｜票面 ${TICKET_TYPE_LABEL[tk.type] || tk.type} ${tk.partySize} 人，`
        + `退票可退 ¥${(face / 100).toFixed(2)}；改乘/延期免费，改期保留金额 ¥${(face / 100).toFixed(2)}`,
      ticketId: tk.id, tripId: tripId || undefined, stationId,
      raisedByRole: 'dispatch', ownerRole: 'service',
      firstNote: `停运锁定（${PHASE_LABEL[phase]}）：等待游客选择改乘 / 延期 / 退票`,
    });
    return row;
  }

  private buildScript(weather: Weather, reason: string) {
    return `【暴雨临时停运统一口径】因${weather.warning || '暴雨'}（${reason}），景区观光车临时停运：`
      + '①已上车游客由工作人员引导就近下车避雨，可改乘恢复后班次、免费延期或按票种全额退票；'
      + '②站点排队及未检票游客请在车票页选择改乘、延期或退票；'
      + '③退票按票种全额（单程¥20/人、环线¥35/人、亲子¥30/人、无障碍优先¥20/人），财务确认后原路退回；'
      + '④改乘、延期均不收手续费。客服统一按此口径答复。';
  }

  /* ================= 游客三选一：改乘 / 延期 / 退票 ================= */

  async chooseOption(affectedId: number, body: {
    option: 'transfer' | 'postpone' | 'refund'; postponedDate?: string; note?: string;
  }) {
    const row = await this.affected.findOne({ where: { id: affectedId } });
    if (!row) throw new NotFoundException('受影响车票记录不存在');
    if (['transferred', 'postponed', 'refund_pending', 'refunded'].includes(row.status)) {
      throw new BadRequestException(`该票已选择「${OPTION_LABEL[row.option]}」，不可重复选择`);
    }
    const sus = await this.suspensions.findOne({ where: { id: row.stormSuspensionId } });
    if (!sus) throw new NotFoundException('停运单不存在');
    const tk = await this.tickets.findOne({ where: { id: row.ticketId } });
    if (!tk) throw new NotFoundException('车票不存在');

    row.option = body.option;
    row.optionAt = now();
    row.note = body.note || '';

    if (body.option === 'refund') {
      // 财务按票种生成退票金额：无责全额，政策内自动核准并同步财务待确认
      const refund = await this.refunds.save(this.refunds.create({
        code: seqCode('RF'),
        ticketId: tk.id,
        amount: row.faceAmount,
        reason: `${sus.warningLabel}临时停运，游客选择退票（${PHASE_LABEL[row.phase]}）`,
        faultTag: 'storm',
        applicantRole: 'system',
        status: 'approved', // 停运无责，政策内自动核准，客服只同步口径
        serviceNote: sus.serviceScript,
        stormSuspensionId: sus.id,
        ticketType: row.ticketType,
        unitPrice: row.unitPrice,
        partySize: row.partySize,
        resolutionKind: 'refund',
        refundAmount: row.faceAmount,
        rescheduleAmount: 0,
        financeSynced: true,
        financeSyncedAt: now(),
        processedAt: now(),
        createdAt: now(),
      }));
      row.status = 'refund_pending';
      row.refundId = refund.id;
      row.refundAmount = row.faceAmount;
      tk.status = 'refund_pending';
      tk.stormRefundId = refund.id;
      tk.stormOption = 'refund';
      tk.stormOptionAt = now();
      await this.tickets.save(tk);
      const inc = await this.incidentByTicket(tk.id);
      if (inc) {
        await this.incidentSvc.update(inc.id, { refundId: refund.id, status: 'processing' },
          { role: 'visitor', text: `游客选择退票：按${TICKET_TYPE_LABEL[row.ticketType] || row.ticketType}核算全额 ¥${(row.faceAmount / 100).toFixed(2)}，已同步财务确认` });
      }
    } else if (body.option === 'postpone') {
      const date = this.postponeDate(body.postponedDate);
      row.status = 'postponed';
      row.postponedDate = date;
      row.rescheduleAmount = row.faceAmount; // 改期保留金额（挂账不退款）
      tk.postponedDate = date;
      tk.stormOption = 'postpone';
      tk.stormOptionAt = now();
      await this.tickets.save(tk);
      await this.noteTicket(tk.id, 'visitor',
        `游客选择延期至 ${date}：免费改期，票款 ¥${(row.faceAmount / 100).toFixed(2)} 挂账保留，运营恢复后可凭原票乘车`);
    } else {
      row.status = 'transferred';
      row.rescheduleAmount = row.faceAmount;
      tk.stormOption = 'transfer';
      tk.stormOptionAt = now();
      await this.tickets.save(tk);
      await this.noteTicket(tk.id, 'visitor',
        `游客选择改乘：运营恢复后安排就近班次接驳，免费改乘，票款 ¥${(row.faceAmount / 100).toFixed(2)} 挂账保留`);
    }
    await this.affected.save(row);
    return this.ticketStormInfo(tk.id);
  }

  private postponeDate(v?: string) {
    if (v && v.trim()) return v.trim().slice(0, 10);
    const d = new Date(Date.now() + 86400000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private async incidentByTicket(ticketId: number) {
    const rows = await this.incidentSvc.list({ ticketId, type: 'storm_suspension' });
    return rows[0] || null;
  }

  private async noteTicket(ticketId: number, role: string, text: string) {
    const inc = await this.incidentByTicket(ticketId);
    if (inc) await this.incidentSvc.update(inc.id, { status: 'resolved' }, { role, text });
  }

  /* ================= 调度：司机收车 / 车辆充电安排 ================= */

  async collectVehicle(planId: number, body: { note?: string }) {
    const plan = await this.garagePlans.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('收车安排不存在');
    if (plan.collectStatus === 'returned') throw new BadRequestException('该车已登记收车');
    const [v, d, t] = await Promise.all([
      this.vehicles.findOne({ where: { id: plan.vehicleId } }),
      this.drivers.findOne({ where: { id: plan.driverId } }),
      plan.tripId ? this.trips.findOne({ where: { id: plan.tripId } }) : Promise.resolve(null),
    ]);
    plan.collectStatus = 'returned';
    plan.collectedAt = now();
    plan.collectNote = body.note || '司机已就近安全停靠并收车回库';
    await this.garagePlans.save(plan);
    if (v) { v.status = 'idle'; v.currentTripId = null; await this.vehicles.save(v); }
    if (d) { d.status = 'on_duty'; d.currentVehicleId = null; await this.drivers.save(d); }
    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'warn',
      title: `暴雨收车：${v?.code || plan.vehicleId} / 司机 ${d?.name || plan.driverId}`,
      detail: `${plan.collectNote}${t ? `；原班次 ${t.code} 已停运` : ''}；充电安排：${this.chargeLabel(plan.chargeStatus)}`,
      vehicleId: plan.vehicleId, tripId: plan.tripId || undefined,
      raisedByRole: 'driver', ownerRole: 'dispatch', status: 'closed',
      firstNote: '调度中心登记司机收车完成',
    });
    return this.findPlan(plan.id);
  }

  async arrangeCharge(planId: number, body: {
    action: 'schedule' | 'charging' | 'done' | 'not_needed';
    scheduledAt?: string; target?: number; note?: string;
  }) {
    const plan = await this.garagePlans.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('充电安排不存在');
    if (plan.collectStatus !== 'returned') throw new BadRequestException('请先登记司机收车，再安排充电');
    const v = await this.vehicles.findOne({ where: { id: plan.vehicleId } });
    if (!v) throw new NotFoundException('车辆不存在');

    plan.chargeNote = body.note || plan.chargeNote;
    if (body.action === 'schedule') {
      plan.chargeStatus = 'scheduled';
      plan.chargeScheduledAt = body.scheduledAt || now();
    } else if (body.action === 'charging') {
      plan.chargeStatus = 'charging';
      if (!plan.chargeScheduledAt) plan.chargeScheduledAt = now();
      v.status = 'charging';
      await this.vehicles.save(v);
    } else if (body.action === 'done') {
      plan.chargeStatus = 'done';
      plan.chargeDoneAt = now();
      const target = body.target && body.target > 0 ? Math.min(100, body.target) : 100;
      plan.batteryAfterCharge = target;
      v.battery = target;
      v.status = 'idle';
      await this.vehicles.save(v);
    } else {
      plan.chargeStatus = 'not_needed';
      plan.batteryAfterCharge = v.battery;
    }
    await this.garagePlans.save(plan);
    return this.findPlan(plan.id);
  }

  private chargeLabel(s: string) {
    return ({ pending: '待安排', scheduled: '已排期', charging: '充电中', done: '充电完成', not_needed: '电量充足无需充电' } as Record<string, string>)[s] || s;
  }

  /* ================= 恢复运营 ================= */

  async resume(body: { note?: string }) {
    const sus = await this.activeSuspension();
    if (!sus) throw new BadRequestException('当前没有进行中的停运单');
    sus.status = 'resumed';
    sus.resumedAt = now();
    sus.resumeNote = body.note || '预警解除，恢复运营';
    await this.suspensions.save(sus);

    // 未选择 / 改乘 / 延期的车票恢复有效；退票流程中的继续锁定至财务完成
    const rows = await this.affected.find({ where: { stormSuspensionId: sus.id } });
    for (const r of rows) {
      const tk = await this.tickets.findOne({ where: { id: r.ticketId } });
      if (!tk) continue;
      if (r.status === 'refund_pending' || r.status === 'refunded') continue;
      tk.stormLocked = false;
      tk.stormPhase = '';
      tk.stormOption = r.option === 'keep' ? '' : r.option;
      tk.stormOptionAt = r.optionAt;
      if (tk.status !== 'used') {
        tk.status = 'valid';
        tk.tripId = null;
      }
      await this.tickets.save(tk);
      if (r.status === 'pending') {
        r.status = 'closed';
        r.note = `${r.note ? `${r.note}；` : ''}运营恢复，游客未作选择，车票恢复有效`;
        await this.affected.save(r);
        await this.noteTicket(tk.id, 'dispatch', '运营恢复：未选择处置的车票自动解锁恢复有效');
      } else if (r.status === 'transferred' || r.status === 'postponed') {
        await this.noteTicket(tk.id, 'dispatch', '运营恢复：改乘/延期车票已解锁，可凭原票重新排队乘车');
      }
    }
    // 排队锁解除（记录保留为 transferred，游客重新扫码入队）
    const lockedEntries = await this.queue.find({ where: { stormSuspensionId: sus.id, stormLocked: true } });
    for (const e of lockedEntries) { e.stormLocked = false; await this.queue.save(e); }

    await this.incidentSvc.create({
      type: 'storm_suspension', severity: 'info',
      title: `暴雨停运 ${sus.code} 已恢复运营`,
      detail: sus.resumeNote || '预警解除，恢复运营',
      raisedByRole: 'dispatch', ownerRole: 'dispatch', status: 'closed',
      firstNote: '调度宣布恢复运营，改乘/延期车票已解锁；退票中的仍由财务完成确认',
    });
    return this.board(sus.id);
  }

  /** 财务完成退票后回填受影响票状态（由财务服务调用） */
  async markRefundedByRefundId(refundId: number) {
    const row = await this.affected.findOne({ where: { refundId } });
    if (!row) return;
    row.status = 'refunded';
    await this.affected.save(row);
    const tk = await this.tickets.findOne({ where: { id: row.ticketId } });
    if (tk) { tk.stormLocked = false; tk.stormPhase = ''; await this.tickets.save(tk); }
    await this.noteTicket(row.ticketId, 'finance',
      `财务已确认退票 ¥${(row.refundAmount / 100).toFixed(2)} 并出账，退票单已同步归档`);
  }

  /* ================= 看板 / 查询 ================= */

  async board(suspensionId?: number) {
    const sus = suspensionId
      ? await this.suspensions.findOne({ where: { id: suspensionId } })
      : await this.activeSuspension();
    if (!sus) return { suspension: null };
    return this.hydrate(sus);
  }

  async listBoards() {
    const list = await this.suspensions.find({ order: { id: 'DESC' }, take: 20 });
    return Promise.all(list.map(s => this.hydrate(s, true)));
  }

  /** 客服端：停运统一口径 + 处置进度 */
  async serviceBoard() {
    const sus = await this.activeSuspension();
    if (!sus) return { suspension: null };
    return this.hydrate(sus);
  }

  private async hydrate(sus: StormSuspension, summaryOnly = false) {
    const [rows, plans, stations, vehicles, drivers, trips] = await Promise.all([
      this.affected.find({ where: { stormSuspensionId: sus.id }, order: { id: 'ASC' } }),
      this.garagePlans.find({ where: { stormSuspensionId: sus.id }, order: { id: 'ASC' } }),
      this.stations.find(),
      this.vehicles.find(),
      this.drivers.find(),
      this.trips.find(),
    ]);
    const sMap = new Map(stations.map(s => [s.id, s]));
    const vMap = new Map(vehicles.map(v => [v.id, v]));
    const dMap = new Map(drivers.map(d => [d.id, d]));

    const refundIds = rows.map(r => r.refundId).filter(Boolean) as number[];
    const refundRows = refundIds.length ? await this.refunds.find({ where: { id: In(refundIds) } }) : [];
    const refundMap = new Map(refundRows.map(r => [r.id, r]));

    const affected = rows.map(r => ({
      ...r,
      phaseLabel: PHASE_LABEL[r.phase],
      optionLabel: OPTION_LABEL[r.option],
      ticketTypeLabel: TICKET_TYPE_LABEL[r.ticketType] || r.ticketType,
      stationName: r.stationId ? sMap.get(r.stationId)?.name || '' : '',
      tripCode: r.tripId ? trips.find(t => t.id === r.tripId)?.code || '' : '',
      refund: r.refundId ? refundMap.get(r.refundId) || null : null,
    }));

    const garage = plans.map(p => ({
      ...p,
      chargeStatusLabel: this.chargeLabel(p.chargeStatus),
      vehicleCode: vMap.get(p.vehicleId)?.code || '',
      vehiclePlate: vMap.get(p.vehicleId)?.plate || '',
      driverName: dMap.get(p.driverId)?.name || '',
      vehicleStatus: vMap.get(p.vehicleId)?.status || '',
      currentBattery: vMap.get(p.vehicleId)?.battery ?? p.batteryAtSuspend,
    }));

    // 按票种汇总改期/退票金额
    const byType = Object.keys(TICKET_UNIT_PRICE).map(tp => {
      const list = rows.filter(r => r.ticketType === tp);
      return {
        ticketType: tp,
        ticketTypeLabel: TICKET_TYPE_LABEL[tp] || tp,
        unitPrice: TICKET_UNIT_PRICE[tp],
        count: list.length,
        refundCount: list.filter(r => r.status === 'refund_pending' || r.status === 'refunded').length,
        refundAmount: list.reduce((a, r) => a + r.refundAmount, 0),
        rescheduleCount: list.filter(r => r.status === 'transferred' || r.status === 'postponed').length,
        rescheduleAmount: list.reduce((a, r) => a + r.rescheduleAmount, 0),
      };
    }).filter(x => x.count > 0);

    const counts = {
      total: rows.length,
      pending: rows.filter(r => r.status === 'pending').length,
      transferred: rows.filter(r => r.status === 'transferred').length,
      postponed: rows.filter(r => r.status === 'postponed').length,
      refundPending: rows.filter(r => r.status === 'refund_pending').length,
      refunded: rows.filter(r => r.status === 'refunded').length,
      onboard: rows.filter(r => r.phase === 'onboard').length,
      queuing: rows.filter(r => r.phase === 'queuing').length,
      unticketed: rows.filter(r => r.phase === 'unticketed').length,
      toCollect: plans.filter(p => p.collectStatus === 'pending').length,
      charging: plans.filter(p => ['pending', 'scheduled', 'charging'].includes(p.chargeStatus)).length,
    };
    const totals = {
      refundAmount: rows.reduce((a, r) => a + r.refundAmount, 0),
      refundPaid: rows.filter(r => r.status === 'refunded').reduce((a, r) => a + r.refundAmount, 0),
      rescheduleAmount: rows.reduce((a, r) => a + r.rescheduleAmount, 0),
    };

    return {
      suspension: sus,
      counts,
      totals,
      byType,
      affected: summaryOnly ? [] : affected,
      garage: summaryOnly ? [] : garage,
    };
  }

  private async findPlan(id: number) {
    const plan = await this.garagePlans.findOne({ where: { id } });
    if (!plan) return null;
    const sus = await this.suspensions.findOne({ where: { id: plan.stormSuspensionId } });
    if (!sus) return null;
    const full = await this.hydrate(sus);
    return { ...full, garagePlan: full.garage.find((g: any) => g.id === id) };
  }

  /** 车票的停运处置信息（游客页） */
  async ticketStormInfo(ticketId: number) {
    const row = await this.affected.findOne({ where: { ticketId }, order: { id: 'DESC' } });
    if (!row) return null;
    const sus = await this.suspensions.findOne({ where: { id: row.stormSuspensionId } });
    return {
      affected: {
        ...row,
        phaseLabel: PHASE_LABEL[row.phase],
        optionLabel: OPTION_LABEL[row.option],
        ticketTypeLabel: TICKET_TYPE_LABEL[row.ticketType] || row.ticketType,
      },
      suspension: sus ? {
        id: sus.id, code: sus.code, status: sus.status, reason: sus.reason,
        warningLabel: sus.warningLabel, serviceScript: sus.serviceScript,
      } : null,
    };
  }

  /* ================= 归档查询 ================= */

  async listArchives() {
    return this.archives.find({ order: { id: 'DESC' }, take: 100 });
  }
}
