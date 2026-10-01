import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Refund, Ticket, Incident, Trip, RefundArchive } from '../entities';
import { ServiceService } from './service.service';
import { ServiceController } from './service.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { StormModule } from '../storm/storm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Refund, Ticket, Incident, Trip, RefundArchive]),
    IncidentsModule,
    StormModule,
  ],
  providers: [ServiceService],
  controllers: [ServiceController],
})
export class ServiceModule {}
