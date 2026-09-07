import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoStatus } from "@/lib/types";
export function StatusNode({status, className}: {status:TodoStatus; className?:string}) {
  const Icon = status === "done" ? CircleCheck : status === "doing" ? CircleDot : Circle;
  return <Icon aria-hidden className={cn("h-4 w-4 shrink-0", status === "done" ? "text-node-done" : status === "doing" ? "text-node-doing" : "text-node-todo", className)} />;
}
