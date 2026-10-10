import { cloudBackupCommands } from 'src/commands/cloud-backup.command.js';
import { GrantAdminCommand, PromptEmailQuestion, RevokeAdminCommand } from 'src/commands/grant-admin.js';
import { ImportImmichCommand } from 'src/commands/import-immich.command.js';
import { ListUsersCommand } from 'src/commands/list-users.command.js';
import { DisableMaintenanceModeCommand, EnableMaintenanceModeCommand } from 'src/commands/maintenance-mode.js';
import {
  ChangeMediaLocationCommand,
  PromptConfirmMoveQuestions,
  PromptMediaLocationQuestions,
} from 'src/commands/media-location.command.js';
import { DisableOAuthLogin, EnableOAuthLogin } from 'src/commands/oauth-login.js';
import { DisablePasswordLoginCommand, EnablePasswordLoginCommand } from 'src/commands/password-login.js';
import { PromptPasswordResetQuestions, ResetAdminPasswordCommand } from 'src/commands/reset-admin-password.command.js';
import { RestoreStateCommand } from 'src/commands/restore-state.command.js';
import { SchemaCheck } from 'src/commands/schema-check.js';
import { SetupCodeCommand } from 'src/commands/setup-code.command.js';
import { VersionCommand } from 'src/commands/version.command.js';

// Frameleaf administration commands.
export const commandsAndQuestions = [
  ImportImmichCommand,
  RestoreStateCommand,
  // FL-164: bare-metal restore from a cloud backup bucket
  ...cloudBackupCommands,
  ResetAdminPasswordCommand,
  SetupCodeCommand,
  PromptPasswordResetQuestions,
  PromptEmailQuestion,
  EnablePasswordLoginCommand,
  DisablePasswordLoginCommand,
  EnableMaintenanceModeCommand,
  DisableMaintenanceModeCommand,
  EnableOAuthLogin,
  DisableOAuthLogin,
  ListUsersCommand,
  VersionCommand,
  GrantAdminCommand,
  RevokeAdminCommand,
  ChangeMediaLocationCommand,
  PromptMediaLocationQuestions,
  PromptConfirmMoveQuestions,
  SchemaCheck,
];
