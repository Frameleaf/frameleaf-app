import { prefersReducedMotion } from '$lib/frameleaf/motion';

/**
 * One burst of confetti (FL-1146 completion window). Draws on a temporary canvas inside `parent` and removes it
 * when the last piece has fallen. A modal dialog sits in the browser's top layer, so pass the dialog as `parent`
 * to draw above it. Does nothing for people who ask for reduced motion.
 */
export function confetti({ parent = document.body, count = 220, duration = 4500 } = {}): () => void {
  if (prefersReducedMotion()) {
    return () => {};
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return () => {};
  }
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '1000' });
  parent.append(canvas);
  const ratio = devicePixelRatio || 1;
  const resize = () => {
    canvas.width = innerWidth * ratio;
    canvas.height = innerHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(document.documentElement);
  resize();
  const style = getComputedStyle(parent);
  const colors = ['--fl-accent', '--fl-teal', '--fl-blue', '--fl-warning'].map(
    (name) => style.getPropertyValue(name).trim() || '#22c55e',
  );
  // Two bursts from the lower corners, angled up and in.
  const pieces = Array.from({ length: count }, (_, index) => {
    const left = index % 2 === 0;
    const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const speed = 18 + Math.random() * 14;
    return {
      x: left ? innerWidth * 0.1 : innerWidth * 0.9,
      y: innerHeight * 0.95,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 6 + Math.random() * 6,
      spin: (Math.random() - 0.5) * 0.3,
      turn: Math.random() * Math.PI,
      color: colors[index % colors.length],
    };
  });
  const start = performance.now();
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.remove();
  };
  const draw = (now: number) => {
    const elapsed = now - start;
    context.clearRect(0, 0, innerWidth, innerHeight);
    context.globalAlpha = Math.max(0, 1 - Math.max(0, elapsed - duration * 0.7) / (duration * 0.3));
    for (const piece of pieces) {
      // Light gravity and a slow terminal speed let the pieces drift down rather than drop.
      piece.vy = Math.min(piece.vy * 0.985 + 0.25, 3.5);
      piece.vx *= 0.97;
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.turn += piece.spin;
      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.turn);
      context.fillStyle = piece.color;
      context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
      context.restore();
    }
    if (elapsed < duration) {
      frame = requestAnimationFrame(draw);
    } else {
      stop();
    }
  };
  frame = requestAnimationFrame(draw);
  return stop;
}
