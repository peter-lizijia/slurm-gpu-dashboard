import { useEffect, useMemo, useState } from "react";
import { Header } from "../components/Header";
import { LiveGpuSection } from "../components/LiveGpuSection";
import { ReservationPanel } from "../components/ReservationPanel";
import { Shell } from "../components/Shell";
import { dashboardConfig } from "../config";
import { useLiveClusters } from "../hooks/useLiveClusters";
import { useSupabaseSession } from "../hooks/useSupabaseSession";
import type { ClusterData } from "../types/dashboard";
import type { ThemeMode } from "../types/theme";
import type { UsageReport } from "../types/usageReport";

const themeKey = "slurm-gpu-dashboard-theme";
function initialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(themeKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* Private browsing may disable local storage. */ }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function DashboardPage() {
  const [reports, setReports] = useState<UsageReport[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const auth = useSupabaseSession();
  const { live, isRefreshing, refresh, error: liveError } = useLiveClusters();
  const clusters = useMemo<ClusterData[]>(() => dashboardConfig.clusters.map((cluster) => ({
    id: cluster.id, name: cluster.id,
    members: cluster.members.map((name) => ({ id: name, name })),
  })), []);

  useEffect(() => {
    document.title = dashboardConfig.title;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem(themeKey, theme); } catch { /* Theme still applies. */ }
  }, [theme]);

  return (
    <Shell>
      <Header authLoading={auth.isLoading} session={auth.session} theme={theme}
        onSignIn={auth.signInWithGoogle} onSignOut={auth.signOut}
        onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} />
      {auth.authError || liveError ? <p role="alert" className="text-sm text-red-600 dark:text-red-300">{auth.authError || liveError}</p> : null}
      <ReservationPanel authLoading={auth.isLoading} clusters={clusters} live={live}
        session={auth.session} onReportsChange={setReports} onSignIn={auth.signInWithGoogle} />
      {clusters.map((cluster) => live[cluster.id] ? (
        <LiveGpuSection key={cluster.id} clusterName={cluster.name} state={live[cluster.id]}
          isRefreshing={isRefreshing} onRefresh={refresh} reservations={reports} />
      ) : (
        <section key={cluster.id} className="border-t border-slate-200 py-6 dark:border-slate-800">
          <h2 className="text-lg font-semibold">{cluster.name}</h2>
          <p className="mt-2 text-sm text-ink-500 dark:text-slate-400">Awaiting telemetry</p>
        </section>
      ))}
      <footer className="py-4 text-xs text-ink-500 dark:text-slate-400">
        <a className="hover:underline" href="https://github.com/peter-lizijia/slurm-gpu-dashboard" target="_blank" rel="noreferrer">Slurm GPU Dashboard</a>
      </footer>
    </Shell>
  );
}
