import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getScoreColor(score: number) {
  if (score >= 90) return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
  if (score >= 75) return "text-blue-400 bg-blue-400/10 border-blue-400/20";
  if (score >= 60) return "text-amber-400 bg-amber-400/10 border-amber-400/20";
  return "text-red-400 bg-red-400/10 border-red-400/20";
}
