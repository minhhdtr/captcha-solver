import { findPortal } from "./portals";
import type { CaptchaField, Portal } from "./portals/types";

const LOG_PREFIX = "[captcha]";

const portal: Portal | undefined = findPortal(location.hostname);

/** src của ảnh đã điền cho từng ô, để captcha không đổi thì không giải lại. */
const filledSrc = new WeakMap<HTMLInputElement, string>();

/** Ảnh đang đợi tải, để khỏi gắn listener trùng mỗi lần scan. */
const waitingLoad = new WeakSet<HTMLImageElement>();

const nativeValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (nativeValueSetter) {
    nativeValueSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fill(portal: Portal, field: CaptchaField): void {
  const { image, input } = field;
  const src = image.getAttribute("src");
  if (!src || filledSrc.get(input) === src) {
    return;
  }

  if (!image.complete || image.naturalWidth === 0) {
    if (!waitingLoad.has(image)) {
      waitingLoad.add(image);
      const done = () => {
        waitingLoad.delete(image);
        scheduleScan();
      };
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
    }
    return;
  }

  const result = portal.solve(image);

  // Đánh dấu kể cả khi không giải được, để observer khỏi giải lại cùng một ảnh.
  filledSrc.set(input, src);

  if (!result || !result.qualified) {
    console.debug(LOG_PREFIX, "không chắc, để trống cho người dùng tự nhập", result);
    return;
  }

  setInputValue(input, result.text);
}

function scan(): void {
  if (!portal) {
    return;
  }
  for (const field of portal.findCaptchaFields()) {
    fill(portal, field);
  }
}

let scanScheduled = false;

function scheduleScan(): void {
  if (scanScheduled) {
    return;
  }
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scan();
  });
}

if (portal?.isReady()) {
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  scan();
}
