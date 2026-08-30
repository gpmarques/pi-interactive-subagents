import { writeFileSync } from "node:fs";

/** Internal offline-only inspector loaded explicitly by the researcher preflight. */
export default function piWebAccessPreflightInspector(pi: {
  on(event: "session_start", handler: () => void): void;
  getActiveTools(): string[];
}): void {
  pi.on("session_start", () => {
    const output = process.env.PI_WEB_ACCESS_PREFLIGHT_OUTPUT;
    const nonce = process.env.PI_WEB_ACCESS_PREFLIGHT_NONCE;
    if (!output || !nonce) throw new Error("missing pi-web-access preflight output identity");
    writeFileSync(
      output,
      JSON.stringify({ nonce, activeTools: [...pi.getActiveTools()].sort() }),
      { encoding: "utf8", flag: "wx" },
    );
  });
}
