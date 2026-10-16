// Paper planes flying between desks when one agent messages or steers another.
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3, QuadraticBezierCurve3, type Group } from 'three';
import { useStore, ARC_DURATION_MS, type Arc } from '../store.ts';
import type { Vec3 } from './layout.ts';

function Plane({ arc, from, to }: { arc: Arc; from: Vec3; to: Vec3 }) {
  const ref = useRef<Group>(null);
  const a = new Vector3(from[0], 2, from[2] - 0.75);
  const b = new Vector3(to[0], 2, to[2] - 0.75);
  const mid = a.clone().lerp(b, 0.5).setY(2 + a.distanceTo(b) * 0.35);
  const curve = useRef(new QuadraticBezierCurve3(a, mid, b)).current;
  useFrame(() => {
    if (!ref.current) return;
    const t = Math.min(1, (performance.now() - arc.born) / (ARC_DURATION_MS * 0.8));
    const p = curve.getPoint(t);
    ref.current.position.copy(p);
    ref.current.lookAt(curve.getPoint(Math.min(1, t + 0.01)));
    ref.current.visible = t < 1;
  });
  return (
    <group ref={ref}>
      <mesh rotation={[Math.PI / 2, 0, 0]} scale={[0.35, 0.5, 0.08]}>
        <coneGeometry args={[0.6, 1, 3]} />
        <meshStandardMaterial color="#ffffff" emissive="#a78bfa" emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

export function MessageArcs({ seats }: { seats: Map<string, Vec3> }) {
  const arcs = useStore(s => s.arcs);
  const prune = useStore(s => s.pruneArcs);
  useFrame(() => prune(performance.now()));
  return (
    <>
      {arcs.map(arc => {
        const from = seats.get(arc.from), to = seats.get(arc.to);
        return from && to ? <Plane key={arc.id} arc={arc} from={from} to={to} /> : null;
      })}
    </>
  );
}
