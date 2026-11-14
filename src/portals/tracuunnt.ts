import templatesText from "../solver/raster/tracuunnt_templates.txt";
import { RasterCaptchaSolver } from "../solver/raster";
import type { CaptchaField, Portal } from "./types";

const INPUT_SELECTOR = 'input[name="captcha"], input#captcha';
const IMAGE_SELECTOR = 'img[src*="captcha"]';
const LOG_PREFIX = "[tracuunnt]";

export function findCaptchaFields(root: ParentNode = document): CaptchaField[] {
  const fields: CaptchaField[] = [];
  const inputs = root.querySelectorAll<HTMLInputElement>(INPUT_SELECTOR);

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const scope = input.form ?? input.closest("table") ?? document;
    const image = scope.querySelector<HTMLImageElement>(IMAGE_SELECTOR);
    if (image) {
      fields.push({ image, input });
    }
  }
  return fields;
}

/** Pixel của ảnh đang hiển thị. null nếu ảnh chưa tải hoặc canvas bị taint. */
export function readImageData(image: HTMLImageElement): ImageData | null {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!image.complete || width === 0 || height === 0) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  try {
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height);
  } catch (error) {
    console.error(LOG_PREFIX, "không đọc được pixel ảnh captcha", error);
    return null;
  }
}

const solver = new RasterCaptchaSolver(templatesText);

export const tracuunnt: Portal = {
  name: "tracuunnt",
  matches: (hostname) => hostname === "tracuunnt.gdt.gov.vn",
  isReady: () => solver.isReady(),
  findCaptchaFields,
  solve(image) {
    const pixels = readImageData(image);
    return pixels ? solver.solve(pixels) : null;
  },
};
