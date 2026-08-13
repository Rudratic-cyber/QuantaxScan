import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface TypewriterProps {
  texts: string[];
  speed?: number;
  deleteSpeed?: number;
  pauseMs?: number;
  loop?: boolean;
  className?: string;
  cursor?: boolean;
  onDone?: () => void;
  startDelay?: number;
}

export function Typewriter({
  texts,
  speed = 38,
  deleteSpeed = 22,
  pauseMs = 1800,
  loop = true,
  className,
  cursor = true,
  onDone,
  startDelay = 0,
}: TypewriterProps) {
  const [display, setDisplay]   = useState("");
  const [phase, setPhase]       = useState<"wait"|"typing"|"pause"|"deleting">("wait");
  const [textIdx, setTextIdx]   = useState(0);
  const rafRef                  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (startDelay > 0) {
      const t = setTimeout(() => setPhase("typing"), startDelay);
      return () => clearTimeout(t);
    }
    setPhase("typing");
    return undefined;
  }, [startDelay]);

  useEffect(() => {
    if (phase === "wait") return;
    const target = texts[textIdx] ?? "";

    if (phase === "typing") {
      if (display.length < target.length) {
        rafRef.current = setTimeout(
          () => setDisplay(target.slice(0, display.length + 1)),
          speed + Math.random() * (speed * 0.4)
        );
      } else {
        rafRef.current = setTimeout(() => setPhase("pause"), pauseMs);
      }
    }
    if (phase === "pause") {
      if (!loop && textIdx === texts.length - 1) { onDone?.(); return; }
      setPhase("deleting");
    }
    if (phase === "deleting") {
      if (display.length > 0) {
        rafRef.current = setTimeout(() => setDisplay(d => d.slice(0, -1)), deleteSpeed);
      } else {
        setTextIdx((textIdx + 1) % texts.length);
        setPhase("typing");
      }
    }
    return () => clearTimeout(rafRef.current);
  }, [phase, display, textIdx, texts, speed, deleteSpeed, pauseMs, loop, onDone]);

  return (
    <span className={cn("inline", className)}>
      {display}
      {cursor && (
        <span
          className="inline-block w-[2px] h-[1em] ml-0.5 align-middle bg-[#4f8ef7] cursor-blink"
          style={{ boxShadow: "0 0 6px rgba(79,142,247,0.8)" }}
        />
      )}
    </span>
  );
}

export function TypewriterOnce({
  text, speed = 32, className, cursor = false, onDone, startDelay = 0,
}: {
  text: string; speed?: number; className?: string; cursor?: boolean;
  onDone?: () => void; startDelay?: number;
}) {
  const [display, setDisplay] = useState("");
  const doneRef = useRef(false);

  useEffect(() => {
    doneRef.current = false;
    setDisplay("");
    let i = 0;
    const type = () => {
      if (i <= text.length) {
        setDisplay(text.slice(0, i++));
        if (i > text.length && !doneRef.current) { doneRef.current = true; onDone?.(); return; }
        setTimeout(type, speed + Math.random() * (speed * 0.3));
      }
    };
    const t = setTimeout(type, startDelay);
    return () => clearTimeout(t);
  }, [text, speed, startDelay, onDone]);

  return (
    <span className={cn("inline", className)}>
      {display}
      {cursor && display.length < text.length && (
        <span className="inline-block w-[2px] h-[1em] ml-0.5 align-middle bg-[#4f8ef7] cursor-blink" />
      )}
    </span>
  );
}
