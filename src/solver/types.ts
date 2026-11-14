export interface SolveResult {
  readonly text: string;
  /** false khi có ký tự đọc không chắc — tương ứng IsQualified bên tool đồng bộ. */
  readonly qualified: boolean;
}

/** TInput: dữ liệu ảnh solver cần — SVG thô (string) hoặc pixel (ImageData). */
export interface CaptchaSolver<TInput = string> {
  readonly name: string;
  isReady(): boolean;
  /** null khi không đọc được: ảnh lỗi, tách sai số ký tự, hoặc chưa có mẫu. */
  solve(input: TInput): SolveResult | null;
}
