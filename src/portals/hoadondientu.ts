import templatesText from "../solver/svg/hoadondientu_templates.txt";
import { SvgCaptchaSolver } from "../solver/svg";
import type { CaptchaField, Portal } from "./types";

const SVG_DATA_PREFIX = "data:image/svg+xml;base64,";
const IMAGE_SELECTOR = 'img[alt="captcha"]';
const INPUT_SELECTOR = 'input#cvalue, input[id$="_cvalue"]';

export function findCaptchaFields(root: ParentNode = document): CaptchaField[] {
  const fields: CaptchaField[] = [];
  const images = root.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR);

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const input = image.closest("form")?.querySelector<HTMLInputElement>(INPUT_SELECTOR);
    if (input) {
      fields.push({ image, input });
    }
  }
  return fields;
}

/** Lấy SVG thô từ data URI của ảnh. null nếu ảnh không phải SVG base64. */
export function readSvg(image: HTMLImageElement): string | null {
  const src = image.getAttribute("src");
  if (!src?.startsWith(SVG_DATA_PREFIX)) {
    return null;
  }
  try {
    const binary = atob(src.slice(SVG_DATA_PREFIX.length));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const solver = new SvgCaptchaSolver(templatesText);

export const hoadondientu: Portal = {
  name: "hoadondientu",
  matches: (hostname) => hostname === "hoadondientu.gdt.gov.vn",
  isReady: () => solver.isReady(),
  findCaptchaFields,
  solve(image) {
    const svg = readSvg(image);
    return svg ? solver.solve(svg) : null;
  },
};
