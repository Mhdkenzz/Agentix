// The 10 premade avatars. Each is built from primitives (no model files), see Avatar3D.tsx.
export type Feature =
  | 'antenna' | 'helmet' | 'wizardHat' | 'mask' | 'catEars'
  | 'hood' | 'goggles' | 'pirateHat' | 'knightHelm' | 'alienEyes';

export interface AvatarDef {
  id: number;
  name: string;
  skin: string;   // head colour
  body: string;   // torso colour
  accent: string; // hat / feature colour
  feature: Feature;
}

export const AVATARS: AvatarDef[] = [
  { id: 0, name: 'Robot', skin: '#b8c4d6', body: '#5b6b85', accent: '#ff5d5d', feature: 'antenna' },
  { id: 1, name: 'Astronaut', skin: '#f2c9a0', body: '#eef1f6', accent: '#7fd3ff', feature: 'helmet' },
  { id: 2, name: 'Wizard', skin: '#f0c7a1', body: '#5a3fb8', accent: '#3b2a86', feature: 'wizardHat' },
  { id: 3, name: 'Ninja', skin: '#e9b98f', body: '#23252e', accent: '#d8343f', feature: 'mask' },
  { id: 4, name: 'Cat-person', skin: '#f6a54a', body: '#2fa38a', accent: '#f6a54a', feature: 'catEars' },
  { id: 5, name: 'Hacker', skin: '#d7a77e', body: '#2e3a2f', accent: '#38e07b', feature: 'hood' },
  { id: 6, name: 'Scientist', skin: '#f3cfae', body: '#f7f7f2', accent: '#ffb000', feature: 'goggles' },
  { id: 7, name: 'Pirate', skin: '#c98d62', body: '#8c2f2f', accent: '#1e1e24', feature: 'pirateHat' },
  { id: 8, name: 'Knight', skin: '#d9b48c', body: '#9aa3ad', accent: '#cfd6de', feature: 'knightHelm' },
  { id: 9, name: 'Alien', skin: '#7ee081', body: '#3b4fd8', accent: '#111318', feature: 'alienEyes' },
];

export const avatarFor = (id: number | undefined): AvatarDef => AVATARS[((id ?? 0) % 10 + 10) % 10];
