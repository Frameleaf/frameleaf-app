import { forkHandoffCommands } from 'src/commands/fork-handoff.command.js';
import { forkSchemaCutoverCommands } from 'src/commands/fork-schema-cutover.command.js';
import {
  ConfirmForkSchemaAdoptQuestion,
  ConfirmForkSchemaStartQuestion,
  ConfirmForkSchemaAdoptQuestion,
  forkSchemaCommands,
} from 'src/commands/fork-schema.command.js';
import { GrantAdminCommand, PromptEmailQuestion, RevokeAdminCommand } from 'src/commands/grant-admin.js';
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
import { SchemaCheck } from 'src/commands/schema-check.js';
import { VersionCommand } from 'src/commands/version.command.js';

// Compatibility handoff commands replace the unsafe historical schema-revert command.
export const commandsAndQuestions = [
  ...forkHandoffCommands,
  ...forkSchemaCutoverCommands,
  ...forkSchemaCommands,
  ConfirmForkSchemaStartQuestion,
  ResetAdminPasswordCommand,
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
