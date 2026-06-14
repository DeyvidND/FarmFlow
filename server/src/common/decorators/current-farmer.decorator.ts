import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The producer id a role='farmer' token is scoped to (undefined otherwise). */
export const CurrentFarmer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.farmerId;
  },
);
