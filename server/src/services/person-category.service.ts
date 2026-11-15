import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PersonCategoriesResponseDto,
  PersonCategoriesSetDto,
  PersonCategoryCreateDto,
  PersonCategoryResponseDto,
  PersonCategoryUpdateDto,
  mapPersonCategory,
} from 'src/dtos/person-category.dto.js';
import { Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { requireEntityAccess } from 'src/utils/access.js';

/** FL-874: the categories every account starts with, made the first time its categories are read. */
export const DEFAULT_PERSON_CATEGORIES = [
  { name: 'Family', color: null },
  { name: 'Friends', color: null },
  { name: 'Work', color: null },
];

/**
 * FL-874: an owner's categories for their people (Family, Friends, Work …). Everything here is the caller's own:
 * categories are per account, a person is only put in categories by their owner, and a partner never sees them.
 */
@Injectable()
export class PersonCategoryService extends BaseService {
  async getAll(auth: AuthDto): Promise<PersonCategoryResponseDto[]> {
    const ownerId = auth.user.id;
    let categories = await this.personRepository.getCategories(ownerId);
    // the starting categories are made once; an account that has deleted them all keeps none
    if (categories.length === 0 && (await this.personRepository.seedCategories(ownerId, DEFAULT_PERSON_CATEGORIES))) {
      categories = await this.personRepository.getCategories(ownerId);
    }
    return categories.map((category) => mapPersonCategory(category));
  }

  async create(auth: AuthDto, dto: PersonCategoryCreateDto): Promise<PersonCategoryResponseDto> {
    const ownerId = auth.user.id;
    // a category made before the list was ever read comes after the starting ones, which are not made later
    await this.personRepository.seedCategories(ownerId, DEFAULT_PERSON_CATEGORIES);
    const category = await this.personRepository.createCategory({ ownerId, name: dto.name, color: dto.color ?? null });
    return mapPersonCategory(category);
  }

  async update(auth: AuthDto, id: string, dto: PersonCategoryUpdateDto): Promise<PersonCategoryResponseDto> {
    const category = await this.personRepository.updateCategory(auth.user.id, id, {
      name: dto.name,
      color: dto.color,
      order: dto.order,
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return mapPersonCategory(category);
  }

  /** Deletes the category; the people in it are left as they are. */
  async delete(auth: AuthDto, id: string): Promise<void> {
    if (!(await this.personRepository.deleteCategory(auth.user.id, id))) {
      throw new NotFoundException('Category not found');
    }
  }

  /** Puts one of the caller's people in exactly these of the caller's categories. */
  async setPersonCategories(
    auth: AuthDto,
    personGroupId: string,
    dto: PersonCategoriesSetDto,
  ): Promise<PersonCategoriesResponseDto> {
    await requireEntityAccess(
      this.accessRepository,
      { auth, permission: Permission.PersonUpdate, ids: [personGroupId] },
      'Person',
    );
    const person = { ownerId: auth.user.id, personGroupId };
    // owner-only: the person must be the caller's own, never a partner's
    if (!(await this.personRepository.getByGroupId(person))) {
      throw new NotFoundException('Person not found');
    }
    const categoryIds = [...new Set(dto.categoryIds)];
    const own = new Set(await this.personRepository.getOwnCategoryIds(auth.user.id, categoryIds));
    if (categoryIds.some((id) => !own.has(id))) {
      throw new BadRequestException('Category not found');
    }
    await this.personRepository.setPersonCategories(person, categoryIds);
    return { categoryIds: categoryIds.toSorted() };
  }
}
