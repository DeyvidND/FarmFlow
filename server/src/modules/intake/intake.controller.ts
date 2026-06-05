import { Controller, Post, Param, Body, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IntakeService } from './intake.service';
import { NewsletterDto } from './dto/newsletter.dto';
import { ContactDto } from './dto/contact.dto';

/** Public storefront intake endpoints (newsletter + contact form). */
@ApiTags('public')
@Controller('public/:slug')
export class PublicIntakeController {
  constructor(private readonly intake: IntakeService) {}

  // Anti-spam on anonymous, email-triggering intake. 5/min/IP each.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('newsletter')
  @HttpCode(200)
  newsletter(@Param('slug') slug: string, @Body() dto: NewsletterDto) {
    return this.intake.subscribe(slug, dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('contact')
  @HttpCode(200)
  contact(@Param('slug') slug: string, @Body() dto: ContactDto) {
    return this.intake.contact(slug, dto);
  }
}
