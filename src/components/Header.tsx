import type { Session } from "@supabase/supabase-js";
import { Cpu } from "lucide-react";
import { dashboardConfig, isDemo } from "../config";
import { AuthButton } from "./AuthButton";
import { ThemeToggle } from "./ThemeToggle";
import type { ThemeMode } from "../types/theme";

interface HeaderProps {
  authLoading: boolean;
  session: Session | null;
  theme: ThemeMode;
  onSignIn: () => void;
  onSignOut: () => void;
  onToggleTheme: () => void;
}

export function Header(props: HeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-5 border-b border-slate-200 pb-6 dark:border-slate-800">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
          <Cpu aria-hidden="true" className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-500 dark:text-slate-400">{dashboardConfig.organization}</p>
          <h1 className="text-xl font-semibold text-ink-950 dark:text-white sm:text-2xl">{dashboardConfig.title}</h1>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {isDemo ? (
          <span className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-ink-500 dark:border-slate-700 dark:text-slate-300" title="Fictional data. Edits reset on reload; no database is contacted.">Demo</span>
        ) : <AuthButton {...props} />}
        <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
      </div>
    </header>
  );
}
