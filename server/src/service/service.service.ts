import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Refund, Ticket, Incident, Trip, RefundArchive } from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { StormService } from '../storm/storm.service';
import { now, seqCode, TICKET_UNIT_PRICE, TICKET_TYPE_LABEL } from '../common';

@Injectable()
export class ServiceService {
  constructor(
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(RefundArchive) private readonly archives: Repository<RefundArchive>,
    private readonly incidentSvc: IncidentsService,
    private readonly stormSvc: StormService,
  ) {}

  /** 客服工作台：待办退票 + 开放事件 + 暴雨停运统一口径 */
  async workbench() {
    const [pendingRefunds, openIncidents, escalated] = await Promise.all([
      this.refunds.find({ where: { status: 'pending' }, order: { id: 'ASC' } }),
      this.incidents.find({
        where: { status: 'open' as any }, order: { id: 'ASC' },
      }),
      this.refunds.find({ where: { status: 'escalated' }, order: { id: 'ASC' } }),
    ]);
    const ticketRows = await this.tickets.find();
    const tMap = new Map(ticketRows.map(t => [t.id, t]));
    const withTicket = (r: Refund) => ({ ...r, ticket: tMap.get(r.ticketId) });
    const storm: any = await this.stormSvc.serviceBoard();
    return {
      pendingRefunds: pendingRefunds.map(withTicket),
      escalatedRefunds: escalated.map(withTicket),
      openIncidents,
      storm,
      counts: {
        pendingRefund: pendingRefunds.length,
        escalated: escalated.length,
        openIncident: openIncidents.length,
        stormPendingChoice: storm.suspension ? (storm.counts?.pending ?? 0) : 0,
        stormRefundPending: storm.suspension ? (storm.counts?.refundPending ?? 0) : 0,
      },
    };
  }

  /** 客服直接同意退票（责任明确：暴雨/车辆/调度）→ 金额同步财务待确认 */
  async approve(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'pending') throw new BadRequestException(`退票单状态 ${r.status}，不可审批`);
    r.status = 'approved';
    r.serviceNote = note;
    r.processedAt = now();
    this.syncAmountToFinance(r);
    await this.refunds.save(r);
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (t) { t.status = 'refunded'; await this.tickets.save(t); }
    await this.syncIncident(r, 'processing', 'service',
      `客服核准退票 ¥${(r.amount / 100).toFixed(2)}：${note}；退票金额已同步财务，等待财务确认出账`);
    return r;
  }

  /** 客服驳回（游客自身原因且不满足退改规则） */
  async reject(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'pending') throw new BadRequestException(`退票单状态 ${r.status}，不可驳回`);
    r.status = 'rejected';
    r.serviceNote = note;
    r.processedAt = now();
    await this.refunds.save(r);
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (t) { t.status = 'refund_rejected'; await this.tickets.save(t); }
    await this.syncIncident(r, 'resolved', 'service',
      `客服驳回退票：${note}`);
    return r;
  }

  /** 退票争议：升级客服主管（如老人优先争议、责任界定不清、金额异议） */
  async escalate(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (!['pending', 'rejected'].includes(r.status)) {
      throw new BadRequestException(`退票单状态 ${r.status}，不可升级`);
    }
    r.status = 'escalated';
    r.serviceNote = note;
    await this.refunds.save(r);
    await this.syncIncident(r, 'escalated', 'service',
      `客服无法判定，升级客服主管：${note}`);
    return r;
  }

  /** 客服主管裁决：同意 / 驳回（终局） */
  async supervisorDecide(refundId: number, body: { approve: boolean; note: string }) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'escalated') throw new BadRequestException('仅升级中的退票单可由主管裁决');
    r.supervisorNote = body.note;
    r.processedAt = now();
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (body.approve) {
      r.status = 'approved';
      this.syncAmountToFinance(r);
      if (t) { t.status = 'refunded'; await this.tickets.save(t); }
      await this.refunds.save(r);
      await this.syncIncident(r, 'processing', 'service_supervisor',
        `客服主管裁决同意退票：${body.note}；退票金额已同步财务，等待财务确认出账`);
    } else {
      r.status = 'rejected';
      await this.refunds.save(r);
      if (t) { t.status = 'refund_rejected'; await this.tickets.save(t); }
      await this.syncIncident(r, 'resolved', 'service_supervisor',
        `客服主管裁决维持驳回：${body.note}`);
    }
    return r;
  }

  /** 财务确认退票：核对票种/金额无误后确认，方可出账 */
  async financeConfirm(refundId: number, note = '金额核对无误，确认退票') {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'approved') throw new BadRequestException('仅已核准退票单可由财务确认');
    if (!r.financeSynced) this.syncAmountToFinance(r);
    r.financeConfirmed = true;
    r.financeConfirmedAt = now();
    r.financeNote = note || r.financeNote;
    await this.refunds.save(r);
    await this.syncIncident(r, 'processing', 'finance',
      `财务已确认退票 ¥${(r.amount / 100).toFixed(2)}（${r.financeNote}），等待出账`);
    return r;
  }

  /** 财务出账：已确认退票单付款 → 同步归档 → 回填停运处置 */
  async pay(refundId: number, note = '原路退回') {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'approved') throw new BadRequestException('仅已核准退票单可付款');
    if (!r.financeConfirmed) throw new BadRequestException('请先由财务确认退票金额，再出账退款');
    r.status = 'paid';
    r.paidAt = now();
    if (note) r.financeNote = r.financeNote ? `${r.financeNote}；${note}` : note;
    await this.refunds.save(r);

    // 退票单同步归档
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (t) { t.status = 'refunded'; await this.tickets.save(t); }
    await this.archiveRefund(r, t);

    // 暴雨停运处置回填
    if (r.stormSuspensionId) await this.stormSvc.markRefundedByRefundId(r.id);

    await this.syncIncident(r, 'closed', 'finance',
      `财务已出账 ¥${(r.amount / 100).toFixed(2)}（${note}），退票单 ${r.archiveNo || ''} 已同步归档`);
    return r;
  }

  /** 退票单同步归档（票据/财务留痕） */
  private async archiveRefund(r: Refund, t: Ticket | null) {
    if (r.archived) return;
    const no = seqCode('AR');
    r.archived = true;
    r.archivedAt = now();
    r.archiveNo = no;
    await this.refunds.save(r);
    await this.archives.save(this.archives.create({
      archiveNo: no,
      refundId: r.id,
      ticketId: r.ticketId,
      refundCode: r.code,
      ticketCode: t?.code || '',
      ticketType: r.ticketType || t?.type || '',
      visitorName: t?.visitorName || '',
      amount: r.amount,
      faultTag: r.faultTag,
      resolutionKind: r.resolutionKind,
      stormRelated: !!r.stormSuspensionId,
      stormSuspensionId: r.stormSuspensionId,
      paidAt: r.paidAt || now(),
      archivedAt: now(),
    }));
  }

  /** 退票金额同步财务：按票种单价×人数落账，进入财务待确认队列 */
  private syncAmountToFinance(r: Refund) {
    const unit = r.unitPrice || TICKET_UNIT_PRICE[r.ticketType] || 0;
    if (!r.ticketType) r.ticketType = '';
    if (!r.unitPrice && unit) r.unitPrice = unit;
    if (!r.refundAmount) r.refundAmount = r.amount;
    if (!r.resolutionKind) r.resolutionKind = 'refund';
    r.financeSynced = true;
    r.financeSyncedAt = now();
  }

  /** 财务台账：待确认 / 待出账 / 已出账归档，按票种汇总 */
  async financeLedger() {
    const rows = await this.refunds.find({ order: { id: 'DESC' } });
    const tickets = await this.tickets.find();
    const tMap = new Map(tickets.map(t => [t.id, t]));
    const list = rows.map(r => ({ ...r, ticket: tMap.get(r.ticketId) }));
    const archives = await this.archives.find({ order: { id: 'DESC' }, take: 100 });

    const active = list.filter(r => ['approved', 'paid'].includes(r.status));
    const byType = Object.keys(TICKET_UNIT_PRICE).map(tp => {
      const rs = active.filter(r => (r.ticketType || r.ticket?.type) === tp);
      return {
        ticketType: tp,
        ticketTypeLabel: TICKET_TYPE_LABEL[tp] || tp,
        unitPrice: TICKET_UNIT_PRICE[tp],
        count: rs.length,
        amount: rs.reduce((a, r) => a + r.amount, 0),
        paidAmount: rs.filter(r => r.status === 'paid').reduce((a, r) => a + r.amount, 0),
      };
    }).filter(x => x.count > 0);

    return {
      refunds: list,
      archives,
      byType,
      totals: {
        toConfirm: list.filter(r => r.status === 'approved' && !r.financeConfirmed).length,
        toPay: list.filter(r => r.status === 'approved' && r.financeConfirmed).length,
        toConfirmAmount: list.filter(r => r.status === 'approved' && !r.financeConfirmed).reduce((a, r) => a + r.amount, 0),
        toPayAmount: list.filter(r => r.status === 'approved' && r.financeConfirmed).reduce((a, r) => a + r.amount, 0),
        paidAmount: list.filter(r => r.status === 'paid').reduce((a, r) => a + r.amount, 0),
        archivedCount: archives.length,
      },
    };
  }

  /** 客服领取/流转其他事件（优先争议、误乘、跳站投诉等） */
  async takeIncident(incidentId: number, role: 'service' | 'dispatch' | 'staff') {
    const inc = await this.incidents.findOne({ where: { id: incidentId } });
    if (!inc) throw new NotFoundException('事件不存在');
    const owner = role === 'service' ? 'service' : role;
    inc.status = 'processing';
    inc.ownerRole = owner as any;
    await this.incidents.save(inc);
    return this.incidentSvc.addNote(incidentId, role, '已领取并开始处理');
  }

  private async syncIncident(r: Refund, status: Incident['status'], role: string, text: string) {
    const inc = await this.incidents.findOne({ where: { refundId: r.id } });
    if (inc) {
      inc.status = status;
      await this.incidents.save(inc);
      await this.incidentSvc.addNote(inc.id, role, text);
    }
  }
}
