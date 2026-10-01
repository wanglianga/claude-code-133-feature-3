import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Refund, Ticket, Incident, Trip, StormSuspension } from '../entities';
import { ServiceService } from './service.service';
import { ServiceController } from './service.controller';
import { IncidentsModule } from '../incidents/incidents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Refund, Ticket, Incident, Trip, StormSuspension]),
    IncidentsModule,
  ],
  providers: [ServiceService],
  controllers: [ServiceController],
})
export class ServiceModule {}
