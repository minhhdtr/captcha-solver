import { hoadondientu } from "./hoadondientu";
import { tracuunnt } from "./tracuunnt";
import type { Portal } from "./types";

const PORTALS: readonly Portal[] = [hoadondientu, tracuunnt];

export function findPortal(hostname: string): Portal | undefined {
  return PORTALS.find((portal) => portal.matches(hostname));
}
