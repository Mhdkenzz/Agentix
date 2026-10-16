// 2D thumbnail of an avatar, for pickers and lists.
import { avatarFor } from './index.ts';

export function AvatarThumb({ id, size = 48 }: { id: number; size?: number }) {
  const a = avatarFor(id);
  const head = a.feature === 'antenna' || a.feature === 'knightHelm'
    ? <rect x="14" y="10" width="20" height="18" rx="4" fill={a.feature === 'knightHelm' ? a.accent : a.skin} />
    : <circle cx="24" cy="19" r="10" fill={a.skin} />;
  const extra: Record<string, React.ReactNode> = {
    antenna: <><line x1="24" y1="10" x2="24" y2="3" stroke={a.body} strokeWidth="2" /><circle cx="24" cy="3" r="2.5" fill={a.accent} /></>,
    helmet: <circle cx="24" cy="19" r="13" fill={a.accent} opacity="0.35" stroke="#fff" strokeWidth="1.5" />,
    wizardHat: <polygon points="13,12 35,12 24,-2" fill={a.accent} />,
    mask: <rect x="13" y="17" width="22" height="9" fill={a.body} />,
    catEars: <><polygon points="14,14 17,4 22,11" fill={a.accent} /><polygon points="34,14 31,4 26,11" fill={a.accent} /></>,
    hood: <path d="M11 22 Q11 6 24 6 Q37 6 37 22 L33 22 Q33 11 24 11 Q15 11 15 22Z" fill={a.body} />,
    goggles: <><circle cx="20" cy="18" r="3.5" fill={a.accent} stroke="#333" /><circle cx="28" cy="18" r="3.5" fill={a.accent} stroke="#333" /></>,
    pirateHat: <><path d="M10 12 Q24 2 38 12 Z" fill={a.accent} /><rect x="17" y="16" width="5" height="4" fill="#111" /></>,
    knightHelm: <rect x="16" y="17" width="16" height="2.5" fill="#333" />,
    alienEyes: <><ellipse cx="19.5" cy="19" rx="3.5" ry="5" fill={a.accent} /><ellipse cx="28.5" cy="19" rx="3.5" ry="5" fill={a.accent} /></>,
  };
  const eyes = ['mask', 'goggles', 'alienEyes', 'knightHelm', 'antenna'].includes(a.feature) ? null
    : <><circle cx="20.5" cy="19" r="1.4" fill="#222" /><circle cx="27.5" cy="19" r="1.4" fill="#222" /></>;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label={a.name}>
      <rect width="48" height="48" rx="10" fill="var(--thumb-bg, #1d2030)" />
      <path d="M10 46 Q10 30 24 30 Q38 30 38 46 Z" fill={a.body} />
      {head}
      {a.feature === 'antenna' && <><rect x="18" y="16" width="4" height="4" fill={a.accent} /><rect x="26" y="16" width="4" height="4" fill={a.accent} /></>}
      {eyes}
      {extra[a.feature]}
    </svg>
  );
}
