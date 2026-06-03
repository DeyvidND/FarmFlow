import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { type Database, users } from '@farmflow/db';
import type { JwtPayload } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

type Role = JwtPayload['role'];

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly jwt: JwtService,
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

    return {
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
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
