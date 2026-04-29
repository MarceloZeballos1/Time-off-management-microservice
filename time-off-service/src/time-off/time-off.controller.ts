import { Controller, Post, Body, Get, Query, ValidationPipe } from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';

@Controller('time-off')
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  @Post('requests')
  async createRequest(@Body(new ValidationPipe({ whitelist: true })) createTimeOffRequestDto: CreateTimeOffRequestDto) {
    return this.timeOffService.createRequest(createTimeOffRequestDto);
  }

  @Get('balances')
  async getBalances(@Query('employeeId') employeeId: string, @Query('locationId') locationId: string) {
    return this.timeOffService.getBalances(employeeId, locationId);
  }

  @Post('sync/batch')
  async syncBatch(@Body('locationId') locationId: string, @Body('employeeId') employeeId?: string) {
    return this.timeOffService.reconcileBatch(locationId, employeeId);
  }
}
