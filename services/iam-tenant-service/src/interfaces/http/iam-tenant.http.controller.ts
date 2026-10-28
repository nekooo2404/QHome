import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { AuthenticationService, LoginCommand } from '../../application/authentication.service';
import { JwksProvider } from '../../application/ports';

interface LoginBody {
  email: string;
  password: string;
  deviceId: string;
}

interface RefreshBody {
  refreshToken: string;
}

@Controller()
export class IamTenantHttpController {
  constructor(
    private readonly authentication: AuthenticationService,
    private readonly jwksProvider: JwksProvider,
  ) {}

  @Get('/.well-known/jwks.json')
  async jwks() {
    return this.jwksProvider.getJwks();
  }

  @Post('/v1/auth/login')
  @HttpCode(200)
  async login(
    @Headers('x-tenant-id') projectId: string,
    @Headers('x-client-ip-hash') ipHash: string | undefined,
    @Headers('x-user-agent-hash') userAgentHash: string | undefined,
    @Body() body: LoginBody,
  ) {
    this.validateLoginBody(body);
    const command: LoginCommand = {
      projectId,
      email: body.email,
      password: body.password,
      deviceId: body.deviceId,
      ipHash,
      userAgentHash,
    };
    return this.authentication.login(command);
  }

  @Post('/v1/auth/refresh')
  @HttpCode(200)
  async refresh(@Body() body: RefreshBody) {
    if (!body || typeof body.refreshToken !== 'string') {
      throw new Error('refreshToken is required');
    }
    return this.authentication.refresh({ refreshToken: body.refreshToken });
  }

  @Post('/v1/auth/logout')
  @HttpCode(204)
  async logout(
    @Headers('x-actor-id') userId: string,
    @Headers('x-session-id') sessionId: string,
  ): Promise<void> {
    await this.authentication.logout(sessionId, userId);
  }

  @Post('/v1/auth/logout-all')
  @HttpCode(204)
  async logoutAll(@Headers('x-actor-id') userId: string): Promise<void> {
    await this.authentication.logoutAll(userId);
  }

  private validateLoginBody(body: LoginBody): void {
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string' || typeof body.deviceId !== 'string') {
      throw new Error('email, password and deviceId are required');
    }
    if (body.password.length > 128 || body.deviceId.length === 0 || body.deviceId.length > 160) {
      throw new Error('invalid login payload');
    }
  }
}
