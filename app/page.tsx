/**
 * Minimal landing page for the first integration milestone.
 *
 * Shows a "Connect HubSpot" button when no portal is connected.
 * When the user returns from the OAuth flow with ?connected=12345 in the URL,
 * shows a success state and lists the themes found in that portal.
 *
 * This is deliberately bare-bones — the Portage prototype UI plugs in later,
 * once we've confirmed the integration plumbing works end-to-end.
 */

"use client";

import { useEffect, useState } from "react";
import { Link2, Check, AlertCircle } from "lucide-react";

type Theme = { path: string; label: string };

export default function Home() {
  const [hubId, setHubId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themes, setThemes] = useState<Theme[] | null>(null);
  const [loadingThemes, setLoadingThemes] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const connectError = params.get("connect_error");

    if (connectError) setError(connectError);
    if (connected) setHubId(connected);
  }, []);

  useEffect(() => {
    if (!hubId) return;
    setLoadingThemes(true);
    fetch(`/api/portals/${hubId}/themes`)
      .then((r) => r.json())
      .then((data) => {
        setThemes(data.themes ?? []);
        setLoadingThemes(false);
      })
      .catch(() => {
        setError("Failed to load themes");
        setLoadingThemes(false);
      });
  }, [hubId]);

  return (
    <main className="min-h-screen flex items-center justify-center p-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-xl w-full">
        <h1 className="text-3xl font-medium mb-2" style={{ color: "#1A1814" }}>
          Portage
        </h1>
        <p className="text-sm mb-8" style={{ color: "#5C574E" }}>
          First integration milestone — connect a HubSpot portal and list its themes.
        </p>

        {error && (
          <div className="mb-6 p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="text-sm">Connection error: {error}</div>
          </div>
        )}

        {!hubId && (
          <a
            href="/api/auth/hubspot/start"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-medium"
            style={{ backgroundColor: "#C8512A", color: "#FFFFFF" }}
          >
            <Link2 className="w-4 h-4" />
            Connect HubSpot Portal
          </a>
        )}

        {hubId && (
          <div>
            <div className="mb-6 p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#E8EDE1", color: "#5A7048" }}>
              <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                Connected to portal <strong>{hubId}</strong>
              </div>
            </div>

            <h2 className="text-lg font-medium mb-3" style={{ color: "#1A1814" }}>
              Themes in this portal
            </h2>

            {loadingThemes && (
              <div className="text-sm" style={{ color: "#5C574E" }}>Loading themes…</div>
            )}

            {themes && themes.length === 0 && (
              <div className="text-sm" style={{ color: "#5C574E" }}>
                No themes found in this portal.
              </div>
            )}

            {themes && themes.length > 0 && (
              <ul className="space-y-2">
                {themes.map((t) => (
                  <li
                    key={t.path}
                    className="p-3 rounded border text-sm"
                    style={{ backgroundColor: "#FFFFFF", borderColor: "#E8E2D6", color: "#1A1814" }}
                  >
                    <div className="font-medium">{t.label}</div>
                    <div className="text-xs mt-1" style={{ color: "#5C574E", fontFamily: "monospace" }}>
                      {t.path}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </main>
  );
}