import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  QueueEntry, Ticket, Trip, Vehicle, Incident, Refund, Station,
} from '../entities';

@Injectable()
export class OpsService {
  constructor(
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
  ) {}

  /** 运营复盘：站点等待 / 车辆利用率 / 投诉原因 / 退票成本 */
  async report() {
    const [entries, allTickets, trips, vehicles, incs, refunds, stations] = await Promise.all([
      this.queue.find(),
      this.tickets.find(),
      this.trips.find(),
      this.vehicles.find(),
      this.incidents.find(),
      this.refunds.find(),
      this.stations.find(),
    ]);

    /* ---- 站点等待 ---- */
    const stationWait = stations.map(s => {
      const es = entries.filter(e => e.stationId === s.id);
      const boarded = es.filter(e => e.status === 'boarded');
      const waits = boarded.map(e => e.waitSeconds).filter(w => w >= 0);
      const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
      const max = waits.length ? Math.max(...waits) : 0;
      const skipped = es.filter(e => e.status === 'skipped').length;
      return {
        stationId: s.id, stationName: s.name, isHot: s.isHot,
        queueGroups: es.length,
        boardedGroups: boarded.length,
        avgWaitSeconds: avg,
        maxWaitSeconds: max,
        skippedGroups: skipped,
      };
    }).sort((a, b) => b.avgWaitSeconds - a.avgWaitSeconds);

    /* ---- 车辆利用率 ---- */
    const vehicleUtil = vehicles.map(v => {
      const vt = trips.filter(t => t.vehicleId === v.id);
      const completed = vt.filter(t => t.status === 'completed');
      const sold = completed.reduce((a, t) => a + t.seatsSold, 0);
      const capacityTotal = completed.reduce((a, t) => a + t.seatsTotal, 0);
      return {
        vehicleId: v.id, vehicleCode: v.code, accessible: v.accessible,
        trips: vt.length,
        completedTrips: completed.length,
        loadFactor: capacityTotal ? Math.round((sold / capacityTotal) * 100) : 0,
        mileageKm: v.mileageKm,
        battery: v.battery,
        status: v.status,
        breakdownTrips: vt.filter(t => t.status === 'suspended').length,
      };
    }).sort((a, b) => b.loadFactor - a.loadFactor);

    /* ---- 投诉/事件原因分布 ---- */
    const complaintTypes = ['long_queue', 'skip_station', 'wrong_direction', 'priority_dispute',
      'vehicle_fault', 'handover_delay', 'storm_suspension', 'refund_request'];
    const typeLabel: Record<string, string> = {
      long_queue: '排队过长', skip_station: '满载跳站', wrong_direction: '误乘反方向',
      priority_dispute: '优先乘车争议', vehicle_fault: '车辆故障',
      handover_delay: '交班延误', storm_suspension: '暴雨停运', refund_request: '退票诉求',
    };
    const complaintReasons = complaintTypes.map(tp => ({
      type: tp,
      label: typeLabel[tp],
      count: incs.filter(i => i.type === tp).length,
      critical: incs.filter(i => i.type === tp && i.severity === 'critical').length,
      resolved: incs.filter(i => i.type === tp && ['resolved', 'closed'].includes(i.status)).length,
    })).filter(x => x.count > 0).sort((a, b) => b.count - a.count);

    /* ---- 退票成本 ---- */
    const paid = refunds.filter(r => ['paid', 'archived'].includes(r.status));
    const approved = refunds.filter(r => r.status === 'approved');
    const pending = refunds.filter(r => r.status === 'pending');
    const escalated = refunds.filter(r => r.status === 'escalated');
    const archived = refunds.filter(r => r.archived);
    const byFault = (['storm', 'vehicle', 'schedule', 'visitor', 'other'] as const).map(f => {
      const rows = refunds.filter(r => r.faultTag === f);
      return {
        fault: f,
        label: ({ storm: '暴雨停运', vehicle: '车辆故障', schedule: '调度延误', visitor: '游客自身', other: '其他' } as Record<string, string>)[f],
        count: rows.length,
        paidAmount: rows.filter(r => ['paid', 'archived'].includes(r.status)).reduce((a, r) => a + r.amount, 0),
        approvedAmount: rows.filter(r => ['approved', 'paid', 'archived'].includes(r.status)).reduce((a, r) => a + r.amount, 0),
      };
    }).filter(x => x.count > 0);

    const ticketRevenue = allTickets
      .filter(t => !['refunded'].includes(t.status))
      .reduce((a, t) => a + t.price, 0);
    const refundPaidTotal = paid.reduce((a, r) => a + r.amount, 0);

    /* ---- 总览 KPI ---- */
    const completedTrips = trips.filter(t => t.status === 'completed');
    const allBoarded = entries.filter(e => e.status === 'boarded');
    const kpi = {
      ticketsSold: allTickets.length,
      ticketsUsed: allTickets.filter(t => t.status === 'used').length,
      tripsTotal: trips.length,
      tripsCompleted: completedTrips.length,
      tripsSuspended: trips.filter(t => t.status === 'suspended').length,
      avgLoadFactor: (() => {
        const sold = completedTrips.reduce((a, t) => a + t.seatsSold, 0);
        const cap = completedTrips.reduce((a, t) => a + t.seatsTotal, 0);
        return cap ? Math.round((sold / cap) * 100) : 0;
      })(),
      avgWaitSeconds: (() => {
        const w = allBoarded.map(e => e.waitSeconds);
        return w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length) : 0;
      })(),
      refundRate: allTickets.length
        ? Math.round((refunds.filter(r => r.kind === 'refund'
            && ['approved', 'paid', 'archived'].includes(r.status)).length / allTickets.length) * 100)
        : 0,
      refundPaidTotal,
      archivedCount: archived.length,
      ticketRevenue,
      pendingRefund: pending.length + approved.length,
      escalatedRefund: escalated.length,
      openIncidents: incs.filter(i => ['open', 'processing', 'escalated'].includes(i.status)).length,
    };

    return { kpi, stationWait, vehicleUtil, complaintReasons, refundByFault: byFault };
  }
}
