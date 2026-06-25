import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service';
import { StandaloneAuthController } from './standalone-auth.controller';

describe('StandaloneAuthController', () => {
  let controller: StandaloneAuthController;
  const auth = {
    login: jest.fn(),
    getMe: jest.fn(),
    changePassword: jest.fn(),
    resetPassword: jest.fn().mockResolvedValue({ ok: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    auth.resetPassword.mockResolvedValue({ ok: true });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StandaloneAuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile();
    controller = module.get(StandaloneAuthController);
  });

  it('reset-password delegates to AuthService.resetPassword (public — token is the auth)', async () => {
    const res = await controller.resetPassword({ token: 'tok', newPassword: 'a-strong-password' });
    expect(auth.resetPassword).toHaveBeenCalledWith('tok', 'a-strong-password');
    expect(res).toEqual({ ok: true });
  });
});
