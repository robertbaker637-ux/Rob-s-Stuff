// Minimal UTC-based date helpers. All domain math works in UTC midnight
// instants keyed off "YYYY-MM-DD" strings so window arithmetic can't drift
// with the host machine's timezone or DST.

import type { IsoDate } from "./types";

export function parseIsoDate(iso: IsoDate): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatIsoDate(date: Date): IsoDate {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

export function lastDayOfMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the *next* month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
