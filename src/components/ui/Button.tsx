import Link from "next/link";

interface ButtonProps {
  children: React.ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}

export default function Button({
  children,
  href,
  onClick,
  variant = "primary",
  size = "md",
  className = "",
  disabled = false,
  type = "button",
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center font-bold uppercase tracking-wide transition-all duration-200 relative overflow-hidden group";
  const border = "border-2";
  const sharp = "rounded-none";

  const variants = {
    primary:
      "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)] hover:bg-[var(--accent)]/40 accent-shadow-lg",
    secondary:
      "bg-fuchsia-600/20 text-fuchsia-300 border-fuchsia-500 hover:bg-fuchsia-600/40 hover:shadow-[0_0_20px_rgba(255,0,110,0.3)]",
    ghost:
      "bg-transparent text-[var(--accent)] border-[var(--accent)]/30 hover:border-[var(--accent)] hover:bg-[var(--accent)]/5",
  };

  const sizes = {
    sm: "px-3 py-1.5 text-xs gap-1.5",
    md: "px-5 py-2.5 text-sm gap-2",
    lg: "px-8 py-3.5 text-base gap-3",
  };

  const classes = `${base} ${border} ${sharp} ${variants[variant]} ${sizes[size]} ${className}`;

  const content = (
    <>
      <span className="relative z-10">{children}</span>
      {/* Corner accents */}
      <span className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
      <span className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
      <span className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
      <span className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled} className={classes}>
      {content}
    </button>
  );
}
