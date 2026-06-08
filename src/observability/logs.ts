// Minimal structured logging. Workers observability ingests these JSON lines.

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", message: string, fields?: Fields): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Fields) => emit("info", message, fields),
  warn: (message: string, fields?: Fields) => emit("warn", message, fields),
  error: (message: string, fields?: Fields) => emit("error", message, fields),
};
