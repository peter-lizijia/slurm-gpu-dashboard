export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatRelativeDate(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const minutes = Math.round((now.getTime() - date.getTime()) / 60000);

  if (Math.abs(minutes) < 1) {
    return "just now";
  }

  if (Math.abs(minutes) < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  if (Math.abs(hours) < 24) {
    return `${hours} hr ago`;
  }

  const days = Math.round(hours / 24);
  return `${days} day${Math.abs(days) === 1 ? "" : "s"} ago`;
}
