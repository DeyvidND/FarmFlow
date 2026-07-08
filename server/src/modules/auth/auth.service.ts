import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { type Database, users, tenants } from '@fermeribg/db';
import type { JwtPayload } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
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
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    // Email is matched case-insensitively: accounts are stored lowercased on the
    // write paths, but legacy rows (and operator typos) may differ in case, and a
    // case mismatch must not lock a user out. lower(...) covers both.
    const email = dto.email.trim().toLowerCase();
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
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
    farmerId: string | null;
  }> {
    const [user] = await this.db
      .select({
        email: users.email,
        role: users.role,
        mustChangePassword: users.mustChangePassword,
        hiddenNav: users.hiddenNav,
        farmerId: users.farmerId,
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
      farmerId: user.farmerId ?? null,
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
    // Normalize + case-insensitive match, mirroring login — a case mismatch
    // (legacy row or a typo in casing) must not silently fail to find the user.
    const normalized = email.trim().toLowerCase();
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalized}`)
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
            subject: 'Възстановяване на парола — ФермериБГ',
            html: resetEmailHtml(link),
            text: `Заявена е смяна на паролата за ФермериБГ.\nОтвори тази връзка, за да зададеш нова парола (валидна 30 минути):\n${link}\n\nАко не си заявявал/а това, просто игнорирай имейла.`,
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
      subject: 'Покана за достъп — ФермериБГ',
      html: inviteEmailHtml(link),
      text: `Получи достъп до своя оборот във ФермериБГ.\nОтвори тази връзка, за да зададеш парола (валидна 7 дни):\n${link}`,
    });
  }

  /**
   * Mint a 7d set-password ("invite") link for a user, targeted at a given app
   * origin, and optionally email it. Reuses the reset-token machinery (separate
   * secret, single-use, bound to the password fingerprint), so a random/unusable
   * password set at creation is never disclosed. The `appUrl` lets the caller aim
   * the link at a specific frontend (e.g. the delivery panel, NOT the farmer panel).
   * Returns the link so the operator can also copy/share it (Viber etc.).
   */
  async issueInvite(
    userId: string,
    opts: { appUrl: string; email?: boolean; subject?: string },
  ): Promise<{ link: string }> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException('Профилът не е намерен');
    const token = await this.jwt.signAsync(
      { sub: user.id, type: 'reset', pv: this.pwFingerprint(user.passwordHash) },
      { secret: this.resetSecret(), expiresIn: '7d' },
    );
    const link = `${opts.appUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    if (opts.email) {
      // Don't let an email-send failure roll back account creation — log + carry on.
      // The operator still gets the link in the response to share manually.
      try {
        await this.email.sendMail({
          to: user.email,
          subject: opts.subject ?? 'Покана за достъп — ФермериБГ Доставка',
          html: inviteEmailHtml(link),
          text: `Получи достъп до ФермериБГ Доставка.\nОтвори тази връзка, за да зададеш парола (валидна 7 дни):\n${link}`,
        });
      } catch (err) {
        this.logger.error(
          `Delivery invite email failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { link };
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

  /**
   * Mint a short-TTL, single-purpose token to hand a logged-in farmer off to the
   * standalone delivery app (dostavki). Signed with a DERIVED secret so it can never
   * be replayed as an auth token; the URL only carries this, never the real session.
   * Exchanged server-side at the delivery app via `handoffLogin`.
   */
  async issueDeliveryHandoff(userId: string, tenantId: string, farmerId?: string): Promise<{ token: string }> {
    const token = await this.jwt.signAsync(
      { sub: userId, tid: tenantId, ...(farmerId ? { fid: farmerId } : {}), type: 'delivery-handoff' },
      { secret: this.handoffSecret(), expiresIn: '120s', jwtid: randomUUID() },
    );
    return { token };
  }

  /**
   * Exchange a valid delivery-handoff token for a real delivery session — and gate
   * on the tenant's „пакет Доставки". This is the authoritative dostavki access gate
   * for FarmFlow shop accounts (standalone delivery-only accounts use their own
   * activation). Backs the delivery-web `?handoff=` login.
   */
  async handoffLogin(token: string): Promise<{ accessToken: string }> {
    let payload: { sub?: string; tid?: string; fid?: string; type?: string; jti?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.handoffSecret() });
    } catch {
      throw new UnauthorizedException('Връзката е невалидна или изтекла');
    }
    if (payload?.type !== 'delivery-handoff' || !payload.sub || !payload.jti) {
      throw new UnauthorizedException('Връзката е невалидна или изтекла');
    }

    // Single-use: the first exchange claims the token id; a replay finds the key
    // already set (NX → null) and is rejected. TTL outlives the 120s token so the
    // claim can't expire while the token is still technically valid.
    const claimed = await this.redis.set(`handoff:used:${payload.jti}`, '1', 'PX', 130_000, 'NX');
    if (claimed !== 'OK') {
      throw new UnauthorizedException('Връзката вече е използвана');
    }

    const [user] = await this.db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
    if (!user || !user.tenantId) throw new UnauthorizedException();
    const [tenant] = await this.db
      .select({ pkg: tenants.deliveriesPackageEnabled })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId))
      .limit(1);
    if (!tenant?.pkg) throw new ForbiddenException('Пакетът „Доставки" не е активен за този магазин');
    return this.sign(
      user.id,
      user.tenantId,
      user.role,
      user.mustChangePassword,
      user.tokenVersion,
      user.farmerId,
    );
  }

  /** Reset tokens use a derived secret so they can't be replayed as auth tokens. */
  private resetSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::pwreset`;
  }

  /** Handoff tokens use their own derived secret — never valid as an auth token. */
  private handoffSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::handoff`;
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
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 ФермериБГ</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:20px;color:#23210f">Покана за достъп</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            Получи достъп до своя личен оборот във ФермериБГ. Натисни бутона, за да зададеш парола и да влезеш.
          </p>
          <p style="margin:0 0 22px">
            <a href="${link}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px">Задай парола и влез</a>
          </p>
          <p style="margin:0;font-size:13px;color:#8a8770">Връзката е валидна 7 дни.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">ФермериБГ · Управление на фермата</td></tr>
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
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 ФермериБГ</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:20px;color:#23210f">Смяна на парола</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            Получихме заявка за нова парола за профила ти във ФермериБГ. Натисни бутона по-долу, за да зададеш нова парола.
          </p>
          <p style="margin:0 0 22px">
            <a href="${link}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px">Задай нова парола</a>
          </p>
          <p style="margin:0 0 6px;font-size:13px;color:#8a8770">Връзката е валидна 30 минути.</p>
          <p style="margin:0;font-size:13px;color:#8a8770">Ако не си заявявал/а смяна на парола, просто игнорирай този имейл — нищо няма да се промени.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">ФермериБГ · Управление на фермата</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
