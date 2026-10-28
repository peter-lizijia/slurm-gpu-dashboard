const hourMs = 60 * 60 * 1000;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function toLocalDateTimeInputValue(date: Date) {
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

export function roundUpToNextHour(date: Date) {
  return new Date(Math.ceil(date.getTime() / hourMs) * hourMs);
}

export function getDefaultPlanStartTime() {
  return toLocalDateTimeInputValue(roundUpToNextHour(new Date()));
}

export function getDefaultPlanningWindowStart() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return toLocalDateTimeInputValue(start);
}

export function getDefaultPlanningWindowEnd() {
  const end = new Date();
  end.setDate(end.getDate() + 7);
  end.setHours(23, 59, 0, 0);
  return toLocalDateTimeInputValue(end);
}

export function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function formatCompactDateTimeRange(start: Date, end: Date) {
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const sameDay = start.toDateString() === end.toDateString();

  if (sameDay) {
    const startText = dateFormatter.format(start);
    const endTime = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(end);
    return `${startText} - ${endTime}`;
  }

  return `${dateFormatter.format(start)} - ${dateFormatter.format(end)}`;
}

/**
 * Countdown text tuned for glanceability: coarse units when the wait is long,
 * ticking seconds only in the last hour where they actually convey urgency.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return "0m";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function getDefaultReservationEndTime(startTime: string) {
  const start = new Date(startTime);
  if (!Number.isFinite(start.getTime())) {
    return startTime;
  }
  return toLocalDateTimeInputValue(addHours(start, 4));
}

export function formatShortDateTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function formatDurationHours(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)} min`;
  }

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rest = Math.round(hours % 24);
    return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
  }

  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}
