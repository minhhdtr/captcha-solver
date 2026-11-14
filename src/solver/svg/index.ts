import type { CaptchaSolver, SolveResult } from "../types";

const CAPTCHA_LENGTH = 6;
const SAMPLE_POINTS = 64;
const VECTOR_SIZE = SAMPLE_POINTS * 2;

// Đo trên dữ liệu thật: ký tự đúng có khoảng cách tối đa 0.230 và tỷ lệ tối đa 0.169,
// ký tự thiếu mẫu có khoảng cách tối thiểu 0.819 và tỷ lệ tối thiểu 0.443.
const MAX_DISTANCE = 0.5;
const MAX_RATIO = 0.3;

const NUMBER_PATTERN = /-?\d+\.?\d*(?:[eE][-+]?\d+)?/g;
const LOG_PREFIX = "[SvgCaptchaSolver]";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Template {
  readonly char: string;
  readonly vector: number[];
}

export class SvgCaptchaSolver implements CaptchaSolver {
  readonly name = "SvgCaptchaSolver";

  private templates: Template[] | null = null;
  private readonly templatesText: string;

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

  solve(svg: string): SolveResult | null {
    try {
      const all = this.getTemplates();
      if (all.length === 0) {
        return null;
      }

      const glyphs = getGlyphs(svg);
      if (glyphs.length !== CAPTCHA_LENGTH) {
        console.debug(LOG_PREFIX, `tách được ${glyphs.length} ký tự, cần ${CAPTCHA_LENGTH}`);
        return null;
      }

      const chars: string[] = [];
      let qualified = true;

      for (let i = 0; i < glyphs.length; i++) {
        const found = recognize(getVector(glyphs[i]), all);
        chars.push(found.char);

        const ratio = found.otherDistance > 0 ? found.distance / found.otherDistance : 1;
        if (found.distance > MAX_DISTANCE || ratio > MAX_RATIO) {
          qualified = false;
          console.debug(
            LOG_PREFIX,
            `ký tự ${i + 1} đọc ra '${found.char}' nhưng không chắc: ` +
              `khoảng cách ${found.distance.toFixed(3)}, tỷ lệ ${ratio.toFixed(3)}`,
          );
        }
      }

      return { text: chars.join(""), qualified };
    } catch (error) {
      console.error(LOG_PREFIX, "lỗi khi giải captcha", error);
      return null;
    }
  }

  private getTemplates(): Template[] {
    this.templates ??= loadTemplates(this.templatesText);
    return this.templates;
  }
}

interface Recognition {
  readonly char: string;
  readonly distance: number;
  readonly otherDistance: number;
}

/**
 * Tìm mẫu gần nhất, đồng thời trả về khoảng cách tới mẫu gần nhất mang nhãn KHÁC.
 * Hai số này để đánh giá độ chắc chắn: xa quá là thiếu mẫu cho ký tự đó,
 * còn gần nhau quá là dễ nhầm với ký tự khác.
 *
 * Duyệt một vòng, so bình phương khoảng cách để khỏi gọi Math.sqrt 126 lần,
 * chỉ lấy căn ở hai kết quả cuối.
 */
function recognize(vector: number[], all: Template[]): Recognition {
  let best = Number.MAX_VALUE;
  let other = Number.MAX_VALUE;
  let result = "?";

  for (let i = 0; i < all.length; i++) {
    const d = distanceSquared(vector, all[i].vector);
    const c = all[i].char;

    if (d < best) {
      // mẫu mới tốt hơn: nếu khác nhãn thì mẫu cũ tốt nhất thành ứng viên nhì
      if (c !== result) {
        other = best;
      }
      best = d;
      result = c;
    } else if (c !== result && d < other) {
      other = d;
    }
  }

  const distance = best === Number.MAX_VALUE ? Number.MAX_VALUE : Math.sqrt(best);
  return {
    char: result,
    distance,
    otherDistance: other === Number.MAX_VALUE ? distance : Math.sqrt(other),
  };
}

function distanceSquared(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

/**
 * Lấy điểm của các path ký tự, đã sắp trái sang phải.
 * Trả về điểm đã parse sẵn để getVector khỏi chạy lại regex lần nữa.
 */
function getGlyphs(svg: string): Point[][] {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("SVG không parse được");
  }

  // getElementsByTagNameNS("*", ...) khớp theo local name, không phụ thuộc
  // namespace của SVG — tương đương vòng duyệt LocalName bên C#.
  const elements = document.getElementsByTagNameNS("*", "path");
  const glyphs: { minX: number; points: Point[] }[] = [];

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const d = element.getAttribute("d");
    if (!d || isNoise(element)) {
      continue;
    }

    const points = getPoints(d);
    if (points.length < 3) {
      continue;
    }

    let minX = Number.MAX_VALUE;
    for (const point of points) {
      if (point.x < minX) {
        minX = point.x;
      }
    }
    glyphs.push({ minX, points });
  }

  glyphs.sort((a, b) => a.minX - b.minX);
  return glyphs.map((glyph) => glyph.points);
}

function isNoise(element: Element): boolean {
  const stroke = (element.getAttribute("stroke") ?? "").trim().toLowerCase();
  const fill = (element.getAttribute("fill") ?? "").trim().toLowerCase();
  const style = (element.getAttribute("style") ?? "").toLowerCase();

  if (stroke.length > 0 && stroke !== "none") {
    return true;
  }
  if (style.includes("stroke:") && !style.replace(/ /g, "").includes("stroke:none")) {
    return true;
  }
  return fill === "none";
}

/**
 * SVG do opentype.js sinh ra chỉ dùng lệnh M/L/Q/C/Z, mọi tham số đều là cặp x,y
 * nên gom số theo cặp tuần tự là đủ để tạo vân tay hình dạng.
 */
function getPoints(d: string): Point[] {
  const matches = d.match(NUMBER_PATTERN);
  const points: Point[] = [];
  if (!matches) {
    return points;
  }

  for (let i = 0; i + 1 < matches.length; i += 2) {
    const x = Number(matches[i]);
    const y = Number(matches[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    points.push({ x, y });
  }
  return points;
}

function getVector(raw: Point[]): number[] {
  const points = resample(normalize(raw), SAMPLE_POINTS);
  const vector = new Array<number>(VECTOR_SIZE);

  for (let i = 0; i < points.length; i++) {
    vector[i * 2] = points[i].x;
    vector[i * 2 + 1] = points[i].y;
  }
  return vector;
}

/** Đổi về gốc rồi chia cho chiều cao glyph -> bất biến với vị trí và cỡ chữ */
function normalize(points: Point[]): Point[] {
  let minX = Number.MAX_VALUE;
  let minY = Number.MAX_VALUE;
  let maxY = -Number.MAX_VALUE;

  for (const point of points) {
    if (point.x < minX) {
      minX = point.x;
    }
    if (point.y < minY) {
      minY = point.y;
    }
    if (point.y > maxY) {
      maxY = point.y;
    }
  }

  let height = maxY - minY;
  if (height === 0) {
    height = 1;
  }

  return points.map((point) => ({
    x: (point.x - minX) / height,
    y: (point.y - minY) / height,
  }));
}

/** Lấy count điểm cách đều nhau theo độ dài cung của đường gấp khúc */
function resample(points: Point[], count: number): Point[] {
  if (points.length === 0) {
    return new Array<Point>(count).fill({ x: 0, y: 0 });
  }
  if (points.length === 1) {
    return new Array<Point>(count).fill(points[0]);
  }

  const lengths = new Array<number>(points.length);
  lengths[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    lengths[i] = lengths[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }

  let total = lengths[lengths.length - 1];
  if (total === 0) {
    total = 1;
  }
  const step = total / (count - 1);

  const result: Point[] = [];
  let j = 0;

  for (let i = 0; i < count; i++) {
    const target = i * step;
    while (j < lengths.length - 2 && lengths[j + 1] < target) {
      j++;
    }

    let segment = lengths[j + 1] - lengths[j];
    if (segment === 0) {
      segment = 1;
    }
    const t = (target - lengths[j]) / segment;

    result.push({
      x: points[j].x + (points[j + 1].x - points[j].x) * t,
      y: points[j].y + (points[j + 1].y - points[j].y) * t,
    });
  }
  return result;
}

/** Mỗi dòng trong hoadondientu_templates.txt: KÝ_TỰ:số,số,... (128 số) */
function loadTemplates(text: string): Template[] {
  const result: Template[] = [];
  const lines = text.split("\n");

  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
    const line = lines[lineNumber - 1].replace(/\r$/, "");
    if (line.length === 0) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const parts = line.slice(separator + 1).split(",");
    if (parts.length !== VECTOR_SIZE) {
      console.warn(LOG_PREFIX, `bỏ qua dòng mẫu ${lineNumber}: có ${parts.length} số, cần ${VECTOR_SIZE}`);
      continue;
    }

    const vector = new Array<number>(VECTOR_SIZE);
    let valid = true;
    for (let i = 0; i < VECTOR_SIZE; i++) {
      const part = parts[i].trim();
      const value = part.length > 0 ? Number(part) : Number.NaN;
      if (!Number.isFinite(value)) {
        valid = false;
        break;
      }
      vector[i] = value;
    }
    if (!valid) {
      console.warn(LOG_PREFIX, `bỏ qua dòng mẫu ${lineNumber}: có số không đọc được`);
      continue;
    }

    result.push({ char: line[0], vector });
  }

  console.debug(LOG_PREFIX, `đã nạp ${result.length} mẫu`);
  return result;
}
