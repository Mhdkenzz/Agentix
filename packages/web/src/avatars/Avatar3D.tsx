// A seated low-poly character built from primitives. Animated by the parent via refs.
import { forwardRef } from 'react';
import type { Group } from 'three';
import { avatarFor } from './index.ts';

interface Props { avatarId: number; leftArm?: React.Ref<Group>; rightArm?: React.Ref<Group>; head?: React.Ref<Group> }

export const Avatar3D = forwardRef<Group, Props>(function Avatar3D({ avatarId, leftArm, rightArm, head }, ref) {
  const a = avatarFor(avatarId);
  const boxy = a.feature === 'antenna' || a.feature === 'knightHelm';
  return (
    <group ref={ref}>
      {/* legs (seated) */}
      <mesh position={[-0.13, 0.45, 0.18]} castShadow><boxGeometry args={[0.18, 0.16, 0.5]} /><meshStandardMaterial color="#2b2f3d" /></mesh>
      <mesh position={[0.13, 0.45, 0.18]} castShadow><boxGeometry args={[0.18, 0.16, 0.5]} /><meshStandardMaterial color="#2b2f3d" /></mesh>
      {/* torso */}
      <mesh position={[0, 0.82, 0]} castShadow>
        {boxy ? <boxGeometry args={[0.5, 0.6, 0.32]} /> : <cylinderGeometry args={[0.2, 0.27, 0.6, 12]} />}
        <meshStandardMaterial color={a.body} />
      </mesh>
      {/* arms, pivot at the shoulder */}
      <group ref={leftArm} position={[-0.3, 1.05, 0]}>
        <mesh position={[0, -0.12, 0.14]} rotation={[-1.1, 0, 0]} castShadow><boxGeometry args={[0.12, 0.4, 0.12]} /><meshStandardMaterial color={a.body} /></mesh>
      </group>
      <group ref={rightArm} position={[0.3, 1.05, 0]}>
        <mesh position={[0, -0.12, 0.14]} rotation={[-1.1, 0, 0]} castShadow><boxGeometry args={[0.12, 0.4, 0.12]} /><meshStandardMaterial color={a.body} /></mesh>
      </group>
      {/* head + feature */}
      <group ref={head} position={[0, 1.38, 0]}>
        <mesh castShadow>
          {boxy ? <boxGeometry args={[0.42, 0.4, 0.4]} /> : <sphereGeometry args={[0.24, 20, 16]} />}
          <meshStandardMaterial color={a.feature === 'knightHelm' ? a.accent : a.skin} metalness={boxy ? 0.5 : 0} roughness={boxy ? 0.4 : 0.8} />
        </mesh>
        <Feature avatarId={avatarId} />
      </group>
    </group>
  );
});

function Eyes({ color = '#1b1b22', y = 0.03, z = 0.22, r = 0.035, spread = 0.08 }) {
  return (
    <>
      <mesh position={[-spread, y, z]}><sphereGeometry args={[r, 8, 8]} /><meshStandardMaterial color={color} /></mesh>
      <mesh position={[spread, y, z]}><sphereGeometry args={[r, 8, 8]} /><meshStandardMaterial color={color} /></mesh>
    </>
  );
}

function Feature({ avatarId }: { avatarId: number }) {
  const a = avatarFor(avatarId);
  switch (a.feature) {
    case 'antenna':
      return (
        <>
          <mesh position={[0, 0.3, 0]}><cylinderGeometry args={[0.02, 0.02, 0.2]} /><meshStandardMaterial color="#666" /></mesh>
          <mesh position={[0, 0.42, 0]}><sphereGeometry args={[0.06]} /><meshStandardMaterial color={a.accent} emissive={a.accent} emissiveIntensity={1.5} /></mesh>
          <Eyes color={a.accent} z={0.205} r={0.05} spread={0.1} />
        </>
      );
    case 'helmet':
      return (
        <>
          <Eyes />
          <mesh><sphereGeometry args={[0.33, 20, 16]} /><meshStandardMaterial color={a.accent} transparent opacity={0.25} roughness={0.1} /></mesh>
        </>
      );
    case 'wizardHat':
      return (
        <>
          <Eyes />
          <mesh position={[0, 0.2, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.38, 0.38, 0.03, 20]} /><meshStandardMaterial color={a.accent} /></mesh>
          <mesh position={[0, 0.48, 0]}><coneGeometry args={[0.25, 0.55, 16]} /><meshStandardMaterial color={a.accent} /></mesh>
          <mesh position={[0, -0.22, 0.14]}><coneGeometry args={[0.13, 0.3, 10]} /><meshStandardMaterial color="#eeeeee" /></mesh>
        </>
      );
    case 'mask':
      return (
        <>
          <mesh scale={[1.02, 1.02, 1.02]} position={[0, -0.05, 0]}><sphereGeometry args={[0.24, 20, 16, 0, Math.PI * 2, Math.PI / 2.3, Math.PI / 1.7]} /><meshStandardMaterial color={a.body} /></mesh>
          <mesh position={[0, 0.1, 0]} rotation={[0, 0, 0]}><torusGeometry args={[0.245, 0.03, 8, 24]} /><meshStandardMaterial color={a.accent} /></mesh>
          <Eyes color="#ffffff" r={0.03} />
        </>
      );
    case 'catEars':
      return (
        <>
          <Eyes color="#2c5c22" />
          <mesh position={[-0.14, 0.24, 0]} rotation={[0, 0, 0.3]}><coneGeometry args={[0.08, 0.18, 4]} /><meshStandardMaterial color={a.accent} /></mesh>
          <mesh position={[0.14, 0.24, 0]} rotation={[0, 0, -0.3]}><coneGeometry args={[0.08, 0.18, 4]} /><meshStandardMaterial color={a.accent} /></mesh>
          <mesh position={[0, -0.02, 0.235]}><sphereGeometry args={[0.025]} /><meshStandardMaterial color="#e2557a" /></mesh>
        </>
      );
    case 'hood':
      return (
        <>
          <Eyes />
          <mesh position={[0, 0.02, -0.04]}><sphereGeometry args={[0.29, 20, 16, Math.PI * 0.15, Math.PI * 1.7]} /><meshStandardMaterial color={a.body} side={2} /></mesh>
          <mesh position={[0, -0.08, 0.26]}><boxGeometry args={[0.16, 0.05, 0.02]} /><meshStandardMaterial color={a.accent} emissive={a.accent} emissiveIntensity={0.8} /></mesh>
        </>
      );
    case 'goggles':
      return (
        <>
          <mesh position={[-0.09, 0.05, 0.21]}><torusGeometry args={[0.06, 0.02, 8, 16]} /><meshStandardMaterial color="#333" /></mesh>
          <mesh position={[0.09, 0.05, 0.21]}><torusGeometry args={[0.06, 0.02, 8, 16]} /><meshStandardMaterial color="#333" /></mesh>
          <mesh position={[-0.09, 0.05, 0.215]}><circleGeometry args={[0.055, 16]} /><meshStandardMaterial color={a.accent} transparent opacity={0.7} /></mesh>
          <mesh position={[0.09, 0.05, 0.215]}><circleGeometry args={[0.055, 16]} /><meshStandardMaterial color={a.accent} transparent opacity={0.7} /></mesh>
          <mesh position={[0, 0.17, -0.02]}><sphereGeometry args={[0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.5]} /><meshStandardMaterial color="#9a9a9a" /></mesh>
        </>
      );
    case 'pirateHat':
      return (
        <>
          <mesh position={[0.08, 0.04, 0.22]}><sphereGeometry args={[0.035]} /><meshStandardMaterial color="#1b1b22" /></mesh>
          <mesh position={[-0.08, 0.04, 0.215]}><cylinderGeometry args={[0.06, 0.06, 0.02, 12]} /><meshStandardMaterial color="#111" /></mesh>
          <mesh position={[0, 0.2, 0]} scale={[1.4, 0.5, 1]}><cylinderGeometry args={[0.22, 0.28, 0.3, 3]} /><meshStandardMaterial color={a.accent} /></mesh>
          <mesh position={[0, 0.22, 0.18]}><sphereGeometry args={[0.04]} /><meshStandardMaterial color="#f2f2f2" /></mesh>
        </>
      );
    case 'knightHelm':
      return (
        <>
          <mesh position={[0, 0.03, 0.205]}><boxGeometry args={[0.3, 0.04, 0.02]} /><meshStandardMaterial color="#1a1a1a" /></mesh>
          <mesh position={[0, 0.3, -0.05]}><boxGeometry args={[0.05, 0.18, 0.3]} /><meshStandardMaterial color="#c0392b" /></mesh>
        </>
      );
    case 'alienEyes':
      return (
        <>
          <mesh position={[-0.09, 0.03, 0.19]} scale={[1, 1.5, 0.6]}><sphereGeometry args={[0.065, 12, 10]} /><meshStandardMaterial color={a.accent} roughness={0.1} /></mesh>
          <mesh position={[0.09, 0.03, 0.19]} scale={[1, 1.5, 0.6]}><sphereGeometry args={[0.065, 12, 10]} /><meshStandardMaterial color={a.accent} roughness={0.1} /></mesh>
          <mesh position={[0, 0.3, 0]}><cylinderGeometry args={[0.015, 0.015, 0.18]} /><meshStandardMaterial color={a.skin} /></mesh>
          <mesh position={[0, 0.4, 0]}><sphereGeometry args={[0.04]} /><meshStandardMaterial color="#ffe14d" emissive="#ffe14d" emissiveIntensity={1} /></mesh>
        </>
      );
  }
}
