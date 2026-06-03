import { Controller, Get, Post, Query, Body, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { NewsletterService } from './newsletter.service';
import { BroadcastDto } from './dto/broadcast.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('newsletter')
@Controller()
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  /** List all subscribers for the current tenant (active + unsubscribed). */
  @Get('subscribers')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  getSubscribers(@CurrentTenant() tenantId: string) {
    return this.newsletterService.getSubscribers(tenantId);
  }

  /** Send a broadcast to all active subscribers. */
  @Post('broadcast')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  broadcast(@CurrentTenant() tenantId: string, @Body() dto: BroadcastDto) {
    return this.newsletterService.broadcast(tenantId, dto);
  }

  /**
   * Public unsubscribe endpoint — no auth guard.
   * Verifies the JWT token, sets unsubscribedAt, returns an HTML confirmation page.
   */
  @Get('unsubscribe')
  @ApiQuery({ name: 'token', required: true })
  async publicUnsubscribe(@Query('token') token: string, @Res() res: Response) {
    const result = await this.newsletterService.unsubscribe(token ?? '');

    if (result.success) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Отписване</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#333">
  <h1 style="font-size:24px;color:#2d6a4f">Отписахте се успешно.</h1>
  <p style="color:#555">Вече няма да получавате имейли от тази ферма.</p>
</body>
</html>`);
    } else {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Грешка</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#333">
  <h1 style="font-size:24px;color:#c0392b">Невалидна връзка.</h1>
  <p style="color:#555">Връзката за отписване е невалидна или е изтекла.</p>
</body>
</html>`);
    }
  }
}
