import { updatePerson, type PersonResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import PersonNotes from '$lib/components/frameleaf/people/PersonNotes.svelte';
import { noteParts } from '$lib/frameleaf/person-notes';
import { personFactory } from '@test-data/factories/person-factory';
import en from '../../../../../../i18n/en.json';

/** Notes on the person page (FL-941): private, plain text, links shown as links; an empty note clears it. */
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), updatePerson: vi.fn() }));

const person = (notes: string | null | undefined) =>
  ({ ...personFactory.build({ name: 'Ray' }), notes }) as PersonResponseDto;

describe('PersonNotes (FL-941)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.clearAllMocks());

  it('shows nothing for a person whose notes the server does not send (a partner’s)', () => {
    render(PersonNotes, { person: person(undefined) });
    expect(screen.queryByText(en.frameleaf_person_notes_title)).not.toBeInTheDocument();
  });

  it('shows a note with its links as links', () => {
    render(PersonNotes, { person: person('Grandad’s brother.\nRecipe: https://example.test/soup, try it.') });
    expect(screen.getByText(en.frameleaf_person_notes_private)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'https://example.test/soup' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: en.edit })).toBeInTheDocument();
  });

  it('adds a note, counts the characters, and tells the page', async () => {
    const current = person(null);
    const saved = { ...current, notes: 'Met at the hiking club.' };
    vi.mocked(updatePerson).mockResolvedValue(saved);
    const onPersonChange = vi.fn();
    render(PersonNotes, { person: current, onPersonChange });

    expect(screen.getByText(en.frameleaf_person_notes_empty)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_person_notes_add }));
    const box = screen.getByRole('textbox', { name: 'Notes about Ray' });
    expect(box).toHaveAttribute('maxlength', '2000');
    await fireEvent.input(box, { target: { value: 'Met at the hiking club.' } });
    expect(screen.getByText(/^23 of 2,000 characters/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.save }));

    await waitFor(() => expect(onPersonChange).toHaveBeenCalledWith(saved));
    expect(updatePerson).toHaveBeenCalledWith({
      id: saved.id,
      personUpdateDto: { notes: 'Met at the hiking club.' },
    });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // FL-1810: a saved field says so beside it, not in a toast
    expect(screen.getByTestId('frameleaf-status-line')).toHaveTextContent(en.frameleaf_person_notes_saved);
  });

  it('says in place that the note was not saved, and keeps the text (FL-1810)', async () => {
    vi.mocked(updatePerson).mockRejectedValue(new Error('offline'));
    render(PersonNotes, { person: person(null) });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_person_notes_add }));
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Keep me' } });
    await fireEvent.click(screen.getByRole('button', { name: en.save }));

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_person_notes_error);
    expect(screen.getByRole('textbox')).toHaveValue('Keep me');
  });

  it('clears the note when it is saved empty, and Cancel changes nothing', async () => {
    const current = person('Old note');
    vi.mocked(updatePerson).mockResolvedValue(person(null));
    render(PersonNotes, { person: current });

    await fireEvent.click(screen.getByRole('button', { name: en.edit }));
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Something else' } });
    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    expect(updatePerson).not.toHaveBeenCalled();
    expect(screen.getByText('Old note')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.edit }));
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: ' '.repeat(3) } });
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    await waitFor(() =>
      expect(updatePerson).toHaveBeenCalledWith({ id: current.id, personUpdateDto: { notes: null } }),
    );
  });

  it('finds web links and leaves the punctuation after them alone', () => {
    expect(noteParts('See https://a.test/x. And (http://b.test/y) too')).toEqual([
      { text: 'See ' },
      { text: 'https://a.test/x', href: 'https://a.test/x' },
      { text: '. And (' },
      { text: 'http://b.test/y', href: 'http://b.test/y' },
      { text: ') too' },
    ]);
    expect(noteParts('javascript:alert(1) ftp://x')).toEqual([{ text: 'javascript:alert(1) ftp://x' }]);
    expect(noteParts(null)).toEqual([]);
    // a bracket the address opened stays; one the sentence opened goes
    expect(noteParts('https://en.wikipedia.org/wiki/John_Smith_(explorer)')).toEqual([
      {
        text: 'https://en.wikipedia.org/wiki/John_Smith_(explorer)',
        href: 'https://en.wikipedia.org/wiki/John_Smith_(explorer)',
      },
    ]);
    expect(noteParts('(see https://a.test/wiki/X_(y)).')).toEqual([
      { text: '(see ' },
      { text: 'https://a.test/wiki/X_(y)', href: 'https://a.test/wiki/X_(y)' },
      { text: ').' },
    ]);
  });

  it('does not hand a late save to the page once the card shows another person', async () => {
    const first = person('Old note');
    let finish: (value: PersonResponseDto) => void = () => {};
    vi.mocked(updatePerson).mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    const onPersonChange = vi.fn();
    const view = render(PersonNotes, { person: first, onPersonChange });

    await fireEvent.click(screen.getByRole('button', { name: en.edit }));
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    await view.rerender({ person: person('Someone else’s note'), onPersonChange });
    finish({ ...first, notes: 'Old note' });
    await Promise.resolve();
    await Promise.resolve();

    expect(onPersonChange).not.toHaveBeenCalled();
    expect(screen.getByText('Someone else’s note')).toBeInTheDocument();
  });
});
