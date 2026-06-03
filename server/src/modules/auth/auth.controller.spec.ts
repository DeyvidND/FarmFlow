import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

function makeAuthService() {
  return {
    login: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
    changePassword: jest.fn().mockResolvedValue({ accessToken: 'new-tok' }),
    getMe: jest.fn().mockResolvedValue({ email: 'u@farm.bg', role: 'admin', mustChangePassword: false }),
  };
}

describe('AuthController — POST /auth/register no longer exists', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: makeAuthService() }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuthController);
  });

  it('does not have a register method on the controller', () => {
    expect(typeof (controller as any).register).toBe('undefined');
  });

  it('has login, changePassword, and getMe', () => {
    expect(typeof (controller as any).login).toBe('function');
    expect(typeof (controller as any).changePassword).toBe('function');
    expect(typeof (controller as any).getMe).toBe('function');
  });
});
