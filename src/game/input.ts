// Keyboard, mouse and gamepad input.

const DRIVE_KEYS = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyQ',
  'KeyE',
  'ShiftLeft',
  'ControlLeft',
];

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  dragging = false;
  /** Virtual joystick from a touch on the left half of the screen (-1..1). */
  touchMove: [number, number] = [0, 0];

  constructor(target: HTMLElement) {
    addEventListener('keydown', e => {
      if (
        (e.target as HTMLElement)?.tagName === 'INPUT' ||
        (e.target as HTMLElement)?.tagName === 'SELECT'
      )
        return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (DRIVE_KEYS.includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousedown', () => {
      this.dragging = true;
      target.focus();
    });
    addEventListener('mouseup', () => (this.dragging = false));
    addEventListener('mousemove', e => {
      if (this.dragging || document.pointerLockElement === target) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    // Touch: left half = move joystick, right half = look.
    const touches = new Map<number, {x: number; y: number; left: boolean}>();
    target.addEventListener(
      'touchstart',
      e => {
        for (const t of Array.from(e.changedTouches))
          touches.set(t.identifier, {
            x: t.clientX,
            y: t.clientY,
            left: t.clientX < innerWidth / 2,
          });
        e.preventDefault();
      },
      {passive: false},
    );
    target.addEventListener(
      'touchmove',
      e => {
        for (const t of Array.from(e.changedTouches)) {
          const s = touches.get(t.identifier);
          if (!s) continue;
          if (s.left) {
            this.touchMove = [
              Math.max(-1, Math.min(1, (t.clientX - s.x) / 60)),
              Math.max(-1, Math.min(1, (t.clientY - s.y) / 60)),
            ];
          } else {
            this.mouseDX += (t.clientX - s.x) * 1.5;
            this.mouseDY += (t.clientY - s.y) * 1.5;
            s.x = t.clientX;
            s.y = t.clientY;
          }
        }
        e.preventDefault();
      },
      {passive: false},
    );
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (touches.get(t.identifier)?.left) this.touchMove = [0, 0];
        touches.delete(t.identifier);
      }
    };
    target.addEventListener('touchend', end);
    target.addEventListener('touchcancel', end);
    target.addEventListener('wheel', e => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    });
  }

  down(code: string) {
    return this.keys.has(code);
  }

  axis(...codes: string[]) {
    return codes.some(c => this.keys.has(c)) ? 1 : 0;
  }

  /** True once per key press. */
  hit(code: string) {
    return this.pressed.has(code);
  }

  private pad(): Gamepad | null {
    for (const p of navigator.getGamepads?.() ?? []) if (p) return p;
    return null;
  }

  gamepadSteer() {
    const p = this.pad();
    const x = p?.axes[0] ?? 0;
    return Math.abs(x) > 0.15 ? -x : 0;
  }

  gamepadThrottle() {
    const p = this.pad();
    if (!p) return 0;
    return (p.buttons[7]?.value ?? 0) - (p.buttons[6]?.value ?? 0);
  }

  driveActive() {
    return (
      DRIVE_KEYS.some(k => this.keys.has(k)) ||
      Math.abs(this.gamepadSteer()) > 0 ||
      Math.abs(this.gamepadThrottle()) > 0.05
    );
  }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
