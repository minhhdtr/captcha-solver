import type { SolveResult } from "../solver/types";

export interface CaptchaField {
  readonly image: HTMLImageElement;
  readonly input: HTMLInputElement;
}

/** Một cổng tra cứu: biết tìm ảnh/ô nhập captcha trên trang và giải ảnh đó. */
export interface Portal {
  readonly name: string;
  matches(hostname: string): boolean;
  isReady(): boolean;
  findCaptchaFields(root?: ParentNode): CaptchaField[];
  /** Chỉ gọi khi ảnh đã tải xong. null khi không đọc được. */
  solve(image: HTMLImageElement): SolveResult | null;
}
