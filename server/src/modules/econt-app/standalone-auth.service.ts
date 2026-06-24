import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { type Database, tenants, users } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { AuthService } from '../auth/auth.service';
import { EcontSignupDto } from './dto/signup.dto';
import { slugifyFarm, econtTenantSettings } from './econt-app.helpers';

@Injectable()
export class StandaloneAuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly auth: AuthService,
  ) {}

  /** Public self-service signup for a standalone Econt account. */
  async signup(dto: EcontSignupDto): Promise<{ accessToken: string }> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает');

    const slug = await this.uniqueSlug(slugifyFarm(dto.farmName));

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name: dto.farmName,
        slug,
        phone: dto.phone,
        email,
        subscriptionStatus: 'active',
        subscriptionSince: new Date(),
        settings: econtTenantSettings(),
      })
      .returning();

    await this.db.insert(users).values({
      tenantId: tenant.id,
      email,
      passwordHash: await argon2.hash(dto.password),
      role: 'admin',
      mustChangePassword: false,
    });

    // Reuse the case-insensitive login to mint the session token.
    return this.auth.login({ email, password: dto.password });
  }

  /** Append -2, -3, … until the slug is free. */
  private async uniqueSlug(stem: string): Promise<string> {
    let slug = stem;
    for (let n = 2; ; n++) {
      const [clash] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      if (!clash) return slug;
      slug = `${stem}-${n}`;
    }
  }
}
