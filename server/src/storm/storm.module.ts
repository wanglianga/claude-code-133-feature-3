import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  StormSuspension, StormAffectedTicket, VehicleGaragePlan, RefundArchive,
  Trip, Ticket, QueueEntry, Station, Vehicle, Driver, Weather, Refund,
} from '../entities';
import { StormService } from './storm.service';
import { StormController } from './storm.controller';
import { IncidentsModule } from '../incidents/incidents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StormSuspension, StormAffectedTicket, VehicleGaragePlan, RefundArchive,
      Trip, Ticket, QueueEntry, Station, Vehicle, Driver, Weather, Refund,
    ]),
    IncidentsModule,
  ],
  providers: [StormService],
  controllers: [StormController],
  exports: [StormService],
})
export class StormModule {}
