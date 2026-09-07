import { create } from "zustand";
export const usePublicMotion = create<{
  paused: boolean;
  reduced: boolean;
  toggle: () => void;
}>((set) => ({
  paused: false,
  reduced:
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
  toggle: () => set((s) => ({ paused: !s.paused })),
}));
export function watchMotionPreference() {
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (!query) return () => {};
  const update = () => usePublicMotion.setState({ reduced: query.matches });
  update();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}
