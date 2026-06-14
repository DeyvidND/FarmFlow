import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
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
    if (!user || !user.tenantId) {
      // Constant-time: pay the same Argon2 cost for an unknown email as for a
      // wrong password, so response latency can't be used to enumerate accounts.
      await this.burnPasswordTime(dto.password);
      throw invalid;
    }
    if (!(await argon2.verify(user.passwordHash, dto.password))) throw invalid;

    return this.sign(user.id, user.tenantId, user.role, user.mustChangePassword, user.tokenVersion, user.farmerId);
  }

  /** Run a throwaway Argon2 verify so the no-such-user path costs the same as a
   *  real verify. Memoized dummy hash; never matches a real password. */
  private burnPasswordTime(password: string): Promise<void> {
    this.dummyHashPromise ??= argon2.hash('argon2-timing-equalizer-placeholder');
    return this.dummyHashPromise
      .then((h) => argon2.verify(h, password))
      .then(() => undefined)
      .catch(() => undefined);
  }
  private dummyHashPromise?: Promise<string>;

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
      .set({
        passwordHash,
        mustChangePassword: false,
        // Bump the session epoch so every previously issued token stops validating.
        tokenVersion: sql`${users.tokenVersion} + 1`,
      })
      .where(eq(users.id, userId))
      .returning();

    return this.sign(
      updated.id,
      updated.tenantId as string,
      updated.role,
      false,
      updated.tokenVersion,
      updated.farmerId,
    );
  }

  async getMe(userId: string): Promise<{
    email: string;
    role: string;
    mustChangePassword: boolean;
    hiddenNav: string[];
  }> {
    const [user] = await this.db
      .select({
        email: users.email,
        role: users.role,
        mustChangePassword: users.mustChangePassword,
        hiddenNav: users.hiddenNav,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new UnauthorizedException();

    return {
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      hiddenNav: user.hiddenNav ?? [],
    };
  }

  /** Save the user's hidden side-nav keys (cosmetic per-user preference). */
  async updateHiddenNav(userId: string, hidden: string[]): Promise<{ hiddenNav: string[] }> {
    const [updated] = await this.db
      .update(users)
      .set({ hiddenNav: hidden })
      .where(eq(users.id, userId))
      .returning({ hiddenNav: users.hiddenNav });

    if (!updated) throw new UnauthorizedException();

    return { hiddenNav: updated.hiddenNav ?? [] };
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
      // Fire-and-forget: do NOT await the send. Awaiting only on the account-exists
      // branch made the response measurably slower for real emails than for unknown
      // ones — a timing oracle. Dispatching async keeps latency independent of
      // whether the account exists. (IIFE so a non-promise/throwing transport is
      // contained and never rejects the caller.)
      void (async () => {
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
      })();
    }
    return { ok: true };
  }

  /**
   * Invite a producer sub-account: email a set-password link. Reuses the password
   * reset token (separate secret, single-use, bound to the password fingerprint), so
   * the temporary random password set at creation is never disclosed. Longer-lived
   * (7d) than a self-service reset since the producer may open the email later.
   */
  async sendFarmerInvite(userId: string): Promise<void> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('Профилът не е намерен');

    const token = await this.jwt.signAsync(
      { sub: user.id, type: 'reset', pv: this.pwFingerprint(user.passwordHash) },
      { secret: this.resetSecret(), expiresIn: '7d' },
    );
    const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
    const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.email.sendMail({
      to: user.email,
      subject: 'Покана за достъп — FarmFlow',
      html: inviteEmailHtml(link),
      text: `Получи достъп до своя оборот във FarmFlow.\nОтвори тази връзка, за да зададеш парола (валидна 7 дни):\n${link}`,
    });
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
      .set({
        passwordHash,
        mustChangePassword: false,
        // Revoke every existing session on reset (the user's "lock out the attacker" action).
        tokenVersion: sql`${users.tokenVersion} + 1`,
      })
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
    tokenVersion = 0,
    farmerId?: string | null,
  ): { accessToken: string } {
    const payload: JwtPayload = {
      sub,
      type: 'tenant',
      tenantId,
      role,
      mustChangePassword,
      tv: tokenVersion,
      ...(farmerId ? { farmerId } : {}),
    };
    return { accessToken: this.jwt.sign(payload) };
  }
}

/** Branded invite email — producer sets their first password. */
function inviteEmailHtml(link: string): string {
  return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0">
    <tr><td align="center">
      <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="max-width:460px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 FarmFlow</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:20px;color:#23210f">Покана за достъп</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            Получи достъп до своя личен оборот във FarmFlow. Натисни бутона, за да зададеш парола и да влезеш.
          </p>
          <p style="margin:0 0 22px">
            <a href="${link}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px">Задай парола и влез</a>
          </p>
          <p style="margin:0;font-size:13px;color:#8a8770">Връзката е валидна 7 дни.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">FarmFlow · Управление на фермата</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
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
