import { useId } from 'react';

// The Twisted F: the upright is a twisted pair (CAN-H and CAN-L) drawn as rope, so every strand
// in front slopes the same way and the wire on top alternates at each crossing. Both wires
// follow one sine so they stay exactly in phase.
const WIDTH = 94;
const HEIGHT = 100;
const RIBBON = 19;
const GAP = 2.5;
const CENTER = 16.5;
const AMPLITUDE = 7;
const TWIST_START = 20;
const HALF_TWIST = 80 / 3;
const TOP_ARM_Y = RIBBON / 2 + 0.5;
const MID_ARM_Y = TWIST_START + HALF_TWIST;
const ARM_END_X = 80;
const TERMINAL_X = 83;
const TERMINAL_R = 10;

const wave = (sign: 1 | -1) => (y: number) => CENTER + sign * AMPLITUDE * Math.cos((Math.PI * (y - TWIST_START)) / HALF_TWIST);
const wireA = wave(-1);
const wireB = wave(1);
const crossing = (n: number) => TWIST_START + n * HALF_TWIST;

function trace(x: (y: number) => number, from: number, to: number): string {
  const steps = Math.ceil((to - from) / 0.5);
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = from + ((to - from) * i) / steps;
    points.push(`${x(y).toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${points.join(' ')}`;
}

const cornerX = wireA(TWIST_START);
// The top arm sweeps down into wire A, which then runs behind the first crossing.
const spine =
  `M${ARM_END_X} ${TOP_ARM_Y}H${cornerX + RIBBON}` +
  `C${cornerX + RIBBON * 0.45} ${TOP_ARM_Y} ${cornerX} ${TOP_ARM_Y + (TWIST_START - TOP_ARM_Y) * 0.45} ${cornerX} ${TWIST_START}` +
  trace(wireA, TWIST_START, crossing(1)).replace('M', 'L');
// The strands in front, top to bottom. The first is clipped so it tucks under the top arm.
const upperStrand = trace(wireB, TOP_ARM_Y, crossing(1));
const amberStrand = trace(wireA, crossing(1), crossing(2));
const lowerStrand = trace(wireB, crossing(2), crossing(3));
const midArm = `M${CENTER + AMPLITUDE + RIBBON / 2} ${MID_ARM_Y}H${ARM_END_X}`;

interface Props {
  size?: number;
  /** Colour behind the mark; the gaps between strands are painted in it. */
  background?: string;
}

export function Logo({ size = 32, background = 'var(--warm-white)' }: Props) {
  const clipId = `logo-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const strand = (d: string, color: string, clipPath?: string) => (
    <>
      <path d={d} stroke={background} strokeWidth={RIBBON + 2 * GAP} clipPath={clipPath} />
      <path d={d} stroke={color} strokeWidth={RIBBON} clipPath={clipPath} />
    </>
  );
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={(size * WIDTH) / HEIGHT}
      height={size}
      fill="none"
      strokeLinecap="round"
      aria-hidden="true"
      className="logo"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={TOP_ARM_Y + RIBBON / 2 + GAP} width={WIDTH} height={HEIGHT} />
        </clipPath>
      </defs>
      <path d={spine} stroke="var(--graphite)" strokeWidth={RIBBON} strokeLinecap="butt" />
      {strand(upperStrand, 'var(--graphite)', `url(#${clipId})`)}
      {strand(amberStrand, 'var(--amber)')}
      {strand(lowerStrand, 'var(--graphite)')}
      {strand(midArm, 'var(--graphite)')}
      {[TOP_ARM_Y, MID_ARM_Y].map((y) => (
        <g key={y}>
          <circle cx={TERMINAL_X} cy={y} r={TERMINAL_R + GAP} fill={background} />
          <circle cx={TERMINAL_X} cy={y} r={TERMINAL_R} fill="var(--amber)" />
        </g>
      ))}
    </svg>
  );
}
