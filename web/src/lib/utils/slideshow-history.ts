export class SlideshowHistory {
  private history: { id: string }[] = [];
  private index = 0;

  constructor(private onChange: (asset: { id: string }) => void) {}

  reset() {
    this.history = [];
    this.index = 0;
  }

  queue(asset: { id: string }) {
    this.history.push(asset);

    // If we were at the end of the slideshow history, move the index to the new end
    if (this.index === this.history.length - 2) {
      this.index++;
    }
  }

  next(): boolean {
    return this.move(this.index + 1);
  }

  previous(): boolean {
    return this.move(this.index - 1);
  }

  private move(index: number): boolean {
    if (index < 0 || index >= this.history.length) {
      return false;
    }

    this.index = index;
    this.onChange(this.history[index]);
    return true;
  }
}
