import { LogIn, LogOut } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

interface AuthButtonProps {
  authLoading: boolean;
  session: Session | null;
  onSignIn: () => void;
  onSignOut: () => void;
}

function getUserLabel(session: Session) {
  const metadata = session.user.user_metadata;

  return (
    metadata.full_name ??
    metadata.name ??
    "Signed in"
  );
}

export function AuthButton({
  authLoading,
  session,
  onSignIn,
  onSignOut,
}: AuthButtonProps) {
  if (authLoading) {
    return (
      <div className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-ink-500 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        Checking sign-in
      </div>
    );
  }

  if (!session) {
    return (
      <button
        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-ink-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-emerald-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800 dark:focus:ring-emerald-900/50"
        type="button"
        onClick={onSignIn}
      >
        <LogIn aria-hidden="true" className="h-4 w-4" />
        Sign in with Google
      </button>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="hidden min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 md:block">
        <div className="max-w-40 truncate font-semibold text-ink-950 dark:text-white">
          {getUserLabel(session)}
        </div>
      </div>
      <button
        aria-label="Sign out"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-ink-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-emerald-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800 dark:focus:ring-emerald-900/50"
        title="Sign out"
        type="button"
        onClick={onSignOut}
      >
        <LogOut aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}
