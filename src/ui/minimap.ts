// In-game map: the loading screen's map of the city (loading.mapSnapshot)
// over the view, with an arrowhead at the camera pointing where it looks.
// Toggled from the toolbar; doesn't take input, so play goes on under it.

import type {Vec3} from '../math/vec.ts';
import {loading} from './loading.ts';

export class MapOverlay {
  private root = document.getElementById('mapview')!;
  private canvas = document.getElementById('mapcanvas') as HTMLCanvasElement;
  private base: {img: HTMLCanvasElement; size: number} | null = null;
  /** City the base map was taken for. */
  private key = '';
  visible = false;

  toggle() {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? '' : 'none';
  }

  /** Once per frame: redraw while visible. `key` names the loaded city. */
  update(key: string, cam: {eye: Vec3; target: Vec3} | null) {
    if (!this.visible) return;
    if (key !== this.key || !this.base) {
      this.base = loading.mapSnapshot();
      this.key = this.base ? key : '';
    }
    const c = this.canvas;
    const n = Math.min(
      2048,
      Math.round(c.clientWidth * Math.min(2, devicePixelRatio || 1)),
    );
    if (!n) return;
    if (c.width !== n) c.width = c.height = n;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, n, n);
    const b = this.base;
    if (!b) return;
    g.imageSmoothingQuality = 'high';
    g.drawImage(b.img, 0, 0, n, n);
    if (!cam) return;
    // World x/z -> map pixels (the map spans -size/2..size/2, z down).
    const k = n / b.size;
    const x = (cam.eye[0] + b.size / 2) * k;
    const y = (cam.eye[2] + b.size / 2) * k;
    const a = Math.atan2(
      cam.target[2] - cam.eye[2],
      cam.target[0] - cam.eye[0],
    );
    const r = n / 40;
    g.save();
    g.translate(Math.min(n, Math.max(0, x)), Math.min(n, Math.max(0, y)));
    g.rotate(a);
    g.beginPath();
    g.moveTo(r, 0);
    g.lineTo(-r * 0.7, r * 0.65);
    g.lineTo(-r * 0.35, 0);
    g.lineTo(-r * 0.7, -r * 0.65);
    g.closePath();
    g.fillStyle = '#ff4d3d';
    g.strokeStyle = '#fff';
    g.lineWidth = Math.max(1.5, n / 400);
    g.lineJoin = 'round';
    g.fill();
    g.stroke();
    g.restore();
  }
}
