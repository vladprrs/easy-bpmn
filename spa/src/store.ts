// App-level state: the operator session + a tiny toast queue. TanStack Query owns
// all server cache; Zustand holds only cross-cutting UI state.

import { create } from "zustand";
import type { MeResponse } from "./api/types";

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
}

interface AppState {
  me: MeResponse | null;
  workspaceId: string;
  setMe: (me: MeResponse | null) => void;
  setWorkspace: (id: string) => void;
  toasts: Toast[];
  toast: (kind: ToastKind, text: string) => void;
  dismiss: (id: string) => void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set) => ({
  me: null,
  workspaceId: "default",
  setMe: (me) => set({ me, workspaceId: me?.workspaceId || "default" }),
  setWorkspace: (id) => set({ workspaceId: id }),
  toasts: [],
  toast: (kind, text) => {
    const id = `t${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
