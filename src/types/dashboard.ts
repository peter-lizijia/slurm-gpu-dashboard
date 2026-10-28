export interface ClusterData {
  id: string;
  name: string;
  members: { id: string; name: string }[];
}
