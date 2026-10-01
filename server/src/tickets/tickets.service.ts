import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket, Refund, QueueEntry, Station, Incident, StormSuspension } from '../entities';
import { BuyTicketDto, RefundRequestDto } from './dto';
import { IncidentsService } from '../incidents/incidents.service';
import {
  now, seqCode, ticketPrice, waitSeconds,
  stormRefundAmount, stormChangeAmounts, nextDayDate,
  STORM_POLICY,
} from '../common';

export type StormOption = 'transfer' | 'postpone' | 'refund';

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(StormSuspension) private readonly suspensions: Repository<StormSuspension>,
    private readonly incidents: IncidentsService,
  ) {}

  /** 游客购票：记录入园时间、起终站、同行人数、婴儿车/老人儿童、预计路线 */
  async buy(dto: BuyTicketDto): Promise<Ticket> {
    const [origin, dest] = await Promise.all([
      this.stations.findOne({ where: { id: dto.originStationId } }),
      this.stations.findOne({ where: { id: dto.destStationId } }),
    ]);
    if (!origin || !dest) throw new BadRequestException('起终点站不存在');
    if (dto.type !== 'loop' && origin.id === dest.id) {
      throw new BadRequestException('单程票起终站不能相同');
    }
    const partySize = dto.partySize || 1;
    const priority = dto.type === 'accessible_priority' || !!dto.needWheelchair || !!dto.hasElder;
    const expectedDirection =
      dto.type === 'loop' || origin.routeId !== dest.routeId
        ? 'loop'
        : origin.seq < dest.seq ? 'forward' : 'backward';

    const t = this.tickets.create({
      code: seqCode('T'),
      type: dto.type,
      visitorName: dto.visitorName,
      phone: dto.phone || '',
      partySize,
      hasStroller: !!dto.hasStroller,
      hasElder: !!dto.hasElder,
      hasChild: !!dto.hasChild || dto.type === 'parent_child',
      needWheelchair: !!dto.needWheelchair,
      priority,
      enterParkAt: now(),
      originStationId: origin.id,
      destStationId: dest.id,
      expectedDirection,
      plannedRoute: dto.plannedRoute || `${origin.name} → ${dest.name}`,
      price: ticketPrice(dto.type, partySize),
      status: 'valid',
      createdAt: now(),
    });
    const saved = await this.tickets.save(t);
    await this.incidents.create({
      type: 'info',
      severity: 'info',
      title: `${saved.visitorName} 购买${this.typeName(saved.type)}`,
      detail: `${origin.name} → ${dest.name}，同行 ${partySize} 人${saved.hasStroller ? '，携带婴儿车' : ''}${saved.hasElder ? '，含老人' : ''}${saved.hasChild ? '，含儿童' : ''}`,
      ticketId: saved.id,
      raisedByRole: 'visitor',
      ownerRole: 'system',
      status: 'closed',
    });
    return saved;
  }

  async list(): Promise<Ticket[]> {
    return this.tickets.find({ order: { id: 'DESC' } });
  }

  /** 车票详情：票 + 排队记录 + 退票单 + 关联事件时间线（所有角色围绕同一张票） */
  async detail(id: number) {
    const ticket = await this.tickets.findOne({ where: { id } });
    if (!ticket) throw new NotFoundException('车票不存在');
    const [queueEntries, refunds, incs] = await Promise.all([
      this.queue.find({ where: { ticketId: id }, order: { id: 'ASC' } }),
      this.refunds.find({ where: { ticketId: id }, order: { id: 'ASC' } }),
      this.incidents.byTicketOrTrip(id, ticket.tripId || undefined),
    ]);
    const [origin, dest] = await Promise.all([
      this.stations.findOne({ where: { id: ticket.originStationId } }),
      this.stations.findOne({ where: { id: ticket.destStationId } }),
    ]);
    return {
      ticket,
      origin,
      dest,
      queueEntries,
      refunds,
      incidents: incs,
      typeLabel: this.typeName(ticket.type),
      storm: ticket.stormLocked ? {
        category: ticket.stormCategory,
        categoryLabel: ({ onboard: '在途车辆', queued: '站点排队', unchecked: '未检票订单' } as Record<string, string>)[ticket.stormCategory] || ticket.stormCategory,
        option: ticket.stormOption,
        optionAt: ticket.stormOptionAt,
        postponeDate: ticket.postponeDate,
        suspensionId: ticket.suspensionId,
        finance: this.stormFinance(ticket),
      } : null,
      currentWaitSeconds: queueEntries.length
        ? waitSeconds(queueEntries[queueEntries.length - 1].enqueueAt)
        : 0,
    };
  }

  async findByCode(code: string) {
    const t = await this.tickets.findOne({ where: { code } });
    if (!t) throw new NotFoundException('车票不存在');
    return this.detail(t.id);
  }

  /** 游客/站务发起退票 → 生成退票单 + 事件，客服介入 */
  async requestRefund(ticketId: number, dto: RefundRequestDto) {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');
    if (ticket.stormLocked && ticket.stormOption !== 'refund') {
      throw new BadRequestException('车票在暴雨停运锁定中，请通过「改乘 / 延期 / 退票」停运通道处理');
    }
    if (['boarded', 'used'].includes(ticket.status)) {
      throw new BadRequestException('已检票上车的车票请走客服争议退票');
    }
    if (ticket.status === 'refund_pending') throw new BadRequestException('该票已在退票审核中');
    if (ticket.status === 'refunded') throw new BadRequestException('该票已退款');

    const r = this.refunds.create({
      code: seqCode('RF'),
      ticketId,
      amount: ticket.price,
      reason: dto.reason,
      faultTag: dto.faultTag || 'visitor',
      applicantRole: dto.applicantRole || 'visitor',
      status: 'pending',
      createdAt: now(),
    });
    const refund = await this.refunds.save(r);
    ticket.status = 'refund_pending';
    await this.tickets.save(ticket);

    const inc = await this.incidents.create({
      type: 'refund_request',
      severity: dto.faultTag === 'visitor' ? 'warn' : 'critical',
      title: `退票申请：${ticket.visitorName}（¥${(ticket.price / 100).toFixed(2)}）`,
      detail: `原因：${dto.reason}｜责任初判：${this.faultLabel(dto.faultTag || 'visitor')}`,
      ticketId,
      refundId: refund.id,
      raisedByRole: dto.applicantRole || 'visitor',
      ownerRole: 'service',
      status: 'open',
      firstNote: `${dto.applicantRole || 'visitor'} 提交退票申请，等待客服审核`,
    });
    return { refund, incident: inc };
  }

  async listRefunds(status?: string) {
    const rows = await this.refunds.find({
      where: status ? { status: status as any } : {},
      order: { id: 'DESC' },
    });
    const tickets = await this.tickets.find();
    const ticketMap = new Map(tickets.map(t => [t.id, t]));
    return rows.map(r => ({ ...r, ticket: ticketMap.get(r.ticketId) }));
  }

  /* ================= 暴雨临时停运：游客三选一 ================= */

  /** 停运车票按票种生成的改期/退票金额（游客页、客服、财务共用口径） */
  stormFinance(ticket: Ticket) {
    const refund = stormRefundAmount(ticket.type, ticket.partySize);
    const transfer = stormChangeAmounts(ticket.type, ticket.partySize, 'transfer');
    const postpone = stormChangeAmounts(ticket.type, ticket.partySize, 'postpone');
    return {
      policy: STORM_POLICY[ticket.type] || STORM_POLICY.single,
      refundAmount: refund,
      transfer: { fee: transfer.fee, carriedAmount: transfer.carriedAmount },
      postpone: { fee: postpone.fee, carriedAmount: postpone.carriedAmount },
    };
  }

  /**
   * 游客对被停运锁定的车票三选一：改乘 / 延期 / 退票
   * - 改乘：生成改乘单（免手续费、原票款结转），恢复后优先安排接驳/首班
   * - 延期：登记改期日期，票款结转，队列标记延期
   * - 退票：按票种生成全额退票单，客服核准 → 财务确认 → 归档
   */
  async stormChoose(ticketId: number, option: StormOption, body: { postponeDate?: string } = {}) {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');
    if (!ticket.stormLocked || !ticket.suspensionId) {
      throw new BadRequestException('该票未处于暴雨停运锁定状态');
    }
    if (ticket.stormOption) throw new BadRequestException('该票已做出停运选择，不能重复选择');
    const suspension = await this.suspensions.findOne({ where: { id: ticket.suspensionId } });
    if (!suspension) throw new NotFoundException('停运单不存在');

    ticket.stormOption = option;
    ticket.stormOptionAt = now();

    const fin = this.stormFinance(ticket);
    const categoryLabel = ({ onboard: '在途', queued: '排队', unchecked: '未检票' } as Record<string, string>)[ticket.stormCategory] || '';

    if (option === 'refund') {
      const amount = fin.refundAmount;
      const refund = await this.refunds.save(this.refunds.create({
        code: seqCode('RF'),
        ticketId: ticket.id,
        kind: 'refund',
        amount,
        carriedAmount: 0,
        reason: `${suspension.warning}临时停运（${categoryLabel}车票），游客选择全额退票`,
        faultTag: 'storm',
        applicantRole: 'visitor',
        status: 'pending',
        suspensionId: suspension.id,
        createdAt: now(),
      }));
      ticket.status = 'refund_pending';
      await this.tickets.save(ticket);
      const inc = await this.incidents.create({
        type: 'refund_request', severity: 'critical',
        title: `暴雨停运退票：${ticket.visitorName}（¥${(amount / 100).toFixed(2)}）`,
        detail: `${this.typeName(ticket.type)} × ${ticket.partySize} 人，按票种全额 ¥${(amount / 100).toFixed(2)}；停运无责免手续费，等待客服核准`,
        ticketId, refundId: refund.id, tripId: ticket.tripId,
        raisedByRole: 'visitor', ownerRole: 'service', status: 'open',
        firstNote: `游客在停运三选一中选择退票（${categoryLabel}）`,
      });
      return { option, refund, incident: inc, finance: fin };
    }

    if (option === 'postpone') {
      const date = body.postponeDate || nextDayDate();
      ticket.postponeDate = date;
      // 排队票：队列标记为延期；未检票/在途/被驳回票回到有效状态，改期日乘车
      const entry = await this.queue.findOne({
        where: { ticketId: ticket.id, status: 'storm_locked' },
      });
      if (entry) { entry.status = 'storm_postponed'; await this.queue.save(entry); }
      ticket.status = 'valid';
      await this.tickets.save(ticket);
      const change = await this.refunds.save(this.refunds.create({
        code: seqCode('RF'),
        ticketId: ticket.id,
        kind: 'postpone',
        amount: fin.postpone.fee,
        carriedAmount: fin.postpone.carriedAmount,
        reason: `${suspension.warning}临时停运，游客选择延期至 ${date}（免手续费，票款结转）`,
        faultTag: 'storm',
        applicantRole: 'visitor',
        status: 'approved', // 改期单无资金流出，客服口径直接确认，财务备案
        suspensionId: suspension.id,
        serviceNote: '暴雨停运延期：免手续费，原票款结转，优先/轮椅资格保留',
        processedAt: now(),
        createdAt: now(),
      }));
      const inc = await this.incidents.create({
        type: 'storm_suspension', severity: 'warn',
        title: `暴雨停运延期：${ticket.visitorName} 改期至 ${date}`,
        detail: `${this.typeName(ticket.type)} × ${ticket.partySize} 人；手续费 ¥0，原票款 ¥${(fin.postpone.carriedAmount / 100).toFixed(2)} 结转`,
        ticketId, refundId: change.id, tripId: ticket.tripId,
        raisedByRole: 'visitor', ownerRole: 'service', status: 'processing',
        firstNote: `游客选择延期（${categoryLabel}），改期日 ${date} 优先安排`,
      });
      return { option, change, incident: inc, finance: fin, postponeDate: date };
    }

    // transfer 改乘
    const entry = await this.queue.findOne({
      where: { ticketId: ticket.id, status: 'storm_locked' },
    });
    if (entry) {
      // 排队游客：保留顺位，恢复后按原顺位优先改乘首班 → 回到 waiting
      entry.status = 'waiting';
      await this.queue.save(entry);
    }
    if (ticket.status === 'boarded') ticket.status = 'valid'; // 在途改乘：回到待乘，由接驳/首班承载
    await this.tickets.save(ticket);
    const change = await this.refunds.save(this.refunds.create({
      code: seqCode('RF'),
      ticketId: ticket.id,
      kind: 'transfer',
      amount: fin.transfer.fee,
      carriedAmount: fin.transfer.carriedAmount,
      reason: `${suspension.warning}临时停运，游客选择改乘（恢复后首班/接驳车，免手续费，票款结转）`,
      faultTag: 'storm',
      applicantRole: 'visitor',
      status: 'approved',
      suspensionId: suspension.id,
      serviceNote: '暴雨停运改乘：免手续费，原票款结转，排队顺位保留',
      processedAt: now(),
      createdAt: now(),
    }));
    const inc = await this.incidents.create({
      type: 'storm_suspension', severity: 'warn',
      title: `暴雨停运改乘：${ticket.visitorName} 等候接驳/恢复后首班`,
      detail: `${this.typeName(ticket.type)} × ${ticket.partySize} 人；手续费 ¥0，原票款 ¥${(fin.transfer.carriedAmount / 100).toFixed(2)} 结转，排队顺位保留`,
      ticketId, refundId: change.id, tripId: ticket.tripId,
      raisedByRole: 'visitor', ownerRole: 'service', status: 'processing',
      firstNote: `游客选择改乘（${categoryLabel}），恢复运营后优先安排`,
    });
    return { option, change, incident: inc, finance: fin };
  }

  private typeName(t: string) {
    return ({
      single: '单程票', loop: '环线票', parent_child: '亲子票', accessible_priority: '无障碍优先票',
    } as Record<string, string>)[t] || t;
  }

  private faultLabel(f: string) {
    return ({
      visitor: '游客自身', storm: '暴雨停运', vehicle: '车辆故障',
      schedule: '调度延误', other: '其他',
    } as Record<string, string>)[f] || f;
  }
}
