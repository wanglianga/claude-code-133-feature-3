import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Vehicle, Driver, Trip, Ticket, QueueEntry, Station, RouteLine, Weather,
  RoadControl, GeofenceEvent, SafetyCheck, CharterOrder, Incident, Refund,
  Broadcast, StormSuspension, StormReturnLog, StormChargePlan,
} from '../entities';
import { DispatchService } from './dispatch.service';
import { DispatchController } from './dispatch.controller';
import { IncidentsModule } from '../incidents/incidents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Vehicle, Driver, Trip, Ticket, QueueEntry, Station, RouteLine, Weather,
      RoadControl, GeofenceEvent, SafetyCheck, CharterOrder, Incident, Refund,
      Broadcast, StormSuspension, StormReturnLog, StormChargePlan,
    ]),
    IncidentsModule,
  ],
  providers: [DispatchService],
  controllers: [DispatchController],
  exports: [DispatchService],
})
export class DispatchModule {}
