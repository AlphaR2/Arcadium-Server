import {
  Body,
  Controller,
  Get,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from '../../common/entities/user.entity';

/** Express request object extended with the JWT payload set by JwtAuthGuard. */
interface AuthRequest extends Express.Request {
  user: JwtPayload;
}

/**
 * Provides read/write access to the authenticated user's own profile.
 * All endpoints require a valid JWT (Bearer token).
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** Returns the full profile of the currently authenticated user. */
  @Get('me')
  @ApiOperation({ summary: "Get the authenticated user's profile" })
  @ApiResponse({ status: 200, description: 'User profile', type: UserEntity })
  getMe(@Request() req: AuthRequest): Promise<UserEntity> {
    return this.usersService.findById(req.user.sub);
  }

  /**
   * Updates the authenticated user's mutable profile fields.
   * Typically called during and after onboarding to set display name, role, and categories.
   */
  @Patch('me')
  @ApiOperation({ summary: "Update the authenticated user's profile" })
  @ApiResponse({ status: 200, description: 'Updated user profile', type: UserEntity })
  updateMe(@Request() req: AuthRequest, @Body() dto: UpdateUserDto): Promise<UserEntity> {
    return this.usersService.update(req.user.sub, dto);
  }
}
