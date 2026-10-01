import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { DispatchService } from './dispatch.service';

@Controller()
export class DispatchController {
  constructor(private readonly svc: DispatchService) {}

  /* 调度看板 */
  @Get('dispatch/dashboard')
  dashboard() {
    return this.svc.dashboard();
  }

  /* 车辆 / 司机 */
  @Get('vehicles')
  vehicles() {
    return this.svc.listVehicles();
  }

  @Get('drivers')
  drivers() {
    return this.svc.listDrivers();
  }

  @Post('drivers/:id/duty')
  duty(@Param('id') id: string, @Body() body: { action: 'on' | 'off' | 'rest' | 'finish_rest' }) {
    return this.svc.driverDuty(Number(id), body.action);
  }

  @Post('drivers/:id/handover-delay')
  handoverDelay(@Param('id') id: string, @Body() body: { minutes: number; reason: string }) {
    return this.svc.handoverDelay(Number(id), body);
  }

  @Post('vehicles/:id/charge')
  charge(@Param('id') id: string, @Body() body: { target?: number }) {
    return this.svc.charge(Number(id), body.target);
  }

  @Post('vehicles/:id/fault')
  fault(@Param('id') id: string, @Body() body: { detail: string }) {
    return this.svc.reportFault(Number(id), body.detail);
  }

  @Post('vehicles/:id/repair')
  repair(@Param('id') id: string) {
    return this.svc.repairVehicle(Number(id));
  }

  /* 安检 */
  @Post('safety-checks')
  safetyCheck(@Body() body: {
    vehicleId: number; driverId: number;
    items: Record<string, boolean>; note?: string;
  }) {
    return this.svc.safetyCheck(body);
  }

  @Get('safety-checks')
  latestChecks() {
    return this.svc.latestChecks();
  }

  /* 班次 */
  @Post('trips')
  dispatchTrip(@Body() body: {
    vehicleId: number; driverId: number;
    originStationId: number; destStationId: number;
    direction?: 'forward' | 'backward' | 'loop';
    departNow?: boolean;
  }) {
    return this.svc.dispatchTrip(body);
  }

  @Post('trips/:id/start-boarding')
  startBoarding(@Param('id') id: string) {
    return this.svc.startBoarding(Number(id));
  }

  @Post('trips/:id/arrive')
  arrive(@Param('id') id: string, @Body() body: { stationId: number }) {
    return this.svc.arriveStation(Number(id), Number(body.stationId));
  }

  @Post('trips/:id/leave')
  leave(@Param('id') id: string, @Body() body: { stationId: number }) {
    return this.svc.leaveStation(Number(id), Number(body.stationId));
  }

  @Post('trips/:id/complete')
  complete(@Param('id') id: string) {
    return this.svc.completeTrip(Number(id));
  }

  /* 天气 / 管制 / 围栏 / 停运 */
  @Get('weather')
  weather() {
    return this.svc.currentWeather();
  }

  @Post('weather')
  updateWeather(@Body() body: any) {
    return this.svc.updateWeather(body);
  }

  @Get('road-controls')
  controls() {
    return this.svc.listControls();
  }

  @Post('road-controls')
  addControl(@Body() body: { stationId?: number; segment: string; reason: string }) {
    return this.svc.addRoadControl(body);
  }

  @Post('road-controls/:id/lift')
  liftControl(@Param('id') id: string) {
    return this.svc.liftControl(Number(id));
  }

  @Get('geofence-events')
  geofence(@Query('vehicleId') vehicleId?: string) {
    return this.svc.listGeofence(vehicleId ? Number(vehicleId) : undefined);
  }

  @Post('dispatch/storm-suspend')
  stormSuspend(@Body() body: { reason: string; routeId?: number }) {
    return this.svc.stormSuspend(body.reason, body.routeId);
  }

  @Get('dispatch/storm-overview')
  stormOverview() {
    return this.svc.stormOverview();
  }

  @Get('dispatch/suspensions')
  suspensions() {
    return this.svc.listSuspensions();
  }

  /** 调度登记司机收车 */
  @Post('dispatch/storm-return')
  stormReturn(@Body() body: {
    suspensionId: number; tripId?: number; vehicleId: number; driverId: number;
    returnStation: string; onboardPeople: number; note?: string;
  }) {
    return this.svc.stormReturnVehicle(body);
  }

  /** 登记停运后车辆充电安排 */
  @Post('dispatch/storm-charge-plan')
  stormChargePlan(@Body() body: {
    suspensionId: number; vehicleId: number; targetBattery?: number;
    slot?: string; plannedAt?: string; note?: string;
  }) {
    return this.svc.stormChargePlan(body);
  }

  /** 充电安排推进：开始充电 / 充电完成 */
  @Post('dispatch/storm-charge-plan/:id/status')
  stormChargeUpdate(@Param('id') id: string, @Body() body: { status: 'charging' | 'done' }) {
    return this.svc.stormChargeUpdate(Number(id), body.status);
  }

  @Post('dispatch/resume')
  resume(@Body() body: { note?: string }) {
    return this.svc.resumeOperation(body.note);
  }

  /* 包车 */
  @Get('charters')
  charters() {
    return this.svc.listCharters();
  }

  @Post('charters')
  createCharter(@Body() body: any) {
    return this.svc.createCharter(body);
  }

  @Post('charters/:id/assign')
  assignCharter(@Param('id') id: string,
                @Body() body: { vehicleId: number; driverId: number; note?: string }) {
    return this.svc.assignCharter(Number(id), body);
  }

  @Post('charters/:id/status')
  charterStatus(@Param('id') id: string, @Body() body: { status: any }) {
    return this.svc.updateCharterStatus(Number(id), body.status);
  }
}
