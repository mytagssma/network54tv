export default function Footer() {
  return (
    <footer className="bg-[var(--panel)] border-t border-[var(--accent)]/30 mt-auto rounded-none">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-center gap-3">
          <div className="h-px w-8 bg-[var(--accent)]/20" />
          <p className="text-[var(--text-decorative)] text-xs text-center uppercase tracking-widest font-mono flex items-center gap-2">
            <svg
              className="w-3 h-3 text-[var(--accent)]/40"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            n54tv &mdash; anime streaming
            <svg
              className="w-3 h-3 text-[var(--accent)]/40"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </p>
          <div className="h-px w-8 bg-[var(--accent)]/20" />
        </div>
      </div>
    </footer>
  );
}
