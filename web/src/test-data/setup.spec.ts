describe('animation stand-in', () => {
  it('finishes an animation in a microtask', async () => {
    const onfinish = vi.fn();
    document.createElement('div').animate([], 100).onfinish = onfinish;
    await Promise.resolve();
    expect(onfinish).toHaveBeenCalledOnce();
  });

  it('does not finish once the document it was set up with is gone', async () => {
    const onfinish = vi.fn();
    document.createElement('div').animate([], 100).onfinish = onfinish;
    vi.stubGlobal('document', undefined);
    await Promise.resolve();
    vi.unstubAllGlobals();
    expect(onfinish).not.toHaveBeenCalled();
  });
});
