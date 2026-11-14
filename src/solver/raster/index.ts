import type { CaptchaSolver, SolveResult } from "../types";

const CAPTCHA_LENGTH = 5;
/** Mực dư (0-255) từ mức này trở lên mới coi là chưa được giải thích. */
const RESIDUAL_INK = 60;
/** Sai lệch do làm tròn alpha khi ghép 2 lớp mực. */
const TOLERANCE = 3;
/** Bỏ qua thiếu mực ở vài cột phải của mẫu: ký tự sau có thể lấn vào đó. */
const RIGHT_OVERLAP = 4;
const SHIFT_BEFORE = 8;
const SHIFT_AFTER = 6;
const BEAM_WIDTH = 6;
const CANDIDATES_PER_STATE = 4;

/**
 * Ngưỡng chắc chắn (tỷ lệ mực dư trên tổng mực). Đo trên captcha thật:
 * xem test/tracuunnt.test.ts.
 */
const MAX_RESIDUAL_RATIO = 0.05;
const MIN_RUNNER_UP_GAP = 2;

const LOG_PREFIX = "[RasterCaptchaSolver]";

/** Đủ để nhận cả ImageData của trình duyệt lẫn ảnh giải mã trong test. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 byte mỗi pixel. */
  readonly data: ArrayLike<number>;
}

interface Template {
  readonly char: string;
  /** Hàng trên cùng của bbox (đường chân chữ cố định nên y là tuyệt đối). */
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Alpha 0-255, theo hàng. */
  readonly alpha: Uint8Array;
  /** Cột đầu tiên trong mẫu có mực đậm >= RESIDUAL_INK. */
  readonly lead: number;
}

interface State {
  readonly ink: Float32Array;
  readonly chars: string;
  /** Cột trái của bbox mẫu đã đặt cho từng ký tự. */
  readonly xs: readonly number[];
  /** Các cột bên trái mốc này đã chốt, ký tự sau không lấn tới. */
  readonly frontier: number;
  readonly cost: number;
}

/** Kết quả dò chi tiết, dùng cho công cụ học mẫu. */
export interface Located {
  readonly chars: string;
  readonly xs: readonly number[];
  /** Tổng mực dư trên toàn ảnh. */
  readonly cost: number;
  readonly totalInk: number;
}

export class RasterCaptchaSolver implements CaptchaSolver<Pixels> {
  readonly name = "RasterCaptchaSolver";

  private templates: Template[] | null = null;

  private readonly templatesText: string;

  /** @param templatesText nội dung tracuunnt_templates.txt, mỗi dòng "KÝ_TỰ y w h base64" */
  constructor(templatesText: string) {
    this.templatesText = templatesText;
  }

  isReady(): boolean {
    if (this.getTemplates().length > 0) {
      return true;
    }
    console.error(LOG_PREFIX, "không nạp được bộ mẫu");
    return false;
  }

  solve(pixels: Pixels): SolveResult | null {
    try {
      const templates = this.getTemplates();
      if (templates.length === 0) {
        return null;
      }

      const target = toInk(pixels);
      const states = search(target, pixels.width, pixels.height, templates);
      if (states.length === 0) {
        console.debug(LOG_PREFIX, "không ghép được đủ ký tự");
        return null;
      }

      const totalInk = sum(target);
      const best = states[0];
      const ratio = totalInk > 0 ? best.cost / totalInk : 1;
      const runnerUp = states.find((state) => state.chars !== best.chars);
      const gap = runnerUp ? runnerUp.cost / Math.max(best.cost, 1) : Number.POSITIVE_INFINITY;

      const qualified = ratio <= MAX_RESIDUAL_RATIO && gap >= MIN_RUNNER_UP_GAP;
      if (!qualified) {
        console.debug(
          LOG_PREFIX,
          `đọc ra '${best.chars}' nhưng không chắc: dư ${ratio.toFixed(3)}, ` +
            `cách phương án nhì ${gap.toFixed(2)} lần ('${runnerUp?.chars}')`,
        );
      }
      return { text: best.chars, qualified };
    } catch (error) {
      console.error(LOG_PREFIX, "lỗi khi giải captcha", error);
      return null;
    }
  }

  /** Các phương án tốt nhất kèm vị trí từng ký tự, tốt nhất trước. */
  locate(pixels: Pixels): Located[] {
    const target = toInk(pixels);
    const totalInk = sum(target);
    return search(target, pixels.width, pixels.height, this.getTemplates()).map((state) => ({
      chars: state.chars,
      xs: state.xs,
      cost: state.cost,
      totalInk,
    }));
  }

  private getTemplates(): Template[] {
    this.templates ??= loadTemplates(this.templatesText);
    return this.templates;
  }
}

/** Độ đậm mực 0-255: mực đen trên nền trong suốt nên chủ yếu là alpha. */
function toInk(pixels: Pixels): Float32Array {
  const { width, height, data } = pixels;
  const ink = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    const darkness = 255 - (0.299 * r + 0.587 * g + 0.114 * b);
    ink[i] = (a * darkness) / 255;
  }
  return ink;
}

function search(target: Float32Array, width: number, height: number, templates: Template[]): State[] {
  let beam: State[] = [{ ink: new Float32Array(width * height), chars: "", xs: [], frontier: 0, cost: 0 }];

  for (let step = 0; step < CAPTCHA_LENGTH; step++) {
    const next: State[] = [];

    for (const state of beam) {
      const column = firstResidualColumn(target, state.ink, width, height);
      if (column < 0) {
        continue;
      }

      // Phương án tốt nhất của từng ký tự. Chỉ giữ 1 phương án mỗi ký tự để
      // beam không bị một ký tự lệch 1 cột chiếm hết chỗ.
      const best = new Map<string, { template: Template; x: number; frontier: number; cost: number }>();
      for (const template of templates) {
        const base = column - template.lead;
        for (let x = base - SHIFT_BEFORE; x <= base + SHIFT_AFTER; x++) {
          // Cắt sớm (không đổi kết quả): vượt phương án tốt nhất của chính ký
          // tự này, hoặc vượt hạng CANDIDATES_PER_STATE, thì không thể được chọn.
          const limit = Math.min(best.get(template.char)?.cost ?? Infinity, kthCost(best, CANDIDATES_PER_STATE));
          const frontier = Math.min(width, Math.max(state.frontier, x + template.width - RIGHT_OVERLAP));
          const cost = placementCost(target, state.ink, width, height, template, x, state.frontier, frontier, limit);
          if (cost < limit) {
            best.set(template.char, { template, x, frontier, cost });
          }
        }
      }

      const chosen = [...best.values()].sort((a, b) => a.cost - b.cost).slice(0, CANDIDATES_PER_STATE);
      for (const candidate of chosen) {
        next.push({
          ink: compose(state.ink, width, height, candidate.template, candidate.x),
          chars: state.chars + candidate.template.char,
          xs: [...state.xs, candidate.x],
          frontier: candidate.frontier,
          cost: state.cost + candidate.cost,
        });
      }
    }

    next.sort((a, b) => a.cost - b.cost);
    beam = next.slice(0, BEAM_WIDTH);
  }

  // Chấm lại trên toàn ảnh: mực còn dư ở đâu cũng tính (kể cả ký tự thứ 6 bị bỏ sót).
  return beam
    .filter((state) => state.chars.length === CAPTCHA_LENGTH)
    .map((state) => ({ ...state, cost: residual(target, state.ink) }))
    .sort((a, b) => a.cost - b.cost);
}

/** Chi phí thứ k nhỏ nhất trong các ký tự đã có; chưa đủ k ký tự thì vô cực. */
function kthCost(best: Map<string, { cost: number }>, k: number): number {
  if (best.size < k) {
    return Infinity;
  }
  const costs = [...best.values()].map((item) => item.cost).sort((a, b) => a - b);
  return costs[k - 1];
}

function firstResidualColumn(target: Float32Array, ink: Float32Array, width: number, height: number): number {
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      if (target[i] - ink[i] >= RESIDUAL_INK) {
        return x;
      }
    }
  }
  return -1;
}

/**
 * Chi phí đặt mẫu tại cột x lên phần đã ghép:
 *  - đậm hơn ảnh thật là sai chắc chắn (mực chỉ cộng dồn, không bớt đi được)
 *  - các cột từ `from` tới `to` (mép phải mẫu trừ vùng ký tự sau có thể lấn)
 *    coi như đã chốt: mực thật còn chưa được giải thích ở đó, trên MỌI hàng,
 *    đều là thiếu. Nhờ vậy mẫu nhỏ như "c" không lọt được vào chỗ của "g"
 *    (đuôi g nằm ngoài bbox của c nhưng vẫn bị tính).
 */
function placementCost(
  target: Float32Array,
  ink: Float32Array,
  width: number,
  height: number,
  template: Template,
  x: number,
  from: number,
  to: number,
  limit: number,
): number {
  let cost = 0;

  for (let ty = 0; ty < template.height; ty++) {
    const y = template.y + ty;
    for (let tx = 0; tx < template.width; tx++) {
      const a = template.alpha[ty * template.width + tx];
      const px = x + tx;
      if (px < 0 || px >= width || y < 0 || y >= height) {
        cost += a;
        continue;
      }
      const i = y * width + px;
      const diff = over(ink[i], a) - target[i];
      if (diff > TOLERANCE) {
        cost += diff;
      }
    }
    if (cost >= limit) {
      return cost;
    }
  }

  for (let px = Math.max(0, from); px < to; px++) {
    const tx = px - x;
    for (let y = 0; y < height; y++) {
      const ty = y - template.y;
      const inside = tx >= 0 && tx < template.width && ty >= 0 && ty < template.height;
      const i = y * width + px;
      const composed = inside ? over(ink[i], template.alpha[ty * template.width + tx]) : ink[i];
      const missing = target[i] - composed;
      if (missing > TOLERANCE) {
        cost += missing;
      }
    }
    if (cost >= limit) {
      return cost;
    }
  }
  return cost;
}

function compose(ink: Float32Array, width: number, height: number, template: Template, x: number): Float32Array {
  const result = ink.slice();
  for (let ty = 0; ty < template.height; ty++) {
    const y = template.y + ty;
    if (y < 0 || y >= height) {
      continue;
    }
    for (let tx = 0; tx < template.width; tx++) {
      const px = x + tx;
      if (px < 0 || px >= width) {
        continue;
      }
      const i = y * width + px;
      result[i] = over(result[i], template.alpha[ty * template.width + tx]);
    }
  }
  return result;
}

/** Ghép alpha kiểu SrcOver, cùng màu đen nên chỉ cần alpha. */
function over(below: number, above: number): number {
  return above + below * (1 - above / 255);
}

function residual(target: Float32Array, ink: Float32Array): number {
  let total = 0;
  for (let i = 0; i < target.length; i++) {
    const diff = Math.abs(target[i] - ink[i]);
    if (diff > TOLERANCE) {
      total += diff;
    }
  }
  return total;
}

function sum(values: Float32Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}

/** Mỗi dòng: "KÝ_TỰ y rộng cao base64(alpha theo hàng)" */
function loadTemplates(text: string): Template[] {
  const result: Template[] = [];
  const lines = text.split("\n");

  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
    const line = lines[lineNumber - 1].trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const parts = line.split(" ");
    if (parts.length !== 5) {
      console.warn(LOG_PREFIX, `bỏ qua dòng mẫu ${lineNumber}: sai định dạng`);
      continue;
    }

    const [char, yText, widthText, heightText, encoded] = parts;
    const y = Number(yText);
    const width = Number(widthText);
    const height = Number(heightText);
    let alpha: Uint8Array;
    try {
      alpha = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    } catch {
      console.warn(LOG_PREFIX, `bỏ qua dòng mẫu ${lineNumber}: base64 lỗi`);
      continue;
    }
    if (char.length !== 1 || !(width > 0) || !(height > 0) || alpha.length !== width * height) {
      console.warn(LOG_PREFIX, `bỏ qua dòng mẫu ${lineNumber}: kích thước không khớp`);
      continue;
    }

    result.push({ char, y, width, height, alpha, lead: leadColumn(alpha, width, height) });
  }

  console.debug(LOG_PREFIX, `đã nạp ${result.length} mẫu`);
  return result;
}

function leadColumn(alpha: Uint8Array, width: number, height: number): number {
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (alpha[y * width + x] >= RESIDUAL_INK) {
        return x;
      }
    }
  }
  return 0;
}
