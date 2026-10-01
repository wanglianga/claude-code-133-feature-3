import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { StormService } from './storm.service';

@Controller()
export class StormController {
  constructor(private readonly svc: StormService) {}

  /* 调度：一键停运 / 恢复 */
  @Post('storm/suspend')
  suspend(@Body() body: { reason: string; routeId?: number }) {
    return this.svc.suspend(body);
  }

  @Post('storm/resume')
  resume(@Body() body: { note?: string }) {
    return this.svc.resume(body || {});
  }

  /* 停运看板（调度/客服） */
  @Get('storm/board')
  board(@Query('id') id?: string) {
    return this.svc.board(id ? Number(id) : undefined);
  }

  @Get('storm/list')
  list() {
    return this.svc.listBoards();
  }

  @Get('storm/service-board')
  serviceBoard() {
    return this.svc.serviceBoard();
  }

  /* 游客：车票停运处置信息 + 三选一 */
  @Get('storm/ticket/:ticketId')
  ticketInfo(@Param('ticketId') ticketId: string) {
    return this.svc.ticketStormInfo(Number(ticketId));
  }

  @Post('storm/affected/:id/choose')
  choose(@Param('id') id: string,
         @Body() body: { option: 'transfer' | 'postpone' | 'refund'; postponedDate?: string; note?: string }) {
    return this.svc.chooseOption(Number(id), body);
  }

  /* 调度：司机收车 / 车辆充电安排 */
  @Post('storm/garage/:id/collect')
  collect(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.collectVehicle(Number(id), body || {});
  }

  @Post('storm/garage/:id/charge')
  charge(@Param('id') id: string, @Body() body: {
    action: 'schedule' | 'charging' | 'done' | 'not_needed';
    scheduledAt?: string; target?: number; note?: string;
  }) {
    return this.svc.arrangeCharge(Number(id), body);
  }

  /* 归档 */
  @Get('storm/archives')
  archives() {
    return this.svc.listArchives();
  }
}
