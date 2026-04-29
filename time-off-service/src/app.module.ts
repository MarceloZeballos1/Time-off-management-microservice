import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './time-off/entities/balance.entity';
import { TimeOffRequest } from './time-off/entities/time-off-request.entity';
import { TimeOffModule } from './time-off/time-off.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'time-off.sqlite',
      entities: [Balance, TimeOffRequest],
      synchronize: true,
    }),
    TimeOffModule,
  ],
})
export class AppModule {}
