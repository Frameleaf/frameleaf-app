import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { CalendarHeatmapDto, CalendarHeatmapResponseDto } from 'src/dtos/calendar-heatmap.dto.js';
import { LicenseActivateDto } from 'src/dtos/frameleaf-license.dto.js';
import { LicenseResponseDto } from 'src/dtos/license.dto.js';
import { OnboardingDto, OnboardingResponseDto } from 'src/dtos/onboarding.dto.js';
import {
  UserPreferenceHistoryResponseDto,
  UserPreferencesResponseDto,
  UserPreferencesUpdateDto,
} from 'src/dtos/user-preferences.dto.js';
import { CreateProfileImageDto, CreateProfileImageResponseDto } from 'src/dtos/user-profile.dto.js';
import { UserAdminResponseDto, UserResponseDto, UserUpdateMeDto } from 'src/dtos/user.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { FileUploadInterceptor } from 'src/middleware/file-upload.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { UserService } from 'src/services/user.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
export class UserController {
  constructor(
    private service: UserService,
    private licenseService: FrameleafLicenseService,
    private logger: LoggingRepository,
  ) {}

  @Get()
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({
    summary: 'Get all users',
    description: 'Retrieve a list of all users on the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  searchUsers(@Auth() auth: AuthDto): Promise<UserResponseDto[]> {
    return this.service.search(auth);
  }

  @Get('me')
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({
    summary: 'Get current user',
    description: 'Retrieve information about the user making the API request.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getMyUser(@Auth() auth: AuthDto): Promise<UserAdminResponseDto> {
    return this.service.getMe(auth);
  }

  @Get('me/calendar-heatmap')
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({
    summary: 'Retrieve calendar heatmap activity',
    description: 'Retrieve activity counts for a specified period, in a calendar heatmap format.',
    history: new HistoryBuilder().added('v3').stable('v3'),
  })
  getMyCalendarHeatmap(@Auth() auth: AuthDto, @Query() dto: CalendarHeatmapDto): Promise<CalendarHeatmapResponseDto> {
    return this.service.getCalendarHeatmap(auth, dto);
  }

  @Put('me')
  @Authenticated({ permission: Permission.UserUpdate })
  @Endpoint({
    summary: 'Update current user',
    description: 'Update the current user making the API request.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateMyUser' }),
  })
  updateMyUser(@Auth() auth: AuthDto, @Body() dto: UserUpdateMeDto): Promise<UserAdminResponseDto> {
    return this.service.updateMe(auth, dto);
  }

  @Patch('me')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.UserUpdate })
  updateMyUserV3(@Auth() auth: AuthDto, @Body() dto: UserUpdateMeDto): Promise<UserAdminResponseDto> {
    return this.service.updateMe(auth, dto);
  }

  @Get('me/preferences')
  @Authenticated({ permission: Permission.UserPreferenceRead })
  @Endpoint({
    summary: 'Get my preferences',
    description: 'Retrieve the preferences for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getMyPreferences(@Auth() auth: AuthDto): Promise<UserPreferencesResponseDto> {
    return this.service.getMyPreferences(auth);
  }

  @Get('me/preferences/history')
  @Authenticated({ permission: Permission.UserPreferenceRead })
  @Endpoint({
    summary: 'Get my preference history',
    description:
      'The newest changes to the current user’s own preferences, with the device that saved each. Locked-content rules appear only as changed.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getMyPreferenceHistory(@Auth() auth: AuthDto): Promise<UserPreferenceHistoryResponseDto> {
    return this.service.getMyPreferenceHistory(auth);
  }

  @Put('me/preferences')
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Update my preferences',
    description: 'Update the preferences of the current user.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateMyPreferences' }),
  })
  updateMyPreferences(
    @Auth() auth: AuthDto,
    @Body() dto: UserPreferencesUpdateDto,
  ): Promise<UserPreferencesResponseDto> {
    return this.service.updateMyPreferences(auth, dto);
  }

  @Patch('me/preferences')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  updateMyPreferencesV3(
    @Auth() auth: AuthDto,
    @Body() dto: UserPreferencesUpdateDto,
  ): Promise<UserPreferencesResponseDto> {
    return this.service.updateMyPreferences(auth, dto);
  }

  @Get('me/license')
  @Authenticated({ permission: Permission.UserLicenseRead })
  @Endpoint({
    summary: 'Get your supporter key',
    description:
      'Your own Frameleaf supporter key (FL-I…), as its last four symbols and activation date. The key itself is never returned.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getUserLicense(@Auth() auth: AuthDto): Promise<LicenseResponseDto> {
    return this.licenseService.getUserSupporter(auth);
  }

  @Put('me/license')
  @Authenticated({ permission: Permission.UserLicenseUpdate })
  @Endpoint({
    summary: 'Activate your supporter key',
    description:
      'Activate a personal Frameleaf supporter key (FL-IXXX-XXXX-XXXX) for your account with Frameleaf Cloud. The key travels only in this request body.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async setUserLicense(@Auth() auth: AuthDto, @Body() dto: LicenseActivateDto): Promise<LicenseResponseDto> {
    return this.licenseService.activateUserSupporter(auth, dto);
  }

  @Delete('me/license')
  @Authenticated({ permission: Permission.UserLicenseDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove your supporter key',
    description: 'Remove your supporter key from this server. The key stays yours to activate again.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async deleteUserLicense(@Auth() auth: AuthDto): Promise<void> {
    await this.licenseService.removeUserSupporter(auth);
  }

  @Get('me/onboarding')
  @Authenticated({ permission: Permission.UserOnboardingRead })
  @Endpoint({
    summary: 'Retrieve user onboarding',
    description: 'Retrieve the onboarding status of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getUserOnboarding(@Auth() auth: AuthDto): Promise<OnboardingResponseDto> {
    return this.service.getOnboarding(auth);
  }

  @Put('me/onboarding')
  @Authenticated({ permission: Permission.UserOnboardingUpdate })
  @Endpoint({
    summary: 'Update user onboarding',
    description: 'Update the onboarding status of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async setUserOnboarding(@Auth() auth: AuthDto, @Body() Onboarding: OnboardingDto): Promise<OnboardingResponseDto> {
    return this.service.setOnboarding(auth, Onboarding);
  }

  @Delete('me/onboarding')
  @Authenticated({ permission: Permission.UserOnboardingDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete user onboarding',
    description: 'Delete the onboarding status of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async deleteUserOnboarding(@Auth() auth: AuthDto): Promise<void> {
    await this.service.deleteOnboarding(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({
    summary: 'Retrieve a user',
    description: 'Retrieve a specific user by their ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getUser(@Param() { id }: UUIDParamDto): Promise<UserResponseDto> {
    return this.service.get(id);
  }

  @Post('profile-image')
  @Authenticated({ permission: Permission.UserProfileImageUpdate })
  @UseInterceptors(FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'A new avatar for the user', type: CreateProfileImageDto })
  @Endpoint({
    summary: 'Create user profile image',
    description: 'Upload and set a new profile image for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createProfileImage(
    @Auth() auth: AuthDto,
    @UploadedFile() fileInfo: Express.Multer.File,
    @Body() dto: CreateProfileImageDto,
  ): Promise<CreateProfileImageResponseDto> {
    return this.service.createProfileImage(auth, fileInfo, dto);
  }

  @Delete('profile-image')
  @Authenticated({ permission: Permission.UserProfileImageDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete user profile image',
    description: 'Delete the profile image of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteProfileImage(@Auth() auth: AuthDto): Promise<void> {
    return this.service.deleteProfileImage(auth);
  }

  @Get(':id/profile-image')
  @FileResponse()
  @Authenticated({ permission: Permission.UserProfileImageRead })
  @Endpoint({
    summary: 'Retrieve user profile image',
    description: 'Retrieve the profile image file for a user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async getProfileImage(@Res() res: Response, @Next() next: NextFunction, @Param() { id }: UUIDParamDto) {
    await sendFile(res, next, () => this.service.getProfileImage(id), this.logger);
  }
}
