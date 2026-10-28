import { useState } from "react";

interface InstallerProps {
  managers: readonly { readonly id: string; readonly command: string }[];
}

const COPY_RESET_MS = 1600;

/** Package-manager installer with switchable tabs and copy-to-clipboard. */
export function Installer({ managers }: InstallerProps) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);

  const command = managers[active]?.command ?? "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch {
      // Clipboard unavailable (e.g. insecure context); leave the label alone.
    }
  }

  return (
    <div className="installer">
      <div className="installer-tabs" role="tablist">
        {managers.map((mgr, i) => (
          <button
            key={mgr.id}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`installer-tab${i === active ? " active" : ""}`}
            onClick={() => setActive(i)}
          >
            {mgr.id}
          </button>
        ))}
      </div>
      <div className="installer-body">
        <span>
          <span className="dollar">$</span> {command}
        </span>
        <button type="button" className="copy" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default Installer;
