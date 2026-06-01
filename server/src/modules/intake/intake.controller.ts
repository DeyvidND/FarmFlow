import { Controller, Post, Param, Body, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IntakeService } from './intake.service';
import { NewsletterDto } from './dto/newsletter.dto';
import { ContactDto } from './dto/contact.dto';

/** Public storefront intake endpoints (newsletter + contact form). */
@ApiTags('public')
@Controller('public/:slug')
export class PublicIntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Post('newsletter')
  @HttpCode(200)
  newsletter(@Param('slug') slug: string, @Body() dto: NewsletterDto) {
    return this.intake.subscribe(slug, dto);
  }

  @Post('contact')
  @HttpCode(200)
  contact(@Param('slug') slug: string, @Body() dto: ContactDto) {
    return this.intake.contact(slug, dto);
  }
}
