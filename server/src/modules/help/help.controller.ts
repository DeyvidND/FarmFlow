import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { HelpAiService } from './help-ai.service';
import { HelpAskDto } from './dto/help-ask.dto';

/** Docs-grounded AI Q&A for the Help pages. No tenant/live-data access by design. */
@ApiTags('help')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('help')
export class HelpController {
  constructor(private readonly helpAi: HelpAiService) {}

  @Roles('admin', 'farmer', 'driver')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('ai/ask')
  async ask(@Body() dto: HelpAskDto) {
    const answer = await this.helpAi.ask(dto.surface, dto.question);
    return { answer };
  }
}
