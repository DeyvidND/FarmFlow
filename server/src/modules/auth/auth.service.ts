import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { type Database, users } from '@farmflow/db';
import type { JwtPayload } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

type Role = JwtPayload['role'];

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);

    const invalid = new UnauthorizedException('Грешен имейл или парола');
    if (!user || !user.tenantId) throw invalid;
    if (!(await argon2.verify(user.passwordHash, dto.password))) throw invalid;

    return this.sign(user.id, user.tenantId, user.role, user.mustChangePassword);
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<{ accessToken: string }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !(await argon2.verify(user.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException('Грешна текуща парола');
    }

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('Новата парола трябва да е различна от текущата');
    }

    const passwordHash = await argon2.hash(dto.newPassword);

    const [updated] = await this.db
      .update(users)
      .set({ passwordHash, mustChangePassword: false })
      .where(eq(users.id, userId))
      .returning();

    return this.sign(updated.id, updated.tenantId as string, updated.role, false);
  }

  async getMe(userId: string): Promise<{ email: string; role: string; mustChangePassword: boolean }> {
    const [user] = await this.db
      .select({ email: users.email, role: users.role, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new UnauthorizedException();

    return {
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Start the reset flow: email a one-time link with a signed, short-lived token.
   * The token is signed with a SEPARATE secret (so it can never authenticate) and
   * bound to the user's current password fingerprint — so it expires in 30 min AND
   * stops working the moment the password changes (single use). Always returns ok,
   * never revealing whether the email exists.
   */
  async requestPasswordReset(email: string): Promise<{ ok: true }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (user && user.tenantId) {
      const token = await this.jwt.signAsync(
        { sub: user.id, type: 'reset', pv: this.pwFingerprint(user.passwordHash) },
        { secret: this.resetSecret(), expiresIn: '30m' },
      );
      const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
      const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
      try {
        await this.email.sendMail({
          to: user.email,
          subject: 'Възстановяване на парола — FarmFlow',
          html: resetEmailHtml(link),
          text: `Заявена е смяна на паролата за FarmFlow.\nОтвори тази връзка, за да зададеш нова парола (валидна 30 минути):\n${link}\n\nАко не си заявявал/а това, просто игнорирай имейла.`,
        });
      } catch (err) {
        // Don't leak send failures to the caller; log for ops.
        this.logger.error(
          `Password-reset email failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { ok: true };
  }

  /** Finish the reset flow: verify the token + set the new password. */
  async resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    let payload: { sub?: string; type?: string; pv?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.resetSecret() });
    } catch {
      throw new BadRequestException('Връзката е невалидна или изтекла. Заяви нова.');
    }
    if (payload?.type !== 'reset' || !payload.sub) {
      throw new BadRequestException('Връзката е невалидна или изтекла. Заяви нова.');
    }

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    // Mismatched fingerprint = token already used (password changed) or user gone.
    if (!user || this.pwFingerprint(user.passwordHash) !== payload.pv) {
      throw new BadRequestException('Връзката вече е използвана или е изтекла. Заяви нова.');
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.db
      .update(users)
      .set({ passwordHash, mustChangePassword: false })
      .where(eq(users.id, user.id));

    return { ok: true };
  }

  /** Reset tokens use a derived secret so they can't be replayed as auth tokens. */
  private resetSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::pwreset`;
  }

  /** Short fingerprint of the password hash — binds a reset token to one password. */
  private pwFingerprint(passwordHash: string): string {
    return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
  }

  private sign(
    sub: string,
    tenantId: string,
    role: Role,
    mustChangePassword = false,
  ): { accessToken: string } {
    const payload: JwtPayload = { sub, type: 'tenant', tenantId, role, mustChangePassword };
    return { accessToken: this.jwt.sign(payload) };
  }
}

/** Branded reset email (inline styles — email clients ignore <style>/classes). */
function resetEmailHtml(link: string): string {
  return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0">
    <tr><td align="center">
      <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="max-width:460px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 FarmFlow</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:20px;color:#23210f">Смяна на парола</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            Получихме заявка за нова парола за профила ти във FarmFlow. Натисни бутона по-долу, за да зададеш нова парола.
          </p>
          <p style="margin:0 0 22px">
            <a href="${link}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px">Задай нова парола</a>
          </p>
          <p style="margin:0 0 6px;font-size:13px;color:#8a8770">Връзката е валидна 30 минути.</p>
          <p style="margin:0;font-size:13px;color:#8a8770">Ако не си заявявал/а смяна на парола, просто игнорирай този имейл — нищо няма да се промени.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">FarmFlow · Управление на фермата</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
