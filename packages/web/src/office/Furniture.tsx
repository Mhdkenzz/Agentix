import { useMemo } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';
// Desks, chairs, plants and rooms. Plain boxes and cylinders, no model files.
import type { Vec3 } from './layout.ts';

export function Desk({ position, glow = 0, color = '#c9a27a', screen = '#7bdcff' }: { position: Vec3; glow?: number; color?: string; screen?: string }) {
  return (
    <group position={position}>
      {/* desk top + legs; the agent sits at -z and faces +z */}
      <mesh position={[0, 0.78, 0]} castShadow receiveShadow><boxGeometry args={[1.8, 0.06, 0.9]} /><meshStandardMaterial color={color} /></mesh>
      {[[-0.82, -0.38], [0.82, -0.38], [-0.82, 0.38], [0.82, 0.38]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.38, z]}><boxGeometry args={[0.06, 0.76, 0.06]} /><meshStandardMaterial color="#4a4f5c" /></mesh>
      ))}
      {/* laptop: base + open screen, facing the agent */}
      <mesh position={[0, 0.82, 0.05]}><boxGeometry args={[0.6, 0.02, 0.4]} /><meshStandardMaterial color="#2c2f38" /></mesh>
      <group position={[0, 0.82, 0.25]} rotation={[0.35, 0, 0]}>
        <mesh position={[0, 0.2, 0]}><boxGeometry args={[0.6, 0.4, 0.02]} /><meshStandardMaterial color="#2c2f38" /></mesh>
        <mesh position={[0, 0.2, -0.012]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.54, 0.34]} />
          <meshStandardMaterial color={glow > 0 ? screen : '#1a1d26'} emissive={screen} emissiveIntensity={glow} />
        </mesh>
      </group>
      {/* mug */}
      <mesh position={[0.65, 0.86, -0.2]}><cylinderGeometry args={[0.05, 0.045, 0.11, 10]} /><meshStandardMaterial color="#e8e2d0" /></mesh>
      <Chair position={[0, 0, -0.75]} />
    </group>
  );
}

export function Chair({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.42, 0]} castShadow><boxGeometry args={[0.55, 0.08, 0.55]} /><meshStandardMaterial color="#3a3f52" /></mesh>
      <mesh position={[0, 0.8, -0.28]} castShadow><boxGeometry args={[0.55, 0.7, 0.08]} /><meshStandardMaterial color="#3a3f52" /></mesh>
      <mesh position={[0, 0.2, 0]}><cylinderGeometry args={[0.04, 0.04, 0.4]} /><meshStandardMaterial color="#222" /></mesh>
      <mesh position={[0, 0.03, 0]}><cylinderGeometry args={[0.28, 0.28, 0.04, 12]} /><meshStandardMaterial color="#222" /></mesh>
    </group>
  );
}

export function Plant({ position, scale = 1 }: { position: Vec3; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.25, 0]} castShadow><cylinderGeometry args={[0.25, 0.2, 0.5, 12]} /><meshStandardMaterial color="#c4744a" /></mesh>
      <mesh position={[0, 0.8, 0]} castShadow><icosahedronGeometry args={[0.45, 0]} /><meshStandardMaterial color="#3f9d58" flatShading /></mesh>
      <mesh position={[0.15, 1.15, 0.05]} castShadow><icosahedronGeometry args={[0.3, 0]} /><meshStandardMaterial color="#4fb86a" flatShading /></mesh>
    </group>
  );
}

/** Low cubicle partitions behind and beside a desk. */
export function Cubicle({ position }: { position: Vec3 }) {
  const [x, , z] = position;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.6, -1.55]} receiveShadow><boxGeometry args={[2.6, 1.2, 0.08]} /><meshStandardMaterial color="#8f9bb3" /></mesh>
      <mesh position={[-1.3, 0.6, -0.6]}><boxGeometry args={[0.08, 1.2, 1.9]} /><meshStandardMaterial color="#8f9bb3" /></mesh>
    </group>
  );
}

/** A glass-walled room with a door gap on the right wall. */
export function GlassRoom({ x0, x1, z0, z1, tint = '#9fd8ff' }: { x0: number; x1: number; z0: number; z1: number; tint?: string }) {
  const h = 2.6, t = 0.06;
  const w = x1 - x0, d = z1 - z0;
  const glass = <meshPhysicalMaterial color={tint} transparent opacity={0.18} roughness={0.05} metalness={0.1} />;
  const frame = <meshStandardMaterial color="#d7dce5" />;
  const door = 1.6; // gap in the right wall
  const seg = (d - door) / 2;
  return (
    <group>
      {/* floor rug */}
      <mesh position={[(x0 + x1) / 2, 0.011, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[w, d]} /><meshStandardMaterial color="#3c4a6e" />
      </mesh>
      {/* front glass (towards camera) kept low so we can see in */}
      <mesh position={[(x0 + x1) / 2, 0.5, z1]}><boxGeometry args={[w, 1, t]} />{glass}</mesh>
      <mesh position={[(x0 + x1) / 2, 1, z1]}><boxGeometry args={[w, 0.05, 0.1]} />{frame}</mesh>
      {/* right wall with a door */}
      <mesh position={[x1, h / 2, z0 + seg / 2]}><boxGeometry args={[t, h, seg]} />{glass}</mesh>
      <mesh position={[x1, h / 2, z1 - seg / 2]}><boxGeometry args={[t, h, seg]} />{glass}</mesh>
      <mesh position={[x1, h, (z0 + z1) / 2]}><boxGeometry args={[0.1, 0.08, d]} />{frame}</mesh>
      {[z0, z0 + seg, z1 - seg, z1].map((z, i) => (
        <mesh key={i} position={[x1, h / 2, z]}><boxGeometry args={[0.1, h, 0.1]} />{frame}</mesh>
      ))}
    </group>
  );
}

/** A wall sign drawn onto a canvas texture (no font download, no DOM overlay). */
export function RoomSign({ position, text, width = 3.2, rotationY = 0 }: { position: Vec3; text: string; width?: number; rotationY?: number }) {
  const texture = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1b2033'; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#6d5dfc'; g.lineWidth = 6; g.strokeRect(3, 3, 506, 122);
    g.fillStyle = '#e7ecff'; g.font = 'bold 60px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text.toUpperCase(), 256, 68);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [text]);
  return (
    <mesh position={position} rotation={[0, rotationY, 0]}>
      <planeGeometry args={[width, width / 4]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}
