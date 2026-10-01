import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket, Refund, QueueEntry, Station, Incident } from '../entities';
import { BuyTicketDto, RefundRequestDto } from './dto';
import { IncidentsService } from '../incidents/incidents.service';
import { StormService } from '../storm/storm.service';
import { now, seqCode, ticketPrice, waitSeconds } from '../common';

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    private readonly incidents: IncidentsService,
    private readonly stormSvc: StormService,
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
    const stormInfo = await this.stormSvc.ticketStormInfo(id);
    return {
      ticket,
      origin,
      dest,
      queueEntries,
      refunds,
      incidents: incs,
      stormInfo,
      typeLabel: this.typeName(ticket.type),
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
    if (['boarded', 'used'].includes(ticket.status)) {
      throw new BadRequestException('已检票上车的车票请走客服争议退票');
    }
    if (ticket.status === 'refund_pending') throw new BadRequestException('该票已在退票审核中');
    if (ticket.status === 'refunded') throw new BadRequestException('该票已退款');
    if (ticket.stormLocked) {
      throw new BadRequestException('暴雨临时停运中：请通过停运处置选择「改乘 / 延期 / 退票」，停运退票按票种全额且无需客服审核');
    }

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
