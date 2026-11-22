import type { PersonResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { personFactory } from '@test-data/factories/person-factory';
import FamilySection from './FamilySection.svelte';

// The three relationship calls are not in the generated SDK until it is next regenerated, so they are added here.
const api = vi.hoisted(() => ({
  createPersonRelationship: vi.fn(),
  deletePersonRelationship: vi.fn(),
  getPersonRelationships: vi.fn(),
  getAllPeople: vi.fn(),
  searchPerson: vi.fn(),
  isHttpError: vi.fn(),
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), ...api }));

const relative = (id: string, name: string) => ({
  id,
  name,
  birthDate: null,
  thumbnailPath: '',
  isHidden: false,
});
const none = { parents: [], children: [], partners: [], siblings: [], inferredSiblingIds: [] };
const personWith = (relationships: unknown) =>
  ({ ...personFactory.build({ name: 'Taylor' }), relationships }) as PersonResponseDto;

describe('FamilySection (FL-842)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
    api.getAllPeople.mockResolvedValue({
      people: [personFactory.build({ id: 'emma', name: 'Emma' })],
      hasNextPage: false,
    });
  });

  it('shows each group with its people and a count', () => {
    render(FamilySection, {
      person: personWith({
        ...none,
        parents: [{ person: relative('m', 'Margaret'), parentRole: 'mother' }],
        children: [{ person: relative('e', 'Emma'), parentRole: 'parent' }],
        partners: [relative('j', 'Jamie')],
      }),
    });

    expect(screen.getByRole('heading', { name: 'Family' })).toBeTruthy();
    expect(screen.getByText('3 relationships')).toBeTruthy();
    expect(screen.getByRole('link', { name: "Open Margaret, Taylor's mother" })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Partner' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Siblings' })).toBeNull();
    expect(screen.queryByText('Family tree')).toBeNull();
  });

  it('shows the empty state', () => {
    render(FamilySection, { person: personWith(none) });

    expect(screen.getByText('No family added yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add relationship' })).toBeTruthy();
  });

  it('asks for the family when the person read did not carry it', async () => {
    api.getPersonRelationships.mockResolvedValue({ ...none, partners: [relative('j', 'Jamie')] });
    const person = personWith(undefined);
    render(FamilySection, { person });

    await waitFor(() => expect(screen.getByText('Jamie')).toBeTruthy());
    expect(api.getPersonRelationships).toHaveBeenCalledWith({ id: person.id });
  });

  it('removes a relationship and says so', async () => {
    const person = personWith({ ...none, siblings: [relative('a', 'Alex')] });
    api.deletePersonRelationship.mockResolvedValue(undefined);
    api.getPersonRelationships.mockResolvedValue(none);
    render(FamilySection, { person });

    await fireEvent.click(screen.getByRole('button', { name: "Remove Alex as Taylor's sibling" }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        "Alex is no longer listed as Taylor's sibling. Their photos are not changed.",
      ),
    );
    expect(api.deletePersonRelationship).toHaveBeenCalledWith({ id: person.id, relatedPersonId: 'a' });
  });

  it('offers no remove for a sibling who only shares a parent', () => {
    render(FamilySection, {
      person: personWith({ ...none, siblings: [relative('a', 'Alex')], inferredSiblingIds: ['a'] }),
    });

    expect(screen.getByText('Alex')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Remove Alex as Taylor's sibling" })).toBeNull();
  });

  const chooseEmmaAsParent = async () => {
    await fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }));
    await fireEvent.click(await screen.findByRole('button', { name: /Emma/ }));
    await fireEvent.click(screen.getByRole('radio', { name: 'Parent' }));
    const buttons = screen.getAllByRole('button', { name: 'Add relationship' });
    await fireEvent.click(buttons.at(-1)!);
  };

  it('adds a relationship from the dialog', async () => {
    const person = personWith(none);
    api.createPersonRelationship.mockResolvedValue({
      ...none,
      parents: [{ person: relative('emma', 'Emma'), parentRole: 'parent' }],
    });
    render(FamilySection, { person });

    await chooseEmmaAsParent();

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Emma added as Taylor's parent."));
    expect(api.createPersonRelationship).toHaveBeenCalledWith({
      id: person.id,
      personRelationshipCreateDto: { relatedPersonId: 'emma', relation: 'parent' },
    });
  });

  it('shows a refusal in the dialog and changes nothing', async () => {
    const message = "Taylor is already Emma's parent, so Taylor can't also be Emma's child.";
    api.isHttpError.mockReturnValue(true);
    api.createPersonRelationship.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { status: 400, data: { message } }),
    );
    render(FamilySection, { person: personWith(none) });

    await chooseEmmaAsParent();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("That relationship can't be added");
    expect(alert.textContent).toContain(message);
    expect(screen.getByText('No family added yet')).toBeTruthy();
  });
});
