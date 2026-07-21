import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { PnlService } from './pnl.service';
import { ExpensesService } from './expenses.service';

@Module({
  controllers: [StatsController],
  providers: [StatsService, PnlService, ExpensesService],
})
export class StatsModule {}
