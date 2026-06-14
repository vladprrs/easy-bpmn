// Custom line-icons for the glass renderer — they replace bpmn-js's default
// corner glyphs (the "Camunda" look). Each is a 24×24 stroke path drawn in the
// element's category-ink colour. Authored compact + legible; tuned visually.

export type IconKey =
  | "service"
  | "receive"
  | "send"
  | "user"
  | "script"
  | "rule"
  | "manual"
  | "subprocess"
  | "call"
  | "timer"
  | "message"
  | "signal"
  | "error"
  | "escalation"
  | "compensation"
  | "conditional"
  | "link"
  | "terminate"
  | "play";

// Stroke icons (fill:none, stroke:currentColor). One or more sub-paths per key.
export const ICONS: Record<IconKey, string[]> = {
  // A bolt — automated work / service.
  service: [
    "M13 2 4.5 13.2a.8.8 0 0 0 .62 1.3H11l-1 7.5 8.5-11.2a.8.8 0 0 0-.62-1.3H12z",
  ],
  // Inbox / tray — a message arriving.
  receive: [
    "M22 12h-5l-2 3H9l-2-3H2",
    "M5.5 5.6 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.4A2 2 0 0 0 16.8 4.5H7.2a2 2 0 0 0-1.7 1.1z",
  ],
  // Paper plane — a message thrown.
  send: ["M22 2 11 13", "M22 2 15 22l-4-9-9-4z"],
  user: ["M16 20v-1.5a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4V20", "M10 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"],
  script: ["M9 6 3.5 12 9 18", "M15 6l5.5 6L15 18", "M13 4l-2 16"],
  rule: ["M4 5h16", "M4 12h16", "M4 19h16", "M9 5v14"],
  manual: [
    "M7 11V6.5a1.5 1.5 0 0 1 3 0V11",
    "M10 10.5V5a1.5 1.5 0 0 1 3 0v5.5",
    "M13 10V6.5a1.5 1.5 0 0 1 3 0V13c0 3.6-2.2 7-6 7-2.3 0-3.7-1-4.8-2.6L4 14.2a1.5 1.5 0 0 1 2.5-1.6L7 13",
  ],
  subprocess: [
    "M12 2.5 2.5 7 12 11.5 21.5 7z",
    "M2.5 16.5 12 21l9.5-4.5",
    "M2.5 11.75 12 16.25l9.5-4.5",
  ],
  call: ["M4 5.5h16v13H4z", "M9 9.5h6", "M9 13.5h6"],
  // A clock — timer.
  timer: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7.5V12l3 2"],
  // An envelope — message.
  message: ["M3 6.5a1.5 1.5 0 0 1 1.5-1.5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z", "m3.5 7 8.5 5.5L20.5 7"],
  signal: ["M12 4.5 21 19.5H3z"],
  error: ["M9.5 3 4 13h5l-1.5 8 9.5-12.5h-5z"],
  escalation: ["M12 4 19 15H5z"],
  compensation: ["M11.5 7 5 12l6.5 5z", "M19 7l-6.5 5 6.5 5z"],
  conditional: ["M5 6h14", "M5 10h14", "M5 14h9", "M5 18h9"],
  link: ["M10 13a4 4 0 0 0 5 .5l2.5-2.5a4 4 0 0 0-5.6-5.6L11 6", "M14 11a4 4 0 0 0-5-.5L6.5 13a4 4 0 0 0 5.6 5.6L13 18"],
  terminate: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"],
  play: ["M9 6.5 16 12l-7 5.5z"],
};

/** Whether the icon should be filled (throw / terminate) vs stroked. */
export const FILLED_ICONS: Partial<Record<IconKey, boolean>> = {
  terminate: true,
};
