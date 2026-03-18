import React, { useState, KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function TagInput({ value = [], onChange, placeholder, className }: TagInputProps) {
  const [input, setInput] = useState("");

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = input.trim();
      if (val && !value.includes(val)) {
        onChange([...value, val]);
        setInput("");
      }
    } else if (e.key === "Backspace" && input === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tagToRemove: string) => {
    onChange(value.filter(t => t !== tagToRemove));
  };

  return (
    <div className={cn(
      "flex flex-wrap gap-2 p-2 border border-input rounded-xl bg-background/50 backdrop-blur-sm transition-all focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10",
      className
    )}>
      {value.map(tag => (
        <span 
          key={tag} 
          className="flex items-center gap-1.5 px-3 py-1 bg-secondary text-secondary-foreground text-sm font-medium rounded-lg border border-border"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="text-muted-foreground hover:text-foreground transition-colors rounded-full hover:bg-black/10 p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? placeholder : "Add more..."}
        className="flex-1 min-w-[120px] bg-transparent outline-none text-sm placeholder:text-muted-foreground py-1 px-1"
      />
    </div>
  );
}
