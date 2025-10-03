// src/components/ChatTypingIndicator.jsx
import React from "react";

export default function ChatTypingIndicator({ active = false, label = "BEPIT está digitando" }) {
  if (!active) return null;
  return (
    <div className="flex items-center gap-2 text-gray-500 text-sm mt-2" role="status" aria-live="polite">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gray-400 opacity-60"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-500"></span>
      </span>
      <span className="inline-flex gap-1 items-end">
        {label}
        <span className="inline-block w-5">
          <span className="animate-pulse">.</span>
          <span className="animate-pulse" style={{ animationDelay: "120ms" }}>.</span>
          <span className="animate-pulse" style={{ animationDelay: "240ms" }}>.</span>
        </span>
      </span>
    </div>
  );
}
