import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BookmarkCreateDto, BookmarkResponseDto, BookmarkTagsDto, BookmarkUpdateDto } from 'src/dtos/bookmark.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Bookmarks)
@Controller('bookmarks')
export class BookmarkController {
  constructor(private service: BookmarkService) {}

  @Post()
  @Authenticated({ permission: Permission.BookmarkCreate })
  @Endpoint({ summary: 'Create a bookmark', history: new HistoryBuilder().added('v3') })
  createBookmark(@Auth() auth: AuthDto, @Body() dto: BookmarkCreateDto): Promise<BookmarkResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.BookmarkRead })
  @Endpoint({ summary: 'Retrieve an owned bookmark', history: new HistoryBuilder().added('v3') })
  getBookmark(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<BookmarkResponseDto> {
    return this.service.get(auth, id);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.BookmarkUpdate })
  @Endpoint({ summary: 'Update an owned bookmark', history: new HistoryBuilder().added('v3') })
  updateBookmark(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BookmarkUpdateDto,
  ): Promise<BookmarkResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.BookmarkDelete })
  @Endpoint({ summary: 'Move an owned bookmark to trash', history: new HistoryBuilder().added('v3') })
  trashBookmark(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.trash(auth, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.BookmarkUpdate })
  @Endpoint({ summary: 'Restore an owned bookmark from trash', history: new HistoryBuilder().added('v3') })
  restoreBookmark(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.restore(auth, id);
  }

  @Get(':id/tags')
  @Authenticated({ permission: Permission.BookmarkRead })
  @Endpoint({ summary: 'Retrieve an owned bookmark’s tag IDs', history: new HistoryBuilder().added('v3') })
  getBookmarkTags(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<BookmarkTagsDto> {
    return this.service.getTags(auth, id);
  }

  @Put(':id/tags')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.BookmarkUpdate })
  @Endpoint({ summary: 'Replace an owned bookmark’s tags', history: new HistoryBuilder().added('v3') })
  setBookmarkTags(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: BookmarkTagsDto): Promise<void> {
    return this.service.setTags(auth, id, dto.ids);
  }
}
