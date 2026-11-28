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
    startPhotoDrag(drag(), 'a');
    expect(draggedPhotos()).toEqual(['a']);
    endPhotoDrag();
  });
});
