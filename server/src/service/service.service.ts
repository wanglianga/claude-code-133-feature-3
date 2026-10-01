import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Refund, Ticket, Incident, Trip, StormSuspension } from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { now, seqCode } from '../common';

@Injectable()
export class ServiceService {
  constructor(
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(StormSuspension) private readonly suspensions: Repository<StormSuspension>,
    private readonly incidentSvc: IncidentsService,
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

    // 进行中暴雨停运：统一口径 + 三类待处理 + 金额汇总
    const activeSuspension = await this.suspensions.findOne({
      where: { status: 'active' }, order: { id: 'DESC' },
    });
    let storm = null;
    if (activeSuspension) {
      const locked = await this.tickets.find({
        where: { suspensionId: activeSuspension.id, stormLocked: true },
      });
      const stormRefunds = await this.refunds.find({
        where: { suspensionId: activeSuspension.id },
      });
      const pendingChoose = locked.filter(t => !t.stormOption);
      storm = {
        suspension: activeSuspension,
        script: activeSuspension.serviceScript,
        pendingChoose: {
          onboard: pendingChoose.filter(t => t.stormCategory === 'onboard').length,
          queued: pendingChoose.filter(t => t.stormCategory === 'queued').length,
          unchecked: pendingChoose.filter(t => t.stormCategory === 'unchecked').length,
        },
        optionStats: {
          transfer: locked.filter(t => t.stormOption === 'transfer').length,
          postpone: locked.filter(t => t.stormOption === 'postpone').length,
          refund: locked.filter(t => t.stormOption === 'refund').length,
        },
        refundPending: stormRefunds.filter(r => r.kind === 'refund' && r.status === 'pending').length,
        refundApproved: stormRefunds.filter(r => r.kind === 'refund' && r.status === 'approved').length,
        refundPaid: stormRefunds.filter(r => r.kind === 'refund' && r.status === 'paid').length,
        refundAmount: stormRefunds.filter(r => r.kind === 'refund')
          .reduce((a, r) => a + r.amount, 0),
        carriedAmount: stormRefunds.filter(r => r.kind !== 'refund')
          .reduce((a, r) => a + r.carriedAmount, 0),
      };
    }

    return {
      pendingRefunds: pendingRefunds.map(withTicket),
      escalatedRefunds: escalated.map(withTicket),
      openIncidents,
      storm,
      counts: {
        pendingRefund: pendingRefunds.length,
        escalated: escalated.length,
        openIncident: openIncidents.length,
      },
    };
  }

  /** 客服直接同意退票（责任明确：暴雨/车辆/调度）→ 金额同步财务，待财务确认/付款 */
  async approve(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'pending') throw new BadRequestException(`退票单状态 ${r.status}，不可审批`);
    r.status = 'approved';
    r.serviceNote = note;
    r.processedAt = now();
    await this.refunds.save(r);
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (t) { t.status = 'refunded'; await this.tickets.save(t); }
    await this.syncIncident(r, 'processing', 'service',
      `客服核准退票 ¥${(r.amount / 100).toFixed(2)}：${note}；退票金额已同步财务，等待财务确认出账`);
    return r;
  }

  /** 客服批量核准某停运单下的全部暴雨退票（无责全额，口径一致） */
  async approveStormBatch(suspensionId: number, note: string) {
    const s = await this.suspensions.findOne({ where: { id: suspensionId } });
    if (!s) throw new NotFoundException('停运单不存在');
    const rows = await this.refunds.find({
      where: { suspensionId, kind: 'refund', status: 'pending' },
    });
    let amount = 0;
    for (const r of rows) {
      r.status = 'approved';
      r.serviceNote = note || `暴雨停运无责全额退票，客服批量核准（${s.code}）`;
      r.processedAt = now();
      await this.refunds.save(r);
      amount += r.amount;
      const t = await this.tickets.findOne({ where: { id: r.ticketId } });
      if (t) { t.status = 'refunded'; await this.tickets.save(t); }
      await this.syncIncident(r, 'processing', 'service',
        `客服批量核准暴雨退票 ¥${(r.amount / 100).toFixed(2)}，金额已同步财务`);
    }
    return { approved: rows.length, amount, codes: rows.map(r => r.code) };
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
    if (t) {
      t.status = 'refund_rejected';
      // 暴雨票被驳回：保留停运锁定与三选一资格，游客可改选改乘/延期或重新申请
      if (t.suspensionId) t.stormOption = '' as any;
      await this.tickets.save(t);
    }
    await this.syncIncident(r, 'resolved', 'service', `客服驳回退票：${note}，游客可重新选择改乘/延期`);
    return r;
  }

  /** 退票争议：升级客服主管 */
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
      if (t) { t.status = 'refunded'; await this.tickets.save(t); }
      await this.syncIncident(r, 'processing', 'service_supervisor',
        `客服主管裁决同意退票：${body.note}；金额同步财务确认出账`);
    } else {
      r.status = 'rejected';
      if (t) {
        t.status = 'refund_rejected';
        if (t.suspensionId) { t.stormLocked = false; t.stormOption = '' as any; }
        await this.tickets.save(t);
      }
      await this.syncIncident(r, 'resolved', 'service_supervisor',
        `客服主管裁决维持驳回：${body.note}`);
    }
    return this.refunds.save(r);
  }

  /** 财务确认退票：复核退票金额、登记渠道与备注（出账前确认） */
  async financeConfirm(refundId: number, body: { note?: string; channel?: string }) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.kind !== 'refund') throw new BadRequestException('改乘/延期单为票款结转，无需财务确认退款');
    if (r.status !== 'approved') throw new BadRequestException('仅客服已核准的退票单可由财务确认');
    r.financeConfirmedAt = now();
    r.financeNote = body.note || '财务复核金额无误';
    r.financePayChannel = body.channel || '原路退回';
    await this.refunds.save(r);
    await this.syncIncident(r, 'processing', 'finance',
      `财务已确认退票 ¥${(r.amount / 100).toFixed(2)}（${r.financePayChannel}）：${r.financeNote}；待出账`);
    return r;
  }

  /** 财务付款出账：需先经财务确认 */
  async pay(refundId: number, note = '原路退回') {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'approved') throw new BadRequestException('仅已核准退票单可付款');
    if (!r.financeConfirmedAt) {
      // 兼容旧流程：付款时补一次确认
      r.financeConfirmedAt = now();
      r.financePayChannel = r.financePayChannel || '原路退回';
    }
    r.status = 'paid';
    r.paidAt = now();
    if (!r.supervisorNote && note) r.supervisorNote = note;
    await this.refunds.save(r);
    await this.syncIncident(r, 'closed', 'finance',
      `财务已出账 ¥${(r.amount / 100).toFixed(2)}（${r.financePayChannel || note}），可归档`);
    return r;
  }

  /** 退票单同步归档：退票已付款 / 改乘延期已结转，生成归档单号 */
  async archive(refundId: number, note?: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.archived) throw new BadRequestException('该单已归档');
    if (r.kind === 'refund') {
      if (r.status !== 'paid') throw new BadRequestException('退票单须出账完成后方可归档');
    } else {
      if (!['approved', 'paid'].includes(r.status)) {
        throw new BadRequestException('改乘/延期单确认结转后方可归档');
      }
    }
    r.archived = true;
    r.archivedAt = now();
    r.archiveNo = seqCode('AR');
    if (note) r.financeNote = `${r.financeNote}${r.financeNote ? '；' : ''}${note}`;
    r.status = 'archived';
    await this.refunds.save(r);
    await this.syncIncident(r, 'closed', 'finance',
      r.kind === 'refund'
        ? `退票单 ${r.code} 已同步归档（归档号 ${r.archiveNo}）`
        : `${r.kind === 'transfer' ? '改乘' : '延期'}单 ${r.code} 已结转归档（归档号 ${r.archiveNo}）`);
    return r;
  }

  /** 客服领取/流转其他事件 */
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
