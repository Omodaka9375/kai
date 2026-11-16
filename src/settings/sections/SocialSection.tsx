import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  clearGmailSecret,
  gmailAccountEmail,
  setGmailSecret,
} from "@/modules/ai/tools/gmail";
import { clearXBearer, setXBearer, xBearerSet } from "@/modules/ai/tools/social";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/**
 * Social panel — read-only account integrations the agent can use:
 * Gmail (IMAP search via app password) and X/Twitter (developer Bearer
 * token). Moved here from General (2026-11-16) so General stays
 * appearance/editor/terminal/startup and every connected-account surface
 * lives in one place. Same storage contract as before: OS keychain under
 * service "kai", never the settings store.
 */

export function SocialSection() {
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Social"
        description="Read-only Gmail and X access for the agent."
      />
      <GmailCard />
      <SocialCard />
    </div>
  );
}

/**
 * Gmail read-only access card. The agent's gmail_read tool searches the
 * user's own inbox over IMAP with an app password — no OAuth, no GCP
 * project, no MCP server. The stored secret is "<email> <app-password>" in
 * the OS keychain (service "kai", account "gmail-app-password").
 *
 * Read-only is enforced in the Rust module: connect/login, UID SEARCH,
 * UID FETCH, LOGOUT — there is no code path that can write or send.
 */
function GmailCard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [configuredEmail, setConfiguredEmail] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void gmailAccountEmail().then(setConfiguredEmail);
  }, []);

  const onSave = async () => {
    setBusy(true);
    setIsError(false);
    setStatus("");
    try {
      await setGmailSecret(email, password);
      setConfiguredEmail(await gmailAccountEmail());
      setEmail("");
      setPassword("");
      setStatus("Saved. The agent can now search your Gmail (read-only).");
    } catch (e) {
      setIsError(true);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      await clearGmailSecret();
      setConfiguredEmail(null);
      setStatus("Gmail access removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/50 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">Gmail (read-only)</div>
        {configuredEmail ? (
          <div className="truncate text-[10.5px] text-muted-foreground">{configuredEmail}</div>
        ) : null}
      </div>
      <div className="text-[10.5px] text-muted-foreground">
        Agent cannot send or modify mail. Needs a{" "}
        <button
          type="button"
          title="Opens Google's app-password page (2-Step Verification required)"
          onClick={() => void openUrl("https://myaccount.google.com/apppasswords")}
          className="text-foreground/90 underline-offset-2 hover:underline"
        >
          Google app password
        </button>
        . Requires 2-Step Verification. Stored in your OS keychain.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          value={email}
          placeholder={configuredEmail ?? "you@gmail.com"}
          onChange={(e) => setEmail(e.target.value)}
          className="h-8 min-w-[8rem] flex-[2]"
        />
        <Input
          type="password"
          value={password}
          placeholder="app password"
          onChange={(e) => setPassword(e.target.value)}
          className="h-8 min-w-[8rem] flex-[2]"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !email.trim() || !password.trim()}
          onClick={() => void onSave()}
        >
          Save
        </Button>
        {configuredEmail ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onRemove()}>
            Remove
          </Button>
        ) : null}
      </div>
      {status ? (
        <div
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs",
            isError ? "bg-red-500/10 text-red-500" : "bg-primary/5 text-muted-foreground",
          )}
        >
          {status}
        </div>
      ) : null}
    </div>
  );
}

/**
 * X (Twitter) card — developer Bearer token for the agent's read-only
 * social_read tool. Same storage contract as the Gmail card: OS keychain
 * under service "kai", never the settings store.
 *
 * Read-only is enforced in social.ts: only search + timeline GETs are
 * implemented — no code path can post, like, or follow.
 */
function SocialCard() {
  const [xToken, setXToken] = useState("");
  const [xConfigured, setXConfigured] = useState(false);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void xBearerSet().then(setXConfigured);
  }, []);

  const onSaveX = async () => {
    setBusy(true);
    setIsError(false);
    setStatus("");
    try {
      await setXBearer(xToken);
      setXConfigured(true);
      setXToken("");
      setStatus("Saved. The agent can now search X and read account timelines (read-only).");
    } catch (e) {
      setIsError(true);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemoveX = async () => {
    setBusy(true);
    try {
      await clearXBearer();
      setXConfigured(false);
      setStatus("X token removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/50 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">X / Twitter (read-only)</div>
        {xConfigured ? (
          <div className="text-[10.5px] text-muted-foreground">configured</div>
        ) : null}
      </div>
      <div className="text-[10.5px] text-muted-foreground">
        Agent cannot post, like, or follow. Needs your developer{" "}
        <button
          type="button"
          title="Opens the X developer portal (create a project to get a Bearer token)"
          onClick={() => void openUrl("https://developer.x.com/en/portal/dashboard")}
          className="text-foreground/90 underline-offset-2 hover:underline"
        >
          Bearer token
        </button>
        . Stored in your OS keychain.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={xToken}
          placeholder="Bearer token"
          onChange={(e) => setXToken(e.target.value)}
          className="h-8 min-w-[8rem] flex-[3]"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !xToken.trim()}
          onClick={() => void onSaveX()}
        >
          Save
        </Button>
        {xConfigured ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onRemoveX()}>
            Remove
          </Button>
        ) : null}
      </div>
      {status ? (
        <div
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs",
            isError ? "bg-red-500/10 text-red-500" : "bg-primary/5 text-muted-foreground",
          )}
        >
          {status}
        </div>
      ) : null}
    </div>
  );
}
