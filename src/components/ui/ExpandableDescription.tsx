"use client";

import { useState, useEffect } from "react";

interface ExpandableDescriptionProps {
  description: string;
  maxLines?: number;
}

export default function ExpandableDescription({ description, maxLines = 3 }: ExpandableDescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);

  // Check if description is long enough to need truncation
  useEffect(() => {
    // Create a temporary element to measure text height
    const temp = document.createElement("div");
    temp.style.cssText = `
      position: absolute;
      visibility: hidden;
      width: 100%;
      font-size: 1rem;
      line-height: 1.625;
      font-family: inherit;
      white-space: pre-wrap;
      word-wrap: break-word;
    `;
    temp.textContent = description;
    document.body.appendChild(temp);
    
    const lineHeight = parseFloat(getComputedStyle(temp).lineHeight);
    const height = temp.offsetHeight;
    const lines = height / lineHeight;
    
    setIsLong(lines > maxLines);
    document.body.removeChild(temp);
  }, [description, maxLines]);

  if (!isLong) {
    return (
      <p className="text-[#9a9aa0] leading-relaxed whitespace-pre-wrap">
        {description}
      </p>
    );
  }

  return (
    <div className="text-[#9a9aa0] leading-relaxed">
      <p className={expanded ? "whitespace-pre-wrap" : "line-clamp-3 whitespace-pre-wrap"}>
        {description}
      </p>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs font-mono text-[var(--accent)]/70 hover:text-[var(--accent)] uppercase tracking-wider transition-colors"
      >
        {expanded ? "Show Less" : "Show More"}
      </button>
    </div>
  );
}