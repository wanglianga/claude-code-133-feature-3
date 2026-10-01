import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ServiceService } from './service.service';

@Controller()
export class ServiceController {
  constructor(private readonly svc: ServiceService) {}

  @Get('service/workbench')
  workbench() {
    return this.svc.workbench();
  }

  @Post('refunds/:id/approve')
  approve(@Param('id') id: string, @Body() body: { note: string }) {
    return this.svc.approve(Number(id), body.note);
  }

  /** 客服批量核准某暴雨停运单下全部退票 */
  @Post('storm/:suspensionId/approve-refunds')
  approveStormBatch(@Param('suspensionId') sid: string, @Body() body: { note?: string }) {
    return this.svc.approveStormBatch(Number(sid), body.note || '');
  }

  @Post('refunds/:id/reject')
  reject(@Param('id') id: string, @Body() body: { note: string }) {
    return this.svc.reject(Number(id), body.note);
  }

  @Post('refunds/:id/escalate')
  escalate(@Param('id') id: string, @Body() body: { note: string }) {
    return this.svc.escalate(Number(id), body.note);
  }

  @Post('refunds/:id/supervisor-decide')
  supervisor(@Param('id') id: string,
             @Body() body: { approve: boolean; note: string }) {
    return this.svc.supervisorDecide(Number(id), body);
  }

  /** 财务确认退票（出账前复核金额/渠道） */
  @Post('refunds/:id/finance-confirm')
  financeConfirm(@Param('id') id: string,
                 @Body() body: { note?: string; channel?: string }) {
    return this.svc.financeConfirm(Number(id), body);
  }

  @Post('refunds/:id/pay')
  pay(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.pay(Number(id), body.note);
  }

  /** 退票单同步归档 */
  @Post('refunds/:id/archive')
  archive(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.archive(Number(id), body.note);
  }

  @Post('incidents/:id/take')
  take(@Param('id') id: string, @Body() body: { role: 'service' | 'dispatch' | 'staff' }) {
    return this.svc.takeIncident(Number(id), body.role);
  }
}
