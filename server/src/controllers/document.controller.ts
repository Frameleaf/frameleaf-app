import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DocumentFieldEditDto,
  DocumentFieldParamDto,
  DocumentLineEditDto,
  DocumentLineParamDto,
  DocumentResponseDto,
  DocumentRevisionDto,
  DocumentSearchDto,
  DocumentSearchResponseDto,
} from 'src/dtos/document.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DocumentService } from 'src/services/document.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * Documents (FL-63): photos with recognized text, and the owner's corrections to it.
 *
 * Listing is the caller's own library. Reading one document follows the photo's access; changing
 * it needs the owner (see `DocumentService`). Shared links never reach these endpoints.
 */
@ApiTags(ApiTag.Documents)
@Controller('documents')
export class DocumentController {
  constructor(private service: DocumentService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Search documents',
    description:
      'List the signed-in account’s photos that show recognized text, newest first, optionally matching text read from them or the owner’s corrections.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  searchDocuments(@Auth() auth: AuthDto, @Query() dto: DocumentSearchDto): Promise<DocumentSearchResponseDto> {
    return this.service.search(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve a document',
    description:
      'Retrieve the text read from a photo with the owner’s corrections applied, where each line is in the photo, and, for the owner, the values suggested from it.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getDocument(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DocumentResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id/lines')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Correct or dismiss a line of text',
    description:
      'Record the owner’s correction or dismissal of one recognized line. The recognized text itself is kept unchanged.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  updateDocumentLine(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DocumentLineEditDto,
  ): Promise<DocumentResponseDto> {
    return this.service.editLine(auth, id, dto);
  }

  @Delete(':id/lines/:editId')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Restore a line of text',
    description: 'Remove the owner’s correction or dismissal of a line, so it reads as recognized again.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  deleteDocumentLine(
    @Auth() auth: AuthDto,
    @Param() { id, editId }: DocumentLineParamDto,
    @Query() { revision }: DocumentRevisionDto,
  ): Promise<DocumentResponseDto> {
    return this.service.removeLineEdit(auth, id, editId, revision);
  }

  @Put(':id/fields/:field')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Decide a document field',
    description: 'Confirm, correct or dismiss a value suggested from the text of a photo.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  updateDocumentField(
    @Auth() auth: AuthDto,
    @Param() { id, field }: DocumentFieldParamDto,
    @Body() dto: DocumentFieldEditDto,
  ): Promise<DocumentResponseDto> {
    return this.service.editField(auth, id, field, dto);
  }

  @Delete(':id/fields/:field')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Clear a document field decision',
    description: 'Remove the owner’s decision about a field, so the text’s suggestion shows again.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  deleteDocumentField(
    @Auth() auth: AuthDto,
    @Param() { id, field }: DocumentFieldParamDto,
    @Query() { revision }: DocumentRevisionDto,
  ): Promise<DocumentResponseDto> {
    return this.service.removeFieldEdit(auth, id, field, revision);
  }
}
