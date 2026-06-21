import {
  Controller, Get, Post, Patch, Delete, HttpCode,
  Param, Body, Query, UseGuards, Res,
  UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiQuery, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { NewsletterService } from './newsletter.service';
import { UpsertCampaignDto } from './dto/campaign.dto';
import {
  UploadNewsletterMediaDto,
  NEWSLETTER_IMG_MIME_REGEX,
  NEWSLETTER_IMG_MAX_BYTES,
} from './dto/upload-newsletter-media.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

@ApiTags('newsletter')
@Controller()
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  /** Paginated subscribers for the current tenant (active + unsubscribed). */
  @Get('subscribers')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getSubscribers(@CurrentTenant() tenantId: string, @Query() q: PaginationQueryDto) {
    return this.newsletterService.getSubscribers(tenantId, { cursor: q.cursor, limit: q.limit });
  }

  /** Cost preview for the composer (active count, this-send cost, month-to-date). */
  @Get('newsletter/quote')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  quote(@CurrentTenant() tenantId: string) {
    return this.newsletterService.quote(tenantId);
  }

  /** List campaigns (drafts + sent), newest-edited first. */
  @Get('newsletter/campaigns')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listCampaigns(@CurrentTenant() tenantId: string, @Query() q: PaginationQueryDto) {
    return this.newsletterService.listCampaigns(tenantId, { cursor: q.cursor, limit: q.limit });
  }

  @Post('newsletter/campaigns')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
  createCampaign(@CurrentTenant() tenantId: string, @Body() dto: UpsertCampaignDto) {
    return this.newsletterService.createCampaign(tenantId, dto);
  }

  @Get('newsletter/campaigns/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  getCampaign(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.newsletterService.getCampaign(id, tenantId);
  }

  @Patch('newsletter/campaigns/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
  updateCampaign(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpsertCampaignDto,
  ) {
    return this.newsletterService.updateCampaign(id, tenantId, dto);
  }

  @Delete('newsletter/campaigns/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  deleteCampaign(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.newsletterService.deleteCampaign(id, tenantId);
  }

  @Post('newsletter/campaigns/:id/images')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadNewsletterMediaDto })
  @UseInterceptors(FileInterceptor('file'))
  addInlineImage(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: NEWSLETTER_IMG_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: NEWSLETTER_IMG_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.newsletterService.addInlineImage(id, tenantId, file);
  }

  @Post('newsletter/campaigns/:id/preview')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  preview(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.newsletterService.preview(id, tenantId);
  }

  @Post('newsletter/campaigns/:id/send')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
  sendCampaign(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.newsletterService.sendCampaign(id, tenantId);
  }

  /**
   * Public unsubscribe endpoint — no auth guard. Verifies the JWT token, sets
   * unsubscribedAt, returns an HTML confirmation page.
   */
  @Get('unsubscribe')
  @ApiQuery({ name: 'token', required: true })
  async publicUnsubscribe(@Query('token') token: string, @Res() res: Response) {
    const result = await this.newsletterService.unsubscribe(token ?? '');

    // Set imperatively, not via @Header: this handler uses a non-passthrough
    // @Res(), so Nest's response pipeline (and the @Header decorator) is bypassed.
    // The page carries a unique token — never let a shared cache or back/forward
    // re-serve a stale "успешно"/"невалидна" result.
    res.setHeader('Cache-Control', 'no-store');

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

  /**
   * RFC 8058 one-click unsubscribe — the `List-Unsubscribe-Post` target. Mailbox
   * providers (Gmail/Yahoo) POST here with `List-Unsubscribe=One-Click` when the
   * user clicks the native unsubscribe button; same effect as the GET link. No
   * auth (token-verified), no HTML — just 200.
   */
  @Post('unsubscribe')
  @HttpCode(200)
  @ApiQuery({ name: 'token', required: true })
  async oneClickUnsubscribe(@Query('token') token: string) {
    await this.newsletterService.unsubscribe(token ?? '');
    return { ok: true };
  }
}
