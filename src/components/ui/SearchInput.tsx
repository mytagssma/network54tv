"use client";

import { useState } from "react";

interface SearchInputProps {
  onSearch: (query: string) => void;
  placeholder?: string;
  initialValue?: string;
  className?: string;
}

export default function SearchInput({
  onSearch,
  placeholder = "Search anime...",
  initialValue = "",
  className = "",
}: SearchInputProps) {
  const [query, setQuery] = useState(initialValue);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={`relative group ${className}`}
    >
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-decorative)]"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-black/60 border-2 border-[var(--accent)]/30 text-white pl-10 pr-4 py-3 
                   rounded-none outline-none transition-all duration-300
                   focus:border-[var(--accent)] accent-shadow-sm
                   placeholder:text-[var(--text-decorative)]/50 font-mono text-sm"
      />
      <button
        type="submit"
        className="absolute right-1 top-1/2 -translate-y-1/2 px-3 py-2 
                   text-[var(--accent)] hover:brightness-125 transition-colors"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14 5l7 7m0 0l-7 7m7-7H3"
          />
        </svg>
      </button>
    </form>
  );
}
