import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Returns the authenticated user's id (sub). Works for tenant tokens only. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.userId;
  },
);
