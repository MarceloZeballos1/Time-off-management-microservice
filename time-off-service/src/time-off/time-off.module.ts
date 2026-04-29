import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffService } from './time-off.service';
import { TimeOffController } from './time-off.controller';
import { Balance } from './entities/balance.entity';
import { TimeOffRequest } from './entities/time-off-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, TimeOffRequest])],
  controllers: [TimeOffController],
  providers: [TimeOffService],
})
export class TimeOffModule {}
