// RTS camera: orbits a ground target at a fixed-ish pitch. Pan with WASD /
// arrows / screen edge, rotate with Q/E or middle-drag, zoom with the wheel.
import * as THREE from "three";

export class RtsCamera {
  constructor(mapW, mapH, startX, startZ) {
    this.cam = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 400);
    this.mapW = mapW; this.mapH = mapH;
    this.tx = startX; this.tz = startZ;   // ground target
    this.yaw = Math.PI * 0.25;
    this.dist = 26;
    this.minDist = 10; this.maxDist = 55;
    this.panSpeed = 24;                    // world units/sec at dist 26
    this.updateTransform();
  }

  resize() {
    this.cam.aspect = innerWidth / innerHeight;
    this.cam.updateProjectionMatrix();
  }

  jumpTo(x, z) {
    this.tx = x; this.tz = z;
    this.clamp();
    this.updateTransform();
  }

  // dx/dz in screen-relative units (already * dt); rotated by yaw
  pan(dx, dz) {
    const s = this.dist / 26;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    this.tx += (dx * cos - dz * sin) * s;
    this.tz += (dx * sin + dz * cos) * s;
    this.clamp();
    this.updateTransform();
  }

  rotate(dyaw) {
    this.yaw += dyaw;
    this.updateTransform();
  }

  zoom(factor) {
    this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist * factor));
    this.updateTransform();
  }

  clamp() {
    this.tx = Math.min(this.mapW, Math.max(0, this.tx));
    this.tz = Math.min(this.mapH, Math.max(0, this.tz));
  }

  updateTransform() {
    const pitch = 0.92;                     // ~53 degrees down
    const flat = Math.cos(pitch) * this.dist;
    this.cam.position.set(
      this.tx + Math.sin(this.yaw) * flat,
      Math.sin(pitch) * this.dist,
      this.tz + Math.cos(this.yaw) * flat,
    );
    this.cam.lookAt(this.tx, 0, this.tz);
  }
}
