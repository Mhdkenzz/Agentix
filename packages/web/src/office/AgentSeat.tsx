// One agent at its desk: avatar, name tag, live activity bubble, status animation.
import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import type { Agent } from '../../../shared/src/types.ts';
import { Avatar3D } from '../avatars/Avatar3D.tsx';
import { Desk } from './Furniture.tsx';
import type { Vec3 } from './layout.ts';
import { useStore } from '../store.ts';

const STATUS_COLOR: Record<string, string> = {
  idle: '#7d7d7d', starting: '#22d3ee', thinking: '#a78bfa', working: '#34d399',
  waiting_input: '#fbbf24', error: '#f87171', stopped: '#4a4a4a',
};

const ROLE_BADGE: Record<string, string> = { coordinator: '★ coordinator', ceo: '♛ CEO', worker: '' };

export function AgentSeat({ agent, position, selected, deskColor }: { agent: Agent; position: Vec3; selected: boolean; deskColor?: string }) {
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const [hover, setHover] = useState(false);
  const select = useStore(s => s.select);
  // the task this agent is on, shown on its desk tag
  const task = useStore(s => Object.values(s.tasks).find(t => t.owner === agent.id && t.status === 'doing')
    ?? Object.values(s.tasks).find(t => t.owner === agent.id && (t.status === 'todo' || t.status === 'review' || t.status === 'blocked')));
  const status = agent.status;
  const working = status === 'working' || status === 'starting';
  const phase = useRef(Math.random() * 10).current;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    if (!body.current || !head.current || !leftArm.current || !rightArm.current) return;
    body.current.position.y = status === 'thinking' ? Math.abs(Math.sin(t * 3)) * 0.06 : 0;
    head.current.rotation.z = status === 'thinking' ? Math.sin(t * 1.5) * 0.15 : 0;
    head.current.rotation.x = working ? 0.15 + Math.sin(t * 2) * 0.03 : 0;
    // typing: quick alternating arm taps; waiting: right hand up
    leftArm.current.rotation.x = working ? Math.sin(t * 18) * 0.15 : 0;
    rightArm.current.rotation.x = status === 'waiting_input' ? -2.2 + Math.sin(t * 4) * 0.15 : working ? Math.sin(t * 18 + 1.6) * 0.15 : 0;
    if (ring.current) {
      const m = ring.current.material as MeshStandardMaterial;
      const pulse = status === 'error' ? 0.6 + Math.sin(t * 6) * 0.6 : selected ? 1.2 : hover ? 0.8 : 0.35;
      m.emissiveIntensity = Math.max(0, pulse);
      ring.current.scale.setScalar(selected ? 1.15 + Math.sin(t * 3) * 0.04 : 1);
    }
  });

  const color = STATUS_COLOR[status] ?? '#7d7d7d';
  const bubble = status === 'thinking' ? '…' : status === 'waiting_input' ? '?' : agent.activity;
  const showBubble = status !== 'idle' && status !== 'stopped' && bubble;

  return (
    <group position={position}>
      <Desk position={[0, 0, 0]} glow={working ? 1.4 : status === 'thinking' ? 0.5 : 0} color={deskColor} screen={color} />
      <group
        position={[0, 0, -0.75]}
        onClick={e => { e.stopPropagation(); select(agent.id); }}
        onPointerOver={e => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = ''; }}
      >
        <mesh ref={ring} position={[0, 0.02, 0.1]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.55, 0.7, 32]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} transparent opacity={0.85} />
        </mesh>
        <Avatar3D ref={body} head={head} leftArm={leftArm} rightArm={rightArm} avatarId={agent.avatarId} />
        {/* invisible, larger hit box so avatars are easy to click */}
        <mesh position={[0, 0.9, 0]} visible={false}><boxGeometry args={[0.9, 1.9, 0.9]} /></mesh>
        <Html position={[0, 2.15, 0]} center distanceFactor={18} zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
          <div className={`tag ${selected ? 'tag-selected' : ''}`}>
            {showBubble && <div className={`bubble bubble-${status}`}>{bubble}</div>}
            <div className="nameplate">
              <span className="dot" style={{ background: color }} />
              {agent.name}
              <span className="kind">{agent.kind}</span>
            </div>
            {ROLE_BADGE[agent.role] && <div className="role-badge">{ROLE_BADGE[agent.role]}</div>}
            {task && <div className={`desk-task desk-task-${task.status}`} title={task.title}>☑ {task.title}</div>}
          </div>
        </Html>
        {status === 'error' && <pointLight position={[0, 1.5, 0.5]} color="#ff3344" intensity={2} distance={3} />}
      </group>
    </group>
  );
}
