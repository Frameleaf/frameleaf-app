import { draggedPhotos, endPhotoDrag, providePhotoSelection, startPhotoDrag } from './photo-drag';

describe('photos dragged onto a sidebar album', () => {
  const drag = () => new Event('dragstart') as DragEvent;

  it('takes the whole selection with a selected photo, and any other photo alone', () => {
    const stop = providePhotoSelection(() => ['a', 'b']);
    startPhotoDrag(drag(), 'a');
    expect(draggedPhotos()).toEqual(['a', 'b']);
    startPhotoDrag(drag(), 'c');
    expect(draggedPhotos()).toEqual(['c']);
    endPhotoDrag();
    expect(draggedPhotos()).toBeNull();
    stop();
    // every match selected, not all loaded: nothing is dragged, so a part of it is never added
    const stopAll = providePhotoSelection(() => undefined);
    const refused = drag();
    const prevented = vi.spyOn(refused, 'preventDefault');
    startPhotoDrag(refused, 'a');
    expect(prevented).toHaveBeenCalled();
    expect(draggedPhotos()).toBeNull();
    stopAll();
    startPhotoDrag(drag(), 'a');
    expect(draggedPhotos()).toEqual(['a']);
    endPhotoDrag();
  });
});
