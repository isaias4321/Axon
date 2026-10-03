/**
 * Renderização de gráficos simples (barra, pizza, fluxograma) como SVG puro.
 *
 * Por que SVG e não canvas/Puppeteer: o Dockerfile deste projeto usa
 * `node:22-slim` (sem toolchain de compilação nem bibliotecas nativas como
 * Cairo/Pango). Bibliotecas de canvas em Node exigem módulos nativos
 * (`node-canvas`) que falhariam para compilar nessa imagem sem adicionar
 * várias dependências de sistema ao Dockerfile; Puppeteer precisa de um
 * Chromium inteiro. SVG é texto puro — zero dependência nativa, zero
 * mudança de imagem Docker, e abre nativamente em navegador, Word, Figma etc.
 */

export type ChartDataPoint = { label: string; value?: number };
export type ChartType = "bar" | "pie" | "flowchart";

const CHART_COLORS = [
  "#f2a93b",
  "#6bb6ff",
  "#3dd68c",
  "#f0576b",
  "#c792ea",
  "#7ee7d8",
  "#ffb454",
  "#82aaff",
];

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTitle(title: string | undefined, width: number): string {
  if (!title) return "";
  return `<text x="${width / 2}" y="28" font-family="Helvetica, Arial, sans-serif" font-size="18" text-anchor="middle" font-weight="bold" fill="#111827">${escapeXml(title)}</text>`;
}

function renderBarChart(data: ChartDataPoint[], title?: string): string {
  const width = 640;
  const height = 400;
  const padding = 60;
  const topOffset = title ? 50 : 20;
  const values = data.map((d) => d.value ?? 0);
  const max = Math.max(...values, 1);
  const barAreaWidth = width - padding * 2;
  const gap = barAreaWidth / data.length;
  const barWidth = Math.min(gap * 0.6, 80);
  const baseY = height - padding;
  const chartHeight = baseY - topOffset;

  const bars = data
    .map((d, i) => {
      const val = d.value ?? 0;
      const barH = max > 0 ? (val / max) * chartHeight : 0;
      const x = padding + i * gap + (gap - barWidth) / 2;
      const y = baseY - barH;
      const color = CHART_COLORS[i % CHART_COLORS.length];
      return `
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="4"/>
    <text x="${(x + barWidth / 2).toFixed(1)}" y="${(baseY + 18).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#374151">${escapeXml(d.label)}</text>
    <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#111827">${val}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${renderTitle(title, width)}
  <line x1="${padding}" y1="${baseY}" x2="${width - padding}" y2="${baseY}" stroke="#d1d5db" stroke-width="1"/>
  ${bars}
</svg>`;
}

function renderPieChart(data: ChartDataPoint[], title?: string): string {
  const width = 480;
  const height = 480;
  const topOffset = title ? 20 : 0;
  const cx = width / 2;
  const cy = height / 2 + topOffset;
  const r = Math.min(width, height) / 2 - 90;
  const values = data.map((d) => Math.max(d.value ?? 0, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  let angleStart = -Math.PI / 2;

  const slices = data
    .map((d, i) => {
      const val = Math.max(d.value ?? 0, 0);
      const angle = (val / total) * Math.PI * 2;
      const angleEnd = angleStart + angle;
      const x1 = cx + r * Math.cos(angleStart);
      const y1 = cy + r * Math.sin(angleStart);
      const x2 = cx + r * Math.cos(angleEnd);
      const y2 = cy + r * Math.sin(angleEnd);
      const largeArc = angle > Math.PI ? 1 : 0;
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const path = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      const midAngle = (angleStart + angleEnd) / 2;
      const labelX = cx + (r + 24) * Math.cos(midAngle);
      const labelY = cy + (r + 24) * Math.sin(midAngle);
      const pct = total > 0 ? Math.round((val / total) * 100) : 0;
      angleStart = angleEnd;
      return `
    <path d="${path}" fill="${color}" stroke="#ffffff" stroke-width="2"/>
    <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#374151">${escapeXml(d.label)} (${pct}%)</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${renderTitle(title, width)}
  ${slices}
</svg>`;
}

function renderFlowchart(data: ChartDataPoint[], title?: string): string {
  const boxWidth = 240;
  const boxHeight = 54;
  const gapY = 46;
  const width = 360;
  const topMargin = title ? 60 : 30;
  const height = topMargin + data.length * boxHeight + (data.length - 1) * gapY + 30;

  const nodes = data
    .map((d, i) => {
      const y = topMargin + i * (boxHeight + gapY);
      const x = (width - boxWidth) / 2;
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const arrow =
        i < data.length - 1
          ? `<line x1="${width / 2}" y1="${y + boxHeight}" x2="${width / 2}" y2="${y + boxHeight + gapY}" stroke="#6b7280" stroke-width="2" marker-end="url(#arrowhead)"/>`
          : "";
      return `
    <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="10" fill="${color}" fill-opacity="0.85" stroke="#374151" stroke-width="1.5"/>
    <text x="${width / 2}" y="${y + boxHeight / 2 + 5}" font-family="Helvetica, Arial, sans-serif" font-size="13" text-anchor="middle" fill="#111827">${escapeXml(d.label)}</text>
    ${arrow}`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/>
    </marker>
  </defs>
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${renderTitle(title, width)}
  ${nodes}
</svg>`;
}

/** Ponto de entrada único: escolhe o layout certo pelo `chartType`. */
export function renderChartSvg(chartType: ChartType, data: ChartDataPoint[], title?: string): string {
  switch (chartType) {
    case "bar":
      return renderBarChart(data, title);
    case "pie":
      return renderPieChart(data, title);
    case "flowchart":
      return renderFlowchart(data, title);
  }
}
