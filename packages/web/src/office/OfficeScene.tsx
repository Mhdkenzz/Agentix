// The 3D office: floor, walls, coordinator's glass office, CEO corner, worker cubicles.
import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import type { Agent } from '../../../shared/src/types.ts';
import { useStore } from '../store.ts';
import { AgentSeat } from './AgentSeat.tsx';
import { MessageArcs } from './MessageArcs.tsx';
import { Desk, Cubicle, Plant, GlassRoom, RoomSign } from './Furniture.tsx';
import {
  seatAgents, workerDesk, rowsFor, roomBounds, COLS,
  COORDINATOR_ROOM, COORDINATOR_DESK, CEO_AREA, CEO_DESK,
} from './layout.ts';

function Room({ workers }: { workers: number }) {
  const { x0, x1, z0, z1 } = roomBounds(workers);
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#0d0d10" roughness={0.9} />
      </mesh>
      <gridHelper args={[Math.max(w, d), Math.round(Math.max(w, d) / 2), '#2a2140', '#16161c']} position={[cx, 0.005, cz]} />
      {/* back + left walls only, so the camera can see in */}
      <mesh position={[cx, 1.6, z0 - 0.1]} receiveShadow><boxGeometry args={[w, 3.2, 0.2]} /><meshStandardMaterial color="#141418" /></mesh>
      <mesh position={[x0 - 0.1, 1.6, cz]} receiveShadow><boxGeometry args={[0.2, 3.2, d]} /><meshStandardMaterial color="#111115" /></mesh>
      {/* thin neon strips along the walls */}
      <mesh position={[cx, 2.6, z0 + 0.01]}><planeGeometry args={[w - 1, 0.05]} /><meshBasicMaterial color="#a78bfa" /></mesh>
      <mesh position={[x0 + 0.01, 2.6, cz]} rotation={[0, Math.PI / 2, 0]}><planeGeometry args={[d - 1, 0.05]} /><meshBasicMaterial color="#22d3ee" /></mesh>
      <Plant position={[x1 - 0.8, 0, z0 + 0.8]} />
      <Plant position={[-5.5, 0, z0 + 0.8]} scale={0.8} />
      <Plant position={[x1 - 0.8, 0, z1 - 0.8]} scale={1.2} />
    </group>
  );
}

function CeoCorner() {
  const { x0, x1, z0, z1 } = CEO_AREA;
  return (
    <group>
      <mesh position={[(x0 + x1) / 2, 0.15, (z0 + z1) / 2]} receiveShadow castShadow>
        <boxGeometry args={[x1 - x0, 0.3, z1 - z0]} />
        <meshStandardMaterial color="#121212" />
      </mesh>
      {/* amber trim: a slightly bigger glowing plane just under the dark top */}
      <mesh position={[(x0 + x1) / 2, 0.302, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[x1 - x0 - 0.9, z1 - z0 - 0.9]} /><meshBasicMaterial color="#fbbf24" />
      </mesh>
      <mesh position={[(x0 + x1) / 2, 0.305, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[x1 - x0 - 1, z1 - z0 - 1]} />
        <meshStandardMaterial color="#151515" metalness={0.3} roughness={0.6} />
      </mesh>
      <RoomSign position={[-15.98, 2, (z0 + z1) / 2]} rotationY={Math.PI / 2} text="CEO" width={2.4} />
      <Plant position={[x0 + 0.8, 0.3, z1 - 0.8]} />
    </group>
  );
}

export function OfficeScene({ active = true }: { active?: boolean }) {
  const agents = useStore(s => s.agents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const list = useMemo(() => Object.values(agents) as Agent[], [agents]);
  const seats = useMemo(() => seatAgents(list), [list]);
  const workers = list.filter(a => a.role === 'worker').length;
  const deskCount = rowsFor(workers) * COLS;
  const coordinator = list.find(a => a.role === 'coordinator');
  const ceo = list.find(a => a.role === 'ceo');
  const { z1 } = roomBounds(workers);

  return (
    <Canvas frameloop={active ? 'always' : 'never'} shadows="percentage" dpr={[1, 1.5]} camera={{ position: [1, 13, z1 + 6], fov: 45 }} onPointerMissed={() => select(undefined)}>
      {/* The first drei <Html> mounted in a Canvas renders empty (seen with drei 10.7 + React 19.3),
          so mount a throwaway one before the real name tags. */}
      <Html><span /></Html>
      <color attach="background" args={['#000000']} />
      <fog attach="fog" args={['#000000', 35, 70]} />
      <ambientLight intensity={0.6} />
      <hemisphereLight args={['#d6ccff', '#0a0a12', 0.6]} />
      <directionalLight position={[8, 18, 10]} intensity={1.4} castShadow shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-25} shadow-camera-right={25} shadow-camera-top={25} shadow-camera-bottom={-25} />

      <Room workers={workers} />
      <GlassRoom {...COORDINATOR_ROOM} />
      <RoomSign position={[(COORDINATOR_ROOM.x0 + COORDINATOR_ROOM.x1) / 2, 2.5, -7.95]} text="Coordinator" />
      <CeoCorner />

      {/* empty desks first, so the office looks like an office even with no agents */}
      {Array.from({ length: deskCount }, (_, i) => <Cubicle key={`c${i}`} position={workerDesk(i)} />)}
      {Array.from({ length: deskCount }, (_, i) => i).filter(i => i >= workers).map(i => <Desk key={`d${i}`} position={workerDesk(i)} />)}
      {!coordinator && <Desk position={COORDINATOR_DESK} color="#7a5a3a" />}
      {!ceo && <Desk position={CEO_DESK} color="#3a2a1a" />}

      {list.map(a => {
        const seat = seats.get(a.id);
        return seat ? (
          <AgentSeat key={a.id} agent={a} position={seat} selected={a.id === selectedId}
            deskColor={a.role === 'coordinator' ? '#24202e' : a.role === 'ceo' ? '#1c1a14' : undefined} />
        ) : null;
      })}

      <MessageArcs seats={seats} />
      <OrbitControls makeDefault target={[0, 0, (z1 - 8) / 2]} minDistance={8} maxDistance={45}
        minPolarAngle={0.2} maxPolarAngle={1.25} enableDamping />
    </Canvas>
  );
}
