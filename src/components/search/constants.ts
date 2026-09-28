/** Select option shape shared by every filter dropdown. */
export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Sort orders available on both routes. The none-selected value is added by
 * `FilterSelect` and labelled "Latest Updates" — that is the default order.
 */
export const SORT_OPTIONS: FilterOption[] = [
  { value: "SCORE_DESC", label: "Score" },
  { value: "TRENDING_DESC", label: "Trending" },
  { value: "POPULARITY_DESC", label: "Popularity" },
  { value: "START_DATE_DESC", label: "Newest Release" },
];

export const FORMATS = ["TV", "Movie", "OVA", "Special", "ONA", "Music"];
export const SEASONS = ["Winter", "Spring", "Summer", "Fall"];
export const STATUSES = ["Finished", "Releasing", "Upcoming", "Cancelled"];

export const TIME_RANGES: FilterOption[] = [
  { value: "week", label: "Past Week" },
  { value: "month", label: "Past Month" },
  { value: "3months", label: "Past 3 Months" },
  { value: "6months", label: "Past 6 Months" },
  { value: "year", label: "Past Year" },
];

/** Plain string lists → select options (label mirrors the value). */
export function toOptions(values: readonly string[]): FilterOption[] {
  return values.map((value) => ({ value, label: value }));
}
