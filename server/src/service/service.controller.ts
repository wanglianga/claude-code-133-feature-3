import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ServiceService } from './service.service';

@Controller()
export class ServiceController {
  constructor(private readonly svc: ServiceService) {}

  @Get('service/workbench')
  workbench() {
    return this.svc.workbench();
  }

  @Get('finance/ledger')
  ledger() {
    return this.svc.financeLedger();
  }

  @Post('refunds/:id/approve')
  approve(@Param('id') id: string, @Body() body: { note: string }) {
    return this.svc.approve(Number(id), body.note);
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

  /* 财务确认退票（金额按票种核对） */
  @Post('refunds/:id/finance-confirm')
  financeConfirm(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.financeConfirm(Number(id), body.note);
  }

  /* 财务出账退款（须先确认；出账后自动归档） */
  @Post('refunds/:id/pay')
  pay(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.pay(Number(id), body.note);
  }

  @Post('incidents/:id/take')
  take(@Param('id') id: string, @Body() body: { role: 'service' | 'dispatch' | 'staff' }) {
    return this.svc.takeIncident(Number(id), body.role);
  }
}
