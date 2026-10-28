import rawConfig from "../config/clusters.json";

export interface PoolConfig {
  key: string;
  label: string;
  qos: string | null;
  partitions: string[];
  capacity: number;
}

export interface ClusterConfig {
  id: string;
  account: string;
  members: string[];
  pools: PoolConfig[];
}

export const dashboardConfig = rawConfig as {
  title: string;
  organization: string;
  maxBookingHours: number;
  clusters: ClusterConfig[];
};

const ids = new Set<string>();
if (!dashboardConfig.clusters.length) throw new Error("Configure at least one cluster.");
for (const cluster of dashboardConfig.clusters) {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(cluster.id) || ids.has(cluster.id)) {
    throw new Error("Cluster IDs must be unique and use letters, digits, underscores or hyphens.");
  }
  ids.add(cluster.id);
  const pools = new Set<string>();
  if (!cluster.pools.length) throw new Error(`Configure GPU pools for ${cluster.id}.`);
  for (const pool of cluster.pools) {
    if (!pool.key || pools.has(pool.key) || !Number.isInteger(pool.capacity) || pool.capacity < 1) {
      throw new Error(`Invalid GPU pool configuration for ${cluster.id}.`);
    }
    pools.add(pool.key);
  }
}

export const clusterOptions = dashboardConfig.clusters.map((cluster) => cluster.id);
export const isDemo = (import.meta.env.VITE_DATA_SOURCE ?? "demo") === "demo";
