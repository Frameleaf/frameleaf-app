import { slidingPlate } from '$lib/components/timeline/sliding-plate';

const control = (pressed: number, width = 80) => {
  const node = document.createElement('div');
  for (let index = 0; index < 3; index++) {
    const button = document.createElement('button');
    button.setAttribute('aria-pressed', String(index === pressed));
    Object.defineProperties(button, {
      offsetWidth: { get: () => width },
      offsetLeft: { get: () => index * width },
    });
    node.append(button);
  }
  document.body.append(node);
  return node;
};

describe('slidingPlate', () => {
  it('publishes where the pressed segment is and marks the control ready after the first paint', async () => {
    const node = control(1);
    const action = slidingPlate(node, 'months');
    expect(node.style.getPropertyValue('--plate-x')).toBe('80px');
    expect(node.style.getPropertyValue('--plate-w')).toBe('80px');
    // Not before a frame has passed, so the plate does not slide in from the edge.
    expect(node.dataset.plateReady).toBeUndefined();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(node.dataset.plateReady).toBe('');
    action.destroy();
  });

  it('moves when the value changes', async () => {
    const node = control(0);
    const action = slidingPlate(node, 'years');
    node.firstElementChild!.setAttribute('aria-pressed', 'false');
    node.lastElementChild!.setAttribute('aria-pressed', 'true');
    action.update();
    await Promise.resolve();
    await Promise.resolve();
    expect(node.style.getPropertyValue('--plate-x')).toBe('160px');
    action.destroy();
  });

  it('leaves the plain pressed style alone where nothing can be measured', () => {
    const node = control(1, 0);
    const action = slidingPlate(node, 'months');
    expect(node.dataset.plateReady).toBeUndefined();
    expect(node.style.getPropertyValue('--plate-w')).toBe('');
    action.destroy();
  });
});
