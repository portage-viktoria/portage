/**
 * Portage landing page — theme path input milestone.
 *
 * After a portal is connected, the user pastes the folder path to their
 * target theme (e.g. `@marketplace/Stuff_Matters_Inc_/Focus`). The app
 * validates the path by fetching `<path>/theme.json` and shows the theme's
 * metadata on success, or a helpful error on failure.
 *
 * This replaces the prior attempt at automatic theme discovery — see the
 * validate-theme route for the reasoning.
 */

"use client";

import { useEffect, useState } from "react";
import {
  Link2,
  Check,
  AlertCircle,
  Loader2,
  Info,
  X,
  ArrowRight,
} from "lucide-react";

type Validated = {
  ok: true;
  path: string;
  label: string;
  author?: string;
  version?: string;
  description?: string;
  source: "marketplace" | "nested" | "custom";
};

type ValidationError = {
  ok: false;
  error: string;
  hint?: string;
};

type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "success"; data: Validated }
  | { status: "error"; error: ValidationError };

export default function Home() {
  const [hubId, setHubId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [themePath, setThemePath] = useState("");
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const err = params.get("connect_error");
    if (err) setConnectError(err);
    if (connected) setHubId(connected);
  }, []);

  // Reset validation whenever the path changes after a previous validation
  useEffect(() => {
    if (validation.status === "success" || validation.status === "error") {
      setValidation({ status: "idle" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themePath]);

  async function validate() {
    if (!hubId || themePath.trim().length === 0) return;
    setValidation({ status: "validating" });
    try {
      const res = await fetch(`/api/portals/${hubId}/validate-theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: themePath }),
      });
      const data = await res.json();
      if (data.ok) {
        setValidation({ status: "success", data });
      } else {
        setValidation({ status: "error", error: data });
      }
    } catch {
      setValidation({
        status: "error",
        error: { ok: false, error: "Couldn't reach the server. Try again in a moment." },
      });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      validate();
    }
  }

  return (
    <main className="min-h-screen py-20 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-xl mx-auto">
        <div className="mb-10">
          <div
            className="inline-flex items-center gap-2 mb-4"
            style={{ color: "#C8512A", fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.1em" }}
          >
            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ backgroundColor: "#1A1814" }}>
              <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#C8512A" }} />
            </div>
            <span className="uppercase">Portage · first integration</span>
          </div>
          <h1 className="text-3xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.02em" }}>
            Connect your portal, then point Portage at a theme.
          </h1>
        </div>

        {connectError && (
          <div
            className="mb-6 p-4 rounded flex items-start gap-3"
            style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-medium">Connection error</div>
              <div className="text-sm mt-0.5 opacity-80">{connectError}</div>
            </div>
            <button onClick={() => setConnectError(null)} className="flex-shrink-0 opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {!hubId ? (
          <a
            href="/api/auth/hubspot/start"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-medium"
            style={{ backgroundColor: "#C8512A", color: "#FFFFFF" }}
          >
            <Link2 className="w-4 h-4" />
            Connect HubSpot portal
          </a>
        ) : (
          <>
            <div
              className="mb-8 p-4 rounded flex items-start gap-3"
              style={{ backgroundColor: "#E8EDE1", color: "#5A7048" }}
            >
              <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                Connected to portal{" "}
                <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 500 }}>{hubId}</span>
              </div>
            </div>

            {/* Theme path input */}
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium" style={{ color: "#1A1814" }}>
                Target theme path
              </label>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="flex items-center gap-1 text-xs"
                style={{ color: "#5C574E" }}
              >
                <Info className="w-3.5 h-3.5" />
                How do I find this?
              </button>
            </div>
            <p className="text-xs mb-3" style={{ color: "#5C574E", lineHeight: 1.6 }}>
              Paste the folder path to your theme from HubSpot's Design Manager.
            </p>

            {showHelp && (
              <div
                className="mb-3 p-3 rounded text-xs leading-relaxed"
                style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#5C574E" }}
              >
                <div className="mb-2" style={{ color: "#1A1814", fontWeight: 500 }}>
                  Finding your theme path
                </div>
                <ol className="space-y-1 list-decimal list-inside">
                  <li>Open HubSpot → Marketing → Files and Templates → Design Tools</li>
                  <li>Find your theme folder in the left sidebar</li>
                  <li>Right-click the folder → "Copy path" (or read the breadcrumb at the top)</li>
                </ol>
                <div className="mt-3 pt-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
                  <div style={{ color: "#1A1814", fontWeight: 500, marginBottom: 4 }}>Examples</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                    @marketplace/Stuff_Matters_Inc_/Focus
                    <br />
                    @marketplace/Helpful_Hero/Clean_Pro_Theme
                    <br />
                    MyCustomTheme
                    <br />
                    Acme/child-theme
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <input
                value={themePath}
                onChange={(e) => setThemePath(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="@marketplace/Publisher/Theme_Name"
                className="flex-1 px-3 py-2.5 rounded-md outline-none"
                style={{
                  backgroundColor: "#FFFFFF",
                  border: "1px solid #E8E2D6",
                  color: "#1A1814",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 13,
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                onClick={validate}
                disabled={validation.status === "validating" || themePath.trim().length === 0}
                className="px-4 py-2.5 rounded-md text-sm font-medium inline-flex items-center gap-2"
                style={{
                  backgroundColor: "#1A1814",
                  color: "#FAF7F2",
                  opacity: validation.status === "validating" || themePath.trim().length === 0 ? 0.5 : 1,
                  cursor:
                    validation.status === "validating" || themePath.trim().length === 0
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {validation.status === "validating" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Validating
                  </>
                ) : (
                  <>
                    Validate
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>

            {/* Validation result */}
            {validation.status === "success" && (
              <div
                className="mt-4 p-4 rounded"
                style={{ backgroundColor: "#FFFFFF", border: "1px solid #B8D0A8" }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ backgroundColor: "#5A7048" }}
                  >
                    <Check className="w-3.5 h-3.5" strokeWidth={2.5} style={{ color: "#FAF7F2" }} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-base" style={{ color: "#1A1814" }}>
                        {validation.data.label}
                      </span>
                      <SourceBadge source={validation.data.source} />
                      {validation.data.version && (
                        <span
                          className="text-xs"
                          style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}
                        >
                          v{validation.data.version}
                        </span>
                      )}
                    </div>
                    {validation.data.author && (
                      <div className="text-sm mt-0.5" style={{ color: "#5C574E" }}>
                        by {validation.data.author}
                      </div>
                    )}
                    {validation.data.description && (
                      <div
                        className="text-sm mt-2"
                        style={{ color: "#5C574E", lineHeight: 1.5 }}
                      >
                        {validation.data.description}
                      </div>
                    )}
                    <div
                      className="text-xs mt-3 pt-3"
                      style={{
                        color: "#8B8478",
                        fontFamily: "ui-monospace, monospace",
                        borderTop: "1px dashed #E8E2D6",
                      }}
                    >
                      {validation.data.path}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {validation.status === "error" && (
              <div
                className="mt-4 p-4 rounded flex items-start gap-3"
                style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}
              >
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium">{validation.error.error}</div>
                  {validation.error.hint && (
                    <div className="text-sm mt-1 opacity-80">{validation.error.hint}</div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function SourceBadge({ source }: { source: "marketplace" | "nested" | "custom" }) {
  const config = {
    marketplace: { label: "Marketplace", bg: "#F5EAD1", fg: "#B8822A" },
    custom: { label: "Custom", bg: "#F4E4DA", fg: "#C8512A" },
    nested: { label: "Nested", bg: "#E8EDE1", fg: "#5A7048" },
  }[source];
  return (
    <span
      className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={{ backgroundColor: config.bg, color: config.fg, fontFamily: "ui-monospace, monospace" }}
    >
      {config.label}
    </span>
  );
}