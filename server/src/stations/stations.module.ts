import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Station, RouteLine, QueueEntry, Ticket, Trip, Vehicle, Weather,
  Broadcast, RoadControl, GeofenceEvent, Incident,
} from '../entities';
import { StationsService } from './stations.service';
import { StationsController } from './stations.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { StormModule } from '../storm/storm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Station, RouteLine, QueueEntry, Ticket, Trip, Vehicle, Weather,
      Broadcast, RoadControl, GeofenceEvent, Incident,
    ]),
    IncidentsModule,
    StormModule,
  ],
  providers: [StationsService],
  controllers: [StationsController],
  exports: [StationsService],
})
export class StationsModule {}
