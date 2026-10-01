import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { BuyTicketDto, RefundRequestDto } from './dto';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly svc: TicketsService) {}

  @Post()
  buy(@Body() dto: BuyTicketDto) {
    return this.svc.buy(dto);
  }

  @Get()
  list() {
    return this.svc.list();
  }

  @Get('refunds')
  refunds(@Query('status') status?: string) {
    return this.svc.listRefunds(status);
  }

  @Get('code/:code')
  byCode(@Param('code') code: string) {
    return this.svc.findByCode(code);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.svc.detail(Number(id));
  }

  @Post(':id/refund')
  refund(@Param('id') id: string, @Body() dto: RefundRequestDto) {
    return this.svc.requestRefund(Number(id), dto);
  }

  /** 暴雨停运：游客对被锁定车票三选一（改乘/延期/退票） */
  @Post(':id/storm-option')
  stormOption(@Param('id') id: string,
              @Body() body: { option: 'transfer' | 'postpone' | 'refund'; postponeDate?: string }) {
    return this.svc.stormChoose(Number(id), body.option, { postponeDate: body.postponeDate });
  }
}
