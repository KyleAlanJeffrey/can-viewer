import type uPlot from 'uplot';
import type { PlotSpec } from '../../components/Plots';
import { downloadBlob } from '../../download';
import { cssVar } from '../../format';

export interface ExportLane {
  u: uPlot;
  spec: PlotSpec;
  /** Cursor values for the lane head, already formatted. */
  readout: string;
}

interface Options {
  fileName: string;
  title: string;
  subtitle: string;
  lanes: ExportLane[];
}

const PAD = 16;
const TITLE_H = 48;
const HEAD_H = 24;
const GAP = 8;

/** Composites the lanes' canvases and their labels onto one white image and downloads it as a PNG. */
export async function exportPlotPng({ fileName, title, subtitle, lanes }: Options): Promise<void> {
  if (lanes.length === 0) return;
  const laneW = Math.max(...lanes.map((l) => l.u.width));
  const width = laneW + 2 * PAD;
  const height = TITLE_H + lanes.reduce((h, l) => h + HEAD_H + l.u.height, 0) + GAP * (lanes.length - 1) + PAD;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('This browser could not draw the PNG.');
  g.scale(dpr, dpr);

  const ui = cssVar('--font-ui');
  const mono = cssVar('--font-mono');
  const graphite = cssVar('--graphite');
  const slate = cssVar('--slate');
  g.fillStyle = cssVar('--paper');
  g.fillRect(0, 0, width, height);
  g.textBaseline = 'middle';
  g.fillStyle = graphite;
  g.font = `600 13px ${ui}`;
  g.fillText(title, PAD, 18);
  if (subtitle) {
    g.fillStyle = slate;
    g.font = `400 12px ${ui}`;
    g.fillText(subtitle, PAD, 36);
  }

  let y = TITLE_H;
  for (const { u, spec, readout } of lanes) {
    const mid = y + HEAD_H / 2;
    g.fillStyle = cssVar('--plot-paper');
    g.fillRect(PAD, y, u.width, HEAD_H + u.height);
    g.strokeStyle = cssVar('--hairline');
    g.lineWidth = 1;
    g.strokeRect(PAD + 0.5, y + 0.5, u.width - 1, HEAD_H + u.height - 1);

    g.fillStyle = spec.color;
    g.beginPath();
    g.arc(PAD + 17, mid, 5, 0, 2 * Math.PI);
    g.fill();
    g.textAlign = 'left';
    g.fillStyle = graphite;
    g.font = `400 13px ${mono}`;
    g.fillText(spec.info.name, PAD + 28, mid);
    if (spec.info.unit) {
      const nameW = g.measureText(spec.info.name).width;
      g.fillStyle = slate;
      g.font = `400 12px ${ui}`;
      g.fillText(`(${spec.info.unit})`, PAD + 28 + nameW + 6, mid);
    }
    if (readout) {
      g.textAlign = 'right';
      g.fillStyle = graphite;
      g.font = `400 12px ${ui}`;
      g.fillText(readout, PAD + u.width - 12, mid);
      g.textAlign = 'left';
    }
    g.drawImage(u.ctx.canvas, PAD, y + HEAD_H, u.width, u.height);
    y += HEAD_H + u.height + GAP;
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not encode the PNG.');
  downloadBlob(fileName, blob);
}
