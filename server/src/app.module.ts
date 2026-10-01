import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from './entities';
import { IncidentsModule } from './incidents/incidents.module';
import { TicketsModule } from './tickets/tickets.module';
import { StationsModule } from './stations/stations.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { ServiceModule } from './service/service.module';
import { OpsModule } from './ops/ops.module';
import { StormModule } from './storm/storm.module';
import { SeedService } from './seed.service';

function dbConfig() {
  const type = (process.env.DB_TYPE || 'sqlite').toLowerCase();
  if (type === 'mysql') {
    return {
      type: 'mysql' as const,
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'root',
      database: process.env.DB_NAME || 'scenic_shuttle',
      charset: 'utf8mb4',
    };
  }
  return {
    type: 'better-sqlite3' as const,
    database: process.env.SQLITE_PATH || `${__dirname}/../data/app.sqlite`,
  };
}

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...dbConfig(),
      entities: ALL_ENTITIES,
      synchronize: true,
      logging: false,
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
    IncidentsModule,
    TicketsModule,
    StationsModule,
    DispatchModule,
    ServiceModule,
    OpsModule,
    StormModule,
  ],
  providers: [SeedService],
})
export class AppModule {}
